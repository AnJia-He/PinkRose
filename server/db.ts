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
 *
 * `migrations` 是给测试留的：要验"迁移失败会不会留下半个状态"，就得往序列里塞一条会炸的。
 * 做成参数，而不是让测试去 push/pop `MIGRATIONS` —— 那个数组的整个契约就是"只许追加"，
 * 让测试亲手示范一个不该有的用法，比多一个参数贵。生产路径永远走默认值。
 */
export function openDb(path: string, migrations: readonly string[] = MIGRATIONS): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const raw = new sqlite.DatabaseSync(path)

  // 外键默认是关的，得显式打开。现在只有一个表用不上，
  // 但后面 works.user_id 要靠它保证删用户时不留孤儿。
  raw.exec('PRAGMA foreign_keys = ON')

  raw.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`)
  const row = raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null } | undefined
  const version = row?.v ?? null
  // ⚠️ 判"空表"要用 null，**不能用 0**：迁移失败之后 MAX 正好停在 0，
  // 拿 0 当"空"就会每失败一次再插一行 version=0（实测：连开三次失败，表里攒到 4 行）。
  if (version === null) raw.prepare('INSERT INTO schema_version (version) VALUES (0)').run()
  const current = version ?? 0

  for (let i = current; i < migrations.length; i++) {
    // 一条迁移里的多条语句必须**一起生效或一起不生效**。SQLite 的 DDL 是事务性的，包上就够。
    // 不包的后果：迁移第二句失败时，第一句建出来的表已经永久生效而版本没记上，
    // 下次开库从同一条重跑 → 撞 already exists → 每次启动都炸，**而且用户没有自救路径**。
    // 今天只有一条单句 DDL 触发不了，但后面几段全是"建表 + 插默认行"这种两句起步的。
    raw.exec('BEGIN')
    try {
      raw.exec(migrations[i]!)
      raw.prepare('UPDATE schema_version SET version = ?').run(i + 1)
    } catch (e) {
      // 回滚失败也不能盖掉原始错误 —— 用户要看的是"哪条迁移炸了"，不是"回滚也炸了"
      try { raw.exec('ROLLBACK') } catch { /* 见上 */ }
      // 把手柄关掉再抛。不然失败的那个库一直占着文件，Windows 上删除会被拒（EPERM）
      raw.close()
      throw e
    }
    raw.exec('COMMIT')
  }

  return {
    raw,
    close: () => raw.close(),
  }
}
