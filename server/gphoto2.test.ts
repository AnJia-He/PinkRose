import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createGphoto2CameraProvider,
  gphoto2SettingDescriptor,
  jpegFromBuffer,
  parseGphoto2Config,
  parseGphoto2ConfigList,
  parseGphoto2Detect,
  parseGphoto2Setting,
  type CameraCommandRunner,
} from './gphoto2.ts'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pinkrose-gphoto-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const ok = (text = '') => ({ stdout: Buffer.from(text), stderr: '' })

describe('gphoto2 输出解析', () => {
  it('从 --auto-detect 里认出机型和端口', () => {
    expect(parseGphoto2Detect([
      'Model                          Port',
      '----------------------------------------------------------',
      'Canon EOS R5                   usb:001,004',
      '',
    ].join('\n'))).toEqual({ model: 'Canon EOS R5', port: 'usb:001,004' })
  })

  it('没有相机时不把表头当机型', () => {
    expect(parseGphoto2Detect('Model Port\n------------------------\n')).toBeNull()
  })

  it('PTP/IP port 会加到每条 gphoto2 命令前面', async () => {
    const calls: string[][] = []
    const provider = createGphoto2CameraProvider({
      root,
      port: 'ptpip:192.168.1.50',
      runner: async (_command, args) => {
        calls.push([...args])
        return ok('Model Port\n------------------------\n')
      },
    })
    const status = await provider.status()
    expect(status.connected).toBe(false)
    expect(calls[0]).toEqual(['--port', 'ptpip:192.168.1.50', '--auto-detect'])
  })

  it('没装 gphoto2 时给出安装路径，不只说没检测到相机', async () => {
    const provider = createGphoto2CameraProvider({
      root,
      runner: async () => {
        throw new Error('没找到 gphoto2。先在终端安装 gphoto2，再重启相机桥。')
      },
    })
    expect(await provider.status()).toMatchObject({
      connected: false,
      diagnostic: expect.stringContaining('brew install gphoto2'),
    })
  })

  it('PTP/IP 连不上时提示检查相机网络设置，而不是让人重装工具', async () => {
    const provider = createGphoto2CameraProvider({
      root,
      port: 'ptpip:192.168.1.50',
      runner: async () => {
        throw new Error('Command failed: gphoto2 --port ptpip:192.168.1.50 --auto-detect')
      },
    })
    const status = await provider.status()
    expect(status.diagnostic).toContain('PC Remote / PTP')
    expect(status.diagnostic).toContain('同一 Wi-Fi')
    expect(status.diagnostic).not.toContain('brew install')
  })

  it('USB 被其它软件占用时直接点名要关掉的程序', async () => {
    const provider = createGphoto2CameraProvider({
      root,
      runner: async () => {
        throw new Error('gphoto2: Could not claim the USB device: Resource busy')
      },
    })
    const status = await provider.status()
    expect(status.diagnostic).toContain('EOS Utility')
    expect(status.diagnostic).toContain('Imaging Edge')
    expect(status.diagnostic).toContain('Capture One')
  })

  it('显式 USB port 的其它失败不会被误判为无线网络问题', async () => {
    const provider = createGphoto2CameraProvider({
      root,
      port: 'usb:001,004',
      runner: async () => {
        throw new Error('Command failed: gphoto2 --port usb:001,004 --auto-detect')
      },
    })
    const status = await provider.status()
    expect(status.diagnostic).toContain('相机连接失败')
    expect(status.diagnostic).not.toContain('同一 Wi-Fi')
  })

  it('从 --get-config 里取 Current 值', () => {
    expect(parseGphoto2Config('Label: ISO Speed\nType: RADIO\nCurrent: 400\nChoice: 0 100\n'))
      .toBe('400')
    expect(parseGphoto2Config('Label: Shutter\nCurrent: 1/125\n')).toBe('1/125')
    expect(parseGphoto2Config('Label: Empty\n')).toBeNull()
  })

  it('从 --list-config 认出相机支持的配置名', () => {
    const names = parseGphoto2ConfigList([
      '/main/imgsettings/iso',
      '/main/capturesettings/shutter-speed',
      '/main/capturesettings/whitebalance',
      '',
    ].join('\n'))
    expect([...names]).toEqual(['iso', 'shutter-speed', 'whitebalance'])
  })

  it('解析相机实际给出的选项和范围', () => {
    const radio = parseGphoto2Setting([
      'Label: ISO Speed',
      'Type: RADIO',
      'Current: 400',
      'Choice: 0 100',
      'Choice: 1 200',
      'Choice: 2 400',
      '',
    ].join('\n'))
    expect(radio).toEqual({
      type: 'RADIO',
      current: '400',
      choices: [
        { value: '0', label: '100' },
        { value: '1', label: '200' },
        { value: '2', label: '400' },
      ],
      bottom: null,
      top: null,
      step: null,
    })
    expect(gphoto2SettingDescriptor('iso', radio)).toMatchObject({
      key: 'iso', label: 'ISO', type: 'select',
      options: expect.arrayContaining([{ value: '100', label: '100' }]),
    })

    const range = parseGphoto2Setting([
      'Label: ISO Speed',
      'Type: RANGE',
      'Current: 640',
      'Bottom: 100',
      'Top: 12800',
      'Step: 100',
      '',
    ].join('\n'))
    expect(range).toMatchObject({
      type: 'RANGE', current: '640', bottom: 100, top: 12800, step: 100,
    })
    expect(gphoto2SettingDescriptor('iso', range)).toMatchObject({
      type: 'number', min: 100, max: 12800, step: 100,
    })
    expect(gphoto2SettingDescriptor('shutter', range)).toMatchObject({
      key: 'shutter', type: 'number',
    })
  })

  it('从前面带提示文字的预览输出里取出 JPEG', () => {
    const frame = jpegFromBuffer(Buffer.from([0x0a, 0x0a, 0xff, 0xd8, 0xff, 0xd9]))
    expect(frame).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
    expect(jpegFromBuffer(Buffer.from('not a jpeg'))).toBeNull()
  })
})

