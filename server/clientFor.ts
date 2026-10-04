import type { PublicUser } from './account.ts'
import type { Config } from './config.ts'
import type { Db } from './db.ts'
import type { Vault } from './keyvault.ts'
import { resolveSecret, type ModelConfigDeps } from './models.ts'
import { assertModelHostAllowed, assertResolvedHostAllowed, type HostLookup } from './hostGuard.ts'
import { SenseNovaClient, type ModelConnection } from './sn.ts'

export type ClientDeps = {
  db: Db
  vault: Vault
  config: Config
  /**
   * 测试注入用。生产永远走默认（`c => new SenseNovaClient(c)`）。
   *
   * ★ 它挂在 `ClientDeps` 而不是 `AppDeps` 上：要验的是"**这两条连接**分别是谁"，
   * 而连接是在这里拼出来的 —— 假客户端得站在拼连接的那一头，才看得见
   * 出站的请求头里到底是哪把钥匙。挂在 AppDeps 上就只能换掉最终产物，
   * 看不见"它是不是拿对了那一套"。
   */
  clientFactory?: (conn: ModelConnection) => SenseNovaClient
  /**
   * 出站前"把域名解析成 IP 再判一次"的注入点（测试用；生产走真实 DNS）。
   * 要验的行为是"**解析结果**指向内网就拒"，而真去查 DNS 的测试既慢又不稳。
   */
  lookupHost?: HostLookup
}

/**
 * 这一次请求该用哪个模型客户端。
 *
 * ★ **每条请求都要重新取一次**，不缓存。理由：用户随时可能刚在设置里换过；
 * 而"解密 + 一次 SQLite 查询"在这个量级上根本不值一提
 * （OrcaRouter 也是按请求解密、明确不缓存）。
 *
 * ★ **两个类别各造一个客户端**（§7.4）：
 *   · `chat`  —— `/api/route` 和 `/api/suggest`（要看图的模型）
 *   · `image` —— `/api/edit`（真改图的模型）
 *   分开的直接好处：图片的钥匙填错了，对话**完全不受影响** ——
 *   因为它们是两条独立的路，谁也不会碰谁。
 *
 * 任何一步取不到（没配 / 没激活 / 密文读不出来）都安静地回默认。
 * **不抛**：那是"用户配过但现在用不了"，正确答案是照旧能用（走我们的），
 * 而不是让他连图都改不了。
 */
export async function resolveClients(user: PublicUser, deps: ClientDeps): Promise<{
  chat: SenseNovaClient
  image: SenseNovaClient
}> {
  return {
    chat: await clientOf('chat', user, deps),
    image: await clientOf('image', user, deps),
  }
}

async function clientOf(kind: 'chat' | 'image', user: PublicUser, deps: ClientDeps): Promise<SenseNovaClient> {
  const modelDeps: ModelConfigDeps = { db: deps.db, vault: deps.vault }
  const secret = resolveSecret(kind, user, modelDeps)

  // ★ 2026-10-02（安全审计 S1）：**存量配置也要拦**。
  //   上面那条内网黑名单是后来才加到 `normalizeBaseUrl` 的，而库里可能早就躺着
  //   一条指向内网的地址（加校验之前存进去的）—— 它不会自己消失。
  //   所以这里在**真正发请求之前**再拦一次。
  //   ⚠️ 抛（而不是像别的失败那样安静回落到我们自己的钥匙）：这是"这个地址
  //      不让用"的**政策拒绝**，不是"读不出来"。安静回落的话，用户的图照样改成了
  //      —— 花的是我们的额度，而他以为用的是自己那套。
  if (secret) {
    assertModelHostAllowed(secret.baseUrl)
    // ★ 2026-10-04：字面量那道上头挡不住**公共通配 DNS**（`127.0.0.1.nip.io` 实测
    //   可绕，一分钱不花）—— 真正发请求之前，把域名解析成 IP 再判一次。
    //   只拦用户配的那一条：默认那条是我们自己的地址，不是攻击面。
    await assertResolvedHostAllowed(secret.baseUrl, { lookup: deps.lookupHost })
  }

  // 用户没配（或配了用不了）→ 用我们自己的那一套。
  // ⚠️ ★ 2026-10-03：**两个类别各有自己的默认通道**（chat 走 Agnes、image 走商汤，
  //    见 config.ts 顶上那段）。所以这里取的是一整条通道（钥匙 + 地址 + 模型），
  //    不是"一份默认 + 两个模型名" —— 写成后者的话，两个类别会一起串到同一家去，
  //    而且**不报错**，只是悄悄换了个模型在干活。
  const fallback = kind === 'chat' ? deps.config.chat : deps.config.image
  const conn: ModelConnection = secret
    ? { apiKey: secret.apiKey, baseUrl: secret.baseUrl, modelId: secret.modelId }
    : { apiKey: fallback.apiKey, baseUrl: fallback.baseUrl, modelId: fallback.model }

  const make = deps.clientFactory ?? ((c: ModelConnection) => new SenseNovaClient(c))
  return make(conn)
}
