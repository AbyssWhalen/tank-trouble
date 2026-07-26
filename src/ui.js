// ============================================================
// ui.js — 界面层：菜单 / 浮层 / HUD / 结算横幅的绘制与命中检测
// 职责边界：只画东西 + 算「点到了什么」，不改任何游戏状态——
// 命中检测返回 action 对象（如 {type:"mode", mode:"pvp"}），由 main 消费。
// 所有坐标都是逻辑像素（CANVAS.width/height 坐标系），与竞技场世界坐标无关；
// ctx 由调用方传入（ui 不持有 canvas）。
// ============================================================

import {
  CANVAS, THEME, AI_DIFFICULTY, PLAYER_COLORS, KEY_BINDINGS, POWERUP,
} from "./config.js";

// —— 菜单按钮（逻辑坐标，不随迷宫平移）——
const BTN_W = 300, BTN_H = 66;
const BTN_X = (CANVAS.width - BTN_W) / 2;
const buttons = [
  { label: "双人对战", sub: "P1 vs P2", mode: "pvp", enabled: true, x: BTN_X, y: 322, w: BTN_W, h: BTN_H },
  { label: "人机对战", sub: "P1 vs AI", mode: "pve", enabled: true, x: BTN_X, y: 410, w: BTN_W, h: BTN_H },
];

// —— AI 难度 chip（人机按钮正下方一排单选）——
const CHIP_W = 88, CHIP_H = 32, CHIP_GAP = 14;
const chipKeys = Object.keys(AI_DIFFICULTY); // ["easy","normal","hard"]，展示顺序即定义顺序
const CHIPS_X = (CANVAS.width - (chipKeys.length * CHIP_W + (chipKeys.length - 1) * CHIP_GAP)) / 2;
const difficultyChips = chipKeys.map((key, i) => ({
  key,
  x: CHIPS_X + i * (CHIP_W + CHIP_GAP),
  y: 494, // 人机按钮底边 476 再留 18px
  w: CHIP_W,
  h: CHIP_H,
}));

// —— 道具类型 chip（难度 chip 下方一排，多选 toggle：选中=该类道具会刷新）——
// 由 POWERUP.types 生成，新道具加进 config 自动出现在菜单；全不选=整局无道具。
const POWERUP_LABELS = { scatter: "散射", shield: "护盾", laser: "激光", mine: "地雷" };
const POW_CHIP_W = 88, POW_CHIP_H = 32, POW_CHIP_GAP = 14;
const POW_CHIPS_X =
  (CANVAS.width - (POWERUP.types.length * POW_CHIP_W + (POWERUP.types.length - 1) * POW_CHIP_GAP)) / 2;
const powupChips = POWERUP.types.map((key, i) => ({
  key,
  label: POWERUP_LABELS[key] || key,
  x: POW_CHIPS_X + i * (POW_CHIP_W + POW_CHIP_GAP),
  y: 544, // 难度 chip 底边 526 再留 18px
  w: POW_CHIP_W,
  h: POW_CHIP_H,
}));

// —— 玩法说明按钮（右下角圆形 "?" 按钮，点开浮窗）——
const helpBtn = { x: CANVAS.width - 56, y: CANVAS.height - 56, r: 20 };

// —— 键位设置按钮（左下角圆形按钮，与右下 "?" 对称）——
const rebindBtn = { x: 56, y: CANVAS.height - 56, r: 20 };

// —— 音效开关按钮（「键」按钮右侧，同规格，设置类按钮成组）——
const audioBtn = { x: 108, y: CANVAS.height - 56, r: 20 };

// —— 键位设置面板（居中浮窗）：布局常量 + 每个键位 chip 的命中矩形 ——
const REBIND_PANEL = { w: 620, h: 540 };
REBIND_PANEL.x = (CANVAS.width - REBIND_PANEL.w) / 2;
REBIND_PANEL.y = (CANVAS.height - REBIND_PANEL.h) / 2;

const REBIND_ACTIONS = ["forward", "back", "left", "right", "fire", "special"];
const ACTION_LABELS = {
  forward: "前进", back: "后退", left: "左转", right: "右转", fire: "开火", special: "道具",
};

