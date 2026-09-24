import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

/**
 * 为什么不是 `import { DatabaseSync } from 'node:sqlite'`：
 *
 * vitest 的模块加载器（vite-node）判断"这是不是内置模块"的办法，是先把 `node:` 前缀**剥掉**、
 * 再拿裸名去比对内置名单 —— 而 Node 的 `module.builtinModules` 里存的偏偏是带前缀的
 * `node:sqlite`。于是它剥成 `sqlite`，既不在名单里、也不是一个真实存在的包，测试直接报
 * `Cannot find package 'sqlite'`。`node:test` 当年踩的是同一个坑，上游给 vite-node 开了张
 * 白名单（vitest-dev/vitest#7179）；`node:sqlite` 的修复只进了 vitest 3，而这里用的是 2.1.9。
 *
 * `process.getBuiltinModule` 是 Node 22.3 起自带的、按模块名直接取内置模块的入口，不经过
 * 打包器/加载器 —— 测试和真跑（`node server/index.ts`）因此走的是同一条路。类型是准的：
 * @types/node 的内置模块表里就有 `node:sqlite`，不需要任何 cast。
 *
 * ⚠️ 只有这一个文件需要绕。外面的人只认 `openDb` 和 `Db`，碰不到 node:sqlite。
 */
const sqlite = process.getBuiltinModule('node:sqlite')

/**
 * 建表语句，**下标 + 1 = 版本号**。
 *
 * ⚠️ 只许往后追加，永远不许改或删已经发布过的那几条 —— 用户的库是按顺序跑过来的，
 * 改一条老的就等于让"新库"和"老库升上来的"长得不一样，而现场已经跑过的那个不会重跑。
 * 要改结构就追加一条新的（ALTER TABLE / 新建表都行）。
 */
export const MIGRATIONS: readonly string[] = [
  // 1 —— users
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    created_at    INTEGER NOT NULL
  );
  `,
]

export type Db = {
  raw: DatabaseSync
  close(): void
}

/**
 * 开库并跑迁移。
 *
 * 传 ':memory:' 时不开文件（测试用）。传路径时会先把父目录建出来 ——
 * 不然第一次跑会因为 data/ 不存在而挂在一个跟数据库无关的错误上。
 */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const raw = new sqlite.DatabaseSync(path)

  // 外键默认是关的，得显式打开。现在只有一个表用不上，
  // 但后面 works.user_id 要靠它保证删用户时不留孤儿。
  raw.exec('PRAGMA foreign_keys = ON')

  raw.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`)
  const row = raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }
  const current = row?.v ?? 0
  if (current === 0) raw.prepare('INSERT INTO schema_version (version) VALUES (0)').run()

  for (let i = current; i < MIGRATIONS.length; i++) {
    raw.exec(MIGRATIONS[i]!)
    raw.prepare('UPDATE schema_version SET version = ?').run(i + 1)
  }

  return {
    raw,
    close: () => raw.close(),
  }
}
