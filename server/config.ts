import { resolve } from 'node:path'

/**
 * 一条默认上游通道（**我们自己的**钥匙，不是用户自带的那套）。
 *
 * ★ 2026-10-03：**两条通道从此不是同一家** ——
 *   · `chat`  —— 看懂照片 + 听懂人话（`/api/route`、`/api/suggest`）→ **Agnes**
 *      （`agnes-2.5-flash`：实测 1.0~2.1 秒，商汤那条是 4~8.5 秒；判断也准）
 *   · `image` —— 真去改图（`/api/edit`）→ 仍然是**商汤**（`sensenova-u1.5-fast`）
 *
 *   为什么**只换了一半**（这是量出来的，不是挑的）：Agnes 的图片模型有两类活会
 *   翻车 —— 换天空时**把背对镜头的人转过来画了张没五官的脸**、修痘印时**顺手
 *   磨平皮肤还梳了头发**；同一刀商汤都不犯。加硬约束能压住这两条，却又把
 *   "换背景"那张的脸改动从 53% 顶到 91.5%（负面清单越长越是在提醒它）。
 *   证据 `.superpowers/scratch/audit/_verify_agnes*.py`、`_probe_agnes_prompt*.py`，
 *   对照图在 `shots/V-*.png` / `sn-SN-*.png`。
 */
export type Channel = {
  apiKey: string
  baseUrl: string
  /** 这条通道用哪个模型 id */
  model: string
}

export type Config = {
  chat: Channel
  image: Channel
  port: number
  dbPath: string
  /** 图片文件放哪 —— Storage 那一层的根目录。和 dbPath 一样，默认落在仓库根的 data/ 下 */
  photoDir: string
  /** 滤镜文件放哪 —— 和 photoDir 同一套规矩 */
  lutDir: string
  /** 会话签名用的钥匙。**没有默认值** —— 见 loadConfig 里那一抛。 */
  sessionSecret: string
  /**
   * ★ 2026-10-12：微信小程序那两把钥匙（`POST /api/wx-login` 用）。
   *
   * ⚠️ 和上面两条通道**不一样，缺了也照常启动**（所以是空串、不是抛）：
   *   缺 chat/image 钥匙是"这个产品缺一半"（对话和出图整个废掉），而缺微信钥匙
   *   只是"小程序登不进来"—— 电脑版**一个字都不受影响**。为它拒绝启动等于
   *   让一个可选的入口把整个服务拖死。
   *   代价是"没配"要由**路由**当场说清楚（503 +「后端没有配置微信登录」），
   *   而不是变成一个看不懂的 401（app.ts 那条路由上写着这件事）。
   */
  wx: { appid: string; secret: string }
}

export const DEFAULT_CHAT_BASE_URL = 'https://apihub.agnes-ai.com/v1'
export const DEFAULT_CHAT_MODEL = 'agnes-2.5-flash'
export const DEFAULT_IMAGE_BASE_URL = 'https://token.sensenova.cn/v1'
export const DEFAULT_IMAGE_MODEL = 'sensenova-u1.5-fast'
export const DEFAULT_PORT = 8787

type ChannelEnv = { key: string; base: string; model: string }

/**
 * 读一条通道。**缺钥匙就抛**，而且只说缺了哪个变量、绝不回显任何值
 * （这个错误信息会被打日志）。
 */
