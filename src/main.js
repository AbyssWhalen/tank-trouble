// ============================================================
// main.js — 游戏入口与主循环 + 状态机
//   MENU      —— 标题 + 模式按钮，鼠标点「双人对战/人机对战」开局
//   PLAYING   —— 2 辆坦克分置左上/右下角，各自控制源（键盘/AI）独立操作，
//                子弹全局，互相击中
//   ROUND_OVER—— 存活 ≤1 时显示获胜/同归于尽横幅，R 重开同模式，Esc 回菜单
// 地图 2 人 = 9×7 = 864×672，稳放进 960×720 画布，居中平移，暂不缩放。
//
// 渲染坐标系：全程跑「逻辑像素」960×720（CANVAS.width/height）。
//   HiDPI 适配：canvas 内部分辨率放大到 dpr 倍，ctx 统一 scale(dpr)，
//   于是 render 里只管逻辑坐标，线条按物理像素渲染 → 锐利不糊。
//   ⚠️ 凡是铺满/居中/遮罩，一律用 CANVAS.width/height（逻辑），
//      绝不能用 canvas.width/height（那是放大后的物理像素）。
// ============================================================

import {
  CANVAS, PLAYER_COLORS, KEY_BINDINGS, MAZE_TIERS, TIER_POOL_BY_MODE,
  WALL, CELL_SIZE, BULLET, TANK, THEME, ROUND_RESTART_DELAY, AI_DIFFICULTY,
  POWERUP,
} from "./config.js";
import { Player } from "./player.js";
import { generateMaze } from "./maze.js";
import { circleVsCircle, separateCircles, resolveCircleWalls } from "./collision.js";
import { fitArena } from "./layout.js";
import { TankExplosion, PickupFlash } from "./effects.js";
import { PowerupSpawner } from "./powerup.js";
import {
  isJustPressed, endFrame,
  bindMouse, getMousePos, isClicked,
} from "./input.js";

const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");

// —— HiDPI 适配 + 视口自适应：内部分辨率拉到 dpr 倍保锐利；
// CSS 尺寸在窗口装不下 960×720 时等比缩小（取宽高比的小者），
// 保证画布永远完整可见——大地图底边/外框被窗口裁掉的根治就在这。
// 鼠标坐标无需跟着改：input.bindMouse 按 getBoundingClientRect 归一化。
function setupCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = CANVAS.width * dpr;
  canvas.height = CANVAS.height * dpr;
  // 窗口装得下用原尺寸(scale=1)，装不下等比缩到正好放下（兜底 || 防 stub 环境无 innerWidth）
  const fit = Math.min(
    1,
    (window.innerWidth || CANVAS.width) / CANVAS.width,
    (window.innerHeight || CANVAS.height) / CANVAS.height
  );
  canvas.style.width = CANVAS.width * fit + "px";
  canvas.style.height = CANVAS.height * fit + "px";
  // 之后所有绘制按逻辑坐标，乘 dpr 落到物理像素
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
setupCanvas();

// 窗口尺寸/显示器 dpr 变化（拉窗口、拖到不同缩放的屏）时重算适配
window.addEventListener("resize", setupCanvas);

bindMouse(canvas);

// —— 游戏状态机 ——
const STATE = { MENU: "menu", PLAYING: "playing", PAUSED: "paused", ROUND_OVER: "round_over" };
let state = STATE.MENU;

// —— 对局状态 ——
let maze;
let players = [];
let bullets = [];
let effects = [];              // 进行中的视觉特效（爆炸等），done 后移除
let powerups = [];             // 场上待拾取的道具
let spawner = null;            // 道具刷新器（每回合按开关重建）
let offsetX = 0, offsetY = 0;  // 竞技场缩放后左上角偏移（fitArena 算出，含居中）
let arenaScale = 1;            // 竞技场自适应缩放比，∈(0,1]；大图超画面时 <1
let winner = null;             // ROUND_OVER 时存活的 Player；null 表示同归于尽
let currentMode = "pvp";       // 当前对局模式，R 重开时复用

