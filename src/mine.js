// ============================================================
// mine.js — 地雷实体
// 职责：落地后的雷本体——布防计时（armDelay 内是哑雷）、自渲染
// （布防期半透明、警戒后指示灯红色闪烁）。
// 引爆判定（近敌检测/波及结算/护盾交互）放 main——与子弹击中判定同层，
// 需要跨所有坦克交叉；本模块只管"地上有颗会闪的雷"。
// 布雷动作在 tank.tryFire（持雷时开火键=在车尾放雷，与散射「接下来 N 次
// 开火变身」同构）；main 按 instanceof 把 tryFire 产物分流进 mines[]。
// ============================================================

import { POWERUP, THEME } from "./config.js";

export class Mine {
  // x, y: 落点世界坐标（车尾方向，已做出墙修正）；owner: 放雷的坦克
  //（owner 目前仅语义记录：雷不认人，主人踩上同样炸——armDelay 就是逃逸窗口）
  constructor(x, y, owner) {
    this.x = x;
    this.y = y;
    this.owner = owner;
    this.age = 0;
    this.exploded = false; // main 引爆后标记，统一过滤移除
  }

  // 布防完成进入警戒：近敌即炸
  get armed() {
    return this.age >= POWERUP.mine.armDelay;
  }

  update(dt) {
    this.age += dt;
  }

  render(ctx) {
    const r = POWERUP.mine.discRadius;

    ctx.save();
    ctx.translate(this.x, this.y);

    // 雷盘：布防期半透明（看得见但知道还没警戒），警戒后实色
    ctx.globalAlpha = this.armed ? 0.95 : 0.45;
    ctx.fillStyle = THEME.mineBody;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.stroke();

    // 盘面十字压线（一点"机械感"细节）
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-r * 0.6, 0);
    ctx.lineTo(r * 0.6, 0);
    ctx.moveTo(0, -r * 0.6);
    ctx.lineTo(0, r * 0.6);
    ctx.stroke();

    // 中心指示灯：警戒后红色 sin 闪烁，布防期灰色常亮
    if (this.armed) {
      ctx.globalAlpha = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(this.age * 10));
      ctx.fillStyle = THEME.mineBlink;
    } else {
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = "#9a9aa5";
    }
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
    ctx.globalAlpha = 1;
  }
}
