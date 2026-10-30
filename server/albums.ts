import type { PublicUser } from './account.ts'
import { nowMs } from './clock.ts'
import type { Db } from './db.ts'
import { HttpError, asObject, str } from './http.ts'
import type { AlbumMeta } from '../shared/works.ts'

export type AlbumDeps = { db: Db; now?: () => number }

type AlbumRow = { id: number; user_id: number; name: string; created_at: number }
type AlbumCountRow = AlbumRow & { work_count: number }

const MAX_ALBUMS = 100
const MAX_NAME = 40

const toMeta = (row: AlbumCountRow): AlbumMeta => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  workCount: row.work_count,
})

function loadOwned(id: number, user: PublicUser, deps: AlbumDeps): AlbumRow {
  const row = deps.db.raw.prepare(
    'SELECT id, user_id, name, created_at FROM albums WHERE id = ? AND user_id = ?',
  ).get(id, user.id) as AlbumRow | undefined
  if (!row) throw new HttpError('BAD_REQUEST', '没有这个相册', 404)
  return row
}

function readName(body: unknown): string {
  const name = str(asObject(body).name).trim()
  if (!name || name.length > MAX_NAME) {
    throw new HttpError('BAD_REQUEST', `相册名要 1–${MAX_NAME} 个字`, 400)
  }
  return name
}

function assertNameFree(name: string, user: PublicUser, deps: AlbumDeps, exceptId = 0): void {
  const hit = deps.db.raw.prepare(
    'SELECT id FROM albums WHERE user_id = ? AND name = ? AND id != ?',
  ).get(user.id, name, exceptId)
  if (hit) throw new HttpError('BAD_REQUEST', `已经有一个叫「${name}」的相册了，换个名字。`, 400)
}

function readIds(body: unknown): number[] {
  const raw = asObject(body).ids
  if (!Array.isArray(raw)) throw new HttpError('BAD_REQUEST', '没给要操作哪些作品', 400)
  const ids = raw.map(value => Number(value))
  if (ids.some(value => !Number.isInteger(value) || value <= 0)) {
    throw new HttpError('BAD_REQUEST', '作品 id 得都是正整数', 400)
  }
  if (ids.length === 0) throw new HttpError('BAD_REQUEST', '没给要操作哪些作品', 400)
  const unique = [...new Set(ids)]
  if (unique.length > 500) throw new HttpError('BAD_REQUEST', '一次最多操作 500 张作品', 400)
  return unique
}

export function listAlbums(user: PublicUser, deps: AlbumDeps): { albums: AlbumMeta[] } {
  const rows = deps.db.raw.prepare(
    `SELECT a.id, a.user_id, a.name, a.created_at, COUNT(wa.work_id) AS work_count
     FROM albums a
     LEFT JOIN work_albums wa ON wa.album_id = a.id
     WHERE a.user_id = ?
     GROUP BY a.id
     ORDER BY a.created_at DESC, a.id DESC`,
  ).all(user.id) as unknown as AlbumCountRow[]
  return { albums: rows.map(toMeta) }
}

export function createAlbum(
  body: unknown, user: PublicUser, deps: AlbumDeps,
): { album: AlbumMeta } {
  const name = readName(body)
  const count = (deps.db.raw.prepare(
    'SELECT COUNT(*) AS n FROM albums WHERE user_id = ?',
  ).get(user.id) as { n: number }).n
  if (count >= MAX_ALBUMS) {
    throw new HttpError('BAD_REQUEST', `最多建 ${MAX_ALBUMS} 个相册`, 400)
  }
  assertNameFree(name, user, deps)
  try {
    const at = nowMs(deps)
    const result = deps.db.raw.prepare(
      'INSERT INTO albums (user_id, name, created_at) VALUES (?, ?, ?)',
    ).run(user.id, name, at)
    return {
      album: {
        id: Number(result.lastInsertRowid),
        name,
        createdAt: at,
        workCount: 0,
      },
    }
  } catch (e) {
    if (String((e as Error).message).includes('UNIQUE')) {
      throw new HttpError('BAD_REQUEST', `已经有一个叫「${name}」的相册了，换个名字。`, 400)
    }
    throw e
  }
}

export function renameAlbum(
  id: number, body: unknown, user: PublicUser, deps: AlbumDeps,
): { album: AlbumMeta } {
  const row = loadOwned(id, user, deps)
  const name = readName(body)
  if (name !== row.name) assertNameFree(name, user, deps, id)
  deps.db.raw.prepare('UPDATE albums SET name = ? WHERE id = ? AND user_id = ?')
    .run(name, id, user.id)
  const count = (deps.db.raw.prepare(
    'SELECT COUNT(*) AS n FROM work_albums WHERE album_id = ?',
  ).get(id) as { n: number }).n
  return { album: { id, name, createdAt: row.created_at, workCount: count } }
}

export function deleteAlbum(id: number, user: PublicUser, deps: AlbumDeps): { ok: true } {
  loadOwned(id, user, deps)
  deps.db.raw.prepare('DELETE FROM albums WHERE id = ? AND user_id = ?').run(id, user.id)
  return { ok: true }
}

export function addWorksToAlbum(
  id: number, body: unknown, user: PublicUser, deps: AlbumDeps,
): { added: number[]; missing: number[] } {
  loadOwned(id, user, deps)
  const unique = readIds(body)
  const marks = unique.map(() => '?').join(',')
  const owned = deps.db.raw.prepare(
    `SELECT id FROM works WHERE user_id = ? AND id IN (${marks})`,
  ).all(user.id, ...unique) as { id: number }[]
  const found = new Set(owned.map(row => row.id))
  const added = unique.filter(workId => found.has(workId))
  const missing = unique.filter(workId => !found.has(workId))
  const insert = deps.db.raw.prepare(
    'INSERT OR IGNORE INTO work_albums (album_id, work_id, added_at) VALUES (?, ?, ?)',
  )
  const at = nowMs(deps)
  for (const workId of added) insert.run(id, workId, at)
  return { added, missing }
}

export function removeWorksFromAlbum(
  id: number, body: unknown, user: PublicUser, deps: AlbumDeps,
): { removed: number[]; missing: number[] } {
  loadOwned(id, user, deps)
  const unique = readIds(body)
  const marks = unique.map(() => '?').join(',')
  const linked = deps.db.raw.prepare(
    `SELECT work_id FROM work_albums WHERE album_id = ? AND work_id IN (${marks})`,
  ).all(id, ...unique) as { work_id: number }[]
  const found = new Set(linked.map(row => row.work_id))
  const removed = unique.filter(workId => found.has(workId))
  const missing = unique.filter(workId => !found.has(workId))
  const remove = deps.db.raw.prepare(
    'DELETE FROM work_albums WHERE album_id = ? AND work_id = ?',
  )
  for (const workId of removed) remove.run(id, workId)
  return { removed, missing }
}
