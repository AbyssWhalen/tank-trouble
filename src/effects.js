// ============================================================
// effects.js — 视觉特效（世界坐标，跟竞技场一起缩放平移）
// 阶段 6 起：坦克被击破的爆炸——参考原版 Tank Trouble 的死亡演出：
//   烟团：中心几个深色圆斑错位叠放，持续膨胀 + 淡出
//   碎片：若干随机多边形"残骸"四散飞出，自旋 + 阻尼减速 + 淡出
// 道具系统起：PickupFlash 拾取闪光、ShieldBreak 破盾——都是一次性扩散环。
// 纯表现层：不参与碰撞，不影响物理；done 后由 main 从数组移除。
// 联机 v2 直接复用：死亡有反馈而非凭空消失。
// ============================================================

import { EXPLOSION, THEME, TANK } from "./config.js";

// [min, max] 区间取随机数
function randRange([min, max]) {
  return min + Math.random() * (max - min);
}

// 生成一个随机碎片多边形（局部坐标顶点数组）：
// 4~5 个顶点按极角排好序，半径抖动，出来就是"纸片残骸"的不规则感
function makeShardShape(size) {
  const n = 4 + Math.floor(Math.random() * 2);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.6;
    const r = size * (0.55 + Math.random() * 0.45);
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

export class TankExplosion {
  // x, y: 爆炸中心（被击破坦克的位置）；color: 坦克色（碎片淡淡染一点身份色）
  constructor(x, y, color) {
    this.x = x;
    this.y = y;
    this.color = color;
    this.age = 0;

    // 碎片：随机方向 + 随机初速飞出，自旋方向随机
    const count = Math.round(randRange(EXPLOSION.shardCount));
    this.shards = [];
    for (let i = 0; i < count; i++) {
      const dir = Math.random() * Math.PI * 2;
      const speed = randRange(EXPLOSION.shardSpeed);
      this.shards.push({
        x: 0,                       // 相对爆炸中心
        y: 0,
        vx: Math.cos(dir) * speed,
        vy: Math.sin(dir) * speed,
        rot: Math.random() * Math.PI * 2,
        spin: (Math.random() * 2 - 1) * EXPLOSION.shardSpin,
        shape: makeShardShape(randRange(EXPLOSION.shardSize)),
        tinted: Math.random() < 0.35, // 少数碎片染坦克色，看得出是谁的残骸
      });
    }

    // 烟团：中心一个 + 周围错位几个，半径各自随机
    this.smoke = [];
    for (let i = 0; i < EXPLOSION.smokeCount; i++) {
      this.smoke.push({
        // 第一个居中，其余在中心附近随机错位
        x: i === 0 ? 0 : (Math.random() * 2 - 1) * 12,
        y: i === 0 ? 0 : (Math.random() * 2 - 1) * 12,
        r: randRange(EXPLOSION.smokeRadius),
      });
    }
  }

  get done() {
    return this.age >= EXPLOSION.duration;
  }

  update(dt) {
    if (this.done) return;
    this.age += dt;

    // 碎片：指数阻尼减速（速度按 e^(-drag·dt) 衰减），边飞边自旋
    const damp = Math.exp(-EXPLOSION.shardDrag * dt);
    for (const s of this.shards) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= damp;
      s.vy *= damp;
      s.rot += s.spin * dt;
    }

    // 烟团持续膨胀
    for (const p of this.smoke) {
      p.r += EXPLOSION.smokeGrow * dt;
    }
  }

  render(ctx) {
    if (this.done) return;

    const progress = this.age / EXPLOSION.duration;
    // 前段全显，过 fadeStart 后线性淡出到 0
    const alpha = progress < EXPLOSION.fadeStart
      ? 1
      : 1 - (progress - EXPLOSION.fadeStart) / (1 - EXPLOSION.fadeStart);

    ctx.save();
    ctx.translate(this.x, this.y);

    // —— 1) 烟团（底层）：深灰圆斑，膨胀中淡出 ——
    ctx.fillStyle = "#2f2f33";
    ctx.globalAlpha = alpha * 0.8;
    for (const p of this.smoke) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // —— 2) 碎片（上层）：浅色"纸片残骸"+ 深色描边，贴近原版截图质感 ——
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#2b2b33";
    for (const s of this.shards) {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.beginPath();
      ctx.moveTo(s.shape[0].x, s.shape[0].y);
      for (let i = 1; i < s.shape.length; i++) {
        ctx.lineTo(s.shape[i].x, s.shape[i].y);
      }
      ctx.closePath();
      ctx.fillStyle = s.tinted ? this.color : "#f2f1ec";
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
    ctx.globalAlpha = 1; // 复位，别污染后续绘制
  }
}

// ============================================================
// PickupFlash — 拾取道具时的一圈快速扩散彩环（~0.3s）
// 轻量提示「这里捡到了东西」，颜色按道具类型取（散射橙 / 护盾青）。
// ============================================================
export class PickupFlash {
  // x, y: 拾取位置；type: "scatter" | "shield"（决定环色）
  constructor(x, y, type) {
    this.x = x;
    this.y = y;
    this.color = type === "scatter" ? THEME.powScatterBg : THEME.powShieldBg;
    this.age = 0;
    this.duration = 0.3;
  }

  get done() {
    return this.age >= this.duration;
  }

  update(dt) {
    this.age += dt;
  }

  render(ctx) {
    if (this.done) return;
    const p = this.age / this.duration;
    // 环半径从坦克尺寸快速扩到 ~2.5 倍，同时淡出
    const r = TANK.radius * (0.8 + p * 1.7);
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.globalAlpha = 1 - p;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

// ============================================================
// ShieldBreak — 护盾挡下一发时的破碎特效（~0.4s）
// 一圈炸开的光环 + 几片向外飞的弧形碎光，告诉玩家「盾碎了，这下没保护了」。
// ============================================================
export class ShieldBreak {
  // x, y: 坦克位置；color: 护盾环色（与 tank 上的护盾环同色，视觉连贯）
  constructor(x, y, color) {
    this.x = x;
    this.y = y;
    this.color = color;
    this.age = 0;
    this.duration = 0.4;
    // 几片碎光：均匀分布的弧段，向外飞 + 淡出
    this.shards = [];
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.3;
      this.shards.push({ a, speed: 70 + Math.random() * 50 });
    }
  }

  get done() {
    return this.age >= this.duration;
  }

  update(dt) {
    this.age += dt;
  }

  render(ctx) {
    if (this.done) return;
    const p = this.age / this.duration;
    const alpha = 1 - p;

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = this.color;

    // —— 1) 炸开的光环：半径快速扩张 ——
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, (TANK.radius + 6) * (1 + p * 0.8), 0, Math.PI * 2);
    ctx.stroke();

    // —— 2) 碎光：每片是一小段弧，沿各自方向向外飞 ——
    ctx.lineWidth = 2;
    const baseR = TANK.radius + 6;
    for (const s of this.shards) {
      const dist = baseR + s.speed * this.age;
      const cx = Math.cos(s.a) * dist;
      const cy = Math.sin(s.a) * dist;
      ctx.beginPath();
      ctx.arc(cx, cy, 3.5, s.a - 0.6, s.a + 0.6);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }
}
