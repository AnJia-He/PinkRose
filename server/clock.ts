/**
 * 「现在几点」只有这一处知道。
 *
 * ★ 2026-10-09 收口：`deps.now ?? Date.now` 这行原来在 `luts.ts` / `sessions.ts` /
 *   `works.ts` 里各写了一份（还是两种写法：三元的和 `??` 的），`app.ts` 里
 *   还有第四份内联的。四份 = 四个"哪天加了时区/偏移，只改了三个"的机会。
 *
 * ⚠️ 依赖里那个可选的 `now` 是**测试拨钟**用的：各模块的 deps 都带着它，
 *   传了就用它、没传用真实时间。**全服务端只能有这一个钟** ——
 *   两边各用一个的话，测试里拨动的时间就只对一半代码生效
 *   （`app.ts` 的 `renewSessionIfStale` 那句注释记着这条）。
 */
export type ClockDeps = { now?: () => number }

export const nowMs = (deps: ClockDeps): number => (deps.now ? deps.now() : Date.now())
