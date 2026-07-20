// ============================================================
// main.js — 游戏入口与主循环 + 状态机
//   MENU      —— 标题 + 模式按钮，鼠标点「双人对战/人机对战」开局
//   PLAYING   —— 2 辆坦克分置左上/右下角，各自控制源（键盘/AI）独立操作，
//                子弹全局，互相击中
//   ROUND_OVER—— 存活 ≤1 时显示获胜/同归于尽横幅，R 重开同模式，Esc 回菜单
// 界面绘制与命中检测在 ui.js（菜单/浮层/HUD/横幅）；本文件持有全部游戏状态，
// 消费 ui 返回的 action 对象做状态变更——ui 只说「点到了什么」，不动状态。
//
// 渲染坐标系：全程跑「逻辑像素」960×720（CANVAS.width/height）。
//   HiDPI 适配：canvas 内部分辨率放大到 dpr 倍，ctx 统一 scale(dpr)，
//   于是 render 里只管逻辑坐标，线条按物理像素渲染 → 锐利不糊。
//   ⚠️ 凡是铺满/居中/遮罩，一律用 CANVAS.width/height（逻辑），
//      绝不能用 canvas.width/height（那是放大后的物理像素）。
// ============================================================

import {
  CANVAS, PLAYER_COLORS, KEY_BINDINGS, MAZE_TIERS, TIER_POOL_BY_MODE,
  WALL, CELL_SIZE, BULLET, TANK, THEME, ROUND_RESTART_DELAY,
  POWERUP,
} from "./config.js";
import { Player } from "./player.js";
import { generateMaze } from "./maze.js";
import { circleVsCircle, separateCircles, resolveCircleWalls } from "./collision.js";
import { fitArena } from "./layout.js";
import {
  TankExplosion, PickupFlash, ShieldBreak, MuzzleFlash, MineBlast,
  addShake, updateShake, shakeOffset,
} from "./effects.js";
import { PowerupSpawner } from "./powerup.js";
import {
  isJustPressed, endFrame,
  bindMouse, getMousePos, isClicked, getAnyJustPressed,
} from "./input.js";
import {
  renderMenu, renderPauseOverlay, renderHud, renderRoundOverBanner,
  renderRebindOverlay, menuAction, pauseAction, rebindAction, keyLabel,
} from "./ui.js";
import { initSettings, saveBindings, resetBindings } from "./settings.js";

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

// 启动时套用持久化设置（键位覆写 KEY_BINDINGS 前两套，重启不丢）
initSettings();

// —— 游戏状态机 ——
const STATE = { MENU: "menu", PLAYING: "playing", PAUSED: "paused", ROUND_OVER: "round_over" };
let state = STATE.MENU;

// —— 对局状态 ——
let maze;
let players = [];
let bullets = [];
let effects = [];              // 进行中的视觉特效（爆炸等），done 后移除
let powerups = [];             // 场上待拾取的道具
let mines = [];                // 场上已布的地雷（tryFire 分流入列，引爆后移除）
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

// —— 键位设置面板状态（菜单子状态）——
// capturing 非空表示等待玩家按下新键；conflictMsg 是面板内的红字提示（限时消失）
const rebind = { open: false, capturing: null, conflictMsg: "", msgTimer: 0 };
const RESERVED_KEYS = ["Escape", "F11"]; // 系统语义键，禁止绑定（Esc=暂停/取消，F11=全屏）

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
  mines = [];
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
      updateMenu(dt);
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

// 菜单：把点击交给 ui.menuAction 判定「点到了什么」，这里只做状态变更。
// 键位面板打开时整个菜单交互移交 updateRebind（面板是独占浮层）。
function updateMenu(dt) {
  if (rebind.open) {
    updateRebind(dt);
    return;
  }

  if (!isClicked()) return;
  const { x: mx, y: my } = getMousePos();
  const action = menuAction(mx, my, { showHelp });
  if (!action) return;

  switch (action.type) {
    case "closeHelp":
      showHelp = false;
      break;
    case "openHelp":
      showHelp = true;
      break;
    case "openRebind":
      rebind.open = true;
      break;
    case "aiLevel":
      aiLevel = action.key;
      break;
    case "powerups":
      powerupsOn = action.on;
      break;
    case "mode":
      startMatch(action.mode);
      break;
  }
}

