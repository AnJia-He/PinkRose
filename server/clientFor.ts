import type { PublicUser } from './account.ts'
import type { Config } from './config.ts'
import type { Db } from './db.ts'
import type { Vault } from './keyvault.ts'
import { resolveSecret, type ModelConfigDeps } from './models.ts'
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
export function resolveClients(user: PublicUser, deps: ClientDeps): {
  chat: SenseNovaClient
  image: SenseNovaClient
} {
  return {
    chat: clientOf('chat', user, deps),
    image: clientOf('image', user, deps),
  }
}

function clientOf(kind: 'chat' | 'image', user: PublicUser, deps: ClientDeps): SenseNovaClient {
  const modelDeps: ModelConfigDeps = { db: deps.db, vault: deps.vault }
  const secret = resolveSecret(kind, user, modelDeps)

  // 用户没配（或配了用不了）→ 用我们自己的那一套。
  // 模型名取 config 里对应的那一个：chat 用 vlm、image 用 image model。
  const conn: ModelConnection = secret
    ? { apiKey: secret.apiKey, baseUrl: secret.baseUrl, modelId: secret.modelId }
    : {
      apiKey: deps.config.apiKey,
      baseUrl: deps.config.baseUrl,
      modelId: kind === 'chat' ? deps.config.vlmModel : deps.config.imageModel,
    }

  const make = deps.clientFactory ?? ((c: ModelConnection) => new SenseNovaClient(c))
  return make(conn)
}
