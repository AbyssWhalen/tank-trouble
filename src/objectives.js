// ============================================================
// objectives.js — 可插拔胜负条件（纯数据 + 纯函数）
// 零依赖（连 config 都不 import），smoke 可直接断言整张真值表。
//
// 为什么单独一层：阶段 27 之前「赢没赢」散在三处且语义打架——challenge 在
// levels.js 里有一份带「玩家死优先」的正确实现，wave 在 main.js 里内联
// 「配额清零 && 场上零敌」，pvp/pve 在 main.js 里内联「存活 ≤1」。再加一种
// 目标类型（守点波）这笔债就要翻倍，所以先把判定抽成一张可插拔的表。
//
// **「玩家死 → lose」只在 evaluate 的第一行写一次**，条件函数里一律不重复：
// 同帧同归于尽算失败（挑战要活着赢）是全游戏统一的规则，两处实现必然跑偏。
//
// ctx 字段表（每个条件只读自己关心的那几个，缺字段一律退化成「继续打」）：
//   playerAlive  bool    玩家坦克是否还活着
//   enemiesAlive int     场上活着的敌人数
//   quotaLeft    number  波次：本波还没投放完的余额（Infinity = 无限压力）
//   elapsed      number  本关/本波已过秒数（**单调递增**，不是倒计时）
//   holdSecs     number  已累计的守点秒数
//
// elapsed 的单一语义是刻意的：旧的 `levelTimer` 在 survive 关是已过秒数、
// 在 eliminateTimed 关是**剩余**秒数——同一个变量两种意思，HUD 得靠 objective
// 字符串二次分流才显示得对。现在限时目标自己拿 elapsed 跟 secs 比，HUD 合流。
//
// pvp/pve 的回合结束**刻意不折进来**：evaluate 只回答「赢没赢」，而 pvp 还得
// 回答「谁赢」（matchScores 要 winner index）。硬塞要么给返回值加字段污染五个
// 单人型，要么在调用处再判一次——收益 ≈2 行，风险落在最常玩的模式上，不划算。
// ============================================================

// 缺 secs / 坏 secs 一律当「这个计时条件永不达成」（Infinity）而不是当 0：
// 参数缺失时宁可让目标继续跑，也不要白送一个 win 或白判一个 lose。
const needOf = (p) =>
  typeof p?.secs === "number" && Number.isFinite(p.secs) && p.secs > 0 ? p.secs : Infinity;

// 条件表：(ctx, params) → "win" | "lose" | null（null = 继续打）。
// 加新型只在这里加一行 + 在 smoke 真值表里加一格，调用方零改动。
export const OBJECTIVES = {
  // 歼灭：场上零敌即过（关卡主力，也是未知型的退化目标）
  eliminate: (c) => (c.enemiesAlive === 0 ? "win" : null),
  // 存活：熬满 secs，或**威胁清零**提前过关（空场硬熬计时没意义，用户实测反馈）
  survive: (c, p) => (c.enemiesAlive === 0 || c.elapsed >= needOf(p) ? "win" : null),
  // 限时歼灭：清场即胜、超时判负。清场优先——同帧到点也算赢
  eliminateTimed: (c, p) => (c.enemiesAlive === 0 ? "win" : c.elapsed >= needOf(p) ? "lose" : null),
  // 清空配额：波次生存的常规波——投放余额清零**且**场上零敌才算过波
  clearQuota: (c) => (c.quotaLeft <= 0 && c.enemiesAlive === 0 ? "win" : null),
  // 守点：站在区域里累计 secs 秒。**没有失败态**——守不住就继续打，唯一的失败
  // 仍然是死（一条命模式里给 boss 波加时限 = 硬墙 = 到此为止，软墙才对）
  hold: (c, p) => (c.holdSecs >= needOf(p) ? "win" : null),
};

// 判定入口。objective = { type, secs? }；未知/拼错的 type 退化成 eliminate（不抛）。
export function evaluate(objective, ctx) {
  if (!ctx || !ctx.playerAlive) return "lose"; // ← 唯一一处，别在别处再写
  const fn = OBJECTIVES[objective && objective.type] || OBJECTIVES.eliminate;
  return fn(ctx, objective || {}) ?? null;
}
