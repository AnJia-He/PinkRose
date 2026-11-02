/** 用户可管理的跨会话长期偏好。单会话压缩摘要不属于公开接口。 */
export type MemoryProfile = {
  enabled: boolean
  summary: string | null
  updatedAt: number | null
}
