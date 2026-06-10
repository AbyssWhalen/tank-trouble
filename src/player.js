// ============================================================
// player.js — 玩家实体
// 职责：把一辆坦克与它的"身份信息"(键位/颜色/是否AI)绑在一起，
// 并充当控制源的分发口：人类玩家读键盘、AI 玩家问 AiController，
// 两者都产出同构的 { turn, move, fire }，主循环对人机无感知。
// ============================================================

import { Tank } from "./tank.js";
import { readControls } from "./input.js";
import { AiController } from "./ai.js";

export class Player {
  // index: 玩家序号(0-based)，用于取颜色/键位
  // color: 玩家色(取自 PLAYER_COLORS)
  // keys:  该玩家键位表(取自 KEY_BINDINGS)，AI 玩家传 null
  // x, y, angle: 出生位姿，用于创建坦克
  // isAI:  是否由 AI 控制（true 时内建 AiController，忽略 keys）
  // aiLevel: AI 难度档位 key（AI_DIFFICULTY 的 easy/normal/hard），仅 isAI 时生效
  constructor(index, color, keys, x, y, angle, isAI = false, aiLevel = "normal") {
    this.index = index;
    this.color = color;
    this.keys = keys;
    this.isAI = isAI;

    this.tank = new Tank(x, y, angle, color);
    this.ai = isAI ? new AiController(this, aiLevel) : null;
  }

  // 本帧控制指令：AI 走控制器决策，人类读键盘。
  // world = { maze, players, bullets }，仅 AI 需要（人类玩家自己看屏幕）。
  getControls(dt, world) {
    return this.isAI ? this.ai.update(dt, world) : readControls(this.keys);
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
