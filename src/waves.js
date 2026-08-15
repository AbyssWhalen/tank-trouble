// ============================================================
// waves.js — 无尽波次生存：波次曲线（纯数据 + 纯函数）
// 零浏览器依赖（只 import config 常量与 collision 的纯几何），smoke 与 arena
// 可直接断言/跑分。
// 最高记录持久化在 settings.js（loadWaveBest/saveWaveBest）；
// 波次调度（投放/间隙/换图，WAVE_OVER 状态机）在 main.js。
//
// 难度靠三层叠加，而不是无限拔 AI 强度（AI 只有三档，到顶就到顶了）：
//   quota       本波敌人总数——被打掉就补，配额清零进下一波（越往后越持久）
//   concurrent  同屏上限——早期 1 辆单挑、后期 3 辆围攻（读得清、AI 不挤成团）
//   mix         三档 AI 权重，随波次从 easy 滑向 hard（hardCap 留点 normal 变化）
// 同屏上限硬顶 3 有个硬理由：PLAYER_COLORS 只有 4 色，敌人占 1..3 号，
// 第 4 辆会撞玩家自己的青绿。
// ============================================================

import { WAVE, TIER_POOL_BY_MODE, CELL_SIZE, TANK } from "./config.js";
import { resolveCircleWalls } from "./collision.js";

// 三档权重的固定枚举顺序（对象字面量插入序即此序，加权抽取才确定）
export const MIX_KEYS = ["easy", "normal", "hard"];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 第 n 波（1-based）的规格。纯函数，同一 n 恒等——smoke 断言与 arena 跑分
// 都靠这点。style 不在这里：档位是难度（确定性），风格是花样（main 随机抽）。
export function waveSpec(n) {
  const wave = Math.max(1, Math.floor(n));
  const quota = Math.min(WAVE.quotaCap, 1 + Math.floor(wave * WAVE.quotaSlope));
  // 同屏数还要被配额压住：第 1 波总共就 1 辆，同屏不可能有 2 辆。
  // 用 (wave-1) 而不是 wave 做除法：这样台阶落在**章节第一波**上（与 chapterOf 同相位），
  // concurrentEvery === remapEvery 时就是「每换一张图恰好加一辆」——压力台阶与地形
  // 换新同时发生，玩家感知得到「这一章的主题变了」，而不是在章中间莫名多出一辆。
  const concurrent = Math.min(
    WAVE.concurrentCap,
    quota,
    1 + Math.floor((wave - 1) / WAVE.concurrentEvery)
  );

  // easy 线性退场 → hard 线性登场，中间地带全归 normal（不会为负：
  // easy 归零发生在 hard 起步之后，两者重叠区权重和 < 1）
  const easy = clamp(1 - (wave - 1) / WAVE.easyFade, 0, 1);
  const hard = clamp((wave - WAVE.hardFrom) / WAVE.hardRamp, 0, WAVE.hardCap);
  const mix = { easy, normal: 1 - easy - hard, hard };

  return {
    wave,
    quota,
    concurrent,
    mix,
    tier: wave >= WAVE.largeFrom ? "large" : "medium",
    // 每波开局强制补给几个道具（受 POWERUP.maxOnField 压制，由 main 钳）
    supply: wave % WAVE.supplyBonusEvery === 0 ? 2 : 1,
  };
}

// 按 mix 权重抽一个 AI 档位。rand 可注入（smoke 里喂定值验证边界）。
export function pickEnemyLevel(mix, rand = Math.random) {
  let r = clamp(rand(), 0, 1) * MIX_KEYS.reduce((s, k) => s + (mix[k] || 0), 0);
  let last = "normal";
  for (const key of MIX_KEYS) {
    const w = mix[key] || 0;
    if (w <= 0) continue;
    if (r < w) return key;
    r -= w;
    last = key;
  }
  return last; // 浮点残差落到末尾：给最后一个有权重的档
}

// 章节（每 remapEvery 波一章，用于换图与档位升级）。1-based 波号 → 0-based 章号。
export function chapterOf(n) {
  return Math.floor((Math.max(1, Math.floor(n)) - 1) / WAVE.remapEvery);
}

// 进第 n 波时是否该换新地图。换图 = 清空玩家打出来的破洞与雷阵，
// 所以只在章节边界换（波内换图会把「战场是你的资产」这点乐趣抹掉）。
export function shouldRemap(n) {
  return n > 1 && chapterOf(n) !== chapterOf(n - 1);
}

// 波次刷点：在离玩家最远的空格里挑一个。纯函数（rand 可注入 → smoke 可断言）。
// 为什么不复用 powerup 的 pickSpot：那个是「随机试 12 次」，要的是随机分布；
// 刷敌人要的是「离玩家远」这个方向性，且必须成功（返回 null 会让本波卡住）。
// 也不能用 setupRound 那 4 个硬编码角位——同屏 3 辆敌人 + 玩家就把角位占满了。
//   maze     当前地图（读 cols/rows/walls）
//   hero     玩家坦克位置（远离目标）
//   occupied 场上所有坦克（含玩家）——不许贴脸空降
// 找不到合法点返回 null（图挤到连 1 格安全距都腾不出来，调用方下帧再试）。
export function pickSpawnSpot(maze, hero, occupied, rand = Math.random) {
  const cells = [];
  for (let cy = 0; cy < maze.rows; cy++) {
    for (let cx = 0; cx < maze.cols; cx++) {
      const x = (cx + 0.5) * CELL_SIZE;
      const y = (cy + 0.5) * CELL_SIZE;
      // 格心理论上不嵌墙，但稀疏格栅偶有贴边：被推开就说明这格塞不下车，跳过
      const fixed = resolveCircleWalls(x, y, TANK.radius, maze.walls);
      if (Math.hypot(fixed.x - x, fixed.y - y) > 0.5) continue;
      const near = occupied.length
        ? Math.min(...occupied.map((o) => Math.hypot(o.x - x, o.y - y)))
        : Infinity;
      cells.push({ x, y, near, far: Math.hypot(hero.x - x, hero.y - y) });
    }
  }

  // 安全距逐级放宽：优先不贴脸，但挤到没法讲究时也得把人刷出来（宁近勿卡波）
  for (const gate of [WAVE.spawnSafeCells, 1.5, 1]) {
    const ok = cells.filter((c) => c.near >= gate * CELL_SIZE);
    if (!ok.length) continue;
    ok.sort((a, b) => b.far - a.far);
    // 最远的三分之一里随机取，别每波都从同一个角冒出来（可预测=可蹲守）
    const top = ok.slice(0, Math.max(1, Math.ceil(ok.length / 3)));
    return top[Math.min(top.length - 1, Math.floor(clamp(rand(), 0, 1) * top.length))];
  }
  return null;
}

// 最高记录宽松校验。坏档/空档落 { wave: 0, kills: 0 }（0 波 = 没有记录）。
export function normalizeWaveBest(raw) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  if (!raw || typeof raw !== "object") return { wave: 0, kills: 0 };
  return { wave: num(raw.wave), kills: num(raw.kills) };
}

// 破纪录判定：先比波次，同波次比击杀（活得更久 > 杀得更多）。
export function isBetterRecord(rec, best) {
  const a = normalizeWaveBest(rec), b = normalizeWaveBest(best);
  return a.wave > b.wave || (a.wave === b.wave && a.kills > b.kills);
}

// 档位池自检用（smoke 断言 waveSpec 产出的 tier 都在模式池里）
export const WAVE_TIERS = TIER_POOL_BY_MODE.wave;
