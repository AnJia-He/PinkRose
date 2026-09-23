# 交互完善（计划三）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让对话式修图那条链路「看得见、能对比、卡住时能指位置」—— 补上 spec 里
还没做的三样：历史缩略图、按住看原图、图上点选消歧。

**Architecture:** 三样都挂在已有的 `history`（快照列表）和 `Canvas` 上，**不改后端**。
缩略图存成 **data URL 字符串**（不是位图 —— 位图占 GPU 内存，字符串不占）。
「按住看原图」不重新上传原图纹理，改用一张上传时预先备好的长边 1280 预览盖上去。
「图上点选」的红圈是普通 DOM 元素；送模型时另画一份到图里。

**Tech Stack:** React 18 + TypeScript、WebGL2（已有）、vitest（node 跑纯函数 /
jsdom 跑 App 层）、Playwright（`npm run check:layout`，只验排版）

**Spec:** `docs/superpowers/specs/2026-09-21-ruixing-conversational-editing-design.md`
§2.4（撤销 = 翻聊天记录）、§2.5（对比原图）、§6.3（歧义处理）

## Global Constraints

以下每一条对**每个任务**都成立，不再逐条重复：

- **铁律：参数绝不烘进 `base`。** 参数只在最终渲染时应用（spec §3.5）。
- **位图占的是 GPU 内存。** 不再用的必须 `close()`；还在用的一张都不能关。
- **「调色不缩图」在 2026-09-23 修订后仍生效**：只在**设备真画不动**时才缩，
  缩了必须明说（spec §4.4）。
- **测试命令**：`npm test`（全量）、`npx vitest run <file>`（单个）。
  纯逻辑放 `environment: node`（默认），碰 DOM 的加 `// @vitest-environment jsdom`。
- **每个任务收尾必须**：`npm test` 全绿 + `npm run typecheck` 干净。
- **改动排版（`styles.css`）之后必须**跑 `npm run check:layout`（dev 服务器开着）。
- **提交前必须确认 `.env` 没被暂存**（`git diff --cached --name-only` 里不许出现它）。
- **中文注释、叙述式提交信息**，与既有风格一致。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/core/history.ts` | 快照列表的纯函数 | 改：`Snapshot` 加 `thumb`；加 `attachThumb` |
| `src/core/thumbnail.ts` | 位图/画布 → 缩略图 data URL | **新建** |
| `src/image/mark.ts` | 把红圈画进图里（送模型用） | **新建** |
| `src/ui/Canvas.tsx` | 画布本体：原图预览覆盖、点选、红圈 | 改 |
| `src/ui/ChatPanel.tsx` | 对话：缩略图、「就改这里」 | 改 |
| `src/App.tsx` | 编排三样 | 改 |
| `src/styles.css` | 缩略图 / 覆盖层 / 红圈的样式 | 改 |

**为什么不把 `makeThumbnail` 放进 `image/`**：它服务的不是"处理用户照片"，
而是"给对话做一张看得懂的小图"，跟 `history` 是一件事。放 `core/`。

---

### Task 1: 快照带上缩略图字段（纯逻辑）

**Files:**
- Modify: `src/core/history.ts`
- Test: `src/core/history.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type Snapshot` 增加字段 `thumb: string`（data URL；空串 = 还没生成）
  - `function attachThumb(list: readonly Snapshot[], id: number, thumb: string): Snapshot[]`

- [ ] **Step 1: 写失败的测试**

在 `src/core/history.test.ts` 末尾追加：

```ts
describe('attachThumb', () => {
  const snap = (id: number, thumb = ''): Snapshot =>
    ({ id, label: `${id}`, base: fakeBitmap(`${id}`), params: ZERO, isOriginal: id === 1, thumb })

  it('把缩略图挂到指定那一步上', () => {
    const list = [snap(1), snap(2), snap(3)]
    const next = attachThumb(list, 2, 'data:image/jpeg;base64,AAA')
    expect(next[1].thumb).toBe('data:image/jpeg;base64,AAA')
    // 别的不能动 —— 挂错行等于给用户看错图
    expect(next[0].thumb).toBe('')
    expect(next[2].thumb).toBe('')
  })

  it('不改入参', () => {
    // 这个项目里出现过一次「函数悄悄改了传进来的数组」。
    // 纯函数是这个模块存在的意义，必须钉住。
    const list = [snap(1)]
    attachThumb(list, 1, 'x')
    expect(list[0].thumb).toBe('')
  })

  it('找不到那个 id 时原样返回一份拷贝', () => {
    const list = [snap(1)]
    const next = attachThumb(list, 99, 'x')
    expect(next).toEqual(list)
    expect(next).not.toBe(list)
  })
})
```

补 import：`attachThumb` 从 `./history` 引入；`ZERO` 从 `../../shared/adjustments.ts` 引入。

- [ ] **Step 2: 跑测试，确认它红**

Run: `npx vitest run src/core/history.test.ts`
Expected: FAIL —— `attachThumb is not a function`（且 `Snapshot` 上报 `thumb` 不存在）

- [ ] **Step 3: 实现**

`src/core/history.ts`：给 `Snapshot` 加字段

```ts
export type Snapshot = {
  /** 与聊天记录里那条助手消息同 id —— 「回到这一步」按钮靠它对上号。 */
  id: number
  /** 给用户看的短标签，比如"原图"。 */
  label: string
  base: DecodedImage
  params: Adjustments
  /** 原图。这一条永远不会被挤出去。 */
  isOriginal: boolean
  /**
   * 这一步长什么样的缩略图（data URL）。**空串 = 还没生成**。
   *
   * 为什么是字符串不是位图：位图占 GPU 内存，一步一张、最多六步，
   * 而缩略图的价值远不值那个代价。一张 data URL 约 5~10 KB，普通内存。
   *
   * 为什么会有"还没生成"这个中间态：快照是在 `setParams` / `setImage`
   * **同一个批次**里推入的，而那一刻画布还没重画（React 的状态更新是异步的）。
   * 直接抓会抓到**上一步的颜色**。所以先推空，等画面更新后由 App 补上
   * （见 src/App.tsx 里那个 effect）。
   */
  thumb: string
}

