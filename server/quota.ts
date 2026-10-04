import type { Db } from './db.ts'
import { HttpError } from './http.ts'

/**
 * 每人的存储配额（spec §6.6）。
 *
 * ⚠️ **口径：作品 + 会话的文件都算**。设计文档那张表上写的是"作品容量
 * （约 2500 张）"，但真正会长的是**会话**（每上传一张照片都要存原图 + 每一步的底）——
 * 只卡作品等于把审计那条"可无限写"原样留着。
 *
 * ⚠️ **为什么要有它**（spec 原话）：**不是防用户，是防止一个人把整台服务搞挂** ——
 * 数据库和图片在**同一块盘**上，图片把盘塞满之后，注册、登录、看作品集
 * **全部**失败：一个人堆满盘，所有人都用不了。
 */
export const QUOTA_BYTES = 5 * 1024 ** 3

/** 这一位**总共占了多少**（作品 + 会话名下的文件字节）。 */
export function storedBytes(db: Db, userId: number): number {
  const w = db.raw
    .prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM works WHERE user_id = ?')
    .get(userId) as { n: number }
  const s = db.raw
    .prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM sessions WHERE user_id = ?')
    .get(userId) as { n: number }
  return w.n + s.n
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
  what: 'work' | 'session', freeing = 0,
): void {
  if (storedBytes(db, userId) - freeing + incoming <= QUOTA_BYTES) return
  const message = what === 'work'
    ? '空间满了（5 GB）。这张图已经给你了，但没能存进作品集 —— 先用「下载到电脑」拿到手，再去作品集删几张腾地方。'
    : '空间满了（5 GB）。先去作品集删几张，再上传新的。'
  throw new HttpError('BAD_REQUEST', message, 413)
}
