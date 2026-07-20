// ============================================================
// powerup.js — 道具实体 + 刷新管理
// 职责：在地图上随机刷新可拾取道具（散射弹 / 护盾），并自渲染。
//   - Powerup        单个道具：世界坐标 + 类型，画圆底 + 类型图标
//   - PowerupSpawner 刷新器：持有计时器，到点在空格随机刷一个，
//                    场上数量受 maxOnField 限流；菜单关掉道具则 types 传空，永不刷
// 拾取检测（坦克碾过）放 main —— 与子弹击中判定同一层（都用 circleVsCircle）。
// 效果如何作用在坦克上由 tank.applyPowerup 负责，这里只管"在地上有个能捡的东西"。
// 渲染随竞技场缩放（与子弹/坦克同一套世界坐标），物理与显示解耦。
// ============================================================

import { POWERUP, THEME, CELL_SIZE, TANK } from "./config.js";
import { resolveCircleWalls } from "./collision.js";

// [min, max] 区间取随机数（刷新间隔抖动用）
function randRange([min, max]) {
  return min + Math.random() * (max - min);
}

// 道具类型 → 圆底颜色（新增类型在此登记一行即可）
const TYPE_BG = {
  scatter: THEME.powScatterBg,
  shield: THEME.powShieldBg,
  pierce: THEME.powPierceBg,
  mine: THEME.powMineBg,
};

export class Powerup {
  // x, y: 世界坐标（格中心附近）；type: "scatter" | "shield" | "pierce"
  constructor(x, y, type) {
    this.x = x;
    this.y = y;
    this.type = type;
    this.age = 0;          // 用于轻微呼吸动画
  }

  update(dt) {
    this.age += dt;
  }

  render(ctx) {
    const r = POWERUP.radius;
    // 轻微呼吸：半径在 ±6% 间缓动，让道具"活"一点，好被注意到
    const pulse = 1 + Math.sin(this.age * 3) * 0.06;
    const rr = r * pulse;

    ctx.save();
    ctx.translate(this.x, this.y);

    // —— 圆底（按类型上色）+ 深色描边 ——
    ctx.fillStyle = TYPE_BG[this.type] || THEME.powScatterBg;
    ctx.beginPath();
    ctx.arc(0, 0, rr, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = THEME.powRing;
    ctx.stroke();

    // —— 类型图标（白色线条，压在底色上）——
    ctx.strokeStyle = THEME.powIcon;
    ctx.fillStyle = THEME.powIcon;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (this.type === "scatter") {
      drawScatterIcon(ctx, r);
    } else if (this.type === "pierce") {
      drawPierceIcon(ctx, r);
    } else if (this.type === "mine") {
      drawMineIcon(ctx, r);
    } else {
      drawShieldIcon(ctx, r);
    }

    ctx.restore();
  }
}

// 散射图标：三道从左侧汇聚、向右发散的箭线（表"一变三"）
function drawScatterIcon(ctx, r) {
  const len = r * 0.62;
  const originX = -len * 0.6;
  for (const ang of [-0.5, 0, 0.5]) {
    const ex = originX + Math.cos(ang) * len * 1.7;
    const ey = Math.sin(ang) * len * 1.4;
    ctx.beginPath();
    ctx.moveTo(originX, 0);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // 箭头小叉
    const back = 4;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.cos(ang - 0.5) * back, ey - Math.sin(ang - 0.5) * back);
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.cos(ang + 0.5) * back, ey - Math.sin(ang + 0.5) * back);
    ctx.stroke();
  }
}

// 护盾图标：经典盾形（顶平、底尖），白描边
function drawShieldIcon(ctx, r) {
  const w = r * 0.5;
  const top = -r * 0.5;
  const mid = r * 0.18;
  const bot = r * 0.62;
  ctx.beginPath();
  ctx.moveTo(-w, top);
  ctx.lineTo(w, top);
  ctx.lineTo(w, mid);
  ctx.quadraticCurveTo(w, bot, 0, bot);   // 右下收向尖底
  ctx.quadraticCurveTo(-w, bot, -w, mid); // 左下收向尖底
  ctx.closePath();
  ctx.stroke();
}

