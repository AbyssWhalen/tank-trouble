// ============================================================
// tank.js — 坦克实体
// 职责：维护位置/朝向，按「控制指令」移动转向，渲染自身。
// 不直接读键盘：每帧由外部传入 { turn, move, fire }（人类来自
// input.readControls，AI 来自 ai.js），坦克只消费指令不关心来源。
// ============================================================

import { TANK, BULLET, POWERUP, THEME } from "./config.js";
import { resolveCircleWalls, segmentVsSegmentParam } from "./collision.js";
import { Bullet } from "./bullet.js";

export class Tank {
  // x, y: 车体中心世界坐标（像素）
  // angle: 朝向弧度，0 指向右(+x)，顺时针为正
  // color: 车体颜色
  constructor(x, y, angle, color) {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.color = color;
    this.alive = true;
    this.cooldown = 0;

    // —— 道具状态（捡到道具时由 applyPowerup 设置；无道具时全为初值）——
    // scatter/pierce 同属「武器改装槽」互斥（异类拾取清旧换新，同类叠加次数），
    // shield 独立并存——见 applyPowerup。
    this.scatterShots = 0;   // 剩余「扇形开火」次数，>0 时 tryFire 打扇形并递减
    this.pierceShots = 0;    // 剩余「穿墙弹」发数，>0 时单发子弹带穿墙 1 次的能力
    this.shield = false;     // 是否持有护盾（挡一次致命伤害）
    this.shieldTimer = 0;    // 护盾剩余时间（秒），到点自动消失防一直龟
  }

