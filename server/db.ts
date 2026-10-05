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
 *
 * ⚠️ **迁移串里不许自带 `BEGIN` / `COMMIT` / `ROLLBACK` / `PRAGMA foreign_keys`** ——
 * 外层已经把它整条包进事务了（见 openDb）。这一条不是洁癖，是有人一定会踩的坑：
 * **SQLite 官方那套"改表"配方正是 `PRAGMA foreign_keys=OFF; BEGIN; …; COMMIT;`**
 * （建新表 → 拷数据 → 删旧表 → 改名，中间那两句就是这个形状）。照抄进来，
 * 内层的 `BEGIN` 会抛 `cannot start a transaction within a transaction`，
 * 而且**炸在开库那一步** —— 服务根本起不来，用户手里也没有自救路径。
 * 同一段配方里的 `PRAGMA foreign_keys` 更阴：事务里它是**静默的空操作**，
 * 写的人以为自己关掉了外键，其实没有。
 * 设计文档 §12 排着四段，每段都要往这个数组里追加 —— 所以这句契约写在这儿，
 * 并且由 openDb 里那道守卫**当场拒掉**（不是等 SQLite 抛一句看不懂的话）。
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
  // 2 —— works（作品集，第二段）
  `
  CREATE TABLE works (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    stored_name TEXT    NOT NULL,
    thumb_name  TEXT,
    bytes       INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    alias       TEXT,
    recipe      TEXT    NOT NULL
  );
  CREATE INDEX works_user_updated ON works(user_id, updated_at);
  `,
  // 3 —— model_configs + users 上两个指针（spec §4.1 / §7.4）
  //
  // ★ 两件事值得写在这儿：
  //
  //   ① `kind` 上的 CHECK 是**结构**，不是纪律。「chat 和 image 彻底分开」
  //      这条要是靠代码记得判，就一定会有人忘；写进表里就忘不掉。
  //
  //   ② 两个指针用 **REFERENCES … ON DELETE SET NULL** —— 删掉正在用的那一套时，
  //      指针**自己就指空了**，于是"回默认"是结构上的必然，
  //      不是"记得写一句 if"。这和 §6.5 那个"改密码 = 所有设备下线"
  //      是同一个套路：把不会错做成结构。
  //
  // ⚠️ 必须先建表再改 users：两条语句在同一个事务里，但 SQLite 建表时会检查
  //    被引用的表存在（外键在 node:sqlite 里默认是开的）。
  `
  CREATE TABLE model_configs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT    NOT NULL CHECK (kind IN ('chat', 'image')),
    provider     TEXT    NOT NULL,
    base_url     TEXT,
    api_key_enc  TEXT    NOT NULL,
    model_id     TEXT    NOT NULL,
    alias        TEXT    NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX model_configs_user ON model_configs(user_id, kind);
  ALTER TABLE users ADD COLUMN active_chat_config_id  INTEGER REFERENCES model_configs(id) ON DELETE SET NULL;
  ALTER TABLE users ADD COLUMN active_image_config_id INTEGER REFERENCES model_configs(id) ON DELETE SET NULL;
  `,
  // 4 —— 会话表（2026-10-01）。设计：docs/superpowers/specs/2026-10-01-sessions-design.md
  //
  // 一次会话 = 一张上传的照片。和 `works` 是**两层，不合并**：
  // 会话是过程（对话 + 每一步），作品是产物（用户挑出来存下的那张成图）。
  //
  // ⚠️ `original_name` 存的是**用户那张照片原来的名字**（`古镇.jpg`），
  //    和 `original` 不是一回事 —— 后者是 storage 层给的文件名，是不透明的。
  //    它有两个用处，都写进 spec 了：§6.3 列表上"没说过话的会话"叫什么，
  //    以及恢复出来的会话「下载」时文件叫什么。
  //
  // ⚠️ `files` 这一列是**安全 + 收尸**两件事的落点，别当成冗余：
  //   · 安全：`steps` 里每一步指向哪个文件，没有这份名单就没法验证
  //     "这个文件确实属于这条会话"（`requireOwnFile`）；
  //   · 收尸：删会话时要知道该删哪几个文件，不然盘上留一堆孤儿。
  `CREATE TABLE sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      title         TEXT,
      original      TEXT NOT NULL,
      original_name TEXT,
      base          TEXT NOT NULL,
      thumb         TEXT,
      messages      TEXT NOT NULL,
      steps         TEXT NOT NULL,
      files         TEXT NOT NULL
    );
    CREATE INDEX sessions_user_updated ON sessions(user_id, updated_at DESC);`,
  // 5 —— sessions 的**字节数**（2026-10-04，为 §6.6 的 5 GB 配额）
  //
  // ⚠️ 老行是 0，由开机时的 `backfillSessionBytes`（sessions.ts）补齐 ——
  //    迁移串里只有 SQL，够不到磁盘上的文件大小。
  // ⚠️ 口径：这一列是"这条会话名下的文件一共多少字节"（原图 + 各步的底 + 缩略图），
  //    和 `files` 那份名单是一套东西的两面 —— 加文件的地方两个都要动。
  `ALTER TABLE sessions ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;`,
  // 6 —— 滤镜（LUT，2026-10-05）。设计：docs/superpowers/specs/2026-10-05-lut-design.md
  //
  // ⚠️ `name` 上的 COLLATE NOCASE：对话里靠**名字**对号，"Sunset" 和 "sunset"
  //    同时存在会让模型和用户都认不出该选哪个；中文没有大小写，不受影响。
  // ⚠️ 文件在 data/luts（不在这张表里）——名字由 storage 层发，和照片同一套规矩。
  `
  CREATE TABLE luts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL COLLATE NOCASE,
      stored_name TEXT    NOT NULL,
      size        INTEGER NOT NULL,
      bytes       INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      UNIQUE(user_id, name)
    );
    CREATE INDEX luts_user ON luts(user_id);
  `,
]