// 地雷图标：半圆雷体扣在地平线上 + 顶部三根触刺 + 中心引信点
function drawMineIcon(ctx, r) {
  const w = r * 0.55;   // 雷体半宽
  const base = r * 0.35; // 地平线高度（图标重心略下移）

  // 地平线
  ctx.beginPath();
  ctx.moveTo(-r * 0.75, base);
  ctx.lineTo(r * 0.75, base);
  ctx.stroke();

  // 半圆雷体（扣在地平线上）
  ctx.beginPath();
  ctx.arc(0, base, w, Math.PI, 0);
  ctx.closePath();
  ctx.stroke();

  // 顶部三根触刺（从雷体表面沿径向朝外，-135°/-90°/-45°）
  for (const a of [-Math.PI * 0.75, -Math.PI * 0.5, -Math.PI * 0.25]) {
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * w, base + Math.sin(a) * w);
    ctx.lineTo(Math.cos(a) * (w + r * 0.3), base + Math.sin(a) * (w + r * 0.3));
    ctx.stroke();
  }

  // 中心引信点
  ctx.beginPath();
  ctx.arc(0, base - w * 0.45, 1.8, 0, Math.PI * 2);
  ctx.fill();
}

// 穿墙图标：中间一道竖墙（两段留缺口），一支箭从左穿缺口而过（表"穿透"）
function drawPierceIcon(ctx, r) {
  const wallX = 0;
  const half = r * 0.62;
  const gap = r * 0.2;
  // 竖墙上下两段，中间留缺口
  ctx.beginPath();
  ctx.moveTo(wallX, -half);
  ctx.lineTo(wallX, -gap);
  ctx.moveTo(wallX, gap);
  ctx.lineTo(wallX, half);
  ctx.stroke();
  // 横穿的箭：杆 + 箭头
  const ax0 = -r * 0.62, ax1 = r * 0.62;
  ctx.beginPath();
  ctx.moveTo(ax0, 0);
  ctx.lineTo(ax1, 0);
  ctx.stroke();
  const back = 4.5;
  ctx.beginPath();
  ctx.moveTo(ax1, 0);
  ctx.lineTo(ax1 - back, -back * 0.8);
  ctx.moveTo(ax1, 0);
  ctx.lineTo(ax1 - back, back * 0.8);
  ctx.stroke();
}

export class PowerupSpawner {
  // types: 本局可刷的种类数组（菜单关掉道具则传 []，永不刷）
  constructor(types) {
    this.types = types || [];
    this.timer = randRange(POWERUP.spawnInterval); // 开局先等一拍再刷第一个
  }

  // 每帧推进。到点且场上未满则刷一个，入 powerups 数组（原地 push）。
  // maze: 当前地图（取 cols/rows/walls 选位）；powerups: 当前场上道具（数量限流）；
  // tanks: 存活坦克数组（避开正踩在上面的位置，防一刷出来就被吃/重叠）。
  update(dt, maze, powerups, tanks) {
    if (this.types.length === 0) return;          // 道具关闭
    if (powerups.length >= POWERUP.maxOnField) return; // 场上已满

    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = randRange(POWERUP.spawnInterval); // 重置下一次刷新计时

    const spot = this.pickSpot(maze, powerups, tanks);
    if (!spot) return; // 没找到合适位置，这次跳过（下一拍再试）

    const type = this.types[Math.floor(Math.random() * this.types.length)];
    powerups.push(new Powerup(spot.x, spot.y, type));
  }

  // 随机选一个刷新点：随机格中心 → 推出墙体 → 校验不与现有道具/坦克太近。
  // 试若干次仍找不到就返回 null（地图太挤，本次不刷）。
  pickSpot(maze, powerups, tanks) {
    for (let tries = 0; tries < 12; tries++) {
      const c = Math.floor(Math.random() * maze.cols);
      const r = Math.floor(Math.random() * maze.rows);
      let x = (c + 0.5) * CELL_SIZE;
      let y = (r + 0.5) * CELL_SIZE;
      // 格中心理论上不会嵌墙，但稀疏格栅偶有贴边，兜一下保险
      const fixed = resolveCircleWalls(x, y, POWERUP.radius, maze.walls);
      x = fixed.x;
      y = fixed.y;

      const clear = POWERUP.radius + TANK.radius;
      // 避开正踩在该点的坦克（否则一刷出来立刻被吃，没存在感）
      let tooClose = tanks.some(
        (t) => t.alive && Math.hypot(t.x - x, t.y - y) < clear
      );
      // 避开已有道具，别叠在一起
      tooClose = tooClose || powerups.some(
        (p) => Math.hypot(p.x - x, p.y - y) < POWERUP.radius * 2.2
      );
      if (!tooClose) return { x, y };
    }
    return null;
  }
}