// —— 整场累计状态（跨回合，不随 setupRound 重建）——
// 累计分是「整场/玩家」维度的数据，挂在每回合重建的 Player 上会被一起归零，
// 所以提到这里按玩家 index 存。开新整场(startMatch)才清零，回合重开不碰。
let matchScores = [0, 0];      // 各玩家累计胜场，index 对齐 players
let roundOverTimer = 0;        // ROUND_OVER 倒计时（秒），归零自动重开
let aiLevel = "normal";        // 选中的 AI 难度档（菜单 chip 单选），开局/R 重开沿用
let powerupsOn = true;         // 道具开关（菜单 toggle），开局/R 重开沿用
let showHelp = false;          // 玩法说明浮窗是否显示（叠在菜单上的浮层）

// —— 菜单按钮（逻辑坐标，不随迷宫平移）——
const BTN_W = 300, BTN_H = 66;
const BTN_X = (CANVAS.width - BTN_W) / 2;
const buttons = [
  { label: "双人对战", sub: "P1 vs P2", mode: "pvp", enabled: true, x: BTN_X, y: 322, w: BTN_W, h: BTN_H },
  { label: "人机对战", sub: "P1 vs AI", mode: "pve", enabled: true, x: BTN_X, y: 410, w: BTN_W, h: BTN_H },
];

// —— AI 难度 chip（人机按钮正下方一排单选，点选改 aiLevel）——
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

// —— 道具开关（难度 chip 下方一排开/关 chip，与难度选择同款样式，视觉统一）——
// 之前是 iOS 风滑动开关，和上方的 chip 组风格割裂、略显呆板；
// 改成同款 chip 单选（开/关），整个菜单的选项区视觉一致。
const POW_CHIP_W = 88, POW_CHIP_H = 32, POW_CHIP_GAP = 14;
const powChipKeys = [true, false]; // 开 / 关
const POW_CHIPS_X = (CANVAS.width - (2 * POW_CHIP_W + POW_CHIP_GAP)) / 2;
const powupChips = powChipKeys.map((on, i) => ({
  on,
  label: on ? "开启" : "关闭",
  x: POW_CHIPS_X + i * (POW_CHIP_W + POW_CHIP_GAP),
  y: 544, // 难度 chip 底边 526 再留 18px
  w: POW_CHIP_W,
  h: POW_CHIP_H,
}));

// —— 玩法说明按钮（右下角圆形 "?" 按钮，点开浮窗）——
const helpBtn = { x: CANVAS.width - 56, y: CANVAS.height - 56, r: 20 };

// —— 暂停菜单按钮（PAUSED 状态下浮窗里的两个按钮，逻辑坐标居中）——
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

// 开一整场：从菜单进入时调用。清零累计分，再开第一回合。
// 与 setupRound 的分工：startMatch 负责「整场」级状态(分数)，
// setupRound 只负责「单回合」级状态(地图/玩家)。回合重开只走 setupRound，分数不动。
function startMatch(mode) {
  matchScores = [0, 0];
  setupRound(mode);
}