/**
 * 迁移串里不该出现的语句：**句首的**事务控制语句，和 `PRAGMA foreign_keys`。
 *
 * 两个刻意的取舍：
 * - 只认"句首"（串开头、或分号后面）那一种。所以触发器体里的
 *   `CREATE TRIGGER … BEGIN … END;` 不会误伤：那里面的 BEGIN / END 属于
 *   CREATE TRIGGER 这一句，不是独立的语句（END 因此干脆不进这个名单 ——
 *   触发器体里 `…; END;` 太常见，而它当 COMMIT 的用法本来就罕见）。
 * - 不用 `m` 标志：`^` 是整串的开头，不是每一行的开头。行首缩进的 BEGIN
 *   要拦，靠的是它前面那个分号。
 */
const FORBIDDEN_IN_MIGRATION =
  /(?:^|;)\s*(BEGIN|COMMIT|ROLLBACK|PRAGMA\s+foreign_keys)\b/i

/**
 * 迁移数组的契约检查。**在碰数据库之前**跑 —— 契约被违反是写代码时的事，
 * 不该先建库建到一半再发现。
 *
 * 错误信息里要带上**是第几条**：这个数组只会越来越长，只说"有非法语句"
 * 等于让下一个人自己一条条翻。
 */
function assertMigrationsArePlain(migrations: readonly string[]): void {
  migrations.forEach((sql, i) => {
    const hit = FORBIDDEN_IN_MIGRATION.exec(sql)
    if (!hit) return
    throw new Error(
      `第 ${i + 1} 条迁移里有 "${hit[1]}" —— 迁移串不许自带事务控制语句 / PRAGMA foreign_keys，` +
      '外层已经整条包进事务了（见 db.ts 里 MIGRATIONS 上面那段契约）。' +
      'SQLite 官方那套"改表"配方就是 PRAGMA foreign_keys=OFF + BEGIN + … + COMMIT，照抄会炸在开库这一步。',
    )
  })
}

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
 *
 * 传进来的那一份也要守 `MIGRATIONS` 上面那条契约（不许自带开始/结束事务的语句），
 * 由 assertMigrationsArePlain 当场拒掉 —— 测试塞坏迁移时要的是"这条迁移本身炸"，
 * 不是"绕开契约去测另一种炸法"。
 */
export function openDb(path: string, migrations: readonly string[] = MIGRATIONS): Db {
  // 先验契约，再碰文件 —— 数组写坏了不该先建出一个库来才发现
  assertMigrationsArePlain(migrations)
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const raw = new sqlite.DatabaseSync(path)

  // 外键。SQLite 自身的默认是**关**的，容易想当然把这一句当"承重句" ——
  // 实测不是：node:sqlite 的 DatabaseSync 默认就开着外键
  // （enableForeignKeyConstraints 默认 true，PRAGMA 读出来是 1），
  // **拿掉这一句，db.test.ts 全绿**。真正守"删用户不留孤儿"的是那两条行为用例
  // （拒绝孤儿作品、拒绝删还有作品的用户）—— 它们守的是"外键在拦"这个事实，
  // 不关心开关是谁打开的。这一句留着：不依赖驱动默认值。
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
    // 第 2 条迁移就是"两句"的（建表 + 建索引）—— 这条路已经真的在开库里走过了，
    // 不是"以后总会遇到"。
    //
    // ★ 三句（BEGIN / 语句 / COMMIT）**全在 try 里面、收拾全在 finally 里**：
    //   COMMIT 自己也会抛（盘满、延迟外键检查），而它原来站在 try 外面 ——
    //   那样一来这次失败既不 ROLLBACK 也不 close，和上面那段要防的是同一个后果。
    //   用 `inTransaction` 而不是"无条件 ROLLBACK"：成功那条路上没有事务可回滚，
    //   硬滚只会多抛一个要吞掉的错。
    let inTransaction = false
    try {
      raw.exec('BEGIN')
      inTransaction = true
      raw.exec(migrations[i]!)
      raw.prepare('UPDATE schema_version SET version = ?').run(i + 1)
      raw.exec('COMMIT')
      inTransaction = false
    } finally {
      if (inTransaction) {
        // 回滚失败也不能盖掉原始错误 —— 用户要看的是"哪条迁移炸了"，不是"回滚也炸了"
        try { raw.exec('ROLLBACK') } catch { /* 见上 */ }
        // 把手柄关掉再抛。不然失败的那个库一直占着文件，Windows 上删除会被拒（EPERM）
        raw.close()
      }
    }
  }

  return {
    raw,
    close: () => raw.close(),
  }
}
