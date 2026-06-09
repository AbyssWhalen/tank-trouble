// ============================================================
// main.js — 游戏入口与主循环 + 状态机
//   MENU      —— 标题 + 模式按钮，鼠标点「双人对战」开局；「人机」占位（敬请期待）
//   PLAYING   —— 2 辆坦克分置左上/右下角，各自键位独立操作，子弹全局，互相击中
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
  CANVAS, PLAYER_COLORS, KEY_BINDINGS, MAZE_SIZE_BY_PLAYERS,
  WALL, CELL_SIZE, BULLET, TANK, THEME,
} from "./config.js";
import { Player } from "./player.js";
import { generateMaze } from "./maze.js";
import { circleVsCircle } from "./collision.js";
import {
  isJustPressed, endFrame,
  bindMouse, getMousePos, isClicked,
} from "./input.js";

const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");

// —— HiDPI 适配：把 canvas 内部分辨率拉到 dpr 倍，CSS 尺寸保持逻辑尺寸 ——
// 这是「画质糊」的根因修复：之前 canvas 固定 960，在 125%/150% 缩放屏上被硬拉伸。
function setupCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = CANVAS.width * dpr;
  canvas.height = CANVAS.height * dpr;
  canvas.style.width = CANVAS.width + "px";
  canvas.style.height = CANVAS.height + "px";
  // 之后所有绘制按逻辑坐标，乘 dpr 落到物理像素
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
setupCanvas();

// 显示器 dpr 变化（拖窗到不同缩放的屏）时重设，保持锐利
window.addEventListener("resize", setupCanvas);

bindMouse(canvas);

// —— 游戏状态机 ——
const STATE = { MENU: "menu", PLAYING: "playing", ROUND_OVER: "round_over" };
let state = STATE.MENU;

// —— 对局状态 ——
let maze;
let players = [];
let bullets = [];
let offsetX = 0, offsetY = 0;  // 迷宫居中渲染偏移
let winner = null;             // ROUND_OVER 时存活的 Player；null 表示同归于尽
let currentMode = "pvp";       // 当前对局模式，R 重开时复用

// —— 菜单按钮（逻辑坐标，不随迷宫平移）——
const BTN_W = 300, BTN_H = 66;
const BTN_X = (CANVAS.width - BTN_W) / 2;
const buttons = [
  { label: "双人对战", sub: "P1 vs P2", mode: "pvp", enabled: true, x: BTN_X, y: 322, w: BTN_W, h: BTN_H },
  { label: "人机对战", sub: "敬请期待", mode: "pve", enabled: false, x: BTN_X, y: 410, w: BTN_W, h: BTN_H },
];

// 点 (mx,my) 是否落在矩形内
function hitRect(mx, my, r) {
  return mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h;
}

// 开一局：按模式生成地图与玩家。当前只有 pvp（两个人类玩家）。
function setupRound(mode) {
  currentMode = mode;
  const { cols, rows } = MAZE_SIZE_BY_PLAYERS[2];
  maze = generateMaze(cols, rows);

  offsetX = (CANVAS.width - cols * CELL_SIZE) / 2;
  offsetY = (CANVAS.height - rows * CELL_SIZE) / 2;

  const half = CELL_SIZE / 2;
  // P1 左上角格朝右，P2 右下角格朝左，初始背对，给彼此反应空间
  players = [
    new Player(0, PLAYER_COLORS[0], KEY_BINDINGS[0], half, half, 0),
    new Player(
      1, PLAYER_COLORS[1], KEY_BINDINGS[1],
      (cols - 1) * CELL_SIZE + half,
      (rows - 1) * CELL_SIZE + half,
      Math.PI
    ),
  ];

  bullets = [];
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
    case STATE.ROUND_OVER:
      updateRoundOver();
      break;
  }
  endFrame();
}

function updateMenu() {
  if (!isClicked()) return;
  const { x: mx, y: my } = getMousePos();
  for (const b of buttons) {
    if (b.enabled && hitRect(mx, my, b)) {
      setupRound(b.mode);
      return;
    }
  }
}