// 开一局：按模式从档位池随机抽一档地图，生成随机布局与玩家。
// 缩放偏移由 fitArena 算（小图原样、大图等比缩小并居中），每回合重抽换图。
function setupRound(mode) {
  currentMode = mode;

  // 从该模式的档位池随机抽一档（pvp/pve → small|medium）
  const pool = TIER_POOL_BY_MODE[mode] || TIER_POOL_BY_MODE.pvp;
  const tier = pool[Math.floor(Math.random() * pool.length)];
  const { cols, rows } = MAZE_TIERS[tier];
  maze = generateMaze(cols, rows);

  // 自适应缩放 + 居中：把竞技场世界尺寸喂给 fitArena
  const fit = fitArena(cols * CELL_SIZE, rows * CELL_SIZE);
  arenaScale = fit.scale;
  offsetX = fit.offsetX;
  offsetY = fit.offsetY;

  const half = CELL_SIZE / 2;
  // P1 左上角格朝右，P2 右下角格朝左，初始背对，给彼此反应空间。
  // pve 模式 P2 是 AI：keys=null + isAI=true，Player 内建 AiController。
  const p2IsAI = mode === "pve";
  players = [
    new Player(0, PLAYER_COLORS[0], KEY_BINDINGS[0], half, half, 0),
    new Player(
      1, PLAYER_COLORS[1], p2IsAI ? null : KEY_BINDINGS[1],
      (cols - 1) * CELL_SIZE + half,
      (rows - 1) * CELL_SIZE + half,
      Math.PI,
      p2IsAI,
      aiLevel
    ),
  ];

  bullets = [];
  effects = [];
  powerups = [];
  // 道具刷新器：开关关闭则传空种类，整局永不刷（spawner 内部 types 为空直接 return）
  spawner = new PowerupSpawner(powerupsOn ? POWERUP.types : []);
  winner = null;
  state = STATE.PLAYING;
}

let lastTime = 0;

function loop(now) {
  const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0;
  lastTime = now;
  update(dt);
  render();
  requestAnimationFrame(loop);
}

function update(dt) {
  switch (state) {
    case STATE.MENU:
      updateMenu();
      break;
    case STATE.PLAYING:
      updatePlaying(dt);
      break;
    case STATE.PAUSED:
      updatePaused();
      break;
    case STATE.ROUND_OVER:
      updateRoundOver(dt);
      break;
  }
  endFrame();
}

function updateMenu() {
  if (!isClicked()) return;
  const { x: mx, y: my } = getMousePos();

  // 说明浮窗打开时：点任意处（或关闭按钮）关闭浮窗，不穿透到下层菜单
  if (showHelp) {
    showHelp = false;
    return;
  }

  // 玩法说明按钮（右下角 "?"）：打开浮窗
  if (hitCircle(mx, my, helpBtn.x, helpBtn.y, helpBtn.r)) {
    showHelp = true;
    return;
  }

  // 难度 chip：单选切换，不开局
  for (const c of difficultyChips) {
    if (hitRect(mx, my, c)) {
      aiLevel = c.key;
      return;
    }
  }
  // 道具开/关 chip：单选切换，不开局
  for (const c of powupChips) {
    if (hitRect(mx, my, c)) {
      powerupsOn = c.on;
      return;
    }
  }
  for (const b of buttons) {
    if (b.enabled && hitRect(mx, my, b)) {
      startMatch(b.mode);
      return;
    }
  }
}