// 键位设置面板：捕获按键 → 校验（保留键/冲突）→ 写入 KEY_BINDINGS + 存盘。
// 交互规则：点 chip 进捕获态；捕获态按 Esc 只取消捕获；非捕获态 Esc 关面板。
function updateRebind(dt) {
  // 红字提示限时消失
  if (rebind.msgTimer > 0) {
    rebind.msgTimer -= dt;
    if (rebind.msgTimer <= 0) rebind.conflictMsg = "";
  }
  const flash = (msg) => {
    rebind.conflictMsg = msg;
    rebind.msgTimer = 2.2;
  };

  // 1) 捕获态：吃掉本帧按下的第一个键
  if (rebind.capturing) {
    const code = getAnyJustPressed();
    if (code) {
      const { player, action } = rebind.capturing;
      if (code === "Escape") {
        rebind.capturing = null; // 仅取消捕获，不关面板
      } else if (RESERVED_KEYS.includes(code)) {
        flash(`${keyLabel(code)} 是系统保留键，不能绑定`);
        rebind.capturing = null;
      } else if (code === KEY_BINDINGS[player][action]) {
        rebind.capturing = null; // 绑回原键，无事发生
      } else {
        // 冲突检测：与前两套键位的任何动作重复即拒绝
        const conflict = findBindingConflict(code);
        if (conflict) {
          flash(`${keyLabel(code)} 已被 玩家${conflict.player + 1} 的「${conflict.label}」占用`);
          rebind.capturing = null;
        } else {
          KEY_BINDINGS[player][action] = code;
          saveBindings();
          rebind.capturing = null;
        }
      }
      return;
    }
  } else if (isJustPressed("Escape")) {
    // 2) 非捕获态 Esc：关闭面板
    rebind.open = false;
    return;
  }

  // 3) 鼠标点击：chip 进入/切换捕获，恢复默认，面板外关闭
  if (!isClicked()) return;
  const { x: mx, y: my } = getMousePos();
  const action = rebindAction(mx, my);
  if (!action) return;

  if (action.type === "bind") {
    rebind.capturing = { player: action.player, action: action.action };
  } else if (action.type === "reset") {
    resetBindings();
    rebind.capturing = null;
    flash("已恢复默认键位");
  } else if (action.type === "close") {
    rebind.open = false;
    rebind.capturing = null;
  }
}