// 键位 chip 命中表：两列（P1/P2）× 6 行，静态算好
const rebindChips = [];
for (let p = 0; p < 2; p++) {
  REBIND_ACTIONS.forEach((action, row) => {
    rebindChips.push({
      player: p,
      action,
      x: REBIND_PANEL.x + 110 + p * 270,
      y: REBIND_PANEL.y + 120 + row * 50,
      w: 140,
      h: 36,
    });
  });
}
const rebindResetBtn = {
  x: (CANVAS.width - 140) / 2,
  y: REBIND_PANEL.y + REBIND_PANEL.h - 84, // 底部提示文字上方，别与之重叠
  w: 140,
  h: 38,
};

// —— 暂停菜单按钮（PAUSED 浮窗里的两个按钮，逻辑坐标居中）——
const PAUSE_BTN_W = 240, PAUSE_BTN_H = 54;
const PAUSE_BTN_X = (CANVAS.width - PAUSE_BTN_W) / 2;
const pauseButtons = [
  { label: "继续对战", action: "resume", x: PAUSE_BTN_X, y: 340, w: PAUSE_BTN_W, h: PAUSE_BTN_H },
  { label: "返回主菜单", action: "menu", x: PAUSE_BTN_X, y: 410, w: PAUSE_BTN_W, h: PAUSE_BTN_H },
];

// 点 (mx,my) 是否落在矩形内
function hitRect(mx, my, r) {
  return mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h;
}

// 点 (mx,my) 是否落在圆内（圆形按钮命中检测）
function hitCircle(mx, my, cx, cy, radius) {
  return Math.hypot(mx - cx, my - cy) <= radius;
}

