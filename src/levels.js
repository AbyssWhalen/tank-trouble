// ============================================================
// levels.js — 挑战关卡模式：关卡表 + 过关判定（纯数据 + 纯函数）
// 零浏览器依赖（只 import config 常量名），smoke 可直接断言。
// 进度持久化在 settings.js（loadChallengeProgress/saveChallengeProgress）；
// 关卡流转（LEVEL_OVER 状态机/setupRound 分支）在 main.js。
//
// 关卡 schema：
//   objective  "eliminate"        歼灭全部敌人
//              "survive"          存活 mutators.surviveTime 秒
//              "eliminateTimed"   mutators.timeLimit 秒内歼灭全部敌人
//   map        { tier, style }    确定性指定（关卡设计不随机抽图）
//   enemies    [{ level, spawn }] spawn ∈ tl/tr/bl/br 角位；玩家恒 tl 之外的
//                                 出生角由 main 换算（玩家固定 tl）
//   powerups   喂 PowerupSpawner 的类型子集；[] = 整关无道具
//   wallBreak  本关是否开地形破坏（覆写全局设置，只影响本关）
//   player     开局强化：{ weapon:"laser"|"scatter"|"mine", shots, shield }
//   hint       选关卡片与开局提示文案
// ============================================================

export const LEVELS = [
  {
    id: 1, name: "热身", desc: "击败 1 名新手对手",
    objective: "eliminate",
    map: { tier: "small", style: "sparse" },
    enemies: [{ level: "easy", spawn: "br" }],
    powerups: [], wallBreak: false, player: {}, mutators: {},
    hint: "基础对决：绕墙走位，留意跳弹",
  },
  {
    id: 2, name: "军备竞赛", desc: "道具全开，击败普通对手",
    objective: "eliminate",
    map: { tier: "small", style: "sparse" },
    enemies: [{ level: "normal", spawn: "br" }],
    powerups: ["scatter", "shield", "laser", "mine"], wallBreak: false, player: {}, mutators: {},
    hint: "抢道具是胜负手——它也会抢",
  },
  {
    id: 3, name: "以一敌二", desc: "同时击败 2 名新手",
    objective: "eliminate",
    map: { tier: "medium", style: "sparse" },
    enemies: [{ level: "easy", spawn: "br" }, { level: "easy", spawn: "tr" }],
    powerups: ["shield"], wallBreak: false, player: {}, mutators: {},
    hint: "别被夹击——它们也会误伤彼此",
  },
  {
    id: 4, name: "狙击教室", desc: "只用激光击败对手",
    objective: "eliminate",
    map: { tier: "medium", style: "rooms" },
    enemies: [{ level: "normal", spawn: "br" }],
    powerups: [], wallBreak: false,
    player: { weapon: "laser", shots: 99 },
    mutators: {},
    hint: "预瞄线会暴露你——利用反弹打它看不到的角度",
  },
  {
    id: 5, name: "雷区求生", desc: "在布满地雷的战场存活 45 秒",
    objective: "survive",
    map: { tier: "medium", style: "symmetric" },
    enemies: [{ level: "normal", spawn: "br" }],
    powerups: ["mine"], wallBreak: false, player: {},
    mutators: { surviveTime: 45 },
    hint: "不必击杀，活着就是胜利——记住雷埋在哪",
  },
  {
    id: 6, name: "拆迁现场", desc: "炸墙全开，击败 2 名对手",
    objective: "eliminate",
    map: { tier: "medium", style: "rooms" },
    enemies: [{ level: "normal", spawn: "br" }, { level: "easy", spawn: "bl" }],
    powerups: ["scatter", "mine"], wallBreak: true, player: {},
    mutators: {},
    hint: "墙会被打穿——掩体是暂时的",
  },
  {
    id: 7, name: "宿敌", desc: "击败困难对手",
    objective: "eliminate",
    map: { tier: "small", style: "sparse" },
    enemies: [{ level: "hard", spawn: "br" }],
    powerups: ["scatter", "shield", "laser", "mine"], wallBreak: true, player: {},
    mutators: {},
    hint: "它会跳弹吊射、反弹激光狙——像打一个真人高手",
  },
  {
    id: 8, name: "最终试炼", desc: "90 秒内击败困难+普通双人组",
    objective: "eliminateTimed",
    map: { tier: "medium", style: "symmetric" },
    enemies: [{ level: "hard", spawn: "br" }, { level: "normal", spawn: "tr" }],
    powerups: ["scatter", "shield", "laser", "mine"], wallBreak: true,
    player: { shield: true },
    mutators: { timeLimit: 90 },
    hint: "开局有盾。速战速决，拖久必败",
  },
];

export const LEVEL_COUNT = LEVELS.length;

// 过关判定（每帧调用的纯函数）。
// ctx = { playerAlive, enemiesAlive, levelTimer }
//   levelTimer：survive 关 = 已存活秒数；eliminateTimed 关 = 剩余秒数。
// 返回 "win" | "lose" | null（继续打）。
// 判定顺序：玩家死亡优先于达成——同帧同归于尽算失败（挑战要活着赢）。
export function evaluateObjective(level, ctx) {
  if (!ctx.playerAlive) return "lose";
  switch (level.objective) {
    case "survive":
      return ctx.levelTimer >= (level.mutators.surviveTime ?? 60) ? "win" : null;
    case "eliminateTimed":
      if (ctx.enemiesAlive === 0) return "win";
      return ctx.levelTimer <= 0 ? "lose" : null;
    case "eliminate":
    default:
      return ctx.enemiesAlive === 0 ? "win" : null;
  }
}

// 进度宽松校验：progress = 已通关数（0 = 一关未过，解锁第 1 关）。
// 坏档落 0，越界钳到 LEVEL_COUNT。
export function normalizeProgress(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(Math.floor(raw), LEVEL_COUNT);
}
