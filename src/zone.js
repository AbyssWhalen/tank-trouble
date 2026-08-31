// ============================================================
// zone.js — 守点区域实体 + 选点（阶段 27）
// 照 mine.js 的范式：实体类 + 纯查询方法 + update(dt) + render(ctx)，
// `ctx` 只出现在 render 函数体里，所以 smoke 可以 import 本模块断言纯逻辑。
//
// 职责边界：本模块只回答「圈在哪、进度攒了多少」。
//   「第几波有圈、要守几秒」→ waves.js（isHoldWave / holdNeed / waveObjective）
//   「守够了算不算过波」    → objectives.js（OBJECTIVES.hold）
//   「圈什么时候建、什么时候清」→ main.js（beginWave / remapWaveArena）
//
// 三条刻意的设计（每一条都能用一个「更完整」的实现改坏）：
// 1. **出圈冻结，不衰减**。衰减会造出一个隐藏的失败状态（躲两发子弹进度归零，
//    玩家读不出为什么），冻结让守点波永远可完成——难度只来自「你能不能一直回到圈里」。
// 2. **按车心判，不按车身**。车身判定会让「贴着圈边蹭一下」也算，圈就白设了；
//    车心判定的规则一句话说得完，玩家一眼看得出自己在不在里面。
// 3. **只判玩家，敌人站进来不争夺**。争夺会让进度停摆有两个原因
//    （我不在圈里 / 敌人在圈里），HUD 上分不出来就是不讲理。
// ============================================================

import { CELL_SIZE, TANK, HOLD, THEME } from "./config.js";
import { resolveCircleWalls } from "./collision.js";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 选点：在离玩家 [minCells, maxCells] 格的空格心里挑一个。纯函数（rand 可注入 → smoke 可断言）。
// 结构照 waves.js 的 pickSpawnSpot（枚举格心 → 剔嵌墙格 → 距离门 → 排序 → 最贴合的
// 三分之一里按 rand 取），但**判据不同故不合并**：刷点要「贴住理想距离 9 格」，
// 选点要「落在 3~6 格这段区间」——太近等于白送，太远等于先跑 8 秒空场
// （阶段 26 花了一整期铲的正是这种白送）。
//
// **不按「开阔程度」加权**是刻意的：圈落在开阔房间还是走廊尽头本身就是这一波的
// 随机性来源（也是「地形第一次进决策」的那部分乐趣）。按开阔度挑就等于把它调平，
// 而且这个旋钮没有仪器能量——arena 的替身不会读地形。
//
// **永不返回 null**：圈是过波的唯一途径，返回 null 等于把这一波变成死局。
// 距离门按 BANDS 逐级放宽，最后兜底取「离玩家最远的空格」。
export function pickZoneSpot(maze, hero, rand = Math.random) {
  const cells = [];
  for (let cy = 0; cy < maze.rows; cy++) {
    for (let cx = 0; cx < maze.cols; cx++) {
      const x = (cx + 0.5) * CELL_SIZE;
      const y = (cy + 0.5) * CELL_SIZE;
      // 格心理论上不嵌墙，但稀疏格栅偶有贴边：被推开就说明这格塞不下车，跳过
      const fixed = resolveCircleWalls(x, y, TANK.radius, maze.walls);
      if (Math.hypot(fixed.x - x, fixed.y - y) > 0.5) continue;
      cells.push({ x, y, dist: Math.hypot((hero?.x ?? 0) - x, (hero?.y ?? 0) - y) });
    }
  }
  if (!cells.length) return null; // 整张图没有一格塞得下车：地图生成器坏了，不是本模块的事

  // 逐级放宽：小图（或玩家恰好站在图心）可能压根没有 3~6 格的格子
  const bands = [
    [HOLD.minCells, HOLD.maxCells],
    [HOLD.minCells * 0.7, HOLD.maxCells * 1.5],
    [1, Infinity],
  ];
  for (const [lo, hi] of bands) {
    const ok = cells.filter((c) => c.dist >= lo * CELL_SIZE && c.dist <= hi * CELL_SIZE);
    if (!ok.length) continue;
    // 离区间中点最近的排前面；同偏差取更远的（宁远勿贴脸，与 pickSpawnSpot 同向）
    const ideal = ((lo + Math.min(hi, HOLD.maxCells * 2)) / 2) * CELL_SIZE;
    ok.sort((a, b) => Math.abs(a.dist - ideal) - Math.abs(b.dist - ideal) || b.dist - a.dist);
    const top = ok.slice(0, Math.max(1, Math.ceil(ok.length / 3)));
    return top[Math.min(top.length - 1, Math.floor(clamp(rand(), 0, 1) * top.length))];
  }
  // 兜底：全图只剩贴脸的格子（1×1 图之类），取最远的那个
  return cells.slice().sort((a, b) => b.dist - a.dist)[0];
}