  // dt: 距上一帧的秒数；walls: 墙线段数组，用于撞墙不穿
  // controls: 本帧控制指令 { turn: -1|0|1, move: -1|0|1 }（fire 走 tryFire）
  update(dt, walls, controls) {
    if (!this.alive) return;

    // 开炮冷却递减
    if (this.cooldown > 0) this.cooldown -= dt;

    // 护盾限时流逝：到点自动消失（防止捡到盾就一直龟着不出来打）。
    // 「挡一次伤害」的消耗在 main 的击中判定里做，两条触发先到先算。
    if (this.shield) {
      this.shieldTimer -= dt;
      if (this.shieldTimer <= 0) {
        this.shield = false;
        this.shieldTimer = 0;
      }
    }

    // 转向：原地转
    this.angle += controls.turn * TANK.turnSpeed * dt;

    // 前进/后退：沿朝向移动
    if (controls.move !== 0) {
      const dist = controls.move * TANK.moveSpeed * dt;
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

  // 尝试开炮：wantFire 为 true + 冷却就绪 + 同屏己方子弹未达上限时，
  // 从炮口生成子弹。返回「子弹数组」——普通单发是 [bullet]，散射是多发，
  // 不开火/被限流是 []。（原先返回单个 Bullet 或 null，改数组以支持散射弹；
  // 调用方 main 用展开 push 接住，对单发零成本。）
  // wantFire 即控制指令的 fire 位（人类是边沿触发，AI 自带开火节奏）。
  // bullets: 全局子弹数组，用于统计自己还有几发在场（实现 maxAlive 限流）——
  // 这是原版"靠子弹上限而非冷却限流"的核心，去掉固定冷却后尤其关键。
  //   散射开火绕开 maxAlive：扇形是一次性集中火力（一炮多发），受限流会瞬间触顶
  //   只发出一两发，扇形就废了。普通单发仍严格受限流，原版手感不变。
  // walls: 墙线段数组，用于贴墙出膛修正（防穿墙）。
  // 子弹的归属(owner)记为本坦克，便于"出膛宽限期"等判定。
  tryFire(bullets, wantFire, walls) {
    if (!this.alive) return [];
    if (this.cooldown > 0) return [];
    if (!wantFire) return [];

    const scattering = this.scatterShots > 0;

    // 同屏己方存活子弹数达上限则不发射（散射绕开：见上方注释）
    if (!scattering && bullets) {
      let mine = 0;
      for (const b of bullets) {
        if (b.owner === this && !b.dead) mine++;
      }
      if (mine >= BULLET.maxAlive) return [];
    }

    this.cooldown = BULLET.cooldown;

    if (scattering) {
      this.scatterShots--; // 消耗一次扇形开火机会，归零自动恢复单发
      // 扇形：以朝向为中线，pellets 发按 spreadAngle 均匀铺开（奇数有正中那发）
      const { pellets, spreadAngle } = POWERUP.scatter;
      const out = [];
      const mid = (pellets - 1) / 2;
      for (let i = 0; i < pellets; i++) {
        out.push(this.spawnBullet(this.angle + (i - mid) * spreadAngle, walls));
      }
      return out;
    }

    // 穿墙弹：普通单发弹道（受 maxAlive 限流，上面已查过），只是弹上带
    // 「可穿透 1 堵内墙」的额度；打完存货自动恢复普通弹
    if (this.pierceShots > 0) {
      this.pierceShots--;
      return [this.spawnBullet(this.angle, walls, 1)];
    }

    return [this.spawnBullet(this.angle, walls)];
  }

  // 沿给定 heading 生成一发子弹，含贴墙出膛修正（防穿墙）。
  // 抽出来供单发 / 散射多发共用：每发各按自己的角度独立修正出膛点。
  // pierceLeft: 该弹可穿透的内墙数（穿墙弹传 1，普通弹省略为 0）。
  spawnBullet(heading, walls, pierceLeft = 0) {
    // 炮口位置：从车体中心沿朝向伸出（炮管末端再多探出一点，避免子弹生成在车体内被自己挡）
    const muzzleDist = TANK.bodyLength / 2 + TANK.barrelLength + BULLET.radius + 2;

    // 贴墙出膛修正：炮口(36px)比车体碰撞半径(16px)伸得远，贴墙时炮口已越到
    // 墙外侧，子弹会凭空出现在墙另一边——穿墙 bug 的根因。
    // 沿"中心→炮口"连线探测所有墙，被截断就把出膛点压回墙内侧一点。
    // 压回后子弹下一帧即被墙反射，贴脸怼墙开炮会弹回来——原版同款自杀手感。
    let spawnDist = muzzleDist;
    if (walls && walls.length) {
      const mx = this.x + Math.cos(heading) * muzzleDist;
      const my = this.y + Math.sin(heading) * muzzleDist;
      for (const w of walls) {
        const t = segmentVsSegmentParam(this.x, this.y, mx, my, w.x1, w.y1, w.x2, w.y2);
        if (t !== null) {
          spawnDist = Math.min(spawnDist, t * muzzleDist - BULLET.radius - 1);
        }
      }
    }

    const bx = this.x + Math.cos(heading) * spawnDist;
    const by = this.y + Math.sin(heading) * spawnDist;
    const vx = Math.cos(heading) * BULLET.speed;
    const vy = Math.sin(heading) * BULLET.speed;
    return new Bullet(bx, by, vx, vy, this, pierceLeft);
  }

  // 拾取道具：按类型设置对应状态。
  // 武器改装槽（scatter/pierce）互斥：拾取异类先清空旧存货再赋新，
  // 同类拾取叠加次数；shield 独立并存（刷新一层 + 重置计时）。
  // 互斥让 tryFire 的分支优先级永远无歧义，玩家/AI 心智模型也简单。
  applyPowerup(type) {
    if (type === "scatter") {
      this.pierceShots = 0;
      this.scatterShots += POWERUP.scatter.shots;
    } else if (type === "pierce") {
      this.scatterShots = 0;
      this.pierceShots += POWERUP.pierce.shots;
    } else if (type === "shield") {
      this.shield = true;
      this.shieldTimer = POWERUP.shield.duration;
    }
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

    // —— 护盾环（持有护盾时，套在车体外的旋转虚线光环）——
    // 单独一段：只平移不旋转，让光环动画与车头朝向解耦（环跟着车走但自转）。
    // 旋转用 lineDashOffset 随 shieldTimer 推进；快到期时（<1.5s）闪烁提示即将消失。
    if (this.shield) {
      const blink = this.shieldTimer < 1.5 ? 0.4 + 0.4 * Math.abs(Math.sin(this.shieldTimer * 8)) : 0.8;
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.globalAlpha = blink;
      ctx.strokeStyle = THEME.shieldRing;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -this.shieldTimer * 18; // 负值 → 顺时针流动
      ctx.beginPath();
      ctx.arc(0, 0, TANK.radius + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);       // 复位虚线，别污染后续绘制
      ctx.globalAlpha = 1;
      ctx.restore();
    }
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
