// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  buildCameraPairingLink, clearCameraPairingHash,
  normalizeBridgeAddress, readCameraPairingHash,
} from './cameraPairing'

describe('相机桥配对链接', () => {
  it('归一化地址：补 http、去尾斜杠、拒绝非 http', () => {
    expect(normalizeBridgeAddress('192.168.1.8:8788/')).toBe('http://192.168.1.8:8788')
    expect(normalizeBridgeAddress('https://cam.local:8788/')).toBe('https://cam.local:8788')
    expect(normalizeBridgeAddress('ftp://cam.local')).toBeNull()
  })

  it('在 localhost 上生成给 iPad 的局域网配对链接', () => {
    const link = buildCameraPairingLink({
      appUrl: 'http://localhost:5173/app?x=1',
      bridgeAddress: 'http://192.168.1.8:8788',
      token: 'secret-token',
    })!
    const url = new URL(link)
    expect(url.hostname).toBe('192.168.1.8')
    expect(url.port).toBe('5173')
    expect(url.pathname).toBe('/app')
    expect(url.search).toBe('?x=1')
    expect(readCameraPairingHash(url.hash)).toEqual({
      address: 'http://192.168.1.8:8788',
      token: 'secret-token',
    })
  })

  it('特殊字符令牌能原样往返；缺令牌 / 坏地址回 null', () => {
    const link = buildCameraPairingLink({
      appUrl: 'http://192.168.1.8:5173/app',
      bridgeAddress: 'http://192.168.1.8:8788',
      token: 'a+b/c=&?',
    })!
    expect(readCameraPairingHash(new URL(link).hash)?.token).toBe('a+b/c=&?')
    expect(buildCameraPairingLink({
      appUrl: 'http://localhost:5173/app', bridgeAddress: 'http://cam:8788', token: '',
    })).toBeNull()
    expect(readCameraPairingHash('#camera=ftp%3A%2F%2Fcam.local&token=x')).toBeNull()
    expect(readCameraPairingHash('#foo=1')).toBeNull()
  })

  it('读完后能从地址栏清掉 hash', () => {
    history.replaceState(null, '', '/app?x=1#camera=http%3A%2F%2Fcam%3A8788&token=secret')
    clearCameraPairingHash()
    expect(location.hash).toBe('')
    expect(location.pathname + location.search).toBe('/app?x=1')
  })
})
