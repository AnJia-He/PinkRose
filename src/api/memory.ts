import type { MemoryProfile } from '../../shared/memory.ts'
import { del, get, patch } from './client'

export async function getMemoryProfile(): Promise<MemoryProfile> {
  return (await get<{ memory: MemoryProfile }>('/api/memory')).memory
}

export async function setMemoryEnabled(enabled: boolean): Promise<MemoryProfile> {
  return (await patch<{ memory: MemoryProfile }>('/api/memory', { enabled })).memory
}

export async function clearMemoryProfile(): Promise<MemoryProfile> {
  return (await del<{ memory: MemoryProfile }>('/api/memory')).memory
}
