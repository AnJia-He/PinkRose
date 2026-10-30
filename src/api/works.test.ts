import { describe, it, expect } from 'vitest'
import { fileUrl } from './works'
import type { WorkMeta } from '../../shared/works.ts'

const w = (hasThumb: boolean): WorkMeta =>
  ({ id: 7, alias: null, createdAt: 0, updatedAt: 1_700_000_000_000, bytes: 0, hasThumb, rating: 0, flag: 0 })

describe('fileUrl', () => {
  it('有缩略图就走 /thumb —— 列表上那张小图，别拿原图当缩略图下', () => {
    expect(fileUrl(w(true))).toBe('/api/works/7/thumb?v=1700000000000')
  })

  it('★ 没有缩略图退回原图 /file；两条分支都钉住 `?v=<updatedAt>`', () => {
    // 版本号是"替换过一张之后 id 没变、浏览器却缓存了上一版"的唯一解药
    // （替换接口回长缓存 immutable）—— 顺手去掉它，两个分支都会拿到旧的。
    expect(fileUrl(w(false))).toBe('/api/works/7/file?v=1700000000000')
  })
})