/**
 * 给某一步补上缩略图。纯函数，不改入参。
 *
 * 找不到那个 id 时返回一份拷贝 —— 不做任何事，但也不让调用方拿到同一个引用，
 * 免得 React 以为状态变了。
 */
export function attachThumb(
  list: readonly Snapshot[], id: number, thumb: string,
): Snapshot[] {
  return list.map(s => (s.id === id ? { ...s, thumb } : s))
}
```

- [ ] **Step 4: 跑测试，确认它绿**

Run: `npx vitest run src/core/history.test.ts`
Expected: PASS。**同时 `npm run typecheck` 会报错** —— 因为别处构造 `Snapshot`
时没给 `thumb`。先别管，Step 5 一次修完。

- [ ] **Step 5: 把三个构造点补上 `thumb: ''`**

`npm run typecheck` 会指出所有位置。预期是这两处：

- `src/App.tsx`：`setHistory([{ id: welcomeId, label: '原图', base: img, params: ZERO, isOriginal: true }])`
  改成多一行 `thumb: ''`
- `src/App.tsx` 的 `runGenerate` 里 `pushSnapshot(prev, {...})` 同样加 `thumb: ''`

Run: `npm run typecheck` + `npm test`
Expected: 都干净。

- [ ] **Step 6: 提交**

```bash
git add src/core/history.ts src/core/history.test.ts src/App.tsx
git commit -m "feat(history): 快照带上缩略图字段（先存字符串，位图太贵）"
```

---

### Task 2: 缩略图真的生成出来，并挂进对话

**Files:**
- Create: `src/core/thumbnail.ts`
- Modify: `src/App.tsx`、`src/ui/ChatPanel.tsx`、`src/styles.css`
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: `attachThumb`（Task 1）、`Sizable`（`src/image/prepare.ts` 已有）
- Produces:
  - `const THUMB_MAX_SIDE = 160`
  - `function makeThumbnail(source: Sizable, maxSide?: number): string`
  - `ChatPanel` 新 prop：`thumbs: Record<number, string>`

- [ ] **Step 1: 写失败的测试**

在 `src/App.test.tsx` 里加 mock（放在已有的 `vi.mock('./export/save', ...)` 后面）：

```tsx
/** 缩略图要 2D 画布，jsdom 没有。**返回画布上"此刻是什么颜色"** ——
 *  这样才测得出「缩略图是在画面更新之后才抓的」那件事。 */
vi.mock('./core/thumbnail', () => ({ makeThumbnail: vi.fn(), THUMB_MAX_SIDE: 160 }))
```

补 import：`import * as thumbMod from './core/thumbnail'`

`beforeEach` 里加默认实现：

```tsx
  // ★ 假的缩略图 = **画布上此刻记着的那个参数**。
  //   Canvas 的 mock 每次渲染都会把当前 params 写在 data-rendered 上，
  //   所以这里拿到的就是"抓缩略图那一刻，画布显示的是哪一步"。
  vi.mocked(thumbMod.makeThumbnail).mockImplementation(
    (src: unknown) => `thumb:${(src as HTMLElement).dataset.rendered ?? '还没画'}`)
```

把 `./ui/Canvas` 的 mock 改成会记录渲染状态：

```tsx
vi.mock('./ui/Canvas', async () => {
  const React = await import('react')
  return {
    default: ({ canvasRef, image, params, originalPreview, picking, marker, onPickPoint }: any) => {
      canvasProps.images.push(image)
      canvasProps.props.push({ originalPreview, picking, marker })
      return React.createElement('canvas', {
        ref: (node: HTMLElement | null) => {
          canvasRef.current = node
          // 模拟"渲染过了"：把当前参数写在节点上，缩略图能读到
          if (node) node.dataset.rendered = JSON.stringify(params)
        },
        onClick: () => onPickPoint && onPickPoint(0.5, 0.5),
      })
    },
  }
})
```

把 `canvasProps` 扩成两个数组：

```tsx
const canvasProps = vi.hoisted(() => ({
  images: [] as { width: number; height: number }[],
  props: [] as { originalPreview: string | null; picking: boolean; marker: unknown }[],
}))
```

并在 `beforeEach` 里 `canvasProps.props.length = 0`。

新增测试块：

```tsx
/**
 * 2026-09-23 加。用户说过「对话的交付物看不到图片」—— 当时根子是版面把画布
 * 挤没了（见验收记录 §15），修好之后仍然值得把每一步的画面挂进对话里：
 * 它是「撤销」的入口（spec §2.4：不设撤销按钮，翻聊天记录就是撤销）。
 */
