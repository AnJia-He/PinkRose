export type Config = {
  apiKey: string
  baseUrl: string
  imageModel: string
  vlmModel: string
  port: number
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
  const portRaw = Number(env.PORT ?? DEFAULT_PORT)
  return {
    apiKey,
    baseUrl: (env.SN_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    imageModel: env.SN_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL,
    vlmModel: env.SN_VLM_MODEL?.trim() || DEFAULT_VLM_MODEL,
    port: Number.isInteger(portRaw) && portRaw > 0 ? portRaw : DEFAULT_PORT,
  }
}

/** 给人看的配置摘要。**故意不包含 apiKey**，因为这个字符串会被打日志。 */
export function describeConfig(c: Config): string {
  return `base=${c.baseUrl} image=${c.imageModel} vlm=${c.vlmModel} port=${c.port} key=已设置`
}
