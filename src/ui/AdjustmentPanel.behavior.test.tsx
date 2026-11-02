// @vitest-environment jsdom
/**
 * 「调色」面板的**行为**测试（2026-10-04，「专业面板」那一轮 Task 5：分组 + 折叠）。
 *
 * ⚠️ 为什么另开一个文件、不并进 `AdjustmentPanel.test.ts`：
 * 那一份读的是**源码**，路径用 `new URL('./AdjustmentPanel.tsx', import.meta.url)`
 * 拼 —— jsdom 环境里拼出来不是 `file://`，`readFileSync` 当场报
 * "The URL must be of scheme file"。所以那份**一个字没改**，行为另开这一个。
 *
 * 驱动方式照项目惯例（`kit/Slider.test.tsx`、`App.test.tsx`）：`createRoot` + `act`，
 * 点击用原生 `.click()` —— **没有** @testing-library，零新增依赖是规矩。
 */
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkMeta } from '../../shared/works.ts'
import type { LutMeta, LutRef } from '../../shared/lut.ts'
import AdjustmentPanel from './AdjustmentPanel.tsx'
import { ZERO, type Adjustments } from '../../shared/adjustments.ts'
import type { HslBandId } from '../core/hslPick'
import type { ColorReading } from '../core/colorSample'

/** 「从我的作品里选」拉的清单 —— 假掉它（真的会走网络）。
 *  `fileUrl` 等其余导出**保留真的**：纯字符串拼接，真跑一遍正好把
 *  "缩略图网址带着版本号（?v=）"这件事一起钉住。 */
const listWorksMock = vi.hoisted(() => vi.fn())
vi.mock('../api/works.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/works.ts')>()
  return { ...actual, listWorks: listWorksMock }
})

/**
 * 面板是**受控**组件，值在壳子手里（改动一律走 React 的 onChange）。
 *
 * ★ 2026-10-05：这里原来还有一个 `setFromTest` 后门（"先把值置出去，再验套预设
 * 之后归零"）。预设药丸搬去 `PresetRail` 之后这一层不再需要它 —— 那件事的两半
 * 现在住在 `core/presets.test.ts`（字段完整性）和 `App.test.tsx`（整组赋值）。
 */
/** 两条参考图来源交出去的东西 —— 面板只"交货"：本地文件 / 选中那张的元数据。 */
let matchedRef: File | null = null
let matchedWork: WorkMeta | null = null
/** ★ 2026-10-05（滤镜）：那一栏要的四样。面板只管摆 —— 挑哪张 / 强度多少 是 App 的事，
 *  所以这里记的是"面板有没有按下去"。 */
let lutsFromTest: LutMeta[] = []
/** ★ 2026-10-05 终审修复：清单到手没有（默认到手 —— 这一层的用例大多在演"拉到了"）。 */
let lutsKnownFromTest = true
let lutFromTest: LutRef | null = null
let lutThumbsFromTest: { none: string | null; byId: Record<number, string> } = { none: null, byId: {} }
let needThumbsCalls = 0
let pickedLut: number | null | 'x' = 'x'
let wentImport = false
let retriedLuts = 0
let autoCalls = 0
let recommendCalls = 0
let hslPickCalls = 0
let colorSampleCalls = 0
let copyColorCalls = 0

function Harness({
  lutOpen = false, luts = lutsFromTest, initial,
  hslPickedBand = null, hslPickSeq = 0,
  colorSampling = false, colorSample = null,
}: {
  lutOpen?: boolean
  luts?: LutMeta[]
  initial?: Partial<Adjustments>
  hslPickedBand?: HslBandId | null
  hslPickSeq?: number
  colorSampling?: boolean
  colorSample?: ColorReading | null
} = {}) {
  const [v, setV] = useState<Adjustments>({ ...ZERO, ...initial })
  return (
    <AdjustmentPanel
      value={v} onChange={setV} onReset={() => setV(ZERO)}
      onCopyAdjustments={() => {}}
      onPasteAdjustments={() => {}}
      canPasteAdjustments={false}
      photoFile={null}
      image={{ width: 1200, height: 800 }}
      onAuto={() => { autoCalls++ }}
      onRecommend={() => { recommendCalls++ }}
      hslPicking={false}
      onHslPick={() => { hslPickCalls++ }}
      hslPickedBand={hslPickedBand}
      hslPickSeq={hslPickSeq}
      colorSampling={colorSampling}
      colorSample={colorSample}
      onColorSample={() => { colorSampleCalls++ }}
      onCopyColor={() => { copyColorCalls++ }}
      defaultLutOpen={lutOpen}
      onMatchReference={f => { matchedRef = f }}
      onMatchWork={w => { matchedWork = w }}
      luts={luts}
      lutsKnown={lutsKnownFromTest}
      lut={lutFromTest}
      lutThumbs={lutThumbsFromTest}
      onPickLut={id => { pickedLut = id }}
      onLutAmount={() => {}}
      onNeedLutThumbs={() => { needThumbsCalls++ }}
      onGoImport={() => { wentImport = true }}
      onRetryLuts={() => { retriedLuts++ }}
      layers={[]}
      onToggleLayer={() => {}}
      onMoveLayer={() => {}}
      onDeleteLayer={() => {}}
      onEditLayer={() => {}}
      // ★ 2026-10-10（「我的预设」）：这一份测的是面板本体的行为（折叠 / 分组 /
      //   照着这张调），预设那一块的验收在 `App.adjust.test.tsx`（R3）——
      //   这里给个"没有、到手了"的安静底，只为满足 props 形状。
      presets={[]}
      presetsKnown
      onSavePreset={async () => {}}
      onRenamePreset={async () => {}}
      onDeletePreset={async () => {}}
    />
  )
}