describe('历史缩略图：每一步都看得见', () => {
  /** 从对话里读某条助手消息挂的缩略图 */
  function thumbOf(index: number): string | null {
    const imgs = container.querySelectorAll<HTMLImageElement>('.bubble-thumb')
    return imgs[index]?.getAttribute('src') ?? null
  }

  it('传完照片，欢迎语那条上挂一张缩略图', async () => {
    await renderApp()
    await uploadPhoto()
    expect(thumbOf(0)).toBe('thumb:' + JSON.stringify(ZERO))
  })

  it('⚠️ 缩略图必须是**画面画完之后**抓的，不能是上一步的颜色', async () => {
    // 这条是整件事最容易错的地方。快照是在 setParams 的同一个批次里推入的，
    // 那一刻画布还没重画 —— 谁要是"推快照的时候顺手抓一张"，抓到的就是
    // **上一步的颜色**，而用户看到的缩略图和他点进去的画面**对不上**。
    //
    // 原理：假的 makeThumbnail 返回画布节点上记着的 params。
    // 抓早了 → 拿到上一步的 → 这条红。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'params', paramDeltas: { exposure: 40 }, reply: '提亮了。' }))

    await renderApp()
    await uploadPhoto()
    await say('亮一点')

    expect(thumbOf(1)).toBe('thumb:' + JSON.stringify({ ...ZERO, exposure: 40 }))
  })

  it('没改图的那些助手消息不挂缩略图', async () => {
    // 「我不太确定你指的是哪个」这种消息后面没有新的一步，不该挂图 ——
    // 挂了会让用户以为那一步真的改了什么。
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉那个人', needsDisambiguation: true }))

    await renderApp()
    await uploadPhoto()
    await say('把那个去掉')

    expect(container.querySelectorAll('.bubble-thumb')).toHaveLength(1)  // 只有原图那张
  })
})
```

- [ ] **Step 2: 跑测试，确认它红**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL —— 找不到 `.bubble-thumb`

- [ ] **Step 3: 实现 `makeThumbnail`**

`src/core/thumbnail.ts`：

```ts
import { fitWithin } from '../../shared/size.ts'
import type { Sizable } from '../image/prepare'

/** 对话里那张小图的边长上限。160 够看清"天蓝了没有"，再大就只是浪费内存。 */
export const THUMB_MAX_SIDE = 160

/**
 * 把一张图/画布缩成一张小图，返回 data URL。
 *
 * **返回字符串而不是位图**：位图占 GPU 内存（这个项目为此写过好几个
 * `bitmapsToClose` 的注释），而对话里最多六张缩略图，为它们占六份 GPU 内存
 * 完全不值。data URL 是普通内存，一张约 5~10 KB。
 *
 * 用 JPEG 0.7：缩略图看的是"大概长什么样"，不是细节。
 * 带 alpha 的图会变黑底，但我们的图都是照片，没有透明通道。
 *
 * ⚠️ 调用时机很要紧：**必须在画面真的更新之后**再抓。详见 Snapshot.thumb 的注释。
 */
export function makeThumbnail(source: Sizable, maxSide = THUMB_MAX_SIDE): string {
  const { width, height } = fitWithin(source.width, source.height, maxSide)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })
  if (!ctx) throw new Error('拿不到 2D 上下文，做不了缩略图')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.7)
}
```

- [ ] **Step 4: 在 App 里推空 + 补图**

`src/App.tsx`：

1. import：`import { makeThumbnail } from './core/thumbnail'`、
   `import { attachThumb, ... } from './core/history'`

2. 两个构造点已经是 `thumb: ''`（Task 1 Step 5 加的）。

3. 在 `onSave` / `deliver` 附近（任何位置都行，但要在 `canvasElRef` 之后）加这个 effect：

```tsx
  /**
   * 给刚推入的那一步补缩略图。
   *
   * **为什么不在推快照的地方直接抓**：快照是和 `setParams` / `setImage`
   * 同一个批次推入的，那一刻画布还没重画 —— 抓到的会是**上一步的颜色**，
   * 用户看到的小图和点进去的画面就对不上了。
   *
   * 这个 effect 跑在 Canvas 的渲染 effect **之后**（React 的被动 effect
   * 是子先父后），所以它看到的画布已经是这一步的样子了。
   */
  useEffect(() => {
    const canvas = canvasElRef.current
    if (!canvas || history.length === 0) return
    const last = history[history.length - 1]
    if (last.thumb) return           // 已经有了，别重复抓（也防止这个 effect 打转）
    try {
      setHistory(h => attachThumb(h, last.id, makeThumbnail(canvas)))
    } catch (e) {
      // 缩略图是锦上添花的东西，抓不到不该影响用户修图
      console.error('缩略图生成失败（不影响修图）', e)
    }
  }, [history])
```

4. 把缩略图传给对话面板。在 `ChatPanel` 的调用处加：

```tsx
          <ChatPanel
            ...
            thumbs={Object.fromEntries(history.map(s => [s.id, s.thumb]))}
          />
```

- [ ] **Step 5: ChatPanel 把图显示出来**

`src/ui/ChatPanel.tsx`：`Props` 加一行

```ts
  /** 每一步的缩略图，键是消息 id。空串 = 还没生成。 */
  thumbs: Record<number, string>