function updatePlaying(dt) {
  // 0) 对战中按 Esc 进入暂停（不弃局）。暂停菜单提供「继续 / 返回主菜单」。
  //    联机 v2 这里要改成「投降/确认退出」语义，避免一人退局带走别人的对战。
  if (isJustPressed("Escape")) {
    state = STATE.PAUSED;
    return;
  }

  // 1) 收集本帧所有玩家的控制指令（人读键盘 / AI 决策），与执行分离——
  //    保持"先全员移动、再全员开火"的原有顺序，也让 AI 看到的是同一帧的世界
  const world = { maze, players, bullets, powerups };
  const controls = players.map((p) => p.getControls(dt, world));

  // 2) 每辆坦克按指令移动转向 + 冷却
  for (let i = 0; i < players.length; i++) {
    players[i].tank.update(dt, maze.walls, controls[i]);
  }

  // 2.5) 坦克间碰撞：两车不可重叠，相撞沿圆心连线推开（等量分担）。
  //      推开可能把车顶进墙，再各自做一次贴墙解算兜底。
  //      纯位置修正、无反弹动量——手感就是"顶住推不动"，贴近原版。
  const aliveTanks = players.filter((p) => p.alive).map((p) => p.tank);
  for (let i = 0; i < aliveTanks.length; i++) {
    for (let j = i + 1; j < aliveTanks.length; j++) {
      const a = aliveTanks[i];
      const b = aliveTanks[j];
      const sep = separateCircles(a.x, a.y, b.x, b.y, TANK.radius * 2);
      if (!sep) continue;
      a.x = sep.ax; a.y = sep.ay;
      b.x = sep.bx; b.y = sep.by;
      const fa = resolveCircleWalls(a.x, a.y, TANK.radius, maze.walls);
      a.x = fa.x; a.y = fa.y;
      const fb = resolveCircleWalls(b.x, b.y, TANK.radius, maze.walls);
      b.x = fb.x; b.y = fb.y;
    }
  }

  // 2.7) 道具：刷新推进 + 拾取检测。
  //      刷新器到点在空格刷一个（避开墙/坦克），场上数受 maxOnField 限流。
  //      拾取：存活坦克碾到道具圈 → 应用效果 + 移除道具 + 播拾取闪光。
  spawner.update(dt, maze, powerups, aliveTanks);
  for (const p of players) {
    if (!p.alive) continue;
    for (const pw of powerups) {
      if (pw.taken) continue;
      if (circleVsCircle(p.tank.x, p.tank.y, TANK.radius, pw.x, pw.y, POWERUP.radius)) {
        p.tank.applyPowerup(pw.type);
        pw.taken = true; // 标记，循环后统一过滤（避免边遍历边删）
        effects.push(new PickupFlash(pw.x, pw.y, pw.type));
      }
    }
  }
  powerups = powerups.filter((pw) => !pw.taken);

  // 3) 开炮：收集新子弹（传 bullets 统计己方在场数实现 maxAlive 限流；
  //    传 walls 做贴墙出膛修正，防炮口越墙穿墙）。
  //    tryFire 返回子弹数组（普通单发 [b]、散射多发、不开火 []），展开 push。
  for (let i = 0; i < players.length; i++) {
    const news = players[i].tank.tryFire(bullets, controls[i].fire, maze.walls);
    for (const b of news) bullets.push(b);
  }

  // 4) 子弹更新（移动 + 反弹）
  for (const b of bullets) {
    b.update(dt, maze.walls);
  }

  // 5) 击中判定：每颗活子弹 vs 每个存活坦克
  for (const b of bullets) {
    if (b.dead) continue;
    for (const p of players) {
      if (!p.alive) continue;
      if (!b.canHit(p.tank)) continue;
      if (circleVsCircle(b.x, b.y, BULLET.radius, p.tank.x, p.tank.y, TANK.radius)) {
        if (p.tank.shield) {
          // 有护盾：5 秒无敌期，子弹直接消失，坦克无事（护盾不消耗，只有时间到才失效）
          b.dead = true;
        } else {
          b.dead = true;
          p.tank.alive = false;
          // 死亡演出：烟团 + 碎片四散（纯表现，不影响逻辑）
          effects.push(new TankExplosion(p.tank.x, p.tank.y, p.color));
        }
        break; // 一颗子弹只打一个
      }
    }
  }

  // 6) 清理消亡子弹 + 推进道具呼吸动画 + 推进特效（播完移除）
  bullets = bullets.filter((b) => !b.dead);
  for (const pw of powerups) pw.update(dt);
  updateEffects(dt);

  // 7) 胜负判定：存活 ≤1 转结算
  const alivePlayers = players.filter((p) => p.alive);
  if (alivePlayers.length <= 1) {
    winner = alivePlayers.length === 1 ? alivePlayers[0] : null;
    // 计分：转 ROUND_OVER 这一帧加一次（同归于尽 winner=null 不加分）。
    // 状态切走后不再进 updatePlaying，天然只触发一次，无需额外加锁。
    if (winner) matchScores[winner.index]++;
    roundOverTimer = ROUND_RESTART_DELAY; // 启动自动重开倒计时
    state = STATE.ROUND_OVER;
  }
}

