// ============================================================
// stats.js — 战绩统计持久化（命中率 / 分武器击杀 / 连胜纪录）
// 存储范式照抄 settings.js：localStorage + try/catch 静默降级；
// 但用独立 key——统计 schema 与设置各自演进，version 升级互不连坐，
// 且高频回合级写入不牵连设置的全量序列化。
//
// 纯计算（normalizeStats/accuracy/favoriteWeapon/updateStreak）与
// 存储访问分离：前者 node 可直接 import 进 smoke 断言。
//
// schema：
//   localStorage["tank-trouble.stats.v1"] = {
//     version: 1,
//     players: [ { fired, hits, kills:{bullet,scatter,laser,mine},
//                  roundsWon, matchesWon } × 2 ],   // 按槽位：P1 恒人类，P2 pvp=人/pve=AI
//     bestStreak, curStreak,                        // P1 回合连胜（赢+1 输清零 同归不动）
//   }
// 口径：fired 按实际弹数（散射一炮 3 发计 3）；激光每发 +1；地雷不算 fired 只记击杀。
//       hits = 击杀 + 破盾（打中护盾也是打中）；自杀不计 hits/kills。
// ============================================================

const STATS_KEY = "tank-trouble.stats.v1";
const WEAPONS = ["bullet", "scatter", "laser", "mine"];
const WEAPON_LABELS = { bullet: "普通弹", scatter: "散射", laser: "激光", mine: "地雷" };

function emptyPlayer() {
  return { fired: 0, hits: 0, kills: { bullet: 0, scatter: 0, laser: 0, mine: 0 }, roundsWon: 0, matchesWon: 0 };
}

// 宽松校验：任何字段缺失/类型不对都落默认，坏档不炸（纯函数，smoke 可测）
export function normalizeStats(raw) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const player = (p) => {
    if (!p || typeof p !== "object") return emptyPlayer();
    const kills = p.kills && typeof p.kills === "object" ? p.kills : {};
    return {
      fired: num(p.fired),
      hits: num(p.hits),
      kills: Object.fromEntries(WEAPONS.map((w) => [w, num(kills[w])])),
      roundsWon: num(p.roundsWon),
      matchesWon: num(p.matchesWon),
    };
  };
  const arr = Array.isArray(raw?.players) ? raw.players : [];
  return {
    version: 1,
    players: [player(arr[0]), player(arr[1])],
    bestStreak: num(raw?.bestStreak),
    curStreak: num(raw?.curStreak),
  };
}

// 命中率 ∈ [0,1]；没开过火返回 0（除零保护）
export function accuracy(p) {
  return p.fired > 0 ? Math.min(1, p.hits / p.fired) : 0;
}

// 最爱武器：击杀数 argmax 的中文标签；全 0 返回 null（还没杀过人）
export function favoriteWeapon(p) {
  let best = null;
  let bestN = 0;
  for (const w of WEAPONS) {
    if (p.kills[w] > bestN) {
      bestN = p.kills[w];
      best = w;
    }
  }
  return best ? WEAPON_LABELS[best] : null;
}

// P1 连胜推进（纯函数）：winnerIndex 0=P1 赢 / 1=P1 输 / null=同归不动。
// 返回更新后的 { curStreak, bestStreak }。
export function updateStreak(cur, best, winnerIndex) {
  if (winnerIndex === 0) {
    const c = cur + 1;
    return { curStreak: c, bestStreak: Math.max(best, c) };
  }
  if (winnerIndex === 1) return { curStreak: 0, bestStreak: best };
  return { curStreak: cur, bestStreak: best };
}

// —— 存储层（浏览器专属，异常静默降级为内存态）——

let stats = normalizeStats(null); // 内存态兜底

export function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (raw) stats = normalizeStats(JSON.parse(raw));
  } catch (e) {
    console.warn("stats: 读取失败，从零开始统计", e);
  }
  return stats;
}

export function saveStats() {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch (e) {
    console.warn("stats: 保存失败（本次运行内仍累计）", e);
  }
}

// —— 记录接口（main 在事件点调用；只改内存，落盘时机由 main 控制）——

export function recordFired(playerIndex, count = 1) {
  stats.players[playerIndex].fired += count;
}

export function recordHit(playerIndex) {
  stats.players[playerIndex].hits += 1;
}

export function recordKill(playerIndex, weapon) {
  const p = stats.players[playerIndex];
  p.hits += 1; // 击杀必然命中
  if (p.kills[weapon] !== undefined) p.kills[weapon] += 1;
}

// 回合胜负（winnerIndex: 0/1/null=同归）：胜场 + P1 连胜推进
export function recordRoundEnd(winnerIndex) {
  if (winnerIndex !== null) stats.players[winnerIndex].roundsWon += 1;
  const s = updateStreak(stats.curStreak, stats.bestStreak, winnerIndex);
  stats.curStreak = s.curStreak;
  stats.bestStreak = s.bestStreak;
}

export function recordMatchWin(winnerIndex) {
  stats.players[winnerIndex].matchesWon += 1;
}

export function getStats() {
  return stats;
}