export class HoldZone {
  // x, y: 圈心世界坐标（格心）；needSecs: 要累计的秒数（来自 waves.holdNeed）
  constructor(x, y, needSecs) {
    this.x = x;
    this.y = y;
    this.need = typeof needSecs === "number" && needSecs > 0 ? needSecs : 0;
    this.progress = 0;
    this.age = 0;        // 只驱动呼吸动画。**跟着 update 走**，所以抽卡浮层/3-2-1
                         //   冻结期它也停——脉动停下本身就是「现在不计时」的提示
    this.inside = false; // 上一次 update 时玩家在不在圈里（渲染与 HUD 读它给反馈）
  }

  get radius() {
    return HOLD.radius * CELL_SIZE;
  }

  // 圆内判定（按车心，见文件头第 2 条）
  contains(x, y) {
    return Math.hypot(x - this.x, y - this.y) <= this.radius;
  }

  get ratio() {
    return this.need > 0 ? clamp(this.progress / this.need, 0, 1) : 1;
  }

  get done() {
    return this.progress >= this.need;
  }

  // 每帧推进。**调用点必须在 updatePlaying 的三道门（抽卡/Esc/开场倒计时）之后**——
  // 那三道门都只放过 updateEffects 并跳过整段物理，挂在物理段就自动获得正确语义。
  // hero 缺失或已死一律不计（死亡的收场由 updateWaveFlow 段①管，这里只是别记错账）。
  update(dt, hero) {
    this.age += dt;
    this.inside = !!hero && hero.alive !== false && this.contains(hero.x, hero.y);
    if (this.inside) this.progress = Math.min(this.need, this.progress + dt);
  }

  render(ctx) {
    const r = this.radius;
    const pulse = 0.5 + 0.5 * Math.sin(this.age * 3.2); // 呼吸（同 Powerup 的手法）
    const live = this.inside;                           // 在圈里 → 整体更实，一眼看出在计时

    ctx.save();
    ctx.translate(this.x, this.y);

    // ① 地面底盘：极淡的实心圆，让圈读作「地上画的一块区域」而不是漂浮的环
    ctx.globalAlpha = live ? 0.18 : 0.1;
    ctx.fillStyle = THEME.holdFill;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // ② 进度扇形：从正上方（−π/2）顺时针扫 ratio × 2π。图形化进度只此一处，
    //    HUD 那边给精确读数（7.4/12s）——一处图形一处数字，不新造进度条原语
    if (this.ratio > 0) {
      ctx.globalAlpha = live ? 0.42 : 0.3;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + this.ratio * Math.PI * 2);
      ctx.closePath();
      ctx.fill();
    }

    // ③ 外环虚线（同 renderLaserPreview 的风格）+ 呼吸描边。在圈里时环变实、
    //    脉动收窄；出圈时虚线转动感更强 = 「进度停了，回来」
    ctx.globalAlpha = live ? 0.85 : 0.4 + 0.35 * pulse;
    ctx.strokeStyle = THEME.holdRing;
    ctx.lineWidth = live ? 3 : 2;
    ctx.setLineDash(live ? [] : [7, 5]);
    ctx.lineDashOffset = -this.age * 18;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    ctx.restore();
    ctx.globalAlpha = 1;
  }
}