```

解构里加 `thumbs`。气泡里，原「回到这一步」按钮的**上方**插入：

```tsx
            {m.role === 'assistant' && thumbs[m.id] && (
              <img
                className="bubble-thumb"
                src={thumbs[m.id]}
                alt="这一步的效果"
                onClick={() => jumpableIds.includes(m.id) && onJump(m.id)}
              />
            )}
```

- [ ] **Step 6: 样式**

`src/styles.css` 追加：

```css
/* 对话里每一步的小图。点它 = 点「回到这一步」—— spec §2.4：
   「不设撤销按钮，翻聊天记录就是撤销」。所以它是可点的，给个手型。 */
.bubble-thumb {
  display: block;
  width: 120px;
  max-width: 100%;
  border-radius: 8px;
  margin-bottom: 6px;
  cursor: pointer;
  border: 1px solid #3a4048;
}
.bubble-thumb:hover { border-color: var(--accent); }
```

- [ ] **Step 7: 跑测试，确认它绿**

Run: `npx vitest run src/App.test.tsx` + `npm test` + `npm run typecheck`
Expected: 全绿

- [ ] **Step 8: 排版检查**

Run: `npm run build && npm run check:layout`
（`check:layout` 量的是预览版；改了 `styles.css` 必须重新 build）
Expected: ✅ 两档都过（新加的 120px 小图在 390px 手机上不该挤出横向滚动）

- [ ] **Step 9: 提交**

```bash
git add src/core/thumbnail.ts src/ui/ChatPanel.tsx src/App.tsx src/App.test.tsx src/styles.css
git commit -m "feat(chat): 每一步挂一张缩略图 —— 翻聊天记录就是撤销"
```

---

### Task 3: 按住图看原图

**Files:**
- Modify: `src/App.tsx`、`src/ui/Canvas.tsx`、`src/styles.css`
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: `makeThumbnail`（Task 2）
- Produces:
  - `const ORIGINAL_PREVIEW_MAX_SIDE = 1280`
  - `Canvas` 新 prop：`originalPreview: string | null`

**为什么预先备一张预览，而不是按住时把原图塞进 GPU**：
原图可能是 3000 万像素，重新上传一次纹理要几百毫秒、还要一份极大的显存。
而"看原图"永远是在**屏幕大小**上比的 —— 1280 长边绰绰有余，视觉上看不出区别。

- [ ] **Step 1: 写失败的测试**

`src/App.test.tsx` 新增：

```tsx
/**
 * spec §2.5：「按住图 = 看原图，松手回来。跟 Instagram、美图一致，
 * 不要发明新交互。」
 *
 * 手机上有一个必须先挡掉的东西：**长按会弹出系统的"保存图片/复制"菜单**，
 * 跟我们要做的事直接打架。这条靠 CSS（见 styles.css 里那条注释），
 * 测试测不到，但真机验收要专门试一次。
 */
describe('按住看原图', () => {
  it('传完照片就备好了一张原图预览', async () => {
    await renderApp()
    await uploadPhoto()
    // 用 1280 抓的，不是 160（那是对话里的小图）
    expect(thumbMod.makeThumbnail).toHaveBeenCalledWith(
      expect.anything(), 1280)
    expect(canvasProps.props.at(-1)?.originalPreview).toContain('thumb:')
  })

  it('没传照片时没有原图预览', async () => {
    await renderApp()
    expect(canvasProps.props).toHaveLength(0)   // 画布还没渲染
  })

  it('原图预览变了之后，画布也跟着换', async () => {
    await renderApp()
    await uploadPhoto()
    const first = canvasProps.props.at(-1)?.originalPreview
    expect(first).toBeTruthy()
    await uploadPhoto()      // 再传一张
    expect(canvasProps.props.at(-1)?.originalPreview).toBeTruthy()
  })
})
```

- [ ] **Step 2: 跑测试，确认它红**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL —— `makeThumbnail` 没被用 1280 调过，`originalPreview` 是 `undefined`

- [ ] **Step 3: App 里备好预览**

`src/App.tsx`：

```tsx
/** 「按住看原图」那张预览的边长上限。
 *  不直接拿原图：3000 万像素重新上传一次纹理很贵，而"看原图"永远是在
 *  屏幕大小上比的，1280 已经看不出和原图的差别。 */
const ORIGINAL_PREVIEW_MAX_SIDE = 1280
```

新增 state：

```tsx
  /** 「按住看原图」用的预览图（data URL）。没照片时是 null。 */
  const [originalPreview, setOriginalPreview] = useState<string | null>(null)
```

`onPick` 里，`setImage(img)` 之后：

```tsx
      // 备用一张原图预览（spec §2.5 的"按住看原图"）。用刚解码出来的位图，
      // 不是画布 —— 这时候画布上还什么都没有。
      setOriginalPreview(makeThumbnail(img.bitmap, ORIGINAL_PREVIEW_MAX_SIDE))
```

- [ ] **Step 4: Canvas 接住并显示**

`src/ui/Canvas.tsx`：`Props` 加

```ts
  /** 「按住看原图」用的预览（data URL）。null = 没有，按钮就不响应。 */
  originalPreview: string | null
