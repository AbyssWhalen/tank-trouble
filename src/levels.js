// ============================================================
// levels.js — 挑战关卡模式：关卡表 + 过关判定（纯数据 + 纯函数）
// 零浏览器依赖（只 import objectives 的纯函数），smoke 可直接断言。
// 进度持久化在 settings.js（loadChallengeProgress/saveChallengeProgress）；
// 关卡流转（LEVEL_OVER 状态机/setupRound 分支）在 main.js。
// 胜负判定本体自阶段 27 起在 objectives.js（波次的守点/清配额与关卡三型共用
// 一份表）——这里只剩「关卡表 → 目标规格」的翻译。
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

import { evaluate } from "./objectives.js";

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
    id: 2, name: "军备竞赛", desc: "道具全开，击败对手",
    objective: "eliminate",
    map: { tier: "small", style: "sparse" },
    enemies: [{ level: "easy", spawn: "br" }],
    powerups: ["scatter", "shield", "laser", "mine"], wallBreak: false, player: {}, mutators: {},
    hint: "抢道具是胜负手——它也会抢",
  },
  {
    id: 3, name: "以一敌二", desc: "同时击败 2 名新手",
    objective: "eliminate",
    map: { tier: "medium", style: "sparse" },
    enemies: [{ level: "easy", spawn: "br" }, { level: "easy", spawn: "tr" }],
    powerups: ["shield"], wallBreak: false, player: { shield: true }, mutators: {},
    hint: "别被夹击——它们也会误伤彼此",
  },
  {
    id: 4, name: "狙击教室", desc: "只用激光击败对手",
    objective: "eliminate",
    map: { tier: "medium", style: "rooms" },
    enemies: [{ level: "normal", spawn: "br" }],
    powerups: [], wallBreak: false,
    // 10 发而不是原来的 99 发。**这一条是设计判断，arena 量不出来**：这关三档替身
    // 通关率 98/100/98，换成 6 发还是 98/98/100——因为「持激光的 AI 是帧级几何精确
    // 狙击手」这条偏差与档位无关（CLAUDE.md 记的纯激光关虚高），跨档对比在这关失效。
    // 改的理由与难度数字无关：99 发 = 无资源约束，而这关的 hint 要求「算反弹角」，
    // 无限弹把该想的那一步删掉了。打空之后退化成一场公平 1v1（不是死局），
    // 所以下限安全。真实难度只能实机人工验
    player: { weapon: "laser", shots: 10 },
    mutators: {},
    hint: "预瞄线会暴露你——利用反弹打它看不到的角度",
  },
  {
    id: 5, name: "雷区求生", desc: "存活 45 秒（或击败对手提前过关）",
    objective: "survive",
    map: { tier: "medium", style: "symmetric" },
    enemies: [{ level: "normal", spawn: "br" }],
    powerups: ["mine"], wallBreak: false, player: {},
    mutators: { surviveTime: 45 },
    hint: "躲满 45 秒就赢——敢反杀也行，条条大路通关",
  },
  {
    id: 6, name: "拆迁现场", desc: "炸墙全开，击败 2 名对手",
    objective: "eliminate",
    map: { tier: "medium", style: "rooms" },
    enemies: [{ level: "easy", spawn: "br" }, { level: "easy", spawn: "bl" }],
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
    id: 8, name: "最终试炼", desc: "120 秒内击败困难主将 + 一名杂兵",
    objective: "eliminateTimed",
    map: { tier: "medium", style: "symmetric" },
    // 副手是 easy 而不是 normal（阶段 26 实测改）：hard+normal 时替身三档通关率
    // 0/10/10——**技术档差只有 10pp**，那不是难是不讲理（1v2 双高手交叉火力，
    // 两边都在躲弹时玩家没有任何操作空间）。换成 hard+easy 后 0/23/25：
    // 简单档仍打不过（0%），会玩的能过（23%）——难度回到「技术能兑现」的区间。
    // 顺带排除了「时限太紧」这个猜测：150s 版实测 0/5/15，替身是被打死不是被拖死
    enemies: [{ level: "hard", spawn: "br" }, { level: "easy", spawn: "tr" }],
    powerups: ["scatter", "shield", "laser", "mine"], wallBreak: true,
    player: { shield: true },
    mutators: { timeLimit: 120 },
    hint: "开局有盾。先清掉杂兵再单挑主将，速战速决",
  },
];

export const LEVEL_COUNT = LEVELS.length;

// 关卡表 → objectives 规格。关卡表用的是「objective 字符串 + mutators 里
// 各自命名的秒数字段」这套人类可读写法，objectives 只认统一的 { type, secs }，
// 翻译就放这一处（新增关卡类型时这里加一行，判定逻辑不动）。
export function objectiveOf(level) {
  const m = (level && level.mutators) || {};
  switch (level && level.objective) {
    case "survive": return { type: "survive", secs: m.surviveTime ?? 60 };
    case "eliminateTimed": return { type: "eliminateTimed", secs: m.timeLimit ?? 120 };
    default: return { type: "eliminate" };
  }
}

// 过关判定（每帧调用的纯函数）。
// ctx = { playerAlive, enemiesAlive, elapsed }
//   elapsed：本关**已过**秒数，单调递增（阶段 27 前这里叫 levelTimer，且在
//   survive 关是已过、在限时关是剩余——同一个变量两种语义，见 objectives.js）。
// 返回 "win" | "lose" | null（继续打）。真值表与「玩家死优先于达成」都在
// objectives.js，这里只是薄壳——两处实现必然跑偏，所以只留一处。
export const evaluateObjective = (level, ctx) => evaluate(objectiveOf(level), ctx);

// 进度宽松校验：progress = 已通关数（0 = 一关未过，解锁第 1 关）。
// 坏档落 0，越界钳到 LEVEL_COUNT。
export function normalizeProgress(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(Math.floor(raw), LEVEL_COUNT);
}
