import { get, post, patch, del } from './client'
import type { AlbumMeta } from '../../shared/works.ts'

export async function listAlbums(): Promise<AlbumMeta[]> {
  return (await get<{ albums: AlbumMeta[] }>('/api/albums')).albums
}

export async function createAlbum(name: string): Promise<AlbumMeta> {
  return (await post<{ album: AlbumMeta }>('/api/albums', { name })).album
}

export async function renameAlbum(id: number, name: string): Promise<AlbumMeta> {
  return (await patch<{ album: AlbumMeta }>(`/api/albums/${id}`, { name })).album
}

export async function deleteAlbum(id: number): Promise<void> {
  await del<{ ok: true }>(`/api/albums/${id}`)
}

export async function addWorksToAlbum(
  id: number, ids: number[],
): Promise<{ added: number[]; missing: number[] }> {
  return post<{ added: number[]; missing: number[] }>(`/api/albums/${id}/works`, { ids })
}

export async function removeWorksFromAlbum(
  id: number, ids: number[],
): Promise<{ removed: number[]; missing: number[] }> {
  return post<{ removed: number[]; missing: number[] }>(`/api/albums/${id}/works/remove`, { ids })
}
