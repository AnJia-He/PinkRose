import { resolve } from 'node:path'

export type Config = {
  apiKey: string
  baseUrl: string
  imageModel: string
  vlmModel: string
  port: number
  dbPath: string
  /** 会话签名用的钥匙。**没有默认值** —— 见 loadConfig 里那一抛。 */
  sessionSecret: string
}

export const DEFAULT_IMAGE_MODEL = 'sensenova-u1.5-fast'
export const DEFAULT_VLM_MODEL = 'sensenova-6.8-flash-lite'
export const DEFAULT_BASE_URL = 'https://token.sensenova.cn/v1'
export const DEFAULT_PORT = 8787

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.SN_API_KEY?.trim()
  if (!apiKey) {
    // 只说缺了哪个变量，绝不回显任何值——错误信息会被打日志
    throw new Error('缺少环境变量 SN_API_KEY，请复制 .env.example 为 .env 并填入')
  }
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
    apiKey,
    baseUrl: (env.SN_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    imageModel: env.SN_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL,
    vlmModel: env.SN_VLM_MODEL?.trim() || DEFAULT_VLM_MODEL,
    port: Number.isInteger(portRaw) && portRaw > 0 ? portRaw : DEFAULT_PORT,
    dbPath: env.DB_PATH?.trim() || resolve(process.cwd(), 'data', 'ruixing.db'),
    sessionSecret,
  }
}

/** 给人看的配置摘要。**故意不包含 apiKey 和 sessionSecret**，因为这个字符串会被打日志。 */
export function describeConfig(c: Config): string {
  return `base=${c.baseUrl} image=${c.imageModel} vlm=${c.vlmModel} port=${c.port} key=已设置 secret=已设置`
}