describe('gphoto2 相机控制适配器', () => {
  it('提供状态、实时取景、快门下载和参数读写', async () => {
    const calls: string[][] = []
    const current: Record<string, string> = {
      iso: '400',
      'shutter-speed': '1/125',
      'f-number': '5.6',
      whitebalance: 'Daylight',
      drivemode: 'Single',
      meteringmode: 'Evaluative',
      exposurecompensation: '0',
      focusmode: 'AF-S',
      imagequality: 'RAW+JPEG',
      exposureprogram: 'Av',
      batterylevel: '75',
      lensname: 'RF24-70mm F2.8',
    }
    const choices: Record<string, [string, string][]> = {
      iso: [['0', '100'], ['1', '200'], ['2', '400'], ['3', '800']],
      'shutter-speed': [['0', '1/60'], ['1', '1/125'], ['2', '1/250']],
      'f-number': [['0', '2.8'], ['1', '4'], ['2', '5.6']],
      whitebalance: [['0', 'Auto'], ['1', 'Daylight'], ['2', 'Cloudy']],
      drivemode: [['0', 'Single'], ['1', 'Continuous']],
      meteringmode: [['0', 'Evaluative'], ['1', 'Center-weighted']],
      focusmode: [['0', 'AF-S'], ['1', 'AF-C'], ['2', 'MF']],
      imagequality: [['0', 'JPEG Fine'], ['1', 'RAW'], ['2', 'RAW+JPEG']],
      exposureprogram: [['0', 'P'], ['1', 'Av'], ['2', 'Tv'], ['3', 'M']],
      lensname: [['0', 'RF24-70mm F2.8']],
    }
    const runner: CameraCommandRunner = async (_command, args) => {
      calls.push([...args])
      if (args[0] === '--auto-detect') {
        return ok('Model Port\n------------------------\nCanon EOS R5                   usb:001,004\n')
      }
      if (args[0] === '--capture-preview') {
        return { stdout: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), stderr: '' }
      }
      if (args[0] === '--capture-image-and-download') {
        const prefix = args[args.indexOf('--filename') + 1]!
        writeFileSync(`${prefix}.cr3`, Buffer.from([1, 2, 3]))
        return ok()
      }
      if (args[0] === '--list-config') {
        return ok([
          '/main/imgsettings/iso',
          '/main/capturesettings/shutter-speed',
          '/main/capturesettings/f-number',
          '/main/capturesettings/whitebalance',
          '/main/capturesettings/drivemode',
          '/main/capturesettings/meteringmode',
          '/main/capturesettings/exposurecompensation',
          '/main/capturesettings/focusmode',
          '/main/capturesettings/imagequality',
          '/main/capturesettings/exposureprogram',
          '/main/status/batterylevel',
          '/main/status/lensname',
          '',
        ].join('\n'))
      }
      if (args[0] === '--get-config') {
        const key = args[1]!
        if (key === 'exposurecompensation' || key === 'batterylevel') {
          const top = key === 'batterylevel' ? '100' : '5'
          return ok([
            `Label: ${key}`,
            'Type: RANGE',
            `Current: ${current[key]}`,
            `Bottom: ${key === 'batterylevel' ? '0' : '-5'}`,
            `Top: ${top}`,
            `Step: ${key === 'batterylevel' ? '1' : '0.333'}`,
            '',
          ].join('\n'))
        }
        return ok([
          'Label: test',
          'Type: RADIO',
          `Current: ${current[key]}`,
          ...choices[key]!.map(([value, label]) => `Choice: ${value} ${label}`),
          '',
        ].join('\n'))
      }
      if (args[0] === '--set-config') {
        const [key, value] = args[1]!.split('=')
        current[key!] = value!
        return ok()
      }
      throw new Error(`没有预料的命令：${args.join(' ')}`)
    }

    const provider = createGphoto2CameraProvider({
      root, runner, now: () => 123456789,
    })
    const status = await provider.status()
    expect(status).toMatchObject({
      connected: true,
      model: 'Canon EOS R5',
      capabilities: { liveView: true, shutter: true, settings: true },
      settingsSchema: expect.arrayContaining([
        expect.objectContaining({ key: 'iso', label: 'ISO' }),
        expect.objectContaining({ key: 'shutter', label: '快门' }),
        expect.objectContaining({ key: 'aperture', label: '光圈' }),
        expect.objectContaining({ key: 'whiteBalance', label: '白平衡' }),
        expect.objectContaining({ key: 'driveMode', label: '驱动模式' }),
        expect.objectContaining({ key: 'metering', label: '测光' }),
        expect.objectContaining({ key: 'exposureCompensation', label: '曝光补偿' }),
        expect.objectContaining({ key: 'focusMode', label: '对焦模式' }),
        expect.objectContaining({ key: 'imageQuality', label: '图像质量' }),
        expect.objectContaining({ key: 'shootingMode', label: '拍摄模式' }),
        expect.objectContaining({ key: 'battery', label: '电池', readOnly: true }),
        expect.objectContaining({ key: 'lens', label: '镜头', readOnly: true }),
      ]),
    })
    const iso = status.settingsSchema?.find(item => item.key === 'iso')
    const shutter = status.settingsSchema?.find(item => item.key === 'shutter')
    const whiteBalance = status.settingsSchema?.find(item => item.key === 'whiteBalance')
    const exposure = status.settingsSchema?.find(item => item.key === 'exposureCompensation')
    const focus = status.settingsSchema?.find(item => item.key === 'focusMode')
    const quality = status.settingsSchema?.find(item => item.key === 'imageQuality')
    const shooting = status.settingsSchema?.find(item => item.key === 'shootingMode')
    const battery = status.settingsSchema?.find(item => item.key === 'battery')
    expect(iso).toMatchObject({ type: 'select' })
    expect(iso?.options?.map(option => option.label)).toEqual(['100', '200', '400', '800'])
    expect(iso?.options?.map(option => option.value)).toEqual(['100', '200', '400', '800'])
    expect(shutter?.options?.map(option => option.label)).toEqual(['1/60', '1/125', '1/250'])
    expect(whiteBalance?.options?.map(option => option.label))
      .toEqual(['Auto', 'Daylight', 'Cloudy'])
    expect(exposure).toMatchObject({ type: 'number', min: -5, max: 5 })
    expect(focus?.options?.map(option => option.label)).toEqual(['AF-S', 'AF-C', 'MF'])
    expect(quality?.options?.map(option => option.label))
      .toEqual(['JPEG Fine', 'RAW', 'RAW+JPEG'])
    expect(shooting?.options?.map(option => option.label)).toEqual(['P', 'Av', 'Tv', 'M'])
    expect(battery).toMatchObject({ type: 'number', readOnly: true, min: 0, max: 100 })

    expect(await provider.liveView!()).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))

    const shot = await provider.capture!()
    expect(shot).toEqual({ saved: 'pinkrose-123456789.cr3' })
    expect(existsSync(join(root, 'pinkrose-123456789.cr3'))).toBe(true)

    expect(await provider.getSettings!()).toMatchObject({
      iso: 400, shutter: '1/125', aperture: '5.6',
      whiteBalance: 'Daylight', driveMode: 'Single',
      metering: 'Evaluative', exposureCompensation: 0,
      focusMode: 'AF-S', imageQuality: 'RAW+JPEG',
      shootingMode: 'Av',
      battery: 75, lens: 'RF24-70mm F2.8',
    })
    expect(await provider.setSettings!({
      iso: 800, shutter: '1/250', whiteBalance: 'Cloudy', exposureCompensation: 1,
      focusMode: 'MF', imageQuality: 'RAW',
      shootingMode: 'M',
      battery: 10, lens: 'RF50mm F1.8',
    })).toMatchObject({
      iso: 800, shutter: '1/250', whiteBalance: 'Cloudy', exposureCompensation: 1,
      focusMode: 'MF', imageQuality: 'RAW',
      shootingMode: 'M',
      battery: 75, lens: 'RF24-70mm F2.8',
    })
    expect(calls).toContainEqual(['--set-config', 'iso=800'])
    expect(calls).toContainEqual(['--set-config', 'shutter-speed=1/250'])
    expect(calls).toContainEqual(['--set-config', 'whitebalance=Cloudy'])
    expect(calls).toContainEqual(['--set-config', 'exposurecompensation=1'])
    expect(calls).toContainEqual(['--set-config', 'focusmode=MF'])
    expect(calls).toContainEqual(['--set-config', 'imagequality=RAW'])
    expect(calls).toContainEqual(['--set-config', 'exposureprogram=M'])
    expect(calls).not.toContainEqual(['--set-config', 'batterylevel=10'])
    expect(calls).not.toContainEqual(['--set-config', 'lensname=RF50mm F1.8'])
  })

  it('没插相机时返回 disconnected，实时取景不抛错', async () => {
    const provider = createGphoto2CameraProvider({
      root,
      runner: async () => ok('Model Port\n------------------------\n'),
    })
    expect(await provider.status()).toMatchObject({
      connected: false,
      model: null,
      capabilities: { liveView: false, shutter: false, settings: false },
      diagnostic: expect.stringContaining('没检测到相机'),
    })
    expect(await provider.liveView!()).toBeNull()
  })

  it('非 JPEG 的预览输出按没有帧处理', async () => {
    const provider = createGphoto2CameraProvider({
      root,
      runner: async (_command, args) => args[0] === '--auto-detect'
        ? ok('Model Port\n------------------------\nNikon Z 8                    usb:001,002\n')
        : ok('not a jpeg'),
    })
    await provider.status()
    expect(await provider.liveView!()).toBeNull()
  })

  it('实时取景失败后把可执行原因带到下一次状态查询', async () => {
    const provider = createGphoto2CameraProvider({
      root,
      runner: async (_command, args) => {
        if (args[0] === '--auto-detect') {
          return ok('Model Port\n------------------------\nCanon EOS R5                 usb:001,004\n')
        }
        if (args[0] === '--capture-preview') {
          throw new Error('gphoto2: Could not claim the USB device: Resource busy')
        }
        return ok()
      },
    })
    expect(await provider.status()).toMatchObject({ connected: true })
    expect(await provider.liveView!()).toBeNull()
    const status = await provider.status()
    expect(status.previewDiagnostic).toContain('EOS Utility')
    expect(status.previewDiagnostic).toContain('Imaging Edge')
  })

  it('实时取景恢复后清除上一次的失败诊断', async () => {
    let previewCalls = 0
    const provider = createGphoto2CameraProvider({
      root,
      runner: async (_command, args) => {
        if (args[0] === '--auto-detect') {
          return ok('Model Port\n------------------------\nCanon EOS R5                 usb:001,004\n')
        }
        if (args[0] === '--capture-preview') {
          previewCalls++
          if (previewCalls === 1) throw new Error('preview timed out')
          return { stdout: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), stderr: '' }
        }
        return ok()
      },
    })
    await provider.status()
    expect(await provider.liveView!()).toBeNull()
    expect((await provider.status()).previewDiagnostic).toContain('实时取景')

    expect(await provider.liveView!()).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
    expect((await provider.status()).previewDiagnostic).toBeUndefined()
  })
})