function updatePaused() {
  // 暂停状态：按 Esc 继续，或点击按钮
  if (isJustPressed("Escape")) {
    state = STATE.PLAYING;
    return;
  }

  if (!isClicked()) return;
  const { x: mx, y: my } = getMousePos();
  for (const b of pauseButtons) {
    if (hitRect(mx, my, b)) {
      if (b.action === "resume") {
        state = STATE.PLAYING;
      } else if (b.action === "menu") {
        state = STATE.MENU; // 弃局返回主菜单（不计分）
      }
      return;
    }
  }
}

function updateRoundOver(dt) {
  // 结算横幅期间继续推进爆炸动画（击杀大多发生在转场瞬间，动画要播完）
  updateEffects(dt);

  // 倒计时递减，到点自动重开同模式（累计分不清零）
  roundOverTimer -= dt;
  if (roundOverTimer <= 0 || isJustPressed("KeyR")) {
    setupRound(currentMode); // R 可跳过等待立即重开
  } else if (isJustPressed("Escape")) {
    state = STATE.MENU;
  }
}

// 推进所有特效，播完的移除。PLAYING 与 ROUND_OVER 共用。
function updateEffects(dt) {
  for (const e of effects) e.update(dt);
  effects = effects.filter((e) => !e.done);
}

function render() {
  // 背景铺满（逻辑尺寸）
  ctx.fillStyle = THEME.pageBg;
  ctx.fillRect(0, 0, CANVAS.width, CANVAS.height);

  switch (state) {
    case STATE.MENU:
      renderMenu();
      break;
    case STATE.PLAYING:
      renderArena();
      break;
    case STATE.PAUSED:
      renderArena();
      renderPauseOverlay();
      break;
    case STATE.ROUND_OVER:
      renderArena();
      renderRoundOverBanner();
      break;
  }
}

function renderMenu() {
  const cx = CANVAS.width / 2;
  const { x: mx, y: my } = getMousePos();
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
  renderControlCards(cx);

  // 模式按钮
  for (const b of buttons) {
    const hover = b.enabled && hitRect(mx, my, b);

    // 按钮底
    if (!b.enabled) ctx.fillStyle = THEME.btnDisabledFill;
    else ctx.fillStyle = hover ? THEME.btnFillHover : THEME.btnFill;
    roundRect(b.x, b.y, b.w, b.h, 10);
    ctx.fill();

    // 边框（hover 时用主题色）
    ctx.lineWidth = 2;
    ctx.strokeStyle = !b.enabled ? THEME.btnDisabledBorder : hover ? THEME.accent : THEME.btnBorder;
    roundRect(b.x, b.y, b.w, b.h, 10);
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
    const selected = c.key === aiLevel;
    const hover = hitRect(mx, my, c);
    renderChip(c, AI_DIFFICULTY[c.key].label, selected, hover);
  }

  // 道具开/关 chip（与难度同款样式，视觉统一）
  ctx.textAlign = "right";
  ctx.fillStyle = THEME.textDim;
  ctx.font = "14px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText("道具", powupChips[0].x - 14, powupChips[0].y + POW_CHIP_H / 2);
  ctx.textAlign = "center";
  for (const c of powupChips) {
    const selected = c.on === powerupsOn;
    const hover = hitRect(mx, my, c);
    renderChip(c, c.label, selected, hover);
  }

  // 玩法说明按钮（右下角圆形 "?"）
  renderHelpButton(mx, my);

  // 底部提示 + 快捷键
  ctx.fillStyle = THEME.textDim;
  ctx.font = "13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("点击模式开始对战　·　对战中 R 重开 · Esc 返回菜单", cx, CANVAS.height - 38);

  // 说明浮窗（最上层，盖住整个菜单）
  if (showHelp) renderHelpOverlay(cx);
}

