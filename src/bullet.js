// ============================================================
// bullet.js — 子弹实体
// 职责：沿速度向量直线运动；撞墙反射（v' = v - 2(v·n)n）并推出墙外，
// 防止嵌进墙里反复反射抖动；反弹次数 / 存活时间超限即标记消亡。
// 击中判定放 main（需要和所有坦克交叉），这里只暴露 owner / age 供其判定。
// ============================================================

import { BULLET, THEME } from "./config.js";
import { reflect, circleVsSegment } from "./collision.js";

export class Bullet {
  // x,y: 出膛位置；vx,vy: 速度向量（像素/秒，已含方向与大小）
  // owner: 发射它的坦克（用于自伤宽限期，避免刚出炮口就打死自己）
  constructor(x, y, vx, vy, owner) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.owner = owner;
    this.color = owner ? owner.color : "#ffffff";
    this.bounces = 0;
    this.age = 0;        // 已存活秒数
    this.dead = false;   // true 时 main 会从数组移除
    this.trail = [];     // 最近几帧的位置（拖尾渲染用，反弹处自然拐弯）
  }

  // dt: 距上一帧秒数；walls: 墙线段数组
  update(dt, walls) {
    if (this.dead) return;

    this.age += dt;
    if (this.age >= BULLET.lifetime) {
      this.dead = true;
      return;
    }

    // 拖尾采样：记录移动前的位置（撞墙修正后的最终位置由下一帧记录）
    this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > 6) this.trail.shift();

    // 沿速度移动
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // 撞墙：可能同一帧贴着多面墙（角落），逐墙解算
    if (walls && walls.length) {
      for (const w of walls) {
        const hit = circleVsSegment(
          this.x, this.y, BULLET.radius,
          w.x1, w.y1, w.x2, w.y2
        );
        if (hit) {
          // 1) 先推出墙面，避免嵌进墙里下一帧继续反射
          this.x += hit.nx * hit.depth;
          this.y += hit.ny * hit.depth;
          // 2) 沿墙法线反射速度
          const r = reflect(this.vx, this.vy, hit.nx, hit.ny);
          this.vx = r.vx;
          this.vy = r.vy;
          // 3) 计反弹次数，超限消亡
          this.bounces++;
          if (this.bounces > BULLET.maxBounces) {
            this.dead = true;
            return;
          }
        }
      }
    }
  }

  // 击中判定时调用：该子弹此刻是否可以伤害 tank
  // 出膛宽限只保护"尚未反弹"的子弹（防止刚出炮口就打死自己）；
  // 一旦撞墙反弹就立刻解除豁免——贴墙开炮弹回来打死自己是原版的
  // 经典自杀手感，不能被宽限期豁免掉。
  canHit(tank) {
    if (tank === this.owner && this.bounces === 0 && this.age < BULLET.selfHitGrace) {
      return false;
    }
    return true;
  }

  render(ctx) {
    if (this.dead) return;

    // 拖尾：几个渐隐渐小的灰点垫在弹体后面，浅色场地上似淡淡的烟迹。
    // 反弹瞬间历史点在墙角自然拐弯，跳弹轨迹一眼可读。
    for (let i = 0; i < this.trail.length; i++) {
      const t = this.trail[i];
      const f = (i + 1) / (this.trail.length + 1); // 越新（越靠近弹体）越实
      ctx.globalAlpha = 0.14 * f;
      ctx.beginPath();
      ctx.arc(t.x, t.y, BULLET.radius * (0.4 + 0.5 * f), 0, Math.PI * 2);
      ctx.fillStyle = THEME.bullet;
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 原版风格：朴素的实心黑色小圆点，无描边、无发光（贴合截图）。
    // 不区分归属——原版子弹本就是不分颜色的黑点，满屏跳弹谁的都一样致命。
    ctx.beginPath();
    ctx.arc(this.x, this.y, BULLET.radius, 0, Math.PI * 2);
    ctx.fillStyle = THEME.bullet;
    ctx.fill();
  }
}