function readChannel(
  env: NodeJS.ProcessEnv,
  names: ChannelEnv,
  fallback: { base: string; model: string },
  allowMissing: boolean,
): Channel {
  const apiKey = env[names.key]?.trim()
  if (!apiKey) {
    // 桌面安装包不能再依赖开发机里的 .env，也绝不能把服务端密钥打进安装包。
    // 桌面模式允许先空着启动；真正调用 AI 时由 clientFor.ts 提醒用户到
    //「个人设置 → 模型配置」接自己的模型。Web 部署仍保持缺 key 即拒绝启动。
    if (allowMissing) {
      return {
        apiKey: '',
        baseUrl: (env[names.base]?.trim() || fallback.base).replace(/\/+$/, ''),
        model: env[names.model]?.trim() || fallback.model,
      }
    }
    throw new Error(`缺少环境变量 ${names.key}，请复制 .env.example 为 .env 并填入`)
  }
  return {
    apiKey,
    baseUrl: (env[names.base]?.trim() || fallback.base).replace(/\/+$/, ''),
    model: env[names.model]?.trim() || fallback.model,
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // ★ **两条通道都要有钥匙才起得来。** 少哪一条，产品就缺一半：chat 缺了路由
  //   直接废掉，image 缺了点「生成」就废掉。宁可启动时把话说清楚，也不要等用户
  //   按下去、才在上游那边变成一个看不懂的 401。
  const desktopMode = env.PINKROSE_DESKTOP === '1'
  const chat = readChannel(env,
    { key: 'AGNES_API_KEY', base: 'AGNES_BASE_URL', model: 'AGNES_CHAT_MODEL' },
    { base: DEFAULT_CHAT_BASE_URL, model: DEFAULT_CHAT_MODEL },
    desktopMode)
  const image = readChannel(env,
    { key: 'SN_API_KEY', base: 'SN_BASE_URL', model: 'SN_IMAGE_MODEL' },
    { base: DEFAULT_IMAGE_BASE_URL, model: DEFAULT_IMAGE_MODEL },
    desktopMode)

  const sessionSecret = env.SESSION_SECRET?.trim()
  if (!sessionSecret) {
    // 没配就**拒绝启动**，绝不用一个写死在代码里的默认值 —— 那等于没有签名，
    // 谁都能自己造一张票进来，冒充任何人。生产环境的这种"默认值"是经典事故。
    throw new Error('缺少环境变量 SESSION_SECRET，请复制 .env.example 为 .env 并填一个随机串')
  }
  const portRaw = Number(env.PORT ?? DEFAULT_PORT)
  // 默认落在仓库根的 data/ 下。**故意用 process.cwd() 而不是模块自己的位置**：真跑是
  // `node server/index.ts`、脚本和测试也都从仓库根启动，几边看到的是同一个库；
  // 换成 import.meta.url 的话，从别处启动就会另开一个空库 ——
  // "用户数据在哪"一旦有两个答案，排查起来很贵。
  return {
    chat,
    image,
    port: Number.isInteger(portRaw) && portRaw > 0 ? portRaw : DEFAULT_PORT,
    dbPath: env.DB_PATH?.trim() || resolve(process.cwd(), 'data', 'ruixing.db'),
    photoDir: env.PHOTO_DIR?.trim() || resolve(process.cwd(), 'data', 'photos'),
    lutDir: env.LUT_DIR?.trim() || resolve(process.cwd(), 'data', 'luts'),
    sessionSecret,
    // ★ 2026-10-12：微信那两把钥匙。**空串 = 没配**（见类型上那段：它是可选入口，
    //   不拒绝启动）。⚠️ **两把缺任何一把都算没配**（路由按这个判 503）：
    //   半配置放去 code2session 只会变成一个看不懂的 401 —— 而小程序把 401
    //   当"重登一次"的信号，重登一百次也不会好（审查 Important 2026-10-12 修；
    //   这里原来那句"只缺一个走正常失败路"就是这么想错的）。
    wx: {
      appid: env.WX_APPID?.trim() ?? '',
      secret: env.WX_SECRET?.trim() ?? '',
    },
  }
}

/** 给人看的配置摘要。**故意不包含 apiKey 和 sessionSecret**，因为这个字符串会被打日志。 */
export function describeConfig(c: Config): string {
  return `chat=${c.chat.baseUrl} (${c.chat.model}) ` +
    `image=${c.image.baseUrl} (${c.image.model}) port=${c.port} key=已设置 secret=已设置`
}