// code 是否已被前两套键位占用，返回 { player, label }（动作中文名）或 null
// code 是否已被前两套键位占用，返回 { player, label }（动作中文名）或 null
function findBindingConflict(code) {
  const labels = { forward: "前进", back: "后退", left: "左转", right: "右转", fire: "开火", special: "道具" };
  for (let p = 0; p < 2; p++) {
    for (const [action, label] of Object.entries(labels)) {
      if (KEY_BINDINGS[p][action] === code) return { player: p, label };
    }
  }
  return null;
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
  const world = { maze, players, bullets, powerups, mines };
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

  // 2.8) 地雷：布防计时推进 → 警戒雷近敌引爆 → 波及圈一次性结算。
  //      雷不认人：主人踩上同样炸（armDelay 是唯一的逃逸窗口）。
  //      波及内有盾消盾（与子弹挡一发同语义），无盾即死；可双杀 → 同归于尽。
  for (const m of mines) m.update(dt);
  for (const m of mines) {
    if (m.exploded || !m.armed) continue;
    const tripped = players.some(
      (p) => p.alive && Math.hypot(p.tank.x - m.x, p.tank.y - m.y) < POWERUP.mine.triggerRadius
    );
    if (!tripped) continue;
    m.exploded = true;
    effects.push(new MineBlast(m.x, m.y));
    addShake(6, 0.35);
    for (const p of players) {
      if (!p.alive) continue;
      if (Math.hypot(p.tank.x - m.x, p.tank.y - m.y) >= POWERUP.mine.blastRadius) continue;
      if (p.tank.shield) {
        p.tank.shield = false;
        p.tank.shieldTimer = 0;
        effects.push(new ShieldBreak(p.tank.x, p.tank.y, THEME.shieldRing));
      } else {
        p.tank.alive = false;
        effects.push(new TankExplosion(p.tank.x, p.tank.y, p.color));
      }
    }
  }
  mines = mines.filter((m) => !m.exploded);

  // 3) 开炮 + 部署：开火键产子弹（单发/散射，maxAlive 限流 + 贴墙出膛修正），
  //    道具键走 tryDeploy 部署地雷——射击与部署解耦，各有冷却互不影响。
  for (let i = 0; i < players.length; i++) {
    const news = players[i].tank.tryFire(bullets, controls[i].fire, maze.walls);
    if (news.length > 0) {
      effects.push(new MuzzleFlash(news[0].x, news[0].y, players[i].tank.angle));
    }
    for (const b of news) bullets.push(b);

    const mine = players[i].tank.tryDeploy(controls[i].special, maze.walls);
    if (mine) mines.push(mine);
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
          // 护盾挡一发即碎：消耗护盾、子弹消失、播破盾特效 + 小震动。
          // 「挡一次」与「限时消失」（tank.update 计时器）两条路先到先算。
          p.tank.shield = false;
          p.tank.shieldTimer = 0;
          b.dead = true;
          effects.push(new ShieldBreak(p.tank.x, p.tank.y, THEME.shieldRing));
          addShake(3, 0.2);
        } else {
          b.dead = true;
          p.tank.alive = false;
          // 死亡演出：烟团 + 碎片四散 + 屏幕震动（纯表现，不影响逻辑）
          effects.push(new TankExplosion(p.tank.x, p.tank.y, p.color));
          addShake(5, 0.3);
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
  // 暂停状态：按 Esc 继续，或点击按钮（命中判定在 ui.pauseAction）
  if (isJustPressed("Escape")) {
    state = STATE.PLAYING;
    return;
  }

  if (!isClicked()) return;
  const { x: mx, y: my } = getMousePos();
  const action = pauseAction(mx, my);
  if (action === "resume") {
    state = STATE.PLAYING;
  } else if (action === "menu") {
    state = STATE.MENU; // 弃局返回主菜单（不计分）
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

// 推进所有特效 + 屏幕震动，播完的移除。PLAYING 与 ROUND_OVER 共用。
function updateEffects(dt) {
  updateShake(dt);
  for (const e of effects) e.update(dt);
  effects = effects.filter((e) => !e.done);
}

function render() {
  // 背景铺满（逻辑尺寸）
  ctx.fillStyle = THEME.pageBg;
  ctx.fillRect(0, 0, CANVAS.width, CANVAS.height);

  switch (state) {
    case STATE.MENU:
      renderMenu(ctx, { mouse: getMousePos(), aiLevel, powerupsOn, showHelp });
      if (rebind.open) {
        renderRebindOverlay(ctx, {
          mouse: getMousePos(),
          capturing: rebind.capturing,
          conflictMsg: rebind.conflictMsg,
        });
      }
      break;
    case STATE.PLAYING:
      renderArena();
      break;
    case STATE.PAUSED:
      renderArena();
      renderPauseOverlay(ctx, getMousePos());
      break;
    case STATE.ROUND_OVER:
      renderArena();
      renderRoundOverBanner(ctx, { winner, secondsLeft: roundOverTimer });
      break;
  }
}

// 画竞技场（迷宫 + 子弹 + 坦克），PLAYING 与 ROUND_OVER 共用
function renderArena() {
  const arenaW = maze.cols * CELL_SIZE;
  const arenaH = maze.rows * CELL_SIZE;

  ctx.save();
  // 先平移到竞技场左上角（叠加屏幕震动偏移），再按 fitArena 算出的比例缩放。
  // 之后所有绘制都用「世界坐标」（与碰撞/物理同一套），缩放只影响显示不影响物理。
  // 震动在缩放之前叠加 → 幅度不随竞技场缩放变化；暂停画面不抖。
  const sh = state === STATE.PAUSED ? { x: 0, y: 0 } : shakeOffset();
  ctx.translate(offsetX + sh.x, offsetY + sh.y);
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
  // 地雷贴地（道具之上、子弹之下；坦克开过顶时盖住雷，贴近"碾在脚下"）
  for (const m of mines) m.render(ctx);
  // 子弹在坦克下层
  for (const b of bullets) b.render(ctx);
  for (const p of players) p.tank.render(ctx);
  // 特效最上层（爆炸烟团盖住尸体位置）
  for (const e of effects) e.render(ctx);

  ctx.restore();

  renderHud(ctx, { players, matchScores, isPlaying: state === STATE.PLAYING });
}

requestAnimationFrame(loop);