// 操作说明卡片：左右分栏（P1 蓝 | P2 红），图标化键位
function renderControlCards(cx) {
  const cardW = 230, cardH = 78, gap = 24;
  const totalW = cardW * 2 + gap;
  const startX = cx - totalW / 2;
  const y = 200;

  const cards = [
    { title: "玩家 1", color: PLAYER_COLORS[0], move: "W A S D", fire: "Space 开炮" },
    { title: "玩家 2", color: PLAYER_COLORS[1], move: "↑ ↓ ← →", fire: "Enter 开炮" },
  ];

  cards.forEach((card, i) => {
    const x = startX + i * (cardW + gap);

    // 卡片底
    ctx.fillStyle = "#ffffff";
    roundRect(x, y, cardW, cardH, 10);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = THEME.btnDisabledBorder;
    roundRect(x, y, cardW, cardH, 10);
    ctx.stroke();

    // 左侧色块标识（玩家色）
    ctx.fillStyle = card.color;
    roundRect(x + 14, y + cardH / 2 - 14, 28, 28, 6);
    ctx.fill();

    // 标题
    ctx.textAlign = "left";
    ctx.fillStyle = THEME.textMain;
    ctx.font = "bold 15px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(card.title, x + 54, y + 24);

    // 键位
    ctx.fillStyle = THEME.textDim;
    ctx.font = "13px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(card.move + "  移动", x + 54, y + 44);
    ctx.fillText(card.fire, x + 54, y + 62);
  });
  ctx.textAlign = "center";
}

// 通用 chip 渲染（难度/道具共用）：选中主题色实心，未选白底描边
function renderChip(c, label, selected, hover) {
  ctx.fillStyle = selected ? THEME.accent : THEME.btnFill;
  roundRect(c.x, c.y, c.w, c.h, 8);
  ctx.fill();

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = selected ? THEME.accent : hover ? THEME.accent : THEME.btnDisabledBorder;
  roundRect(c.x, c.y, c.w, c.h, 8);
  ctx.stroke();

  ctx.fillStyle = selected ? "#ffffff" : hover ? THEME.textMain : THEME.textDim;
  ctx.font = "14px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText(label, c.x + c.w / 2, c.y + c.h / 2);
}

// 右下角圆形 "?" 按钮
function renderHelpButton(mx, my) {
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

// 玩法说明浮窗：半透明遮罩 + 居中面板，列出操作/规则/快捷键/道具
function renderHelpOverlay(cx) {
  // 半透明遮罩
  ctx.fillStyle = "rgba(43,43,51,0.55)";
  ctx.fillRect(0, 0, CANVAS.width, CANVAS.height);

  // 面板
  const pw = 560, ph = 480;
  const px = cx - pw / 2, py = (CANVAS.height - ph) / 2;
  ctx.fillStyle = THEME.pageBg;
  roundRect(px, py, pw, ph, 14);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = THEME.accent;
  roundRect(px, py, pw, ph, 14);
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
  line("玩家 1：WASD 移动，Space 开炮");
  line("玩家 2：方向键移动，Enter 开炮");
  ly += 6;

  section("规则");
  line("击毁对手得 1 分，迷宫墙壁可反弹子弹（小心自己的跳弹）");
  line("每回合自动换地图，回合结束后倒计时自动重开");
  ly += 6;

  section("道具（可在菜单开关）");
  line("护盾：5 秒无敌，期间任何子弹都打不死");
  line("散射：连续 3 次扇形开火（一炮 3 发）");
  ly += 6;

  section("快捷键");
  line("R 立即重开本局　·　Esc 返回菜单");

  // 底部关闭提示
  ctx.textAlign = "center";
  ctx.fillStyle = THEME.textDim;
  ctx.font = "13px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText("点击任意处关闭", cx, py + ph - 28);
}

// 暂停浮层（叠在竞技场上）：半透明遮罩 + 标题 + 两个按钮（继续 / 返回主菜单）
function renderPauseOverlay() {
  const cx = CANVAS.width / 2;
  const { x: mx, y: my } = getMousePos();

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
    roundRect(b.x, b.y, b.w, b.h, 10);
    ctx.fill();

    // 边框
    ctx.lineWidth = 2;
    ctx.strokeStyle = hover ? THEME.accentLight : "rgba(255,255,255,0.3)";
    roundRect(b.x, b.y, b.w, b.h, 10);
    ctx.stroke();

    // 文字
    ctx.fillStyle = hover ? "#ffffff" : THEME.textMain;
    ctx.font = "bold 20px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2);
  }
}

