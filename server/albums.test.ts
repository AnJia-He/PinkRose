import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from './db.ts'
import { createStorage, type Storage } from './storage.ts'
import { handleCreateWork, handleListWorks } from './works.ts'
import {
  addWorksToAlbum, createAlbum, deleteAlbum, listAlbums,
  removeWorksFromAlbum, renameAlbum,
} from './albums.ts'
import type { PublicUser } from './account.ts'
import { b64Of, jpegBytes } from './testImages.ts'

const USER: PublicUser = { id: 1, username: '小明', email: 'a@x.com' }
const OTHER: PublicUser = { id: 2, username: '小红', email: 'b@x.com' }
const JPEG = `data:image/jpeg;base64,${b64Of(jpegBytes(64))}`

let root: string
let db: Db
let storage: Storage
let deps: { db: Db; storage: Storage; now: () => number }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ruixing-albums-'))
  db = openDb(':memory:')
  const insert = db.raw.prepare(
    'INSERT INTO users (username, email, password_hash, created_at) VALUES (?,?,?,?)',
  )
  insert.run(USER.username, USER.email, 'h', 1)
  insert.run(OTHER.username, OTHER.email, 'h', 1)
  storage = createStorage(root)
  deps = { db, storage, now: () => 1_700_000_000_000 }
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('albums', () => {
  it('新建 / 重命名 / 删除相册，计数跟着 membership 走', async () => {
    const { album } = createAlbum({ name: '旅行' }, USER, deps)
    expect(listAlbums(USER, deps).albums).toEqual([{
      ...album, workCount: 0,
    }])
    const work = await handleCreateWork({ image: JPEG }, USER, deps)
    addWorksToAlbum(album.id, { ids: [work.id] }, USER, deps)
    expect(listAlbums(USER, deps).albums[0]?.workCount).toBe(1)
    expect(renameAlbum(album.id, { name: '海边' }, USER, deps).album.name).toBe('海边')

    deleteAlbum(album.id, USER, deps)
    expect(listAlbums(USER, deps).albums).toEqual([])
    // 删相册不删照片
    expect(handleListWorks(USER, deps).works.map(item => item.id)).toEqual([work.id])
  })

  it('相册名去重、长度校验；别人的相册当不存在', () => {
    const { album } = createAlbum({ name: '旅行' }, USER, deps)
    expect(() => createAlbum({ name: '旅行' }, USER, deps)).toThrow(/已经有一个/)
    expect(() => createAlbum({ name: '' }, USER, deps)).toThrow(/1–40/)
    expect(() => renameAlbum(album.id, { name: 'x' }, OTHER, deps)).toThrow(/没有这个相册/)
  })

  it('加入 / 移出作品：只收自己的作品，缺失 id 如实回报', async () => {
    const { album } = createAlbum({ name: '精选' }, USER, deps)
    const a = await handleCreateWork({ image: JPEG }, USER, deps)
    const b = await handleCreateWork({ image: JPEG }, USER, deps)
    const other = await handleCreateWork({ image: JPEG }, OTHER, deps)

    expect(addWorksToAlbum(album.id, { ids: [a.id, b.id, other.id, 99999] }, USER, deps))
      .toEqual({ added: [a.id, b.id], missing: [other.id, 99999] })
    expect(handleListWorks(USER, deps, album.id).works.map(item => item.id).sort())
      .toEqual([a.id, b.id].sort())

    expect(removeWorksFromAlbum(album.id, { ids: [a.id, 99999] }, USER, deps))
      .toEqual({ removed: [a.id], missing: [99999] })
    expect(handleListWorks(USER, deps, album.id).works.map(item => item.id)).toEqual([b.id])
  })
})
