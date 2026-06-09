// ============================================================
// tank.js — 坦克实体
// 职责：维护位置/朝向，按输入移动转向，渲染自身。
// 碰撞（撞墙、中弹）放到后续阶段，这里只管"自己怎么动、怎么画"。
// ============================================================

import { TANK, BULLET } from "./config.js";
import { isDown, isJustPressed } from "./input.js";
import { resolveCircleWalls } from "./collision.js";
import { Bullet } from "./bullet.js";

export class Tank {
  // x, y: 车体中心世界坐标（像素）
  // angle: 朝向弧度，0 指向右(+x)，顺时针为正
  // color: 车体颜色
  // keys: 该坦克的键位 { forward, back, left, right, fire }
  constructor(x, y, angle, color, keys) {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.color = color;
    this.keys = keys;
    this.alive = true;
  }

  // dt: 距上一帧的秒数；walls: 墙线段数组，用于撞墙不穿
  update(dt, walls) {
    if (!this.alive) return;

    // 开炮冷却递减
    if (this.cooldown > 0) this.cooldown -= dt;

    // 转向：左右键原地转
    let turn = 0;
    if (isDown(this.keys.left)) turn -= 1;
    if (isDown(this.keys.right)) turn += 1;
    this.angle += turn * TANK.turnSpeed * dt;

    // 前进/后退：沿朝向移动
    let move = 0;
    if (isDown(this.keys.forward)) move += 1;
    if (isDown(this.keys.back)) move -= 1;

    if (move !== 0) {
      const dist = move * TANK.moveSpeed * dt;
      this.x += Math.cos(this.angle) * dist;
      this.y += Math.sin(this.angle) * dist;
    }

    // 撞墙解算：把车体(圆)推出所有相交的墙，实现撞墙不穿 + 沿墙滑动
    if (walls && walls.length) {
      const fixed = resolveCircleWalls(this.x, this.y, TANK.radius, walls);
      this.x = fixed.x;
      this.y = fixed.y;
    }
  }

  // 尝试开炮：fire 键边沿触发 + 冷却就绪 + 同屏己方子弹未达上限时，
  // 从炮口生成一发子弹返回；否则返回 null。
  // bullets: 全局子弹数组，用于统计自己还有几发在场（实现 maxAlive 限流）——
  // 这是原版"靠子弹上限而非冷却限流"的核心，去掉固定冷却后尤其关键。
  // 子弹的归属(owner)记为本坦克，便于"出膛宽限期"等判定。
  // 返回的子弹由 main 收集进全局子弹数组统一管理。
  tryFire(bullets) {
    if (!this.alive) return null;
    if (this.cooldown > 0) return null;
    if (!isJustPressed(this.keys.fire)) return null;

    // 同屏己方存活子弹数达上限则不发射
    let mine = 0;
    if (bullets) {
      for (const b of bullets) {
        if (b.owner === this && !b.dead) mine++;
      }
      if (mine >= BULLET.maxAlive) return null;
    }

    this.cooldown = BULLET.cooldown;

    // 炮口位置：从车体中心沿朝向伸出（炮管末端再多探出一点，避免子弹生成在车体内被自己挡）
    const muzzleDist = TANK.bodyLength / 2 + TANK.barrelLength + BULLET.radius + 2;
    const bx = this.x + Math.cos(this.angle) * muzzleDist;
    const by = this.y + Math.sin(this.angle) * muzzleDist;
    const vx = Math.cos(this.angle) * BULLET.speed;
    const vy = Math.sin(this.angle) * BULLET.speed;

    return new Bullet(bx, by, vx, vy, this);
  }

  render(ctx) {
    if (!this.alive) return;

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);

    const {
      bodyLength, bodyWidth,
      treadLength, treadWidth, treadInset,
      turretRadius,
      barrelLength, barrelWidth,
    } = TANK;

    // 履带颜色：统一深色，不随玩家色变（原版风格）
    const treadColor = "#3a3a4a";
    const treadEdge = "rgba(0,0,0,0.5)";

    // —— 1) 上下两条履带（最底层，深色横条，比车体略长两端探出）——
    // 履带在垂直方向(y)位于车体两侧外缘
    const treadY = bodyWidth / 2 - treadInset; // 履带内缘贴着车体外缘
    for (const sign of [-1, 1]) {
      const y = sign * treadY;
      ctx.fillStyle = treadColor;
      ctx.fillRect(-treadLength / 2, y - (sign < 0 ? treadWidth : 0), treadLength, treadWidth);
      // 履带描边
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = treadEdge;
      ctx.strokeRect(-treadLength / 2, y - (sign < 0 ? treadWidth : 0), treadLength, treadWidth);
      // 履带上的横向纹路（齿），增强"履带"质感
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 1;
      const topY = y - (sign < 0 ? treadWidth : 0);
      const segs = 6;
      for (let i = 1; i < segs; i++) {
        const sx = -treadLength / 2 + (treadLength * i) / segs;
        ctx.beginPath();
        ctx.moveTo(sx, topY);
        ctx.lineTo(sx, topY + treadWidth);
        ctx.stroke();
      }
    }

    // —— 2) 车体（中间彩色方块）——
    ctx.fillStyle = this.color;
    ctx.fillRect(-bodyLength / 2, -bodyWidth / 2, bodyLength, bodyWidth);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.strokeRect(-bodyLength / 2, -bodyWidth / 2, bodyLength, bodyWidth);

    // —— 3) 炮管（从中心向前(+x)伸出的圆头管，先画，让炮塔盖住根部）——
    ctx.strokeStyle = "#2b2b3a";
    ctx.lineWidth = barrelWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(turretRadius + barrelLength, 0);
    ctx.stroke();

    // —— 4) 炮塔（中央圆盘，同色系略深，盖住炮管根部）——
    ctx.fillStyle = this.darkColor();
    ctx.beginPath();
    ctx.arc(0, 0, turretRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.stroke();

    ctx.restore();
  }

  // 把车体色压暗，作为炮塔颜色（让炮塔与车体同色系但有层次）
  darkColor() {
    const c = this.color.replace("#", "");
    const r = Math.round(parseInt(c.slice(0, 2), 16) * 0.7);
    const g = Math.round(parseInt(c.slice(2, 4), 16) * 0.7);
    const b = Math.round(parseInt(c.slice(4, 6), 16) * 0.7);
    return `rgb(${r}, ${g}, ${b})`;
  }
}