async function mount(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { createRoot(container).render(node) })
  return container
}

/** 点一下 + 让 React 把状态刷完（`App.test.tsx` 里 `click` 同款）。 */
async function click(el: Element) {
  await act(async () => {
    ;(el as HTMLElement).click()
    await new Promise(r => setTimeout(r, 0))
  })
}

async function search(container: HTMLElement, text: string) {
  const input = container.querySelector('.panel-search input') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return input
}

describe('第一次调色的起点', () => {
  it('未做任何调整时给出一个短起点，开始调整后自动消失', async () => {
    const untouched = await mount(<Harness />)
    const hint = untouched.querySelector('.adjustment-start-hint')
    expect(hint?.textContent).toContain('第一次调色')
    expect(hint?.textContent).toContain('亮度、高光')
    expect(hint?.textContent).toContain('自动')

    const adjusted = await mount(<Harness initial={{ exposure: 8 }} />)
    expect(adjusted.querySelector('.adjustment-start-hint')).toBeNull()
  })
})

/** 按组标题找那一组（组数/顺序变了时，找错的组会当场红，不会静默串组）。 */
function groupOf(container: HTMLElement, title: string): HTMLElement {
  return [...container.querySelectorAll<HTMLElement>('.panel-group')]
    .find(g => g.querySelector('.panel-group-title')?.textContent === title)!
}

describe('★ 参数搜索：九十四根滑杆不用一路滚', () => {
  it('按参数名只留下包含它的组，并显示对应滑杆', async () => {
    const container = await mount(<Harness />)
    await search(container, '磨皮')
    const titles = [...container.querySelectorAll('.panel-groups .panel-group-title')]
      .map(e => e.textContent)
    expect(titles).toEqual(['效果'])
    expect(groupOf(container, '效果').querySelector('.slider-label')?.textContent)
      .not.toBe('亮度')
    expect([...groupOf(container, '效果').querySelectorAll('.slider-label')]
      .map(e => e.textContent)).toContain('磨皮')
  })

  it('按组名也能找到；清空后十三组原样回来', async () => {
    const container = await mount(<Harness />)
    const input = await search(container, '细节')
    expect([...container.querySelectorAll('.panel-groups .panel-group-title')]
      .map(e => e.textContent)).toEqual(['细节'])
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      }))
    })
    expect(input.value).toBe('')
    expect(container.querySelectorAll('.panel-groups .panel-group').length).toBe(13)
    expect(container.querySelector('.panel-search-empty')).toBeNull()
  })

  it('没有结果时明确说清，并提供清除按钮', async () => {
    const container = await mount(<Harness />)
    await search(container, '不存在的参数')
    expect(container.querySelector('.panel-groups .panel-group')).toBeNull()
    expect(container.querySelector('.panel-search-empty')?.textContent)
      .toContain('不存在的参数')
    const clear = container.querySelector('.panel-search-clear') as HTMLButtonElement
    expect(clear.getAttribute('aria-label')).toBe('清除参数搜索')
    await click(clear)
    expect((container.querySelector('.panel-search input') as HTMLInputElement).value).toBe('')
    expect(container.querySelectorAll('.panel-groups .panel-group').length).toBe(13)
  })
})

