import type { Db } from './db.ts'
import { HttpError } from './http.ts'

/**
 * 每人的存储配额（spec §6.6）。
 *
 * ⚠️ **口径：作品 + 会话 + 滤镜的文件都算**。设计文档那张表上写的是"作品容量
 * （约 2500 张）"，但真正会长的是**会话**（每上传一张照片都要存原图 + 每一步的底）——
 * 只卡作品等于把审计那条"可无限写"原样留着。滤镜（2026-10-05 起）同样睡在这块盘上，
 * 30 个 × 8 MB 是它的上界。
 *
 * ⚠️ **为什么要有它**（spec 原话）：**不是防用户，是防止一个人把整台服务搞挂** ——
 * 数据库和图片在**同一块盘**上，图片把盘塞满之后，注册、登录、看作品集
 * **全部**失败：一个人堆满盘，所有人都用不了。
 */
export const QUOTA_BYTES = 5 * 1024 ** 3

/** 这一位**总共占了多少**（作品 + 会话 + 滤镜名下的文件字节）。 */
export function storedBytes(db: Db, userId: number): number {
  const w = db.raw
    .prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM works WHERE user_id = ?')
    .get(userId) as { n: number }
  const s = db.raw
    .prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM sessions WHERE user_id = ?')
    .get(userId) as { n: number }
  // ★ 2026-10-05：滤镜也是用户的文件、也睡在同一块盘上（每人 30 个 × 8 MB 是上界）。
  const l = db.raw
    .prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM luts WHERE user_id = ?')
    .get(userId) as { n: number }
  return w.n + s.n + l.n
}

/**
 * 再来 `incoming` 字节会不会超？会就抛（413）。
 *
 * `freeing` = **这一笔写入同时会释放掉的字节**（替换作品时是旧文件的大小）——
 * 不扣掉它的话，一个人在 99.9% 的时候连"换一张更小的"都做不了。
 *
 * 文案照 spec §6.6 那张"满了"的说法：**先让他拿到图，再给一条明路**
 * （只说"满了"等于把人拉进一个没有门的房间）。
 */
export function assertRoomFor(
  db: Db, userId: number, incoming: number,
  what: 'work' | 'session' | 'lut', freeing = 0,
): void {
  if (storedBytes(db, userId) - freeing + incoming <= QUOTA_BYTES) return
  const message = what === 'work'
    // ★ 2026-10-11（设计跟进 T4 fix）：句子里这颗按钮的名字是「下载」—— 它经
    // `saveFail.why` **原样**显示在那条存失败横幅上，就挨着那颗按钮；这里还写
    // 「下载到电脑」的话，用户照着去屏幕上找一个不存在的字（评审抓的漏网）。
    // 名字有守卫：`works.test.ts` 那条正则连「下载」一起钉。
    ? '空间满了（5 GB）。这张图已经给你了，但没能存进作品集 —— 先用「下载」拿到手，再去作品集删几张腾地方。'
    : what === 'lut'
      ? '空间满了（5 GB）。先去作品集删几张，再导入新的 Lut。'
      : '空间满了（5 GB）。先去作品集删几张，再上传新的。'
  throw new HttpError('BAD_REQUEST', message, 413)
}