function updatePlaying(dt) {
  // 1) 每辆坦克各自移动转向 + 冷却
  for (const p of players) {
    p.tank.update(dt, maze.walls);
  }

  // 2) 开炮：收集新子弹（传入全局 bullets 以统计己方在场数，实现 maxAlive 限流）
  for (const p of players) {
    const b = p.tank.tryFire(bullets);
    if (b) bullets.push(b);
  }

  // 3) 子弹更新（移动 + 反弹）
  for (const b of bullets) {
    b.update(dt, maze.walls);
  }

  // 4) 击中判定：每颗活子弹 vs 每个存活坦克
  for (const b of bullets) {
    if (b.dead) continue;
    for (const p of players) {
      if (!p.alive) continue;
      if (!b.canHit(p.tank)) continue;
      if (circleVsCircle(b.x, b.y, BULLET.radius, p.tank.x, p.tank.y, TANK.radius)) {
        p.tank.alive = false;
        b.dead = true;
        break; // 一颗子弹只打一个
      }
    }
  }

  // 5) 清理消亡子弹
  bullets = bullets.filter((b) => !b.dead);

  // 6) 胜负判定：存活 ≤1 转结算
  const alivePlayers = players.filter((p) => p.alive);
  if (alivePlayers.length <= 1) {
    winner = alivePlayers.length === 1 ? alivePlayers[0] : null;
    state = STATE.ROUND_OVER;
  }
}

function updateRoundOver() {
  // 子弹继续飞一会儿更自然，但不再判胜负
  if (isJustPressed("KeyR")) {
    setupRound(currentMode);
  } else if (isJustPressed("Escape")) {
    state = STATE.MENU;
  }
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
    case STATE.ROUND_OVER:
      renderArena();
      renderRoundOverBanner();
      break;
  }
}

function renderMenu() {
  const cx = CANVAS.width / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // 标题
  ctx.fillStyle = THEME.title;
  ctx.font = "bold 68px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText("坦克回廊", cx, 170);

  // 标题下细横线装饰
  ctx.strokeStyle = THEME.textDim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 120, 214);
  ctx.lineTo(cx + 120, 214);
  ctx.stroke();

  // 副标题：操作说明
  ctx.fillStyle = THEME.textDim;
  ctx.font = "16px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText("P1  WASD 移动 · Space 开炮        P2  方向键移动 · Enter 开炮", cx, 250);

  // 模式按钮
  const { x: mx, y: my } = getMousePos();
  for (const b of buttons) {
    const hover = b.enabled && hitRect(mx, my, b);

    // 按钮底
    if (!b.enabled) ctx.fillStyle = THEME.btnDisabledFill;
    else ctx.fillStyle = hover ? THEME.btnFillHover : THEME.btnFill;
    roundRect(b.x, b.y, b.w, b.h, 10);
    ctx.fill();

    // 边框
    ctx.lineWidth = 2;
    ctx.strokeStyle = !b.enabled ? THEME.btnDisabledBorder : THEME.btnBorder;
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

  // 底部版本/提示
  ctx.fillStyle = THEME.textDim;
  ctx.font = "13px system-ui, sans-serif";
  ctx.fillText("点击模式开始对战", cx, CANVAS.height - 40);
}

// 画竞技场（迷宫 + 子弹 + 坦克），PLAYING 与 ROUND_OVER 共用
function renderArena() {
  const arenaW = maze.cols * CELL_SIZE;
  const arenaH = maze.rows * CELL_SIZE;

  ctx.save();
  ctx.translate(offsetX, offsetY);

  // 地面
  ctx.fillStyle = THEME.arenaBg;
  ctx.fillRect(0, 0, arenaW, arenaH);

  // 墙
  ctx.strokeStyle = WALL.color;
  ctx.lineWidth = WALL.thickness;
  ctx.lineCap = "round";
  for (const w of maze.walls) {
    ctx.beginPath();
    ctx.moveTo(w.x1, w.y1);
    ctx.lineTo(w.x2, w.y2);
    ctx.stroke();
  }

  // 子弹在坦克下层
  for (const b of bullets) b.render(ctx);
  for (const p of players) p.tank.render(ctx);

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

    // 名称 + 状态
    ctx.fillStyle = p.alive ? THEME.textMain : THEME.textDim;
    const status = p.alive ? "" : " 阵亡";
    const tx = left ? x + 22 : x - 22;
    ctx.fillText(`${p.label}${status}`, tx, y);
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

  // 操作提示
  ctx.fillStyle = THEME.textDim;
  ctx.font = "19px system-ui, 'Microsoft YaHei', sans-serif";
  ctx.fillText("R  再来一局          Esc  返回菜单", cx, cy + 50);
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