// 圆角矩形路径。只建路径，由调用方决定 fill/stroke。
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ============================================================
// 键名显示：KeyboardEvent.code → 面向玩家的短标签。
// 键位可自定义后，卡片/帮助/改键面板的文案都从实际键位动态生成。
// ============================================================
const KEY_LABELS = {
  Space: "Space", Enter: "Enter", Escape: "Esc", Tab: "Tab", Backspace: "BkSp", CapsLock: "Caps",
  ShiftLeft: "LShift", ShiftRight: "RShift",
  ControlLeft: "LCtrl", ControlRight: "RCtrl",
  AltLeft: "LAlt", AltRight: "RAlt",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
  BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`",
  NumpadAdd: "Num+", NumpadSubtract: "Num-", NumpadMultiply: "Num*",
  NumpadDivide: "Num/", NumpadEnter: "NumEnter", NumpadDecimal: "Num.",
};

export function keyLabel(code) {
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (code.startsWith("Key")) return code.slice(3);      // KeyW → W
  if (code.startsWith("Digit")) return code.slice(5);    // Digit1 → 1
  if (code.startsWith("Numpad")) return "Num" + code.slice(6); // Numpad8 → Num8
  return code; // F1~F12 及其他原样兜底
}

// 某玩家的移动键位串（前/左/后/右，与 WASD 的视觉排布一致）
function moveKeysLabel(i) {
  const k = KEY_BINDINGS[i];
  return [k.forward, k.left, k.back, k.right].map(keyLabel).join(" ");
}

// ============================================================
// 命中检测（action 版）：返回「点到了什么」，不执行任何状态变更
// ============================================================

// 菜单点击。判定优先级与浮层遮挡关系保持一致：
// 说明浮窗（开着时点任意处关闭）> 帮助按钮 > 键位设置按钮 > 难度 chip > 道具 chip > 模式按钮
// （键位面板开着时的点击不走这里，由 rebindAction 处理——main 按自身状态分流）
export function menuAction(mx, my, { showHelp }) {
  if (showHelp) return { type: "closeHelp" };
  if (hitCircle(mx, my, helpBtn.x, helpBtn.y, helpBtn.r)) return { type: "openHelp" };
  if (hitCircle(mx, my, rebindBtn.x, rebindBtn.y, rebindBtn.r)) return { type: "openRebind" };
  if (hitCircle(mx, my, audioBtn.x, audioBtn.y, audioBtn.r)) return { type: "toggleMute" };
  for (const c of difficultyChips) {
    if (hitRect(mx, my, c)) return { type: "aiLevel", key: c.key };
  }
  for (const c of powupChips) {
    if (hitRect(mx, my, c)) return { type: "togglePowerup", key: c.key };
  }
  for (const b of buttons) {
    if (b.enabled && hitRect(mx, my, b)) return { type: "mode", mode: b.mode };
  }
  return null;
}

// 暂停浮层点击：返回 "resume" | "menu" | null
export function pauseAction(mx, my) {
  for (const b of pauseButtons) {
    if (hitRect(mx, my, b)) return b.action;
  }
  return null;
}

// 键位设置面板点击（面板打开时 main 只走这里）：
//   {type:"bind", player, action} 点了某个键位 chip，进入捕获态
//   {type:"reset"}                恢复默认
//   {type:"close"}                点在面板外，关闭面板
//   null                          面板内空白处，无动作
export function rebindAction(mx, my) {
  for (const c of rebindChips) {
    if (hitRect(mx, my, c)) return { type: "bind", player: c.player, action: c.action };
  }
  if (hitRect(mx, my, rebindResetBtn)) return { type: "reset" };
  const p = REBIND_PANEL;
  if (mx >= p.x && mx <= p.x + p.w && my >= p.y && my <= p.y + p.h) return null;
  return { type: "close" };
}

// ============================================================
// 绘制
// ============================================================

// 主菜单。view = { mouse:{x,y}, aiLevel, enabledPowerups:Set, showHelp }
export function renderMenu(ctx, view) {
  const cx = CANVAS.width / 2;
  const { x: mx, y: my } = view.mouse;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // 标题
  ctx.fillStyle = THEME.title;
  ctx.font = "bold 64px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText("坦克回廊", cx, 130);

  // 标题下细横线装饰（主题色，加点游戏感）
  ctx.strokeStyle = THEME.accent;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - 90, 172);
  ctx.lineTo(cx + 90, 172);
  ctx.stroke();

  // —— 操作说明：左右分栏卡片（P1 | P2）——
  renderControlCards(ctx, cx);

  // 模式按钮
  for (const b of buttons) {
    const hover = b.enabled && hitRect(mx, my, b);

    // 按钮底
    if (!b.enabled) ctx.fillStyle = THEME.btnDisabledFill;
    else ctx.fillStyle = hover ? THEME.btnFillHover : THEME.btnFill;
    roundRect(ctx, b.x, b.y, b.w, b.h, 10);
    ctx.fill();

    // 边框（hover 时用主题色）
    ctx.lineWidth = 2;
    ctx.strokeStyle = !b.enabled ? THEME.btnDisabledBorder : hover ? THEME.accent : THEME.btnBorder;
    roundRect(ctx, b.x, b.y, b.w, b.h, 10);
    ctx.stroke();

    // 主文字
    const textColor = !b.enabled
      ? THEME.btnDisabledText
      : hover ? THEME.btnTextHover : THEME.btnBorder;
    ctx.fillStyle = textColor;
    ctx.font = "bold 24px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 - 9);

    // 副文字
    ctx.fillStyle = !b.enabled
      ? THEME.btnDisabledText
      : hover ? THEME.btnTextHover : THEME.textDim;
    ctx.font = "13px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(b.sub, b.x + b.w / 2, b.y + b.h / 2 + 16);
  }

  // AI 难度 chip（单选：选中主题色实心，未选白底；只影响人机对战）
  ctx.font = "14px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.textAlign = "right";
  ctx.fillStyle = THEME.textDim;
  ctx.fillText("AI 难度", difficultyChips[0].x - 14, difficultyChips[0].y + CHIP_H / 2);
  ctx.textAlign = "center";
  for (const c of difficultyChips) {
    const selected = c.key === view.aiLevel;
    const hover = hitRect(mx, my, c);
    renderChip(ctx, c, AI_DIFFICULTY[c.key].label, selected, hover);
  }

  // 道具类型 chip（多选：亮=启用该类道具，全灭=整局无道具）
  ctx.textAlign = "right";
  ctx.fillStyle = THEME.textDim;
  ctx.font = "14px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText("道具", powupChips[0].x - 14, powupChips[0].y + POW_CHIP_H / 2);
  ctx.textAlign = "center";
  for (const c of powupChips) {
    const selected = view.enabledPowerups.has(c.key);
    const hover = hitRect(mx, my, c);
    renderChip(ctx, c, c.label, selected, hover);
  }

  // 玩法说明按钮（右下角圆形 "?"）+ 键位设置按钮（左下角）+ 音效开关
  renderHelpButton(ctx, mx, my);
  renderRebindButton(ctx, mx, my);
  renderAudioButton(ctx, mx, my, view.muted);

  // 底部提示 + 快捷键
  ctx.fillStyle = THEME.textDim;
  ctx.font = "13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("点击模式开始对战　·　结算时 R 立即开下一局 · Esc 返回菜单", cx, CANVAS.height - 38);

  // 说明浮窗（最上层，盖住整个菜单）
  if (view.showHelp) renderHelpOverlay(ctx, cx);
}

// 操作说明卡片：左右分栏（P1 | P2），键位从当前 KEY_BINDINGS 动态生成
function renderControlCards(ctx, cx) {
  const cardW = 230, cardH = 96, gap = 24;
  const totalW = cardW * 2 + gap;
  const startX = cx - totalW / 2;
  const y = 200;

  const cards = [0, 1].map((i) => ({
    title: `玩家 ${i + 1}`,
    color: PLAYER_COLORS[i],
    move: moveKeysLabel(i),
    fire: `${keyLabel(KEY_BINDINGS[i].fire)} 开炮`,
    special: `${keyLabel(KEY_BINDINGS[i].special)} 放道具`,
  }));

  cards.forEach((card, i) => {
    const x = startX + i * (cardW + gap);

    // 卡片底
    ctx.fillStyle = "#ffffff";
    roundRect(ctx, x, y, cardW, cardH, 10);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = THEME.btnDisabledBorder;
    roundRect(ctx, x, y, cardW, cardH, 10);
    ctx.stroke();

    // 左侧色块标识（玩家色）
    ctx.fillStyle = card.color;
    roundRect(ctx, x + 14, y + cardH / 2 - 14, 28, 28, 6);
    ctx.fill();

    // 标题
    ctx.textAlign = "left";
    ctx.fillStyle = THEME.textMain;
    ctx.font = "bold 15px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(card.title, x + 54, y + 22);

    // 键位（移动 / 开炮 / 道具三行）
    ctx.fillStyle = THEME.textDim;
    ctx.font = "13px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(card.move + "  移动", x + 54, y + 42);
    ctx.fillText(card.fire, x + 54, y + 60);
    ctx.fillText(card.special, x + 54, y + 78);
  });
  ctx.textAlign = "center";
}

// 通用 chip 渲染（难度/道具共用）：选中主题色实心，未选白底描边
function renderChip(ctx, c, label, selected, hover) {
  ctx.fillStyle = selected ? THEME.accent : THEME.btnFill;
  roundRect(ctx, c.x, c.y, c.w, c.h, 8);
  ctx.fill();

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = selected ? THEME.accent : hover ? THEME.accent : THEME.btnDisabledBorder;
  roundRect(ctx, c.x, c.y, c.w, c.h, 8);
  ctx.stroke();

  ctx.fillStyle = selected ? "#ffffff" : hover ? THEME.textMain : THEME.textDim;
  ctx.font = "14px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText(label, c.x + c.w / 2, c.y + c.h / 2);
}

// 右下角圆形 "?" 按钮
function renderHelpButton(ctx, mx, my) {
  const hover = hitCircle(mx, my, helpBtn.x, helpBtn.y, helpBtn.r);
  ctx.beginPath();
  ctx.arc(helpBtn.x, helpBtn.y, helpBtn.r, 0, Math.PI * 2);
  ctx.fillStyle = hover ? THEME.accent : THEME.btnFill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = THEME.accent;
  ctx.stroke();

  ctx.fillStyle = hover ? "#ffffff" : THEME.accent;
  ctx.font = "bold 20px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("?", helpBtn.x, helpBtn.y + 1);
}

// 左下角圆形「键」按钮（打开键位设置面板）
function renderRebindButton(ctx, mx, my) {
  const hover = hitCircle(mx, my, rebindBtn.x, rebindBtn.y, rebindBtn.r);
  ctx.beginPath();
  ctx.arc(rebindBtn.x, rebindBtn.y, rebindBtn.r, 0, Math.PI * 2);
  ctx.fillStyle = hover ? THEME.accent : THEME.btnFill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = THEME.accent;
  ctx.stroke();

  ctx.fillStyle = hover ? "#ffffff" : THEME.accent;
  ctx.font = "bold 14px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("键", rebindBtn.x, rebindBtn.y + 1);
}

// 「键」按钮右侧的音效开关圆钮：♪ 有声 / 静音时画斜杠压在音符上
function renderAudioButton(ctx, mx, my, muted) {
  const hover = hitCircle(mx, my, audioBtn.x, audioBtn.y, audioBtn.r);
  ctx.beginPath();
  ctx.arc(audioBtn.x, audioBtn.y, audioBtn.r, 0, Math.PI * 2);
  ctx.fillStyle = hover ? THEME.accent : THEME.btnFill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = THEME.accent;
  ctx.stroke();

  const fg = hover ? "#ffffff" : muted ? THEME.textDim : THEME.accent;
  ctx.fillStyle = fg;
  ctx.font = "bold 16px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("♪", audioBtn.x, audioBtn.y + 1);
  if (muted) {
    // 斜杠盖在音符上表示静音（不换字形，避免字体缺 emoji 静音符）
    ctx.strokeStyle = fg;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(audioBtn.x - 9, audioBtn.y + 9);
    ctx.lineTo(audioBtn.x + 9, audioBtn.y - 9);
    ctx.stroke();
  }
}

// 键位设置面板。view = { mouse, capturing: {player, action}|null, conflictMsg }
// 只画不改状态：捕获态高亮对应 chip、冲突信息红字提示，交互全在 main。
export function renderRebindOverlay(ctx, view) {
  const { x: mx, y: my } = view.mouse;
  const p = REBIND_PANEL;
  const cx = CANVAS.width / 2;

  // 半透明遮罩 + 面板底
  ctx.fillStyle = "rgba(43,43,51,0.55)";
  ctx.fillRect(0, 0, CANVAS.width, CANVAS.height);
  ctx.fillStyle = THEME.pageBg;
  roundRect(ctx, p.x, p.y, p.w, p.h, 14);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = THEME.accent;
  roundRect(ctx, p.x, p.y, p.w, p.h, 14);
  ctx.stroke();

  // 标题 + 操作提示
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = THEME.title;
  ctx.font = "bold 28px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText("键位设置", cx, p.y + 40);
  ctx.fillStyle = THEME.textDim;
  ctx.font = "13px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText("点击键位后按下新键 · Esc 取消捕获（Esc / F11 不可绑定）", cx, p.y + 72);

  // 两列表头（玩家色圆点 + 名称）
  for (let i = 0; i < 2; i++) {
    const hx = p.x + 110 + i * 270 + 70; // 列 chip 的水平中点
    ctx.fillStyle = PLAYER_COLORS[i];
    ctx.beginPath();
    ctx.arc(hx - 34, p.y + 104, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = THEME.textMain;
    ctx.font = "bold 15px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(`玩家 ${i + 1}`, hx + 8, p.y + 104);
  }

  // 键位行：动作标签 + 当前键 chip（捕获中高亮显示「按新键…」）
  for (const c of rebindChips) {
    ctx.textAlign = "right";
    ctx.fillStyle = THEME.textDim;
    ctx.font = "14px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(ACTION_LABELS[c.action], c.x - 10, c.y + c.h / 2);

    const capturing =
      view.capturing && view.capturing.player === c.player && view.capturing.action === c.action;
    const hover = hitRect(mx, my, c);

    ctx.fillStyle = capturing ? THEME.accent : THEME.btnFill;
    roundRect(ctx, c.x, c.y, c.w, c.h, 8);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = capturing || hover ? THEME.accent : THEME.btnDisabledBorder;
    roundRect(ctx, c.x, c.y, c.w, c.h, 8);
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.fillStyle = capturing ? "#ffffff" : THEME.textMain;
    ctx.font = "14px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(
      capturing ? "按新键…" : keyLabel(KEY_BINDINGS[c.player][c.action]),
      c.x + c.w / 2,
      c.y + c.h / 2
    );
  }

  // 冲突/提示信息（红字，短暂显示后由 main 清除）
  if (view.conflictMsg) {
    ctx.textAlign = "center";
    ctx.fillStyle = "#c0392b";
    ctx.font = "14px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(view.conflictMsg, cx, rebindResetBtn.y - 22);
  }

  // 恢复默认按钮
  const resetHover = hitRect(mx, my, rebindResetBtn);
  ctx.fillStyle = resetHover ? THEME.accent : THEME.btnFill;
  roundRect(ctx, rebindResetBtn.x, rebindResetBtn.y, rebindResetBtn.w, rebindResetBtn.h, 8);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = THEME.accent;
  roundRect(ctx, rebindResetBtn.x, rebindResetBtn.y, rebindResetBtn.w, rebindResetBtn.h, 8);
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.fillStyle = resetHover ? "#ffffff" : THEME.accent;
  ctx.font = "14px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText("恢复默认", rebindResetBtn.x + rebindResetBtn.w / 2, rebindResetBtn.y + rebindResetBtn.h / 2);

  // 底部关闭提示
  ctx.fillStyle = THEME.textDim;
  ctx.font = "13px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText("点击面板外关闭", cx, p.y + p.h - 24);
}

// 玩法说明浮窗：半透明遮罩 + 居中面板，列出操作/规则/快捷键/道具
function renderHelpOverlay(ctx, cx) {
  // 半透明遮罩
  ctx.fillStyle = "rgba(43,43,51,0.55)";
  ctx.fillRect(0, 0, CANVAS.width, CANVAS.height);

  // 面板
  const pw = 560, ph = 480;
  const px = cx - pw / 2, py = (CANVAS.height - ph) / 2;
  ctx.fillStyle = THEME.pageBg;
  roundRect(ctx, px, py, pw, ph, 14);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = THEME.accent;
  roundRect(ctx, px, py, pw, ph, 14);
  ctx.stroke();

  // 标题
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = THEME.title;
  ctx.font = "bold 28px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText("玩法说明", cx, py + 40);

  // 分区内容（左对齐排版）
  const lx = px + 40;
  let ly = py + 84;
  const lineH = 26;

  const section = (title) => {
    ctx.textAlign = "left";
    ctx.fillStyle = THEME.accent;
    ctx.font = "bold 16px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(title, lx, ly);
    ly += lineH;
  };
  const line = (text) => {
    ctx.textAlign = "left";
    ctx.fillStyle = THEME.textMain;
    ctx.font = "14px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(text, lx + 12, ly);
    ly += lineH - 2;
  };

  section("操作");
  line(`玩家 1：${moveKeysLabel(0)} 移动，${keyLabel(KEY_BINDINGS[0].fire)} 开炮，${keyLabel(KEY_BINDINGS[0].special)} 放道具`);
  line(`玩家 2：${moveKeysLabel(1)} 移动，${keyLabel(KEY_BINDINGS[1].fire)} 开炮，${keyLabel(KEY_BINDINGS[1].special)} 放道具`);
  ly += 6;

  section("规则");
  line("击毁对手得 1 分，迷宫墙壁可反弹子弹（小心自己的跳弹）");
  line("每回合自动换地图，回合结束后倒计时自动重开");
  ly += 6;

  section("道具（菜单可逐类开关）");
  line("护盾：挡下一发致命攻击即碎，或 5 秒后自动消失（先到先算）");
  line("散射：连续 3 次扇形开火（一炮 3 发）");
  line("激光：下一发开火变瞬时射线，沿墙反弹、命中即杀；红色虚线全程预示弹道");
  line("地雷：捡取后按道具键在车尾布雷（共 2 颗），1 秒布防后近敌即炸（不认主人）");
  ly += 6;

  section("快捷键");
  line("结算时 R 立即开下一局　·　Esc 暂停 / 返回菜单");

  // 底部关闭提示
  ctx.textAlign = "center";
  ctx.fillStyle = THEME.textDim;
  ctx.font = "13px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText("点击任意处关闭", cx, py + ph - 28);
}

// 暂停浮层（叠在竞技场上）：半透明遮罩 + 标题 + 两个按钮（继续 / 返回主菜单）
export function renderPauseOverlay(ctx, mouse) {
  const cx = CANVAS.width / 2;
  const { x: mx, y: my } = mouse;

  // 半透明遮罩
  ctx.fillStyle = "rgba(43,43,51,0.7)";
  ctx.fillRect(0, 0, CANVAS.width, CANVAS.height);

  // 标题
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 48px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText("暂停", cx, 220);

  // 提示
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = "14px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText("按 Esc 继续对战", cx, 270);

  // 按钮
  for (const b of pauseButtons) {
    const hover = hitRect(mx, my, b);

    // 按钮底（白底 / hover 主题色）
    ctx.fillStyle = hover ? THEME.accent : "#ffffff";
    roundRect(ctx, b.x, b.y, b.w, b.h, 10);
    ctx.fill();

    // 边框
    ctx.lineWidth = 2;
    ctx.strokeStyle = hover ? THEME.accentLight : "rgba(255,255,255,0.3)";
    roundRect(ctx, b.x, b.y, b.w, b.h, 10);
    ctx.stroke();

    // 文字
    ctx.fillStyle = hover ? "#ffffff" : THEME.textMain;
    ctx.font = "bold 20px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2);
  }
}

// 顶部计分/状态条（固定，不随迷宫平移）。
// view = { players, matchScores, isPlaying }：isPlaying 时底部提示 Esc 退出。
export function renderHud(ctx, { players, matchScores, isPlaying }) {
  ctx.textBaseline = "middle";
  ctx.font = "bold 18px system-ui, 'Microsoft YaHei', sans-serif";
  const y = 22;

  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const left = i === 0;
    const x = left ? 20 : CANVAS.width - 20;
    ctx.textAlign = left ? "left" : "right";

    // 色块标记（左侧玩家在最左，右侧玩家在最右）
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(left ? x + 7 : x - 7, y, 7, 0, Math.PI * 2);
    ctx.fill();

    // 名称 + 累计比分 + 状态。比分紧跟名字，左玩家「P1 3」右玩家「3 P2」。
    ctx.fillStyle = p.alive ? THEME.textMain : THEME.textDim;
    const score = matchScores[i];
    // 阵亡标记朝「远离中线」的一侧排，左右对称不粘连
    const text = left
      ? `${p.label}  ${score}${p.alive ? "" : "  阵亡"}`
      : `${p.alive ? "" : "阵亡  "}${score}  ${p.label}`;
    const tx = left ? x + 22 : x - 22;
    ctx.fillText(text, tx, y);
  }

  // 对战中底部提示：可随时按 Esc 退回菜单（仅 PLAYING 显示；
  // ROUND_OVER 时 Esc 语义是「结算后返回」，由横幅另行提示，这里不重复）。
  if (isPlaying) {
    ctx.fillStyle = THEME.textDim;
    ctx.font = "13px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Esc  退出对战", CANVAS.width / 2, CANVAS.height - 16);
  }

  ctx.textAlign = "left";
}

// 回合结算横幅。view = { winner, secondsLeft }
export function renderRoundOverBanner(ctx, { winner, secondsLeft }) {
  const cx = CANVAS.width / 2;
  const cy = CANVAS.height / 2;

  // 浅色半透明压层
  ctx.fillStyle = THEME.overlay;
  ctx.fillRect(0, 0, CANVAS.width, CANVAS.height);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // 结果主标题
  if (winner) {
    // 胜者色块圆点
    ctx.fillStyle = winner.color;
    ctx.beginPath();
    ctx.arc(cx, cy - 70, 16, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = THEME.textMain;
    ctx.font = "bold 56px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(`${winner.label} 获胜`, cx, cy - 8);
  } else {
    ctx.fillStyle = THEME.textMain;
    ctx.font = "bold 56px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText("同归于尽", cx, cy - 8);
  }

  // 倒计时提示：X.X 秒后自动开下一局
  const secs = Math.max(0, secondsLeft).toFixed(1);
  ctx.fillStyle = THEME.textMain;
  ctx.font = "22px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText(`${secs} 秒后下一局…`, cx, cy + 46);

  // 小字快捷键
  ctx.fillStyle = THEME.textDim;
  ctx.font = "15px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText("R  立即开始          Esc  返回菜单", cx, cy + 80);
}
