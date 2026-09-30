import { describe, it, expect } from 'vitest'
import { handleEdit } from './edit.ts'
import { SenseNovaClient } from './sn.ts'
import { SerialQueue } from './queue.ts'
import type { Config } from './config.ts'

const cfg: Config = {
  apiKey: 'sk-test', baseUrl: 'https://x.cn/v1',
  imageModel: 'sensenova-u1.5-fast', vlmModel: 'v', port: 0,
  dbPath: ':memory:',
  // 这两个是 Config 上的必填字段（起服务要它），这个文件既不碰账号也不碰图
  photoDir: 'unused',
  sessionSecret: 'test-secret',
}
const IMG = 'data:image/jpeg;base64,AAAA'
const deps = (c: SenseNovaClient) => ({ client: c, queue: new SerialQueue({ sleep: async () => {} }) })
const body = { imageDataUrl: IMG, editPrompt: 'Remove the person behind the subject.', width: 1024, height: 768 }

function replying(b64: string | undefined, status = 200) {
  const calls: any[] = []
  const impl = (async (_u: any, init: any) => {
    calls.push(JSON.parse(init.body))
    return status !== 200
      ? new Response('{"error":{"message":"boom"}}', { status })
      : new Response(JSON.stringify({ data: b64 === undefined ? [{}] : [{ b64_json: b64 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { client: new SenseNovaClient(cfg, impl), calls }
}

describe('handleEdit', () => {
  it('返回可直接给 <img> 用的 data URL', async () => {
    const { client } = replying('QUJD')
    const res = await handleEdit(body, deps(client))
    expect(res.imageDataUrl).toBe('data:image/png;base64,QUJD')
    expect(res.width).toBe(1024)
    expect(res.height).toBe(768)
  })

  it('发给模型的是补过保留项的 prompt —— 这一句决定了脸保不保得住', async () => {
    const { client, calls } = replying('QQ==')
    await handleEdit(body, deps(client))
    expect(calls[0].prompt).toContain('Remove the person behind the subject.')
    expect(calls[0].prompt).toContain('Preserve the person')
    expect(calls[0].prompt).toContain('Keep everything else exactly as it is')
  })

  it('把请求里的宽高原样传给上游', async () => {
    const { client, calls } = replying('QQ==')
    await handleEdit({ ...body, width: 1280, height: 896 }, deps(client))
    expect(calls[0].size).toBe('1280x896')
  })

  it('送给上游的是请求里那张图 —— 被编辑的照片本身也要钉住', async () => {
    const { client, calls } = replying('QQ==')
    const other = 'data:image/png;base64,BBBB'
    await handleEdit({ ...body, imageDataUrl: other }, deps(client))
    expect(calls[0].images[0].image_url).toBe(other)
  })

  it('业务上限正好是 2048 —— 2048 放行、2080 拒，且被拒那次一次 API 都不调', async () => {
    // 4096x2048 对 API 完全合法（32 的倍数、在 [512,4096]、2:1）——checkModelSize
    // 放它过。挡住它的是**我们自己的**策略上限（spec §4.4），不设这道门，一个不老实
    // 或有 bug 的客户端就能让账户按 4096² 的账单付费。
    //
    // 为什么钉边界、而不是「值大于某数就报错」：只断言 BAD_REQUEST 的话，把上限换成
    // 任何落在 (1024, 4096) 里的字面量都照样全绿；只断言报错文案里含 2048 也不行——
    // 改判定、不改文案（`longSide > 3000` 但消息仍插值 MAX_DIMENSION）同样全绿
    // （我第一版就是这么打偏的）。只有「2048 必须过 + 2080 必须拒」把那个数钉死，
    // 两个方向都能红。
    const { client, calls } = replying('QQ==')
    // 上限是「不超过」，不是「小于」——正好 2048 必须放行
    const pass = await handleEdit({ ...body, width: 2048, height: 2048 }, deps(client))
    expect(pass.width).toBe(2048)

    const e = await handleEdit({ ...body, width: 2080, height: 2048 }, deps(client)).catch(e => e)
    expect(e.code).toBe('BAD_REQUEST')
    // 只有放行那次打到上游：被拒的那次在本地就断了（省的是时间，也是钱）
    expect(calls).toHaveLength(1)
  })

  it('imageDataUrl 不是 data:image/ 开头 -> 400，且一次 API 都不调', async () => {
    // 没有这一条，守卫里 `!startsWith('data:image/')` 那半边可以直接删掉：
    // 只测 undefined/非字符串的话，第一半就拦下了，测试照样绿。
    const { client, calls } = replying('QQ==')
    await expect(handleEdit({ ...body, imageDataUrl: 'http://evil/x.jpg' }, deps(client)))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(calls).toHaveLength(0)
  })

  it('宽高不是 32 的倍数 -> 400，且**一次 API 都不调**', async () => {
    const { client, calls } = replying('QQ==')
    await expect(handleEdit({ ...body, width: 1000 }, deps(client)))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(calls).toHaveLength(0)   // 省钱的关键：不合规在本地就拒掉
  })

  it('宽高比超过 3:1 -> 400', async () => {
    const { client } = replying('QQ==')
    await expect(handleEdit({ ...body, width: 2048, height: 512 + 32 * 0 }, deps(client)))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('超出 [512,4096] -> 400', async () => {
    const { client } = replying('QQ==')
    await expect(handleEdit({ ...body, width: 256, height: 512 }, deps(client)))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(handleEdit({ ...body, width: 4096 + 32, height: 768 }, deps(client)))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('空 editPrompt -> 400', async () => {
    const { client } = replying('QQ==')
    await expect(handleEdit({ ...body, editPrompt: '  ' }, deps(client)))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('上游限流 -> 503 UPSTREAM_LIMIT（队列已经退避重试过）', async () => {
    const { client } = replying(undefined, 429)
    await expect(handleEdit(body, deps(client))).rejects.toMatchObject({ code: 'UPSTREAM_LIMIT' })
  })

  it('上游挂了 -> 502，且响应里不带任何 key 痕迹', async () => {
    const { client } = replying(undefined, 500)
    const e = await handleEdit(body, deps(client)).catch(e => e)
    expect(e.code).toBe('UPSTREAM_FAILED')
    expect(String(e.message)).not.toContain('sk-test')
  })

  it('透传图像模型的响应不是 JSON 时也归一化成 SnError', async () => {
    const { client } = replying(undefined, 200)
    // 上游返回 200 但没有 b64_json
    await expect(handleEdit(body, deps(client))).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
  })

  /**
   * ★ 2026-09-30 加（前端的「停止」按钮）。
   *
   * 这是**停止唯一真能省钱的那一格**：队列是串行的，用户说这句话的时候
   * 前面那个人可能还在生成，他得干等十几秒 —— 而在这十几秒里反悔是常事。
   * 轮到他跑的时候先看一眼信号，按过停止就一次上游都不打。
   *
   * （已经在跑的那种救不回来：上游早把那张图收下了，钱已经花掉。
   *   前端那句「停了」也因此**不承诺省钱**，只说停了。）
   */
  it('★ 还在排队时用户按了停止 —— 一次上游都不打', async () => {
    const { client, calls } = replying('QUJD')
    const queue = new SerialQueue({ sleep: async () => {} })

    // 前面先塞一个不结束的任务，把队列占住（真实情况就是前一次生成还在跑）
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    const first = queue.run(() => held, 'held')

    const ac = new AbortController()
    const p = handleEdit(body, { client, queue, signal: ac.signal })

    ac.abort()      // ← 用户在这个位置按了停止（还排着队）
    release()       // 前面那个跑完了，轮到这一次

    await expect(p).rejects.toMatchObject({ code: 'UPSTREAM_FAILED', retryable: false })
    expect(calls.length).toBe(0)   // ★ 一个字节都没发出去 —— 这才是省下来的
    await first
  })

  it('⚠️ 没传 signal 时行为和以前一模一样（排到了就打）', async () => {
    const { client, calls } = replying('QUJD')
    await handleEdit(body, deps(client))
    expect(calls.length).toBe(1)
  })
})
