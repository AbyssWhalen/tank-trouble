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
//
// 三层在第 16 波全部到顶（见文件下半部分 eliteSpec 上方的长注释），所以阶段 25
// 追加了第四层「敌人词条」——同一辆车随波次变强，把封顶推到第 31 波。
// ============================================================

import { WAVE, TIER_POOL_BY_MODE, CELL_SIZE, TANK, ENEMY_TRAIT } from "./config.js";
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

// ============================================================
// 敌人词条（阶段 25）——把封顶从第 16 波推到第 31 波
//
// 为什么需要它：waveSpec 的四个旋钮在第 16 波全部到顶（quotaCap 12 /
// concurrentCap 3 / hardCap 0.8 / largeFrom 11），第 16 波与第 26 波的规格
// 逐字节相同——「无尽」其实是无限重复同一波。而三层里没有一层还能往上加：
// 同屏受色板限制（4 色）、AI 只有三档。所以增量只能来自「同一辆车更强」。
//
// 两条纪律：
// 1. **只复用已有机制**（护盾 / 武器改装槽 / 坦克物理倍率），ai.js 一行不改。
//    AI 读的是状态不是事件（self.laserShots / self.mineCharges / 对手 shield），
//    所以发下去的装备它会自动正确使用——这是「不发明新能力」换来的红利。
// 2. **不给地雷**。AI 的布雷三时机 + 离玩家最远处刷点意味着雷多半会超时作废，
//    而没作废的又跨波留在图上（只有换图才清）——第 16 波同屏 3 辆轮换 12 个配额，
//    一条命模式里满地隐形雷不是难度，是不可读。
//
// 档位白名单（两条都是从 ai.js 的实际行为反推的，不是配平口味）：
// - hard 不给盾：berserkMode 在自己有盾时直接放弃躲弹冲锋，而躲弹正是 hard
//   最强的资产（dodgeHorizon 1.1 / dodgeMargin 16）。给 hard 发盾等于削它。
//   作为补偿，不带盾的档提前 5 波拿到武器（weaponFrom 1 而不是 2）。
// - 只有 hard 给激光：低档持激光是「随机方向的瞬时狙」——只有 hard 的 bounceAim
//   认全路径反弹解，会等扫中了才开火。对玩家来说前者是随机死亡，后者是可读威胁。
// ============================================================

// 词条档位：0 无 / 1 第一件 / 2 第二件 / 3 武器加量 / 4 加量翻倍 / 5 hard 换激光。
// 台阶落在 6/11/16/21/26 波——与 remapEvery 同相位，「换一张图升一档」。
export function eliteStep(n) {
  const wave = Math.max(1, Math.floor(n));
  if (wave < ENEMY_TRAIT.from) return 0;
  return Math.min(
    ENEMY_TRAIT.stepCap,
    1 + Math.floor((wave - ENEMY_TRAIT.from) / ENEMY_TRAIT.every)
  );
}

// 连续爬升进度 0..1（creepFrom 波起线性，满于 creepFrom + 1/creepRate 波 = 第 31 波）。
// **这条是整条难度曲线的承重墙**，不是装备阶梯的补充：实测装备阶梯里只有「hard 换激光」
// 一级量得出来（第 26 波中位存活 7.3→4.8s），另外三级（盾 / 散射 / 散射加量）全落在
// 1.2s 的噪声底以内——AI 的出手节奏闸门在 cfg.fireCooldown，弹药与盾都不是它的约束。
// 而移速/转速是物理量，不经过任何 AI 决策，所以从换大图那章（第 11 波）就起爬，
// 一路给到第 31 波，把装备阶梯量不出来的那三级波段填上。
export function eliteCreep(n) {
  return clamp((Math.max(1, Math.floor(n)) - ENEMY_TRAIT.creepFrom) * ENEMY_TRAIT.creepRate, 0, 1);
}

// 第 n 波、某 AI 档位的敌人该带什么。纯函数（同 (n,tier) 恒等，无随机）——
// 确定性是刻意的：玩家能学会「第 26 波起困难敌人开场一发激光」，
// 而不是每辆车随机开盲盒。哪辆车带什么由头顶图标当场告知（渲染读活体状态）。
export function eliteSpec(n, tier = "normal") {
  const step = eliteStep(n);
  const creep = eliteCreep(n);
  const shield = step >= 1 && ENEMY_TRAIT.shieldTiers.includes(tier);
  // 带盾的档第 2 档才拿武器，不带盾的档第 1 档就拿（补偿它永远没有盾）
  const weaponFrom = ENEMY_TRAIT.shieldTiers.includes(tier) ? 2 : 1;
  let weapon = step >= weaponFrom ? "scatter" : null;
  if (step >= ENEMY_TRAIT.stepCap && ENEMY_TRAIT.laserTiers.includes(tier)) weapon = "laser";
  return {
    step,
    shield,
    weapon,
    // 散射加量两级：第 3 档 +1 单位、第 4 档起 +2 单位（3→6→9 发）。
    // 只在真的拿着散射时有意义（换成激光后这层就没了——武器槽互斥）
    scatterBonus: weapon === "scatter"
      ? ENEMY_TRAIT.scatterBonus * clamp(step - 2, 0, 2)
      : 0,
    speed: 1 + creep * ENEMY_TRAIT.speedCap,
    turn: 1 + creep * ENEMY_TRAIT.turnCap,
  };
}

// 把词条套到一辆刚投放的敌方坦克上。幂等（同 spec 重复调结果相同，只有武器发数会叠）。
// 顺序有讲究：先写 mods（applyPowerup 要读 scatterBonus），再发武器，最后发盾
// （盾与武器槽并存，不互斥）。
export function applyElite(tank, elite) {
  if (!tank || !elite) return tank;
  if (tank.mods) {
    tank.mods.speed = elite.speed;
    tank.mods.turn = elite.turn;
    tank.mods.scatterBonus = elite.scatterBonus;
  }
  if (elite.weapon) tank.applyPowerup(elite.weapon);
  if (elite.shield) tank.applyPowerup("shield");
  return tank;
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