```

组件签名加 `originalPreview`，加 state 与处理：

```tsx
  const [peeking, setPeeking] = useState(false)
  ...
  <div className="canvas-wrap"
    onPointerDown={() => originalPreview && setPeeking(true)}
    onPointerUp={() => setPeeking(false)}
    onPointerCancel={() => setPeeking(false)}
    onPointerLeave={() => setPeeking(false)}
  >
    <canvas ref={...} className="canvas" />
    {peeking && originalPreview && (
      <img className="canvas-peek" src={originalPreview} alt="原图" draggable={false} />
    )}
  </div>
```

（`canvasRef` 仍然只挂在那张 `<canvas>` 上 —— 导出读的是它。）

- [ ] **Step 5: 样式（含手机上那个必须挡的坑）**

`src/styles.css` 追加：

```css
.canvas-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  /* ⚠️ 这两行在手机上不是可选的：长按图片会弹出系统的「保存图片 / 复制」
     菜单，跟"按住看原图"直接打架。桌面浏览器看不出区别，只有真机会。 */
  -webkit-touch-callout: none;
  user-select: none;
}
.canvas-peek {
  position: absolute;
  inset: 0;
  margin: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 8px;
}
```

- [ ] **Step 6: 跑测试 + 排版检查**

Run: `npx vitest run src/App.test.tsx` + `npm test` + `npm run typecheck`
Run: `npm run build && npm run check:layout`
Expected: 全绿 / ✅

- [ ] **Step 7: 提交**

```bash
git add src/ui/Canvas.tsx src/App.tsx src/App.test.tsx src/styles.css
git commit -m "feat(canvas): 按住看原图 —— 预存一张预览，不重传 3000 万像素"
```

---

### Task 4: 卡住时能在图上点一下

**Files:**
- Modify: `src/App.tsx`、`src/ui/Canvas.tsx`、`src/ui/ChatPanel.tsx`、`src/styles.css`
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: Task 2、Task 3
- Produces:
  - `type NormPoint = { x: number; y: number }`（0~1，相对图片左上角）
  - `Canvas` 新 props：`picking: boolean`、`marker: NormPoint | null`、`onPickPoint: (x, y) => void`
  - `ChatPanel` 新 props：`canConfirmMark: boolean`、`onConfirmMark: () => void`

- [ ] **Step 1: 写失败的测试**

`src/App.test.tsx` 新增：

```tsx
/**
 * spec §6.3：模型说 `needs_disambiguation` 时，前端提示「你在图上点一下
 * 要改的地方？」，点完连同标记一起送模型。
 *
 * **钱在这一步**：一次生成约 12,900 tokens。所以和用户商量后定的是
 * **先画圈、确认了再改** —— 点错了不亏钱，还能换个地方再点。
 */