describe('面板的分组（2026-10-04）', () => {
  it('★ 颜色取样：入口只发动作，读数显示 HEX / RGB / HSL 并可复制', async () => {
    colorSampleCalls = 0
    copyColorCalls = 0
    const container = await mount(
      <Harness colorSample={{
        rgb: [18, 52, 86], hex: '#123456', hsl: [210, 65, 20],
      }} />,
    )
    const sampleButton = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '颜色取样')!
    await click(sampleButton)
    expect(colorSampleCalls).toBe(1)

    const reading = container.querySelector('[aria-label="颜色读数"]')!
    expect(reading.textContent).toContain('#123456')
    expect(reading.textContent).toContain('RGB 18 · 52 · 86')
    expect(reading.textContent).toContain('HSL 210° · 65% · 20%')
    await click(reading.querySelector('.color-sample-copy')!)
    expect(copyColorCalls).toBe(1)
  })

  it('★ 面板头的「自动」把动作交给上层（本地算法在 App 里）', async () => {
    autoCalls = 0
    const container = await mount(<Harness />)
    await click([...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '自动')!)
    expect(autoCalls).toBe(1)
  })

  it('panel recommend delegates to the app', async () => {
    recommendCalls = 0
    const container = await mount(<Harness />)
    await click([...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '推荐')!)
    expect(recommendCalls).toBe(1)
  })

  it('十三个组标题都在（光效/色彩/黑白/色彩平衡/分离色调/效果/细节/HSL/曲线/美颜/几何/镜头/镜头校正）', async () => {
    const container = await mount(<Harness />)
    // ⚠️ 数的是 **`.panel-groups` 里面**那几组（★ 2026-10-05）：从滤镜那一栏进来
    //    之后，「滤镜」也是一个 `.panel-group`（同样的折叠长相），但它是**参数组
    //    之外的**一段（设计 §5.2 有意沿用同一个语言）。不圈定范围的话，这条会
    //    把"滤镜"也算进"八组参数"里 —— 那两件事就混了。
    const titles = [...container.querySelectorAll('.panel-groups .panel-group-title')]
      .map(e => e.textContent)
    expect(titles).toEqual([
      '光效', '色彩', '黑白', '色彩平衡', '分离色调', '效果', '细节', 'HSL', '曲线', '美颜', '几何',
      '镜头', '镜头校正',
    ])
  })

  it('51 根滑块都在（36 根基础 + HSL 当前色带 3 根 + 美颜 2 根 + 几何 2 根 + 镜头 5 根 + 镜头校正 3 根）', async () => {
    const container = await mount(<Harness />)
    expect(container.querySelectorAll('.slider').length).toBe(51)
  })

  it('光效组：白色 / 黑色色阶都是 -100~100', async () => {
    const container = await mount(<Harness />)
    const group = groupOf(container, '光效')
    expect([...group.querySelectorAll('.slider-label')].map(e => e.textContent))
      .toEqual(['亮度', '对比度', '高光', '阴影', '白色色阶', '黑色色阶'])
    const inputs = [...group.querySelectorAll<HTMLInputElement>('input[type="range"]')]
    expect(inputs.slice(4).map(i => [i.min, i.max])).toEqual([
      ['-100', '100'], ['-100', '100'],
    ])
  })

  it('效果组：清晰度 / 暗角 / 磨皮 / 去雾 / HDR / 柔光，去雾 -100~100，HDR / 柔光 0~100', async () => {
    const container = await mount(<Harness />)
    const group = groupOf(container, '效果')
    expect([...group.querySelectorAll('.slider-label')].map(e => e.textContent))
      .toEqual(['清晰度', '暗角', '磨皮', '去雾', 'HDR 光比', '柔光'])
    const dehaze = [...group.querySelectorAll<HTMLInputElement>('input[type="range"]')][3]!
    expect([dehaze.min, dehaze.max]).toEqual(['-100', '100'])
    const hdr = [...group.querySelectorAll<HTMLInputElement>('input[type="range"]')][4]!
    expect([hdr.min, hdr.max]).toEqual(['0', '100'])
    const glow = [...group.querySelectorAll<HTMLInputElement>('input[type="range"]')][5]!
    expect([glow.min, glow.max]).toEqual(['0', '100'])
  })

  it('色彩组：色温与色调并排，色调也是 -100~100', async () => {
    const container = await mount(<Harness />)
    const group = groupOf(container, '色彩')
    expect([...group.querySelectorAll('.slider-label')].map(e => e.textContent))
      .toEqual(['色温', '色调', '自然饱和度', '饱和度'])
    const tint = [...group.querySelectorAll<HTMLInputElement>('input[type="range"]')][1]!
    expect([tint.min, tint.max]).toEqual(['-100', '100'])
  })

  it('白平衡预设只改色温 / 色调，保留曝光', async () => {
    const container = await mount(<Harness initial={{ exposure: 17 }} />)
    const group = groupOf(container, '色彩')
    const presets = group.querySelector('[aria-label="白平衡预设"]') as HTMLElement
    expect([...presets.querySelectorAll('button')].map(b => b.textContent?.trim()))
      .toEqual(['日光', '阴天', '阴影', '钨丝灯', '荧光灯'])

    await click([...presets.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '阴天')!)
    const valueOf = (label: string) => [...group.querySelectorAll('.slider')]
      .find(row => row.querySelector('.slider-label')?.textContent === label)
      ?.querySelector('.slider-value')?.textContent
    expect(valueOf('色温')).toBe('12')
    expect(valueOf('色调')).toBe('4')
    expect((presets.querySelector('button[aria-pressed="true"]') as HTMLButtonElement).textContent?.trim())
      .toBe('阴天')
  })

  it('黑白组：强度 0~100，红 / 绿 / 蓝混色各为 -100~100', async () => {
    const container = await mount(<Harness />)
    const group = groupOf(container, '黑白')
    expect([...group.querySelectorAll('.slider-label')].map(e => e.textContent))
      .toEqual(['黑白强度', '红色混色', '绿色混色', '蓝色混色'])
    const inputs = [...group.querySelectorAll<HTMLInputElement>('input[type="range"]')]
    expect([inputs[0]!.min, inputs[0]!.max]).toEqual(['0', '100'])
    for (const input of inputs.slice(1)) expect([input.min, input.max]).toEqual(['-100', '100'])
  })

  it('色彩平衡那组里有一个色轮 + 三根轴', async () => {
    const container = await mount(<Harness />)
    const group = groupOf(container, '色彩平衡')
    expect(group.querySelector('.color-wheel')).toBeTruthy()
    const labels = [...group.querySelectorAll('.slider-label')].map(e => e.textContent)
    expect(labels).toEqual(['青 — 红', '洋红 — 绿', '黄 — 蓝'])
  })

  it('细节组七根都在：锐化半径 / 蒙版、彩色降噪等控制齐全', async () => {
    const container = await mount(<Harness />)
    const group = groupOf(container, '细节')
    const labels = [...group.querySelectorAll('.slider-label')].map(e => e.textContent)
    expect(labels).toEqual([
      '纹理', '锐化', '锐化半径', '锐化蒙版', '降噪', '彩色降噪', '颗粒',
    ])
    const inputs = [...group.querySelectorAll<HTMLInputElement>('input[type="range"]')]
    expect([inputs[0]!.min, inputs[0]!.max]).toEqual(['-100', '100'])
    for (const input of inputs.slice(1)) {
      expect(input.min).toBe('0')
      expect(input.max).toBe('100')
    }
  })

  it('HSL 组：八个色带，切到绿带后三根滑块读的是绿色通道', async () => {
    const container = await mount(<Harness initial={{ hslGreenHue: 40 }} />)
    const group = groupOf(container, 'HSL')
    const bands = [...group.querySelectorAll<HTMLButtonElement>('.hsl-band')]
    expect(bands.map(b => b.textContent?.trim())).toEqual(['红', '橙', '黄', '绿', '青', '蓝', '紫', '洋红'])

    const green = bands.find(b => b.textContent?.trim() === '绿')!
    await click(green)
    expect(green.getAttribute('aria-pressed')).toBe('true')
    const labels = [...group.querySelectorAll('.slider-label')].map(e => e.textContent)
    expect(labels).toEqual(['色相', '饱和度', '明度'])
    const values = [...group.querySelectorAll('.slider-value')].map(e => e.textContent)
    expect(values[0]).toBe('40')
    expect(values[1]).toBe('0')
    expect(values[2]).toBe('0')
  })

  it('★ HSL 定向取色：按钮交给上层；取回蓝色后自动切到蓝带', async () => {
    hslPickCalls = 0
    const container = await mount(<Harness hslPickedBand="blue" hslPickSeq={1} />)
    const group = groupOf(container, 'HSL')
    const pick = [...group.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '从照片取色')!
    await click(pick)
    expect(hslPickCalls).toBe(1)

    const blue = [...group.querySelectorAll<HTMLButtonElement>('.hsl-band')]
      .find(b => b.getAttribute('aria-label') === '蓝色')!
    expect(blue.getAttribute('aria-pressed')).toBe('true')
  })

  it('曲线组：五个控制点可键盘调整，拉直按钮把五个点归零', async () => {
    const container = await mount(<Harness initial={{ curveMidtones: 100 }} />)
    const group = groupOf(container, '曲线')
    expect(group.querySelector('.curve-svg')).toBeTruthy()
    const points = [...group.querySelectorAll<SVGGElement>('[role="slider"]')]
    expect(points).toHaveLength(5)
    const middle = points[2]!
    expect(middle.getAttribute('aria-valuenow')).toBe('100')
    await act(async () => {
      middle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(middle.getAttribute('aria-valuenow')).toBe('98')
    await click(group.querySelector('.curve-reset')!)
    expect(middle.getAttribute('aria-valuenow')).toBe('0')
  })

  it('★ RGB 曲线：切到红色通道，拖中间点只改红色参数；切回 RGB 整体曲线不受影响', async () => {
    const container = await mount(<Harness />)
    const group = groupOf(container, '曲线')
    const channel = (name: string) => [...group.querySelectorAll<HTMLButtonElement>('.crop-chip')]
      .find(b => (b.textContent ?? '').trim() === name)!

    await click(channel('红'))
    let points = [...group.querySelectorAll<SVGGElement>('[role="slider"]')]
    expect(points.map(p => p.getAttribute('aria-label'))).toEqual([
      '红色曲线 黑场', '红色曲线 阴影', '红色曲线 中间调',
      '红色曲线 高光', '红色曲线 白场',
    ])
    const redMiddle = points[2]!
    await act(async () => {
      redMiddle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(redMiddle.getAttribute('aria-valuenow')).toBe('2')

    await click(channel('RGB'))
    points = [...group.querySelectorAll<SVGGElement>('[role="slider"]')]
    expect(points[2]!.getAttribute('aria-label')).toBe('曲线 中间调')
    expect(points[2]!.getAttribute('aria-valuenow')).toBe('0')
  })

  it('美颜组：美白 / 红润两根都是 0~100', async () => {
    const container = await mount(<Harness />)
    const group = groupOf(container, '美颜')
    expect([...group.querySelectorAll('.slider-label')].map(e => e.textContent))
      .toEqual(['美白', '红润'])
    for (const input of group.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
      expect(input.min).toBe('0')
      expect(input.max).toBe('100')
    }
  })

  it('几何组：垂直透视 / 水平透视两根都是 -100~100', async () => {
    const container = await mount(<Harness />)
    const group = groupOf(container, '几何')
    expect([...group.querySelectorAll('.slider-label')].map(e => e.textContent))
      .toEqual(['垂直透视', '水平透视'])
    for (const input of group.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
      expect(input.min).toBe('-100')
      expect(input.max).toBe('100')
    }
  })

  it('镜头组：虚化强度 0~100，清晰范围 / 过渡 / 焦点左右 / 焦点上下 -100~100', async () => {
    const container = await mount(<Harness />)
    const group = groupOf(container, '镜头')
    expect([...group.querySelectorAll('.slider-label')].map(e => e.textContent))
      .toEqual(['虚化强度', '清晰范围', '过渡', '焦点左右', '焦点上下'])
    const inputs = [...group.querySelectorAll<HTMLInputElement>('input[type="range"]')]
    expect(inputs.map(i => [i.min, i.max])).toEqual([
      ['0', '100'], ['-100', '100'], ['-100', '100'], ['-100', '100'], ['-100', '100'],
    ])
  })

  it('★ 镜头组切到移轴：隐藏焦点左右，换成角度和清晰带位置', async () => {
    const container = await mount(<Harness />)
    const group = groupOf(container, '镜头')
    const tilt = [...group.querySelectorAll('button')]
      .find(node => (node.textContent ?? '').trim() === '移轴')!
    expect(tilt).toBeTruthy()

    await click(tilt)

    expect([...group.querySelectorAll('.slider-label')].map(e => e.textContent))
      .toEqual(['虚化强度', '清晰范围', '过渡', '清晰带位置', '移轴角度'])
    expect(group.querySelector('[aria-label="虚化方式"]')?.textContent).toContain('移轴')

    const radial = [...group.querySelectorAll('button')]
      .find(node => (node.textContent ?? '').trim() === '径向')!
    await click(radial)
    expect([...group.querySelectorAll('.slider-label')].map(e => e.textContent))
      .toEqual(['虚化强度', '清晰范围', '过渡', '焦点左右', '焦点上下'])
  })

  it('镜头校正组：畸变校正 / 色差校正 / 暗角校正都从 -100 到 100', async () => {
    const container = await mount(<Harness />)
    const group = groupOf(container, '镜头校正')
    expect([...group.querySelectorAll('.slider-label')].map(e => e.textContent))
      .toEqual(['畸变校正', '色差校正', '暗角校正'])
    const inputs = [...group.querySelectorAll<HTMLInputElement>('input[type="range"]')]
    expect(inputs.map(i => [i.min, i.max])).toEqual([
      ['-100', '100'], ['-100', '100'], ['-100', '100'],
    ])
  })

  /**
   * ★ 2026-10-05：`defaultLutOpen` —— 从「滤镜」那一页按「去套在照片上」过来时，
   * 面板里那一栏**进来就该是开着的**。
   *
   * 为什么值得一条测试：这一栏的默认是"收着"（spec §8.3 用户原话「不要写个名字
   * 显示出来占空间」），所以"传进来的那个 true 有没有接上"只看代码是看不出来的
   * —— 两条路长得一模一样，差别只在**用户落地那一刻**。写反/漏掉的表现正是
   * 用户刚抱怨的那件事：人到了，东西还得自己再找一遍。
   */
  it('★ defaultLutOpen：传 true 时进来就是展开的（默认仍然收着）', async () => {
    // ⚠️ 判据是 `.lut-picker` 在不在 —— 它**只在那一栏开着时**渲染。
    //    别改成 `.lut-grid`：那是"格子"那一层，一个滤镜都没有时这一栏也开着
    //    （显示的是「还没有导入过 Lut。」），两个形状在这条测试里长得不一样。
    const open = await mount(<Harness lutOpen />)
    expect(open.querySelector('.lut-picker')).not.toBeNull()

    const shut = await mount(<Harness />)
    expect(shut.querySelector('.lut-picker')).toBeNull()
  })

  it('★ 点组标题 → 收起；再点 → 展开', async () => {
    const container = await mount(<Harness />)
    // ⚠️ **第一颗** `.panel-group-head` 现在可能是「滤镜」那一栏（★ 2026-10-05：
    //    它排在参数组前面）—— 圈定在 `.panel-groups` 里，这条才对得上"点参数组标题"。
    const head = container.querySelector('.panel-groups .panel-group-head')!
    const before = container.querySelectorAll('.slider').length
    await click(head)
    expect(container.querySelectorAll('.slider').length).toBeLessThan(before)
    await click(head)
    expect(container.querySelectorAll('.slider').length).toBe(before)
  })

  it('★ 分组重置：只清当前组，别的组原样保留', async () => {
    const container = await mount(<Harness initial={{ exposure: 17, contrast: 12, saturation: 33 }} />)
    const reset = container.querySelector('[aria-label="重置光效"]') as HTMLButtonElement
    expect(reset).toBeTruthy()
    await click(reset)

    const valueOf = (label: string) => [...container.querySelectorAll('.slider')]
      .find(row => row.querySelector('.slider-label')?.textContent === label)
      ?.querySelector('.slider-value')?.textContent
    expect(valueOf('亮度')).toBe('0')
    expect(valueOf('对比度')).toBe('0')
    expect(valueOf('饱和度')).toBe('33')
    expect(container.querySelector('[aria-label="重置光效"]')).toBeNull()
    expect(container.querySelector('[aria-label="重置色彩"]')).toBeTruthy()
  })

  it('★ 短手机视口默认先收起面板；展开、再收起时参数和入口都还在', async () => {
    const oldWidth = window.innerWidth
    const oldHeight = window.innerHeight
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 664 })
    try {
      const container = await mount(<Harness initial={{ exposure: 17 }} />)
      const toggle = () => container.querySelector<HTMLButtonElement>('.panel-collapse-toggle')!
      const content = () => container.querySelector<HTMLElement>('#adjustment-panel-content')!

      expect(toggle().getAttribute('aria-expanded')).toBe('false')
      expect(toggle().getAttribute('aria-label')).toBe('展开调色参数')
      expect(container.querySelector('.panel')?.classList.contains('panel-collapsed')).toBe(true)
      expect(content()).toBeTruthy()

      await click(toggle())
      expect(container.querySelector('.panel')?.classList.contains('panel-collapsed')).toBe(false)
      expect(toggle().getAttribute('aria-expanded')).toBe('true')
      expect(toggle().getAttribute('aria-label')).toBe('收起调色面板')
      expect(container.querySelectorAll('.panel-group').length).toBeGreaterThan(10)

      await click(toggle())
      expect(container.querySelector('.panel')?.classList.contains('panel-collapsed')).toBe(true)
      expect(toggle().getAttribute('aria-expanded')).toBe('false')
      expect(toggle().getAttribute('aria-label')).toBe('展开调色参数')
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: oldWidth })
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: oldHeight })
    }
  })

  it('色彩分级六根：高光 / 阴影 / 中间调三色相、两组强度与明暗平衡', async () => {
    const container = await mount(<Harness />)
    const group = groupOf(container, '分离色调')
    expect([...group.querySelectorAll('.slider-label')].map(e => e.textContent))
      .toEqual([
        '亮部颜色', '暗部颜色', '强度',
        '中间调颜色', '中间调强度', '明暗平衡',
      ])
    const ranges = [...group.querySelectorAll<HTMLInputElement>('input[type=range]')]
      .map(i => [i.min, i.max])
    expect(ranges).toEqual([
      ['0', '360'], ['0', '360'], ['0', '100'],
      ['0', '360'], ['0', '100'], ['-100', '100'],
    ])
  })

  /**
   * ★ 2026-10-05：原来这里有一条「套一个预设 → 新参数一并归零」（点面板上那排
   * 药丸，看色轮回中心）。**那排药丸搬去照片左边的预设栏了**（`PresetRail`），
   * 面板里不再有预设入口，所以这条测试跟着搬走 —— 它的两半现在住在这儿：
   *   · "每个预设都是 `{...ZERO, …}` 的长拷贝、五十个键一个不缺"
   *     → `core/presets.test.ts`（字段完整性那条）；
   *   · "点一下 = **整组赋值**，不是往当前参数上叠"
   *     → `App.test.tsx`「只动参数（不推快照、不说话）也要落盘」那条
   *       （它现在断言 `after.params` 与预设**全等**）。
   */
})

