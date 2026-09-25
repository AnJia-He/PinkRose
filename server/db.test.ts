import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, MIGRATIONS } from './db.ts'

/**
 * 删临时库，连同 sqlite 的边车文件。**清不掉也不判红** —— 临时目录里的残留不说明
 * 任何被测行为对错，而 Windows 上杀软/索引器偶尔会短暂占住刚建出来的文件。
 */
function removeTempDb(file: string): void {
  try {
    for (const f of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true })
  } catch { /* 见上 */ }
}

describe('openDb', () => {
  it('建出 users 表，字段齐全', () => {
    const db = openDb(':memory:')
    const cols = db.raw.prepare(`SELECT name FROM pragma_table_info('users')`).all()
      .map((r: any) => r.name)
    expect(cols).toContain('id')
    expect(cols).toContain('username')
    expect(cols).toContain('email')
    expect(cols).toContain('password_hash')
    expect(cols).toContain('created_at')
    db.close()
  })

  it('username 和 email 都是唯一的 —— 靠数据库约束，不靠代码查', () => {
    const db = openDb(':memory:')
    const ins = db.raw.prepare(
      `INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)`)
    ins.run('a', 'a@x.com', 'h', 1)
    // 同一个 username、不同 email：必须被数据库拒绝
    expect(() => ins.run('a', 'b@x.com', 'h', 1)).toThrow()
    // 同一个 email、不同 username：也必须被拒绝
    expect(() => ins.run('b', 'a@x.com', 'h', 1)).toThrow()
    db.close()
  })

  it('迁移数组只增不改 —— 拿掉一条就会炸在旧库上', () => {
    const db = openDb(':memory:')
    const v = db.raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as any
    expect(v.v).toBe(MIGRATIONS.length)
    db.close()
  })

  /**
   * ⭐ 已发布迁移的**指纹清单**。
   *
   * `MIGRATIONS` 上面那句"只许往后追加、永远不许改或删已经发布过的那几条"是
   * 这一整段最重要的承诺（后面四段全压在它上面）—— 而在这条测试出现之前，
   * **它没有任何东西守着**：把 `MIGRATIONS[0]` 改掉一个字符，全仓测试照样全绿，
   * 而"新库"和"老库升上来的"从此长得不一样（现场跑过的那个不会重跑）。
   *
   * 用 sha256 而不是把 SQL 原文再抄一份：抄一份的话，改代码时顺手把抄件一起改掉
   * 照样绿 —— 那等于没守。
   *
   * ⚠️ 指纹**不含行尾差异**：JS 的模板字面量自己会把 CRLF 归一成 LF
   * （ECMAScript 的规定，本机实测：文件是 CRLF，字符串里一个 `\r` 都没有），
   * 所以这份清单不会因为换台机器（`core.autocrlf`）就红。
   *
   * **怎么维护**：以后每追加一条迁移，把它的指纹**加到清单末尾**（不是重新生成
   * 整份清单）。比较是**前缀**比，逐个来：追加（唯一被允许的那条路）不红，
   * 改老的、删老的必红。故意不做"整体相等"—— 那会让每次追加都红一次，
   * 而下一个人最省事的做法就是把测试打印出来的那几行整段贴回去；
   * 一个训练人闭眼重生成清单的守卫，等于没有守卫。
   */
  const PINNED_MIGRATIONS = [
    // 1 —— users
    '8a9a1a445d01f8ff0e9e242fc398e653048af972c4102686d3688c9758bff38a',
    // 2 —— works
    'd3e6d1ea45be136378599f2752dd8ad81e6f263687801de6e19fd9ecdc634bbb',
  ]

  it('★ 已发布的迁移一个字都不许改 —— 指纹对不上 = "老库和新库从此是两个形状"', () => {
    const actual = MIGRATIONS.map(m => createHash('sha256').update(m, 'utf8').digest('hex'))
    PINNED_MIGRATIONS.forEach((pinned, i) => {
      expect(actual[i],
        `第 ${i + 1} 条迁移的指纹变了。老库不会重跑它，所以这一改 = "新库"和"老库升上来的"` +
        `从此长得不一样（见 db.ts 里 MIGRATIONS 上面那条契约）。真要改结构：追加一条新的，别动老的。`,
      ).toBe(pinned)
    })
  })

  it('迁移在真文件上幂等 —— 同一个物理库开两次，第二次从 version=1 接着走', () => {
    // ⚠️ 这条不是上面「开两次不炸」的重复，是它的补丁：开两次 :memory: 开的是**两个全新的
    // 空库**，走的永远是 current === 0 那条路 —— 把迁移循环改成 `for (let i = 0; ...)`
    // 上面那条照样全绿（实测过）。而「同一个库升上来，不会重跑已经跑过的迁移」是迁移系统
    // 的核心承诺，后面加作品表/模型配置表/预设表全都压在这上面，只有真文件测得到。
    const file = join(tmpdir(), `ruixing-migrate-${process.pid}-${Date.now()}.db`)
    try {
      openDb(file).close()
      // 第二次开：users 已经在了，schema_version 已经是 1，循环必须从 1 起 ——
      // 从 0 起就会重跑建表，炸在 "table users already exists" 上。
      expect(() => { openDb(file).close() }).not.toThrow()
    } finally {
      // 清不掉也不能把测试判红：临时目录里的残留不说明任何被测行为对错，
      // 而 Windows 上杀软/索引器偶尔会短暂占住刚建出来的文件。顺带清 sqlite 的边车文件。
      try {
        for (const f of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
          rmSync(f, { force: true })
        }
      } catch { /* 见上：清理失败与被测行为无关 */ }
    }
  })

  // 「一条迁移里有多句、后一句炸了」是后面几段最常见的形状（建表 + 插默认行、
  // 建带外键的表）。下面两条分别盯住它的两种现场：全新的库，和已经升过级的库。
  const BAD = 'CREATE TABLE half_applied (id INTEGER); CREATE TABLE half_applied (id INTEGER);'

  it('★ 迁移串自带 BEGIN → 当场拒掉，而且说清是第几条', () => {
    // 谁要照抄 SQLite 官方那套"改表"配方（`PRAGMA foreign_keys=OFF; BEGIN; …; COMMIT;`），
    // 内层的 BEGIN 会撞上外层那个事务 —— 原来炸出来的是 SQLite 那句
    // `cannot start a transaction within a transaction`，**而且炸在开库这一步**：
    // 服务根本起不来、用户手里没有自救路径（正是 R20 要消灭的那一类）。
    // 现在在碰数据库之前就有一个说得清的结局。
    //
    // 三个样本各问一件事：BEGIN 被认出并报第几条、PRAGMA foreign_keys 也在名单里、
    // **触发器体里的 BEGIN/END 不许被误伤**（那是 CREATE TRIGGER 的一部分，不是独立语句）。
    // 条数跟着数组长度走，不写死字面量 —— 段三到段五还要各追加一条迁移，
    // 写死的话每次追加都得回来改这里（那是让测试追着代码跑，不是代码被测试守着）
    expect(() => openDb(':memory:', [...MIGRATIONS, 'BEGIN; CREATE TABLE x (id INTEGER); COMMIT;']))
      .toThrow(new RegExp(`第 ${MIGRATIONS.length + 1} 条[\\s\\S]*BEGIN[\\s\\S]*不许自带`))

    expect(() => openDb(':memory:', ['PRAGMA foreign_keys=OFF; CREATE TABLE y (id INTEGER);']))
      .toThrow(/第 1 条[\s\S]*PRAGMA foreign_keys/)

    // 反过来的那一半：合法迁移照常能跑（守卫是"拒绝这一种写法"，不是"拒绝一切"）
    const trigger = `
      CREATE TABLE log (id INTEGER);
      CREATE TRIGGER log_it AFTER INSERT ON log BEGIN UPDATE log SET id = id; END;
    `
    expect(() => openDb(':memory:', [...MIGRATIONS, trigger]).close()).not.toThrow()
  })

  it('迁移失败会回滚 —— 建到一半的表不许留下，版本也不许动', () => {
    const file = join(tmpdir(), `ruixing-rollback-${process.pid}-${Date.now()}.db`)
    try {
      // 连开三次：每次都必须以同样的方式失败，而且**不许每失败一次就往版本表里再塞一行 0**
      for (let n = 0; n < 3; n++) expect(() => openDb(file, [BAD])).toThrow()

      // 拿一个空迁移序列把库打开看现场 —— 观测本身不改变任何状态（见 openDb 的注释）
      const probe = openDb(file, [])
      try {
        // 第一句建的表必须不在：不在 = 回滚了 = 下次还能重试。在 = 这个库永久卡死
        expect(probe.raw.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='half_applied'`).get()).toBeUndefined()
        expect(probe.raw.prepare('SELECT COUNT(*) AS n FROM schema_version').get()).toEqual({ n: 1 })
        expect(probe.raw.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({ v: 0 })
      } finally { probe.close() }
    } finally { removeTempDb(file) }
  })

  it('★ COMMIT 自己抛（延迟外键）也不许留下半个状态 —— 版本停在原地、库照样打得开', () => {
    // 别的"迁移失败"用例炸的都是**某一句语句**；这一条炸的是 **COMMIT 本身** ——
    // 也就是"语句全过了、最后一步才失败"那个现场（盘满也是这一种）。
    //
    // 怎么造出来：**延迟外键**。违反外键的那一句在 INSERT 时不报错，一直留到 COMMIT
    // 才查出来（实测：`FOREIGN KEY constraint failed`）。盘满没法在测试里复现，
    // 但两者在代码里是同一条路 —— COMMIT 抛了。
    //
    // ⚠️ **这一条钉的是"结局"，不是 finally 里那两句话本身。** 实测过：把 finally
    // 里那两行拿掉（等价于把 COMMIT 挪回 try 外面，也就是修复前的形状），这条**照样绿**。
    //
    // 但**"照样绿"不等于"没事了"** —— 它绿的原因是这条用例**看不见**：
    // 那个连接没提交的建表动作，对另一个连接本来就不可见。所以下面那几条断言过，
    // 不是因为状态干净，是因为它们看的是**旧快照**。
    //
    // 顺带纠正一个想当然 —— **SQLite 不会因为 COMMIT 失败就自己回滚**（实测过）。
    // 事务会**留在打开状态**，连接一直占着文件：新连接写不进去、文件删都删不掉
    // （EPERM）。盘满是同一条路。
    //
    // **所以 finally 里那两行不是可有可无的兜底 —— 它们就是这里唯一的清理**，
    // 守的是"每次启动都炸 + 用户没有自救路径"那一类。别把这条
    // 测试当成它们的守卫，更别因为“删了它照样绿”就把它们删掉。
    const file = join(tmpdir(), `ruixing-commit-${process.pid}-${Date.now()}.db`)
    const DEFERRED_FK = `
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER, pid INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
      INSERT INTO child (id, pid) VALUES (1, 999);
    `
    try {
      openDb(file).close()                                  // 先正常升到当前版本（MIGRATIONS.length）
      expect(() => openDb(file, [...MIGRATIONS, DEFERRED_FK])).toThrow()

      // 现场：那两张表一个都不能留下，版本也得停在当前版本（MIGRATIONS.length），
      // 而且这个库还得能重新打开 —— "下次还能重试"就是靠这三件一起成立的。
      const probe = openDb(file, [])
      try {
        for (const t of ['parent', 'child']) {
          expect(probe.raw.prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t)).toBeUndefined()
        }
        expect(probe.raw.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({ v: MIGRATIONS.length })
      } finally { probe.close() }

      // 再来一次：失败不许有累积效应（每失败一次留一点东西的写法，这里会开始不一样）
      expect(() => openDb(file, [...MIGRATIONS, DEFERRED_FK])).toThrow()
      const again = openDb(file, [])
      try {
        expect(again.raw.prepare('SELECT COUNT(*) AS n FROM schema_version').get()).toEqual({ n: 1 })
      } finally { again.close() }
    } finally { removeTempDb(file) }
  })

  it('已经升过级的库，新追加的迁移失败时版本号不动', () => {
    const file = join(tmpdir(), `ruixing-upgrade-${process.pid}-${Date.now()}.db`)
    try {
      openDb(file).close()                                  // 先正常升到当前版本（MIGRATIONS.length）
      expect(() => openDb(file, [...MIGRATIONS, BAD])).toThrow()

      const probe = openDb(file, [])
      try {
        expect(probe.raw.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({ v: MIGRATIONS.length })
        expect(probe.raw.prepare('SELECT COUNT(*) AS n FROM schema_version').get()).toEqual({ n: 1 })
        expect(probe.raw.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='half_applied'`).get()).toBeUndefined()
      } finally { probe.close() }
    } finally { removeTempDb(file) }
  })

  it('★ 从只有 users 的老库升上来，能拿到 works 表 —— 用户的库就是这么长大的', () => {
    const file = join(tmpdir(), `ruixing-upgrade-works-${process.pid}-${Date.now()}.db`)
    try {
      // 造一个"还在第一版"的库：只跑第一条迁移
      openDb(file, [MIGRATIONS[0]!]).close()
      // 再用完整的迁移数组开 —— 老用户的库就是这样升上来的
      const db = openDb(file)
      try {
        const tables = db.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
          .map((r) => (r as { name: string }).name)
        expect(tables).toContain('works')
        const v = db.raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }
        expect(v.v).toBe(MIGRATIONS.length)
      } finally { db.close() }
    } finally { removeTempDb(file) }
  })

  it('works.user_id 指着一个不存在的用户 → 数据库拒绝', () => {
    const db = openDb(':memory:')
    const ins = db.raw.prepare(
      `INSERT INTO works (user_id, stored_name, thumb_name, bytes, created_at, updated_at, alias, recipe)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    expect(() => ins.run(999, 'a.jpg', null, 1, 1, 1, null, '{}')).toThrow(/FOREIGN KEY constraint failed/)
    db.close()
  })

  it('★ 还有作品没删，就删不掉这个用户 —— 逼代码去删文件', () => {
    // ⚠️ 这里**刻意不加** `ON DELETE CASCADE`。
    // 级联只删数据库里的记录，硬盘上那几百 MB 图片文件它删不到 ——
    // 于是删了用户、文件永远留在盘上，而且**没有任何东西会报错**。
    // 不加级联的话，还有作品时数据库直接拒绝删用户：段三做「注销」的人
    // **必须**先显式删作品（连带删文件）。把"不会错"做成结构，不做成纪律。
    const db = openDb(':memory:')
    db.raw.prepare(
      `INSERT INTO users (username, email, password_hash, created_at) VALUES ('a','a@x.com','h',1)`).run()
    db.raw.prepare(
      `INSERT INTO works (user_id, stored_name, thumb_name, bytes, created_at, updated_at, alias, recipe)
       VALUES (1, 'a.jpg', null, 1, 1, 1, null, '{}')`).run()
    expect(() => db.raw.prepare('DELETE FROM users WHERE id = 1').run()).toThrow(/FOREIGN KEY constraint failed/)
    db.close()
  })
})