describe('图上点选消歧', () => {
  it('模型说拿不准 → 进入点选模式，且**一个生成的钱都不花**', async () => {
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉那个人', needsDisambiguation: true }))

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')

    expect(api.postEdit).not.toHaveBeenCalled()          // 不许先动手
    expect(canvasProps.props.at(-1)?.picking).toBe(true) // 但请用户点一下
    expect(lastReply()).toContain('不太确定')
  })

  it('点一下 → 画面上出现标记，**还是没花钱**', async () => {
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉那个人', needsDisambiguation: true }))

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')
    await act(async () => {
      (container.querySelector('canvas') as HTMLCanvasElement).click()
      await new Promise(r => setTimeout(r, 0))
    })

    expect(canvasProps.props.at(-1)?.marker).toEqual({ x: 0.5, y: 0.5 })
    expect(api.postEdit).not.toHaveBeenCalled()
    expect(container.textContent).toContain('就改这里')
  })

  it('⚠️ 只有点了「就改这里」才花钱 —— 这是和用户定死的规矩', async () => {
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉那个人', needsDisambiguation: true }))
    vi.mocked(api.postEdit).mockResolvedValue({
      imageDataUrl: 'data:image/png;base64,AAA', width: 2048, height: 1365,
    })

    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')
    await act(async () => {
      (container.querySelector('canvas') as HTMLCanvasElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(api.postEdit).not.toHaveBeenCalled()          // 到这儿为止还没花钱

    const confirm = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('就改这里')) as HTMLButtonElement
    expect(confirm).toBeTruthy()
    await act(async () => { confirm.click(); await new Promise(r => setTimeout(r, 0)) })

    expect(api.postEdit).toHaveBeenCalledTimes(1)
    // 送上去的是**画过圈的那张**，而且用的是用户原来那句话
    const req = vi.mocked(api.postEdit).mock.calls[0][0] as { editPrompt: string }
    expect(req.editPrompt).toContain('把后面那个人去掉')
  })

  it('取消掉就不点选了（不点也能继续说话）', async () => {
    vi.mocked(api.postRoute).mockResolvedValueOnce(
      decision({ route: 'generate', editPrompt: '去掉那个人', needsDisambiguation: true }))
    await renderApp()
    await uploadPhoto()
    await say('把后面那个人去掉')

    const cancel = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('不用了')) as HTMLButtonElement
    expect(cancel).toBeTruthy()
    await act(async () => { cancel.click() })

    expect(canvasProps.props.at(-1)?.picking).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试，确认它红**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL —— `picking` 是 `undefined`

- [ ] **Step 3: App 的状态与流程**

`src/App.tsx` 加类型与 state：

```tsx
/** 图上的一点，0~1 相对图片左上角。用归一化坐标，画布缩放大小时才不会跑偏。 */
export type NormPoint = { x: number; y: number }
```

```tsx
  /** 正在等用户在图上点一下（spec §6.3 的歧义兜底）。 */
  const [picking, setPicking] = useState(false)
  /** 用户点的那个点。null = 还没点。 */
  const [marker, setMarker] = useState<NormPoint | null>(null)
  /** 卡住时用户的原话 —— 确认之后要**连同标记一起**再送一次，不能让他重说。 */
  const [pendingText, setPendingText] = useState<string | null>(null)
```

`applyDecision` 里，原来那段 `needsDisambiguation` 的处理改成：

```tsx
    if (d.needsDisambiguation) {
      say('我不太确定你指的是哪个 —— 在图上点一下要改的地方？')
      // 记住他原来那句话：点了之后要连着标记一起再送，不能让他重说一遍
      setPendingText(pendingRef.current)
      setPicking(true)
      setMarker(null)
      return
    }
```

（`pendingRef` 是 `send` 里存下的那句原话；`send` 开头加 `pendingRef.current = text`。）

再加两个回调和确认函数：

```tsx
  const onPickPoint = useCallback((x: number, y: number) => {
    if (!picking) return
    setMarker({ x, y })
    setPicking(false)
  }, [picking])

  const cancelPick = useCallback(() => {
    setPicking(false)
    setMarker(null)
    setPendingText(null)
  }, [])
```

确认那一步放在 Task 5（它要画圈送模型）。

把这几个传给组件：

```tsx
            <Canvas
              ... 
              picking={picking}
              marker={marker}
              onPickPoint={onPickPoint}
            />
```

```tsx
            <ChatPanel
              ...
              canConfirmMark={!!marker && !!pendingText}
              onConfirmMark={confirmMark}
              onCancelMark={cancelPick}
            />
```

- [ ] **Step 4: Canvas 收点、画圈**

`src/ui/Canvas.tsx`：`Props` 加

```ts
  /** 正在等用户点一下（spec §6.3）。true 时画布接受点击并把它换算成坐标。 */
  picking?: boolean
  /** 用户点的那个点，0~1。null = 还没点。 */
  marker?: NormPoint | null
  onPickPoint?: (x: number, y: number) => void
```

在 `canvas-wrap` 上加点选处理（**注意用 `getBoundingClientRect` 而不是画布的像素尺寸** ——
画布内部 3000 万像素、屏幕上只有几百像素，两者差着好几个数量级）：

```tsx
    const handlePick = (e: React.MouseEvent<HTMLDivElement>) => {
      if (!picking || !onPickPoint) return
      const rect = e.currentTarget.getBoundingClientRect()
      // 归一化到 0~1：这样画布怎么缩放都不影响标记的位置
      const x = (e.clientX - rect.left) / rect.width
      const y = (e.clientY - rect.top) / rect.height
      if (x < 0 || x > 1 || y < 0 || y > 1) return
      onPickPoint(x, y)
    }
```

红圈（纯 DOM，不碰 GPU）：

```tsx
      {marker && (
        <span
          className="canvas-marker"
          style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }}
        />
      )}
```

- [ ] **Step 5: ChatPanel 出「就改这里」/「不用了」**

`Props` 加：

```ts
  /** 用户已经在图上点过了，可以确认。 */
  canConfirmMark: boolean
  onConfirmMark: () => void
  onCancelMark: () => void
```

在 `chat-log` 之后、`cards` 之前插入：

```tsx
      {canConfirmMark && (
        <div className="cards">
          <button className="card" onClick={onConfirmMark}>就改这里</button>
          <button className="card" onClick={onCancelMark}>不用了</button>
        </div>
      )}
```

- [ ] **Step 6: 样式**

```css
/* 用户点的那个点。纯 DOM 元素 —— 画布是 WebGL 的，往上画 2D 图形要另开
   一条路；反正是给人看的，一个圆就够了。送模型时会另画一份到图里。 */
.canvas-marker {
  position: absolute;
  width: 44px;
  height: 44px;
  margin: -22px 0 0 -22px;      /* 让圆心落在点上，不是左上角 */
  border: 4px solid #ff3b30;
  border-radius: 50%;
  box-shadow: 0 0 0 2px rgba(0, 0, 0, .45);   /* 浅色照片上也要看得见 */
  pointer-events: none;         /* 别挡住下一次点击 */
}
```

- [ ] **Step 7: 跑测试 + 排版检查**

Run: `npx vitest run src/App.test.tsx` + `npm test` + `npm run typecheck`
Run: `npm run build && npm run check:layout`
Expected: 全绿 / ✅

- [ ] **Step 8: 提交**

```bash
git add src/ui/Canvas.tsx src/ui/ChatPanel.tsx src/App.tsx src/App.test.tsx src/styles.css
git commit -m "feat: 模型拿不准时能在图上点一下 —— 点完先确认再花钱"
```

---

### Task 5: 带着标记送模型（点了才花钱）

**Files:**
- Create: `src/image/mark.ts`
- Modify: `src/App.tsx`
- Test: `src/image/mark.test.ts`、`src/App.test.tsx`

**Interfaces:**
- Consumes: `NormPoint`（Task 4）、`Sizable`、`MAX_DIMENSION` / `fitWithin` / `align32`
- Produces:
  - `const MARKER_RADIUS_RATIO = 0.06`
  - `function markerGeometry(m: NormPoint, w: number, h: number): { cx: number; cy: number; r: number }`
  - `function markImage(source: Sizable, m: NormPoint, maxDim?: number): HTMLCanvasElement`

**为什么标记要**画进图里**而不是当成一句话告诉模型**：spec §6.3 记着实测结论 ——
「在图上画标记让模型只改标记处是可行的，**红圈本身也会被正确擦除**」。
所以图上画圈比文字描述可靠。

- [ ] **Step 1: 写失败的测试（纯几何）**

新建 `src/image/mark.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { markerGeometry, MARKER_RADIUS_RATIO } from './mark'

describe('markerGeometry', () => {
  it('归一化的点换算成像素，圆心落在点上', () => {
    expect(markerGeometry({ x: 0.5, y: 0.5 }, 1000, 800))
      .toMatchObject({ cx: 500, cy: 400 })
  })

  it('四个角和正中间都对', () => {
    // 写成 `x * h` 之类的实现会在这组里露出来
    expect(markerGeometry({ x: 0, y: 0 }, 1000, 800)).toMatchObject({ cx: 0, cy: 0 })
    expect(markerGeometry({ x: 1, y: 1 }, 1000, 800)).toMatchObject({ cx: 1000, cy: 800 })
    expect(markerGeometry({ x: 0.25, y: 0.75 }, 1200, 800)).toMatchObject({ cx: 300, cy: 600 })
  })

  it('半径按**长边**算 —— 横竖图的圈看起来要一样大', () => {
    // 按短边算的话，1000x200 的横图上圈会小得看不见。
    // 这条按长边：1000 * 0.06 = 60
    expect(markerGeometry({ x: .5, y: .5 }, 1000, 200).r)
      .toBe(Math.round(1000 * MARKER_RADIUS_RATIO))
    expect(markerGeometry({ x: .5, y: .5 }, 200, 1000).r)
      .toBe(Math.round(1000 * MARKER_RADIUS_RATIO))
  })

  it('半径至少 8 像素 —— 小图上也得看得见', () => {
    expect(markerGeometry({ x: .5, y: .5 }, 64, 64).r).toBeGreaterThanOrEqual(8)
  })

  it('归一化越界的点会被夹回来（点歪到画布外面时不该画出个空标记）', () => {
    expect(markerGeometry({ x: 1.4, y: -0.3 }, 100, 100)).toMatchObject({ cx: 100, cy: 0 })
  })
})
```

- [ ] **Step 2: 跑测试，确认它红**

Run: `npx vitest run src/image/mark.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现几何 + 合成**

`src/image/mark.ts`：

```ts
import { MAX_DIMENSION, align32, fitWithin } from '../../shared/size.ts'
import type { Sizable } from './prepare'

/** 圈的半径 = 图片长边的这个比例。6% 是"一眼能看见、又不会盖住半个画面"的折中。 */
export const MARKER_RADIUS_RATIO = 0.06

export type NormPoint = { x: number; y: number }

/**
 * 归一化的点 → 图片上的像素坐标和半径。
 *
 * 半径按**长边**算：按短边算的话，一张 1000×200 的横图上圈会小得看不见，
 * 而立图又会大得离谱 —— 同一个比例在两种图上该看起来一样大。
 *
 * 越界的点夹回边界：用户在画布边缘点一下，不该画出一个跑到画面外的圈。
 */
export function markerGeometry(
  m: NormPoint, w: number, h: number,
): { cx: number; cy: number; r: number } {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
  return {
    cx: Math.round(clamp01(m.x) * w),
    cy: Math.round(clamp01(m.y) * h),
    r: Math.max(8, Math.round(Math.max(w, h) * MARKER_RADIUS_RATIO)),
  }
}

/**
 * 把用户点的那个圈**画进图里**，返回一张可以送模型的画布。
 *
 * 为什么不把位置写成一句话告诉模型：spec §6.3 记着实测结论 ——
 * 「在图上画标记让模型只改标记处是可行的，**红圈本身也会被正确擦除**」。
 * 图上画圈比文字描述可靠得多。
 *
 * 尺寸走 `prepareForModel` 那一套（长边 2048、宽高对齐 32）——
 * 圈在**缩放之后**画，所以在最终送出去的图上位置和大小都还对。
 */
export function markImage(
  source: Sizable, m: NormPoint, maxDim = MAX_DIMENSION,
): HTMLCanvasElement {
  const fitted = fitWithin(source.width, source.height, maxDim)
  const width = align32(fitted.width)
  const height = align32(fitted.height)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })
  if (!ctx) throw new Error('拿不到 2D 上下文，画不了标记')

  ctx.drawImage(source, 0, 0, width, height)

  const { cx, cy, r } = markerGeometry(m, width, height)
  ctx.strokeStyle = '#ff3b30'
  ctx.lineWidth = Math.max(4, Math.round(r / 6))
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()

  return canvas
}
```

- [ ] **Step 4: 跑测试，确认它绿**

Run: `npx vitest run src/image/mark.test.ts`
Expected: PASS

- [ ] **Step 5: 接上「就改这里」**

`src/App.tsx`：加 `confirmMark`：

```tsx
  /**
   * 用户在图上点过了，点「就改这里」——**到这一步才花钱**。
   *
   * 圈是画进图里送上去的，不是用文字描述位置（spec §6.3 的实测结论：
   * 图上画圈模型能只改标记处，而且红圈本身会被正确擦掉）。
   *
   * `runGenerate` 的入参从 `DecodedImage` 改成 `Sizable`（能 drawImage 的东西），
   * 这样可以直接送画布，不用为它再造一张位图、再想着关掉它。
   */
  const confirmMark = useCallback(async () => {
    if (!marker || !pendingText || !image) return
    const text = pendingText
    setPicking(false)
    setMarker(null)
    setPendingText(null)
    try {
      const marked = markImage(image.bitmap, marker)
      await runGenerate(text, nextId(), params, marked)
    } catch (e) {
      console.error(e)
      say('这一步没成功，再试一次？')
    }
  }, [marker, pendingText, image, params, runGenerate, say])
```

`runGenerate` 的签名与实现改一处：

```tsx
  const runGenerate = useCallback(async (
    editPrompt: string, messageId: number, paramsAtStep: Adjustments,
    source: Sizable,          // ← 原来是 DecodedImage
  ) => {
    ...
      const prepared = await prepareForModel(source)   // ← 原来传的是 source.bitmap
```

调用方 `applyDecision` 里跟着改成 `runGenerate(d.editPrompt, mid, nextParams, image.bitmap)`。

- [ ] **Step 6: 跑测试，确认它绿**

Run: `npm test` + `npm run typecheck`
Expected: 全绿。**特别是 Task 4 那条「只有点了才花钱」必须绿。**

- [ ] **Step 7: 提交**

```bash
git add src/image/mark.ts src/image/mark.test.ts src/App.tsx
git commit -m "feat: 把用户点的圈画进图里送模型 —— 位置靠圈，不靠嘴说"
```

---

### Task 6: 真机验收（不是自动化测试）

**这一节没有代码，只有必须**在真手机上**做一遍的事。**

**Files:** 无

- [ ] **Step 1: 起生产版本**

```bash
npm run build && npm run preview
```
手机上打开 `http://<电脑局域网IP>:5173`（同一 wifi）。

- [ ] **Step 2: 逐条验，一条一条记**

| # | 做什么 | 该看到什么 |
|---|---|---|
| 1 | 传一张自己的照片 | 对话里出现一张小图挂在欢迎语下面 |
| 2 | 说一句话改颜色 | **新那张小图的颜色是改过的**（不是原样的 —— 这条最容易错） |
| 3 | 点那张小图 | 画面回到那一步 |
| 4 | **按住画面** | 变回原图，松手弹回 |
| 5 | 长按画面不放 | **不许弹出系统的「保存图片 / 复制」菜单** |
| 6 | 说一句有歧义的话（照片里人多时） | 回「在图上点一下要改的地方？」，且**没花钱** |
| 7 | 在画面上点一下 | 出现红圈，且**还是没花钱** |
| 8 | 点「就改这里」 | 这时候才花钱，改的是圈住的地方 |
| 9 | 点「不用了」 | 退出点选，红圈消失，能继续说话 |

- [ ] **Step 3: 把结果写进验收记录**

`docs/superpowers/plans/2026-09-22-conversational-editing-verification.md`
新增一节（§17），格式照 §14 / §15：
**验了什么、原始数字、哪里不符合预期、我错了什么。**

**没有这一步不算做完。** §13、§14、§15 三次事故都是"测试全绿、真机才知道"。

- [ ] **Step 4: 提交验收记录**

```bash
git add docs/superpowers/plans/2026-09-22-conversational-editing-verification.md
git commit -m "docs: 计划三的真机验收记录（含不符合预期的地方）"
```

**记录里必须包含"我错了什么"**，不能只写"全部通过" —— 这是这个项目
从 §13 那次事故留下来的规矩。

---

## 自查

**spec 覆盖**：

| spec 里的目标 | 落在哪个任务 |
|---|---|
| §2.4 历史缩略图（点哪句回到哪句） | Task 1 + 2 |
| §2.5 按住看原图 | Task 3 |
| §6.3 歧义 → 图上点选 | Task 4 + 5 |
| §8.1「点选兜底 / 历史 / 对比原图」三条 | 同上 |

**没做的（明确留到以后）**：
- 「一步步来」开关、流式路由、多图色调迁移 —— 属于计划三的输入里更靠后的部分，
  这一份不做
- 图上**圈选**（画不规则范围）—— spec §8.2 明确说第一版不做，只做「点一下」

**类型一致性自查**：
- `NormPoint` 在 Task 4 定义（`src/App.tsx`），Task 5 的 `mark.ts` **也定义了同名的**。
  → 执行时以 `mark.ts` 的为准，`App.tsx` 改成 `import type { NormPoint } from './image/mark'`，
  不要在两个地方各留一份。
- `Snapshot.thumb` 全程叫 `thumb`，没有第二个名字。
- `runGenerate` 的第四个参数在 Task 5 从 `DecodedImage` 改成 `Sizable` —— 只有一个调用点
  （`applyDecision`），Task 5 Step 5 里写了要一起改。