// 画竞技场（迷宫 + 子弹 + 坦克），PLAYING 与 ROUND_OVER 共用
function renderArena() {
  const arenaW = maze.cols * CELL_SIZE;
  const arenaH = maze.rows * CELL_SIZE;

  ctx.save();
  // 先平移到竞技场左上角，再按 fitArena 算出的比例缩放。
  // 之后所有绘制都用「世界坐标」（与碰撞/物理同一套），缩放只影响显示不影响物理。
  ctx.translate(offsetX, offsetY);
  ctx.scale(arenaScale, arenaScale);

  // 地面
  ctx.fillStyle = THEME.arenaBg;
  ctx.fillRect(0, 0, arenaW, arenaH);

  // 内墙
  ctx.strokeStyle = WALL.color;
  ctx.lineWidth = WALL.thickness;
  ctx.lineCap = "round";
  for (const w of maze.walls) {
    ctx.beginPath();
    ctx.moveTo(w.x1, w.y1);
    ctx.lineTo(w.x2, w.y2);
    ctx.stroke();
  }

  // 外框：沿竞技场四周叠一条更粗的边，框住整个场地（贴近原版醒目灰框）。
  // 外圈本就有物理墙（子弹靠它反弹），这里只是渲染层加粗，不改碰撞。
  ctx.strokeStyle = THEME.arenaBorder;
  ctx.lineWidth = WALL.borderThickness;
  ctx.lineJoin = "round";
  ctx.strokeRect(0, 0, arenaW, arenaH);

  // 道具在地上（墙之上、子弹/坦克之下，坦克碾过去盖住它）
  for (const pw of powerups) pw.render(ctx);
  // 子弹在坦克下层
  for (const b of bullets) b.render(ctx);
  for (const p of players) p.tank.render(ctx);
  // 特效最上层（爆炸烟团盖住尸体位置）
  for (const e of effects) e.render(ctx);

  ctx.restore();

  renderHud();
}

// 顶部计分/状态条（固定，不随迷宫平移）
function renderHud() {
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
    // 阵亡标记朝「远离中线」的一侧排，左玩家放右尾、右玩家放左首，左右对称不粘连
    const text = left
      ? `${p.label}  ${score}${p.alive ? "" : "  阵亡"}`
      : `${p.alive ? "" : "阵亡  "}${score}  ${p.label}`;
    const tx = left ? x + 22 : x - 22;
    ctx.fillText(text, tx, y);
  }

  // 对战中底部提示：可随时按 Esc 退回菜单（仅 PLAYING 显示；
  // ROUND_OVER 时 Esc 语义是「结算后返回」，由横幅另行提示，这里不重复）。
  if (state === STATE.PLAYING) {
    ctx.fillStyle = THEME.textDim;
    ctx.font = "13px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Esc  退出对战", CANVAS.width / 2, CANVAS.height - 16);
  }

  ctx.textAlign = "left";
}

function renderRoundOverBanner() {
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
  const secs = Math.max(0, roundOverTimer).toFixed(1);
  ctx.fillStyle = THEME.textMain;
  ctx.font = "22px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText(`${secs} 秒后下一局…`, cx, cy + 46);

  // 小字快捷键
  ctx.fillStyle = THEME.textDim;
  ctx.font = "15px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText("R  立即开始          Esc  返回菜单", cx, cy + 80);
}

// 圆角矩形路径（菜单按钮用）。只建路径，由调用方决定 fill/stroke。
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

requestAnimationFrame(loop);