/**
 * ★ 2026-10-05（用户：「这个用户应该有两个来源，一个是以往作品效果，一个是本地照片」）：
 * 「照着这张调」展开成**两个来源**。
 *
 * 这一层只测**面板交了什么货**（本地 File / 选中作品的 `WorkMeta`）—— 取图字节、
 * 解码、拟合都在 App 那边；真链路（含 fetch 取图 → 合流）在 `App.test.tsx`。
 */
describe('「照着这张调」的两个来源（2026-10-05）', () => {
  const W = (id: number, updatedAt = 1): WorkMeta =>
    ({ id, alias: null, createdAt: 1, updatedAt, bytes: 1, hasThumb: true, rating: 0, flag: 0 })

  beforeEach(() => {
    listWorksMock.mockReset()
    listWorksMock.mockResolvedValue([])   // 默认拉到空清单；各用例按需覆盖
    matchedRef = null
    matchedWork = null
  })

  /** 点大按钮 = 展开（或收起）两个来源。 */
  const openSources = (container: HTMLElement) =>
    click(container.querySelector('.presets-ref')!)
  /** 第 0 行 = 「从我的作品里选」，第 1 行 = 「从电脑里选」（DOM 顺序即界面顺序）。 */
  const sourceAt = (container: HTMLElement, i: number) =>
    [...container.querySelectorAll('.presets-source')][i]!

  it('点大按钮 → 展开「从我的作品里选 / 从电脑里选」；再点 → 收起', async () => {
    const container = await mount(<Harness />)
    expect(container.querySelector('.presets-sources')).toBeNull()
    await openSources(container)
    expect([...container.querySelectorAll('.presets-source')].map(e => e.textContent))
      .toEqual(['从我的作品里选', '从电脑里选'])
    await openSources(container)
    expect(container.querySelector('.presets-sources')).toBeNull()
  })

  it('★ 点「从电脑里选」→ 触发了那个隐藏的 file input（老路一寸没动）', async () => {
    const container = await mount(<Harness />)
    await openSources(container)
    const input = container.querySelector('input.presets-ref-file')!
    let clicks = 0
    input.addEventListener('click', () => { clicks++ })
    await click(sourceAt(container, 1))
    expect(clicks).toBe(1)
  })

  it('点「从我的作品里选」→ 拉清单 → 网格按清单顺序摆缩略图（网址带版本号）', async () => {
    listWorksMock.mockResolvedValueOnce([W(3), W(5, 9)])
    const container = await mount(<Harness />)
    await openSources(container)
    await click(sourceAt(container, 0))
    const srcs = [...container.querySelectorAll('.presets-work-thumb')]
      .map(i => i.getAttribute('src'))
    expect(srcs).toEqual(['/api/works/3/thumb?v=1', '/api/works/5/thumb?v=9'])
  })

  it('★ 点一张作品 → 面板把**那一张**的元数据交出去，展开区收起', async () => {
    listWorksMock.mockResolvedValueOnce([W(3), W(5)])
    const container = await mount(<Harness />)
    await openSources(container)
    await click(sourceAt(container, 0))
    await click([...container.querySelectorAll('.presets-work')][1]!)   // 第二张 = id 5
    expect(matchedWork?.id).toBe(5)
    expect(container.querySelector('.presets-sources')).toBeNull()
  })

  it('清单拉失败 → 说一句能照着做的（不静默）；再点一下**当场重拉**（不是收起）', async () => {
    listWorksMock.mockRejectedValueOnce(new Error('boom'))
    const container = await mount(<Harness />)
    await openSources(container)
    await click(sourceAt(container, 0))
    expect(container.querySelector('.presets-works-note')?.textContent).toContain('没取到作品清单')
    // 再点一次 —— 文案说的"再点一下试试"必须真的重拉（这次让它成功）
    listWorksMock.mockResolvedValueOnce([W(3)])
    await click(sourceAt(container, 0))
    expect(container.querySelectorAll('.presets-work')).toHaveLength(1)
  })

  it('真的拉到空清单 → 「还没有存过作品」并指向另一条路（不拿 0 顶"还没拉到"）', async () => {
    const container = await mount(<Harness />)
    await openSources(container)
    await click(sourceAt(container, 0))
    const note = container.querySelector('.presets-works-note')?.textContent ?? ''
    expect(note).toContain('还没有存过作品')
    expect(note).toContain('从电脑里选')
  })

  it('选完本地文件 → 文件交出去、展开区收起（挑好了 = 这个动作做完了）', async () => {
    const container = await mount(<Harness />)
    await openSources(container)
    const input = container.querySelector('input.presets-ref-file') as HTMLInputElement
    const file = new File(['x'], 'r.jpg', { type: 'image/jpeg' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(matchedRef).toBe(file)
    expect(container.querySelector('.presets-sources')).toBeNull()
  })
})

/**
 * ★ 2026-10-05（滤镜，设计 §5.2）：微调区那一栏。
 *
 * 这一层只测**面板自己管得着的那几件事**：默认收着、**点开才去要缩略图**
 * （每个滤镜都要拿当前照片重画一张，很贵）、以及"点下去交出去的是什么"。
 * 清单怎么来、cube 怎么解析、选完怎么落盘，全在 App 那一层
 * （`App.test.tsx` 的「滤镜」那一组）。
 */
describe('滤镜那一栏（2026-10-05）', () => {
  const LUT: LutMeta = { id: 1, name: '黄昏', size: 2, bytes: 100, createdAt: 0 }
  /** 「滤镜」那个组头（按文字找 —— 位置是排版的事）。 */
  const headOf = (c: HTMLElement) =>
    [...c.querySelectorAll<HTMLElement>('.panel-group-head')]
      .find(b => (b.textContent ?? '').includes('Lut'))!

  beforeEach(() => {
    lutsFromTest = []
    lutsKnownFromTest = true
    lutFromTest = null
    lutThumbsFromTest = { none: null, byId: {} }
    needThumbsCalls = 0
    pickedLut = 'x'
    wentImport = false
    retriedLuts = 0
  })

  it('★ 默认收着 —— 而且**收着的时候一次缩略图都不去要**', async () => {
    lutsFromTest = [LUT]
    const c = await mount(<Harness />)
    // 默认收着（spec §8.3：用户原话「不要写个名字显示出来占空间」）
    expect(c.querySelector('.lut-tile')).toBeNull()
    // 没用滤镜 → 标题不点亮（点亮那个类名是"正在用"的信号）
    expect(headOf(c).className).not.toContain('on')
    // ⚠️ 这一句才是这条用例的重点：每张缩略图 = 用当前照片 + 当前参数重画一遍。
    //    收着的时候白画一遍，用户看不见、也没人会报错。
    expect(needThumbsCalls).toBe(0)

    await click(headOf(c))
    expect(c.querySelectorAll('.lut-tile')).toHaveLength(2)   // 「不用」+ 黄昏
    expect(needThumbsCalls).toBe(1)
  })

  /**
   * ★ 2026-10-05 **真机抓到的那条**：那一栏开着的时候**清单变了，要再要一次**。
   *
   * 场景正是新开的那条路走出来的：在「滤镜」那一页导完一个、按「去调色里套一张」
   * 过来 —— 面板挂载那一刻，App 手上那份清单**还是旧的（空的）**（它要等"离开
   * 那一页"才重拉）。只在"打开那一刻"叫一次的话，这一次一条都画不出来，而
   * **没有任何东西会再叫第二次**：用户看到一栏开着、格子里全是灰方块，永远不变
   * （真机探针量到的：2 格只有 1 张图）。
   */
  it('★ 开着的时候清单变了（导完就过来那一瞬间）→ 再要一次缩略图', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    // 挂载那一刻手上是**空**清单 —— 就是 bug 的现场
    await act(async () => { root.render(<Harness lutOpen luts={[]} />) })
    expect(needThumbsCalls).toBe(0)     // 空清单时不叫：那时这一栏没有格子要画

    // 清单到手 → 再要一次，格子才有图
    await act(async () => { root.render(<Harness lutOpen luts={[LUT]} />) })
    expect(needThumbsCalls).toBe(1)
    expect(container.querySelectorAll('.lut-tile')).toHaveLength(2)
  })

  it('在用滤镜 → 标题点亮（`.on`）', async () => {
    lutsFromTest = [LUT]
    lutFromTest = { lutId: 1, amount: 80 }
    const c = await mount(<Harness />)
    expect(headOf(c).className).toContain('on')
  })

  it('点格子 → 交出去的是那个 id；点「不用」→ null', async () => {
    lutsFromTest = [LUT]
    const c = await mount(<Harness />)
    await click(headOf(c))
    const tiles = [...c.querySelectorAll<HTMLButtonElement>('.lut-tile')]
    await click(tiles[1]!)                    // 黄昏
    expect(pickedLut).toBe(1)
    await click(tiles[0]!)                    // 不用
    expect(pickedLut).toBeNull()
  })

  it('一个滤镜都没有 → 「去导入」把这件事交出去（去设置里那一页）', async () => {
    const c = await mount(<Harness />)
    await click(headOf(c))
    expect(c.textContent).toContain('还没有导入过 Lut')
    await click(c.querySelector('.lut-import-go')!)
    expect(wentImport).toBe(true)
  })

  it('★ 清单还没到手 → 不摆「还没有导入过 Lut」，摆的是「再试一次」（那块口子接得上）', async () => {
    // 终审修复：这句**关于用户资产**的话只许在"服务端真的回了空清单"时说 ——
    // 这一层钉的是"面板把 `lutsKnown` 一路传到了格子上"（App 那一侧在
    // `App.test.tsx` 的「清单取不到」那条里演）。
    lutsKnownFromTest = false
    const c = await mount(<Harness />)
    await click(headOf(c))
    expect(c.textContent).not.toContain('还没有导入过 Lut')
    expect(c.textContent).toContain('还没到手')
    await click(c.querySelector('.lut-import-go')!)
    expect(retriedLuts).toBe(1)
    expect(wentImport).toBe(false)        // 这一颗不是「去导入」—— 用户该做的不是再导一个
  })
})
