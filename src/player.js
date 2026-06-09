// ============================================================
// player.js — 玩家实体
// 职责：把一辆坦克与它的"身份信息"(键位/颜色/分数/是否AI)绑在一起。
// 主循环只跟 Player 打交道，不用关心坦克是人操还是 AI 操——
// 阶段 6 接入 AI 时，只需把 isAI 置 true 并换输入源，其余逻辑不动。
// ============================================================

import { Tank } from "./tank.js";

export class Player {
  // index: 玩家序号(0-based)，用于取颜色/键位
  // color: 玩家色(取自 PLAYER_COLORS)
  // keys:  该玩家键位表(取自 KEY_BINDINGS)，AI 玩家可为 null
  // x, y, angle: 出生位姿，用于创建坦克
  // isAI:  是否由 AI 控制(阶段 6 用，现在恒 false)
  constructor(index, color, keys, x, y, angle, isAI = false) {
    this.index = index;
    this.color = color;
    this.keys = keys;
    this.isAI = isAI;
    this.score = 0; // 累计胜场，阶段 5 计分用

    this.tank = new Tank(x, y, angle, color, keys);
  }

  get alive() {
    return this.tank.alive;
  }

  // 显示用名字：P1 / P2 ...；AI 玩家标注一下
  get label() {
    const base = `P${this.index + 1}`;
    return this.isAI ? `${base}(AI)` : base;
  }
}
