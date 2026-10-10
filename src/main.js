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
  CANVAS, PLAYER_COLORS, ENEMY_COLORS, KEY_BINDINGS, MAZE_TIERS, TIER_POOL_BY_MODE,
  WALL, CELL_SIZE, BULLET, TANK, THEME, ROUND_RESTART_DELAY,
  POWERUP, PICKUP_RATE, MATCH_TARGET, ROUND_INTRO, SLOWMO, STYLE_POOL_BY_MODE, WAVE, UPGRADE,
  RESERVED_KEYS, HINT,
} from "./config.js";
import { Player } from "./player.js";
import { generateMaze, destroyWallsInRadius, destroyWallSegments } from "./maze.js";
import { circleVsCircle, separateCircles, resolveCircleWalls, closestPointOnSegment } from "./collision.js";
import { fitArena } from "./layout.js";
import {
  TankExplosion, PickupFlash, ShieldBreak, MuzzleFlash, MineBlast, WallBreak,
  addShake, updateShake, shakeOffset, resetShake,
} from "./effects.js";
import { castLaserPath, LaserBeam, renderLaserPreview } from "./laser.js";
import { PowerupSpawner, Powerup, drawPowerupIcon } from "./powerup.js";
import {
  isJustPressed, endFrame,
  bindMouse, getMousePos, getClickPos, isClicked, getAnyJustPressed,
} from "./input.js";
import {
  renderMenu, renderPauseOverlay, renderHud, renderRoundOverBanner,
  renderMatchOverBanner, renderRebindOverlay, renderSettingsOverlay, renderCountdown,
  renderLevelSelectOverlay, renderLevelOverBanner, renderWaveOverBanner, renderDraftOverlay,
  menuAction, pauseAction, rebindAction, settingsAction, matchOverAction,
  levelSelectAction, levelOverAction, waveOverAction, draftAction, keyLabel,
  renderHintToast,
} from "./ui.js";
import {
  initSettings, saveBindings, resetBindings,
  loadEnabledPowerups, saveEnabledPowerups,
  loadAudioMuted, saveAudioMuted,
  loadWallBreak, saveWallBreak,
  loadChallengeProgress, saveChallengeProgress,
  loadWaveBest, saveWaveBest,
  loadHintsSeen, saveHintsSeen,
} from "./settings.js";
import { LEVELS, LEVEL_COUNT, evaluateObjective, objectiveOf, normalizeProgress } from "./levels.js";
import { evaluate } from "./objectives.js";
import {
  waveSpec, pickEnemyLevel, shouldRemap, pickSpawnSpot,
  normalizeWaveBest, isBetterRecord, eliteSpec, applyElite, countArmedLasers,
  waveObjective,
} from "./waves.js";
import { pickZoneSpot, HoldZone } from "./zone.js";
import {
  pickOffers, applyUpgrade, fieldCapOf, supplyCountOf,
} from "./upgrades.js";
import {
  hintText, normalizeSeen, shouldShow, markSeen, weaponHeld, isWeaponSwap,
  isRicochetSelfKill,
} from "./hints.js";
import { initAudio, playSfx, toggleMuted, isMuted } from "./audio.js";
import {
  loadStats, saveStats, getStats, accuracy, accuracyDelta, favoriteWeapon,
  recordFired, recordHit, recordKill, recordRoundEnd, recordMatchWin,
} from "./stats.js";

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

// 音效：读静音存档 + 挂手势解锁监听（Chromium autoplay policy）
initAudio(loadAudioMuted() ?? false);

// 战绩统计：读历史存档进内存（落盘时机在回合/整场结算处）
loadStats();

// —— 游戏状态机 ——
const STATE = { MENU: "menu", PLAYING: "playing", PAUSED: "paused", ROUND_OVER: "round_over", MATCH_OVER: "match_over", LEVEL_OVER: "level_over", WAVE_OVER: "wave_over" };
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
let matchStatsBase = null;     // 本场统计基线（startMatch 快照，横幅显示本场命中率用）
let introTimer = 0;            // 回合开场倒计时（秒）：>0 时双方全冻结（含 AI 决策）
let goTimer = 0;               // "GO!" 余像计时（解冻后纯视觉）
let slowmoTimer = 0;           // 击杀慢动作剩余（真实秒）：>0 时游戏 dt × SLOWMO.scale

// —— 上下文一次性提示（阶段 28.5）。表与纯逻辑在 hints.js，渲染在 ui.renderHintToast ——
// hintsSeen 是**跨局持久**的（存 settings）：一条提示见过就永不再弹，否则老玩家
// 每把都要被告知自己的跳弹会杀自己，教学就变成噪音。
let hintsSeen = normalizeSeen(loadHintsSeen());
let hintQueue = [];            // 待显示的 id（同一帧可能触发两条，排队逐条放）
let hintNow = null;            // 正在显示的 id（null = 没有）
let hintTimer = 0;             // 当前这条还剩多久（真实秒）
let pendingSoloSlowmo = false; // 单人模式（挑战/波次）：本帧有击杀，胜负段确认终局后才转正为慢镜

// —— 挑战关卡模式状态 ——
let currentLevelIndex = 0;     // 当前在打第几关（LEVELS 下标）
let challengeProgress = normalizeProgress(loadChallengeProgress() ?? 0); // 已通关数
// 关卡计时：**纯粹的「本关已过秒数」，单调递增，三型目标同一语义**（游戏秒）。
// 阶段 27 前这里是「survive 累加 / eliminateTimed 倒数」的同名两义，HUD 得靠
// objective 字符串二次分流才显示得对；objectives.js 只认 elapsed 之后那笔债还掉了。
let levelTimer = 0;
let levelWallBreak = false;    // 本关地形破坏开关（关卡表指定，覆写全局）
let levelOutcome = null;       // LEVEL_OVER 时 "win" | "lose"

// —— 无尽波次生存状态（阶段 24）——
// 敌人来去无常：死敌当帧从 players 移除（players[0] 恒为玩家），于是
// 「场上敌数 = players.length - 1」，颜色槽位也能回收——槽位取自 ENEMY_COLORS
// （阶段 28 起敌人有自己的配色表，5 色 ⇒ 同屏上限 5；在那之前是向 PLAYER_COLORS
// 借槽位、0 号被玩家占掉，于是同屏封在 3——那是配色事故不是设计决定）。
// 曲线在 waves.js，这里只存进度。
let waveNo = 0;                // 当前波次（1-based；0=未开局）
let waveKills = 0;             // 本次生存累计击杀
let waveQuotaLeft = 0;         // 本波还没投放的敌人数（投放即减，与场上存活无关）
let waveGapTimer = 0;          // 波间空场喘息（秒）：不冻结，玩家可趁机捡补给/占位
let waveBest = normalizeWaveBest(loadWaveBest()); // 历史最高 { wave, kills }
let waveNewRecord = false;     // 本次是否破纪录（结算横幅提示用）
// 本次开始前**是否已有历史记录**（在覆盖 waveBest 之前抓）。横幅要靠它区分
// 「破了旧记录」与「这是第一把」——否则全新档的第一次结束必然被判成破纪录。
let waveHadRecord = false;
// 本波的过波条件（阶段 27）：普通波 clearQuota、守点波 hold。**只在 beginWave
// 里赋值一次**——「这是什么波」的决策点只有一处，updateWaveFlow 只负责判它。
let waveGoal = { type: "clearQuota" };
let holdZone = null;           // 守点波的区域实体（普通波恒为 null）
// 波间强化抽卡（阶段 25）。**不新增 STATE**：抽卡发生在 PLAYING 内部（底下要照常
// 画竞技场），也不动波次调度器自己那套 waveNo/waveQuotaLeft/waveGapTimer——走
// rebind/levelSelect/settingsPanel 那套「模块级浮层对象 + 早退门」的既有范式。
const draft = { open: false, offers: [], hover: -1 };
const taken = new Map();       // id → 已抽层数（run 级，setupRound 的 wave 分支清空）

let aiLevel = "normal";        // 选中的 AI 难度档（菜单 chip 单选），开局/R 重开沿用
// 启用的道具类型集合（菜单多选 chip；空集=整局无道具）。
// 初始从 localStorage 读上次组合，没存过默认全启;变化即写盘。
let enabledPowerups = new Set(loadEnabledPowerups() ?? POWERUP.types);
let wallBreakEnabled = loadWallBreak() ?? true; // 地雷炸墙开关（菜单「地形」chip，默认开）
// 本局实际生效的地形破坏（关卡模式由关卡表覆写，不动全局设置）
const wallBreakActive = () => (currentMode === "challenge" ? levelWallBreak : wallBreakEnabled);
// 单人模式（挑战/波次）：players 长度可变、战绩口径与 1v1 不同 →
// 不进终身统计（stats.players 定长 2，第三车会越界），慢镜只在终局（见 pendingSoloSlowmo）
const soloMode = () => currentMode === "challenge" || currentMode === "wave";
// 本关的限时/生存秒数上限（0 = 不限时的歼灭关）。HUD 读它算剩余秒数——
// 秒数字段的解析只在 objectiveOf 一处，别在 HUD 里再拆 mutators
const challengeSecs = () => objectiveOf(LEVELS[currentLevelIndex]).secs ?? 0;
let showHelp = false;          // 玩法说明浮窗是否显示（叠在菜单上的浮层）

// —— 键位设置面板状态（菜单子状态）——
// capturing 非空表示等待玩家按下新键；conflictMsg 是面板内的红字提示（限时消失）
const rebind = { open: false, capturing: null, conflictMsg: "", msgTimer: 0 };
// 关面板的唯一出口：**提示文案必须一起清**。msgTimer 只在 updateRebind 里递减，
// 而那个函数只在面板开着时跑，所以关面板时手上那条 2.2s 提示会被冻住——下次打开
// 面板凭空重播一条陈旧提示。最误导的是「已恢复默认键位」那条（走的是同一对字段）：
// 它暗示刚刚发生过一次破坏性操作，玩家会去翻自己的自定义键位是不是被清了，
// 而实际什么都没发生。三条关闭路径（Esc / 点面板外 / 点关闭）共用这一处。
function closeRebind() {
  rebind.open = false;
  rebind.capturing = null;
  rebind.conflictMsg = "";
  rebind.msgTimer = 0;
}
// 设置浮层开关（命名带 Panel 避免与 settings.js 的导入混淆）
const settingsPanel = { open: false };
// 关卡选择浮层开关
const levelSelect = { open: false };
// 键位黑名单迁到 config.js（RESERVED_KEYS）：settings.js 的加载过滤也要读它，
// 留在这里会成环（settings 不能 import main）。表里现在含界面快捷键，见那边的注释。

// 开发自检钩子（CDP 驱动验证用，见 CLAUDE.md「开发自检」）：
// 模块闭包外唯一的状态窥视口。只读快照 + 强设比分（快进局胜流转测试），
// 不进任何正常交互路径；本地单机游戏，常驻无害。
window.__devHook = {
  snapshot: () => ({ state, matchScores: [...matchScores], winnerIndex: winner ? winner.index : null }),
  forceScores: (a, b) => { matchScores = [a, b]; },
  setTank: (i, patch) => { if (players[i]) Object.assign(players[i].tank, patch); },
  // setTank 的只读对偶：验证「某个状态下人还能不能动」需要能读位置（如波间喘息不冻结）。
  // 阶段 25 起附带改装槽——敌人词条发的装备与头顶图标都要能核（图标截图只能看出
  // 「有没有」，核「是哪一件」得读状态）。
  tankAt: (i) => {
    const t = players[i]?.tank;
    return t ? {
      x: t.x, y: t.y, angle: t.angle, alive: t.alive,
      scatter: t.scatterShots, laser: t.laserShots, mine: t.mineCharges, shield: t.shield,
    } : null;
  },
  wallCount: () => (maze ? maze.walls.length : 0),
  erodedCount: () => (maze ? maze.walls.filter((w) => !w.border && w.hp < WALL.hp).length : 0),
  // 场上实体计数：验证「每波开局强制补给」与「雷阵跨波保留」都要能数场上的东西。
  // `foeBullets` 单独数敌方在膛子弹——守点过波时要清掉的正是这一类（清残敌不清子弹的话，
  // 已经过波了还会在喘息期被死人的遗弹打死），而光看 bullets 总数分不出是谁的
  fieldCount: () => ({
    powerups: powerups.length, mines: mines.length, bullets: bullets.length,
    foeBullets: bullets.filter((b) => b.owner !== players[0]?.tank).length,
  }),
  skipCountdown: () => { introTimer = 0; },
  introLeft: () => introTimer,
  slowmoLeft: () => slowmoTimer,
  // 最近一条激光亮线的折线顶点（只读）。阶段 28.3 的「所见即所打」要在实机
  // 比对**屏幕上那条预瞄虚线**与**实际打出去的射线**是否逐点重合，而亮线在
  // effects 里、CDP 摸不到。纯函数探针已钉死几何，这个口子补的是「接线是否
  // 真的把钳位后的出膛点传到了两边」——那是只有跑起来才能证伪的部分。
  // 照 enemySlots()/fieldCount().foeBullets 的先例：只读、不进正常交互路径
  lastBeam: () => {
    for (let i = effects.length - 1; i >= 0; i--) {
      if (effects[i] instanceof LaserBeam) return effects[i].points.map((p) => ({ x: p.x, y: p.y }));
    }
    return null;
  },
  // 预瞄虚线用的那份路径：与 renderLaserPreview 内部逐字同源（同一个
  // muzzlePoint(walls) + 同一个 castLaserPath），供比对实际亮线
  previewPath: (i) => {
    const t = players[i]?.tank;
    if (!t || !maze) return null;
    const m = t.muzzlePoint(maze.walls);
    return castLaserPath(m.x, m.y, m.angle, maze.walls).map((p) => ({ x: p.x, y: p.y }));
  },
  statsSnapshot: () => JSON.parse(JSON.stringify(getStats())),
  levelState: () => ({
    index: currentLevelIndex, progress: challengeProgress, outcome: levelOutcome,
    // elapsed 是已过秒数（阶段 27 起单一语义），left 是 HUD 显示的剩余（歼灭关为 null）
    elapsed: levelTimer, left: challengeSecs() > 0 ? Math.max(0, challengeSecs() - levelTimer) : null,
  }),
  forceUnlock: (n) => { challengeProgress = normalizeProgress(n); saveChallengeProgress(challengeProgress); },
  winLevel: () => { for (const p of players.slice(1)) p.tank.alive = false; }, // 歼灭关直接过（波次清场同用）
  waveState: () => ({
    wave: waveNo, kills: waveKills, quotaLeft: waveQuotaLeft,
    enemies: players.length - 1, gap: waveGapTimer, best: { ...waveBest }, newRecord: waveNewRecord,
    goal: waveGoal.type,
  }),
  // 场上敌人的槽位与配色（阶段 28）。照 fieldCount().foeBullets 的先例——那条是
  // 「光看 bullets 总数分不出是谁的弹」，这条是**光看截图分不出配色重没重**：
  // 旧代码槽位循环上界写死 3，第 4 辆会静默拿到与第 3 辆相同的槽位+颜色，
  // 而两辆同色车在截图上要么恰好离得远看不出、要么被当成「就是这个配色」。
  // 只读，不进正常交互路径。
  enemySlots: () => players.slice(1).map((p) => ({ slot: p.index, color: p.color, alive: p.tank.alive })),
  // 快进到第 n 波（跳过前面的慢热，专测换图/large 档/同屏上限）
  forceWave: (n) => { if (currentMode === "wave") beginWave(Math.max(1, n | 0)); },
  // 阶段 27 守点波：holdState 是圈的唯一窥视口（进度靠截图读不准，扇形只有角度）；
  // forceHoldProgress 用来快进过波流转（守满 12s 才验一次抽卡太慢），
  // **写的是 progress 不是 done**——过波仍由 updateWaveFlow 的判据自己跑出来，
  // 免得测出来的是「我直接把过波按下去了」这种假观测
  holdState: () => (holdZone ? {
    x: holdZone.x, y: holdZone.y, radius: holdZone.radius,
    progress: holdZone.progress, need: holdZone.need, ratio: holdZone.ratio,
    inside: holdZone.inside, done: holdZone.done,
  } : null),
  forceHoldProgress: (s) => {
    if (holdZone) holdZone.progress = Math.max(0, Math.min(holdZone.need, Number(s) || 0));
  },
  // 阶段 25 抽卡与强化：draftState 只读浮层、forceDraft 不清场直接弹（免得为测一张卡
  // 先打完一波）、pickDraft 走的是与点击/数字键完全同一条 applyDraftPick，
  // modsOf 是数值挂点的唯一窥视口（玩家侧强化与敌方侧词条读同一个字段集）
  draftState: () => ({
    open: draft.open, hover: draft.hover,
    offers: draft.offers.map((c) => c.id),
    taken: Object.fromEntries(taken),
  }),
  forceDraft: () => openDraft(),
  pickDraft: (i) => { if (draft.open) applyDraftPick(i | 0); },
  modsOf: (i) => (players[i] ? { ...players[i].tank.mods } : null),
  // 阶段 28.5 提示层：hintState 是唯一窥视口（提示条只在屏幕上存在 4.5 秒，
  // 截图抓不准时机）；forceHint 走的是与真实触发点完全同一条 maybeHint，
  // 所以验的是真链路不是假观测；resetHints 让实机能把「只弹一次」重复验几遍。
  hintState: () => ({ now: hintNow, timer: hintTimer, queue: [...hintQueue], seen: [...hintsSeen] }),
  forceHint: (id) => maybeHint(String(id)),
  resetHints: () => {
    hintsSeen = [];
    saveHintsSeen(hintsSeen);
    hintQueue = [];
    hintNow = null;
    hintTimer = 0;
  },
  blastAt: (x, y) => {
    // 直接触发一次炸墙结算（跳过地雷实体，专测破墙链路：几何/特效/音效/开关）
    if (!maze || !wallBreakEnabled) return 0;
    const broken = destroyWallsInRadius(maze, x, y, POWERUP.mine.wallBlastRadius);
    for (const w of broken) effects.push(new WallBreak(w.x1, w.y1, w.x2, w.y2));
    if (broken.length) playSfx("wallBreak");
    return broken.length;
  },
};

// 开一整场：从菜单进入时调用。清零累计分，再开第一回合。
// 与 setupRound 的分工：startMatch 负责「整场」级状态(分数)，
// setupRound 只负责「单回合」级状态(地图/玩家)。回合重开只走 setupRound，分数不动。
function startMatch(mode) {
  matchScores = [0, 0];
  // 本场命中率基线：整场结算横幅显示的是「本场」而非终身累计，
  // 记开场时的 fired/hits，MATCH_OVER 处做差
  matchStatsBase = getStats().players.map((p) => ({ fired: p.fired, hits: p.hits }));
  setupRound(mode);
}

// 生成地图 + 算自适应缩放 + 返回四角出生位。
// setupRound 与波次换图（remapWaveArena）共用——档位/风格由调用方定：
// 关卡表确定性指定 / pvp·pve 模式池随机抽 / 波次由曲线给。
function buildArena(tier, style) {
  const { cols, rows } = MAZE_TIERS[tier];
  maze = generateMaze(cols, rows, style);

  // 自适应缩放 + 居中：把竞技场世界尺寸喂给 fitArena
  const fit = fitArena(cols * CELL_SIZE, rows * CELL_SIZE);
  arenaScale = fit.scale;
  offsetX = fit.offsetX;
  offsetY = fit.offsetY;

  const half = CELL_SIZE / 2;
  // 四角出生位（tl 恒给玩家；关卡表 enemies[].spawn 取其余三角）
  return {
    tl: { x: half, y: half, a: 0 },
    tr: { x: (cols - 1) * CELL_SIZE + half, y: half, a: Math.PI },
    bl: { x: half, y: (rows - 1) * CELL_SIZE + half, a: 0 },
    br: { x: (cols - 1) * CELL_SIZE + half, y: (rows - 1) * CELL_SIZE + half, a: Math.PI },
  };
}

// 从模式的风格池随机抽一种（与档位正交，各自随机 → 每回合换图+换风格）
function pickStyle(mode) {
  const pool = STYLE_POOL_BY_MODE[mode] || STYLE_POOL_BY_MODE.pvp;
  return pool[Math.floor(Math.random() * pool.length)];
}

// 开一局：按模式从档位池随机抽一档地图，生成随机布局与玩家。
// 缩放偏移由 fitArena 算（小图原样、大图等比缩小并居中），每回合重抽换图。
// challenge 模式：地图/敌人/道具/地形全部由关卡表确定性指定（不随机）。
// wave 模式：档位由波次曲线确定性给，敌人不预生成（交给波次调度投放）。
function setupRound(mode) {
  currentMode = mode;

  const level = mode === "challenge" ? LEVELS[currentLevelIndex] : null;
  let corner;
  if (level) {
    corner = buildArena(level.map.tier, level.map.style);
  } else if (mode === "wave") {
    // 波次：档位是难度（曲线确定性给，第 11 波起 large），风格仍是花样（随机）
    corner = buildArena(waveSpec(1).tier, pickStyle(mode));
  } else {
    // 从该模式的档位池随机抽一档（pvp/pve → small|medium）
    const pool = TIER_POOL_BY_MODE[mode] || TIER_POOL_BY_MODE.pvp;
    corner = buildArena(pool[Math.floor(Math.random() * pool.length)], pickStyle(mode));
  }

  if (level) {
    // 关卡模式：玩家 tl + 按表生成 n 个 AI 敌人
    players = [new Player(0, PLAYER_COLORS[0], KEY_BINDINGS[0], corner.tl.x, corner.tl.y, 0)];
    level.enemies.forEach((e, i) => {
      const c = corner[e.spawn] || corner.br;
      players.push(new Player(i + 1, PLAYER_COLORS[(i + 1) % PLAYER_COLORS.length],
        null, c.x, c.y, c.a, true, e.level));
    });
    // 玩家开局强化
    const pc = level.player || {};
    const pt = players[0].tank;
    if (pc.weapon === "laser") pt.laserShots = pc.shots ?? 1;
    else if (pc.weapon === "scatter") pt.scatterShots = pc.shots ?? 3;
    // 持雷必须一并起超时计时：tank.update 见 mineCharges>0 就扣 mineHoldTimer，
    // 只写存货不写计时的话下一帧 0 <= 0 直接把存货清光（休眠 bug，现在没关卡发雷所以
    // 不可见；留着等以后哪一关配了 weapon:"mine" 再当新 bug 查一遍不值得）
    else if (pc.weapon === "mine") {
      pt.mineCharges = pc.shots ?? 2;
      pt.mineHoldTimer = POWERUP.mine.holdTimeout;
    }
    if (pc.shield) pt.applyPowerup("shield");
    spawner = new PowerupSpawner([...level.powerups]);
    levelWallBreak = !!level.wallBreak; // 关卡覆写，不动全局设置
    levelTimer = 0; // 本关已过秒数（单调递增，所有目标类型同一语义）
  } else if (mode === "wave") {
    // 波次生存：玩家一人 tl 起手，敌人一个都不预生成——全部交给波次调度按
    // 同屏上限逐个投放（见 updateWaveFlow），压力才是渐进的而不是开场一锅端。
    players = [new Player(0, PLAYER_COLORS[0], KEY_BINDINGS[0], corner.tl.x, corner.tl.y, 0)];
    // 道具沿用玩家自己的菜单设置（不像关卡那样锁定），全关则整局无道具
    spawner = new PowerupSpawner(POWERUP.types.filter((t) => enabledPowerups.has(t)));
    waveKills = 0;
    waveNewRecord = false;
    // 强化是 run 级资产：重来就归零。坦克本体是新建的 → mods 天然中性，
    // 这里只需要清「抽过什么」的账本（HUD 强化条与抽卡池都读它）。
    taken.clear();
  } else {
    // P1 左上角格朝右，P2 右下角格朝左，初始背对，给彼此反应空间。
    // pve 模式 P2 是 AI：keys=null + isAI=true，Player 内建 AiController。
    const p2IsAI = mode === "pve";
    players = [
      new Player(0, PLAYER_COLORS[0], KEY_BINDINGS[0], corner.tl.x, corner.tl.y, 0),
      new Player(1, PLAYER_COLORS[1], p2IsAI ? null : KEY_BINDINGS[1],
        corner.br.x, corner.br.y, Math.PI, p2IsAI, aiLevel),
    ];
    // 道具刷新器：只喂启用的类型（保持 POWERUP.types 定义顺序），
    // 全没启用则传空数组，整局永不刷（spawner 内部 types 为空直接 return）
    spawner = new PowerupSpawner(POWERUP.types.filter((t) => enabledPowerups.has(t)));
  }

  bullets = [];
  effects = [];
  powerups = [];
  mines = [];
  resetShake();      // 上一局的余震不许漏进新一局的开场（见 effects.js 里的理由）
  // 上一局的击杀慢镜同理（与 resetShake 同族的转场残留，阶段 27.1 漏了这一个）：
  // loop() 按 slowmoTimer>0 缩放 gameDt，而 introTimer 吃的就是 gameDt，于是
  // 「击杀后 0.55s 内按 R 重开」会让新一局的 3-2-1 用 0.35× 速度走——实测整段
  // 1.35s→1.71s、第一拍从 0.45s 拖到 0.80s（换拍音可听地不齐）。
  // 五条重开路径全部汇入 setupRound，所以清在这一处即全覆盖；**刻意不在
  // remapWaveArena 里重复**——波次中途的非终局击杀只置 pendingSoloSlowmo 从不置
  // slowmoTimer，终局击杀直接进 WAVE_OVER 结束这一 run，故换图时它恒为 0，加了是死代码。
  slowmoTimer = 0;
  holdZone = null;   // 上一次波次 run 的圈不许漏进新一局（beginWave 随后会按波号重建）
  // 抽卡浮层清在**所有模式**共用的这一段而不是 wave 分支里：`updatePlaying` 顶上那道
  // 抽卡门不分模式，万一 open 漏进 pvp 就是最常玩的模式整局冻死。现在的流程漏不出来
  // （浮层期间物理冻结所以死不了、Esc 被吞、R 在 PLAYING 无效），但那是三条不变量的
  // 合力，任一条以后被改动都会把这个洞打开——清在这里成本为零。
  draft.open = false;
  draft.offers = [];
  draft.hover = -1;
  winner = null;
  pendingSoloSlowmo = false;
  // 波次第 1 波必须等实体数组清空后再起（开波补给要 push 进新的 powerups）
  if (mode === "wave") beginWave(1);
  introTimer = ROUND_INTRO.beat * 3; // 3-2-1 三拍冻结开场
  goTimer = 0;
  playSfx("countTick"); // 第一拍「3」（后续换拍音在 updatePlaying 的门里）
  state = STATE.PLAYING;
}

let lastTime = 0;

function loop(now) {
  const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0;
  lastTime = now;
  // 击杀慢动作：游戏时间缩放；slowmo 自身与 GO 余像用真实 dt 衰减
  // （若用缩放后 dt 衰减，慢动作会把自己拖慢 1/scale 倍）
  const gameDt = slowmoTimer > 0 ? dt * SLOWMO.scale : dt;
  slowmoTimer = Math.max(0, slowmoTimer - dt);
  goTimer = Math.max(0, goTimer - dt);
  advanceHints(dt); // 同样用真实 dt：慢镜不该把一条提示拉长到 13 秒
  update(gameDt);
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
    case STATE.MATCH_OVER:
      updateMatchOver(dt);
      break;
    case STATE.LEVEL_OVER:
      updateLevelOver(dt);
      break;
    case STATE.WAVE_OVER:
      updateWaveOver(dt);
      break;
  }
  endFrame();
}

// 菜单：把点击交给 ui.menuAction 判定「点到了什么」，这里只做状态变更。
// 浮层分流顺序 = 层级（先判在上）：rebind > 设置面板 > 菜单本体。
function updateMenu(dt) {
  if (rebind.open) {
    updateRebind(dt);
    return;
  }
  if (settingsPanel.open) {
    updateSettingsPanel();
    return;
  }
  if (levelSelect.open) {
    updateLevelSelect();
    return;
  }

  // 命中检测一律用 getClickPos() 而不是 getMousePos()：后者是实时 hover，会被
  // 「click 之后、本帧消费之前」到达的 mousemove 推走，于是点 A 执行 B（见 input.js）
  if (!isClicked()) return;
  const { x: mx, y: my } = getClickPos();
  const action = menuAction(mx, my, { showHelp });
  if (!action) return;

  switch (action.type) {
    case "closeHelp":
      showHelp = false;
      break;
    case "openHelp":
      showHelp = true;
      break;
    case "openSettings":
      settingsPanel.open = true;
      break;
    case "openLevelSelect":
      levelSelect.open = true;
      break;
    case "mode":
      startMatch(action.mode);
      break;
  }
  playSfx("uiClick");
}

// 关卡选择浮层：点已解锁关卡开局；Esc/面板外关闭
function updateLevelSelect() {
  if (isJustPressed("Escape")) {
    levelSelect.open = false;
    return;
  }
  if (!isClicked()) return;
  const { x: mx, y: my } = getClickPos();
  const action = levelSelectAction(mx, my, challengeProgress);
  if (!action) return;
  playSfx("uiClick");
  if (action.type === "startLevel") {
    levelSelect.open = false;
    currentLevelIndex = action.index;
    setupRound("challenge");
  } else if (action.type === "close") {
    levelSelect.open = false;
  }
}

// 设置浮层：难度/道具/地形/音效 chip 与键位面板入口（阶段 19 从主菜单收纳）。
// Esc 或点面板外关闭；点「键位设置…」在其上叠开 rebind 面板。
function updateSettingsPanel() {
  if (isJustPressed("Escape")) {
    settingsPanel.open = false;
    return;
  }
  if (!isClicked()) return;
  const { x: mx, y: my } = getClickPos();
  const action = settingsAction(mx, my);
  if (!action) return;

  switch (action.type) {
    case "aiLevel":
      aiLevel = action.key;
      break;
    case "togglePowerup":
      // 多选 toggle：点亮/熄灭该类道具,组合即时写盘(下局生效)
      if (enabledPowerups.has(action.key)) enabledPowerups.delete(action.key);
      else enabledPowerups.add(action.key);
      saveEnabledPowerups([...enabledPowerups]);
      break;
    case "toggleMute":
      saveAudioMuted(toggleMuted());
      break;
    case "toggleWallBreak":
      wallBreakEnabled = !wallBreakEnabled;
      saveWallBreak(wallBreakEnabled);
      break;
    case "openRebind":
      rebind.open = true;
      break;
    case "close":
      settingsPanel.open = false;
      break;
  }
  // 点击音在 switch 之后：切到静音那下无声、解除静音那下有反馈，语义自洽
  playSfx("uiClick");
}

// 键位设置面板：捕获按键 → 校验（保留键/冲突）→ 写入 KEY_BINDINGS + 存盘。
// 交互规则：点 chip 进捕获态；捕获态按 Esc 只取消捕获；非捕获态 Esc 关面板。
function updateRebind(dt) {
  // 红字提示限时消失
  if (rebind.msgTimer > 0) {
    rebind.msgTimer -= dt;
    if (rebind.msgTimer <= 0) rebind.conflictMsg = "";
  }
  const flash = (msg, isError = true) => {
    rebind.conflictMsg = msg;
    rebind.msgTimer = 2.2;
    if (isError) playSfx("uiError");
  };

  // 1) 捕获态：吃掉本帧按下的第一个键
  if (rebind.capturing) {
    const code = getAnyJustPressed();
    if (code) {
      const { player, action } = rebind.capturing;
      if (code === "Escape") {
        rebind.capturing = null; // 仅取消捕获，不关面板
      } else if (RESERVED_KEYS.includes(code)) {
        // 文案要说清是「界面」而不是笼统的「系统」——表里现在两类都有，
        // 而玩家真正会撞上的是 R（紧邻 WASD/ESDF 手位，所以它才会被绑）
        flash(`${keyLabel(code)} 是界面快捷键，不能绑定`);
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
    closeRebind();
    return;
  }

  // 3) 鼠标点击：chip 进入/切换捕获，恢复默认，面板外关闭
  if (!isClicked()) return;
  const { x: mx, y: my } = getClickPos();
  const action = rebindAction(mx, my);
  if (!action) return;

  if (action.type === "bind") {
    rebind.capturing = { player: action.player, action: action.action };
  } else if (action.type === "reset") {
    resetBindings();
    rebind.capturing = null;
    flash("已恢复默认键位", false); // 成功提示不播错误音
    playSfx("uiClick");
  } else if (action.type === "close") {
    closeRebind();
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

// 触发一条上下文提示：没见过才排队，并**当场写盘**。
// 立刻写而不是攒着：一次性提示的全部价值就是「只弹一次」，而这个模式里玩家会
// 直接关窗口，攒着写等于下一局重新弹一遍。
// **只给玩家 1（人类位）调**——AI 的拾取与死亡不该教任何人东西。
function maybeHint(id) {
  if (!shouldShow(id, hintsSeen)) return;
  hintsSeen = markSeen(id, hintsSeen);
  saveHintsSeen(hintsSeen);
  if (hintQueue.length < HINT.maxQueue) hintQueue.push(id);
}

// 推进提示条（真实 dt，在 loop 里调）。
// **刻意不随转场清空**：最该被看见的那条（跳弹自杀）恰好在死亡那一刻触发，
// 而死亡紧接着就是 ROUND_OVER / WAVE_OVER 转场——照「转场排空」的惯例清掉队列，
// 这条提示就永远看不见。它只是一行 4.5 秒的字，跨过一次转场无害。
// 提示条的可见性判据**只有这一处**：时钟与渲染必须读同一个谓词。
// 分开写的后果很具体——提示弹出时玩家按 Esc 想停下来读，PAUSED 下不画它但计时
// 照走，4.5 秒后这条**一次性且已写盘**的提示就永远消失了。这与「清 effects 必须
// 同时排空震动」是同一族缺陷：两半必须一致，所以只留一份、两边都来问它。
function hintsVisible() {
  return state !== STATE.MENU && state !== STATE.PAUSED;
}

function advanceHints(dt) {
  if (!hintsVisible()) return; // 看不见就不走表、也不出队（见 hintsVisible）
  if (hintTimer > 0) {
    hintTimer = Math.max(0, hintTimer - dt);
    if (hintTimer === 0) hintNow = null;
  }
  if (!hintNow && hintQueue.length) {
    hintNow = hintQueue.shift();
    hintTimer = HINT.duration;
  }
}

// 统一命中结算（阶段 23 抽出）：有盾消盾、无盾击杀——子弹/散射/激光/地雷共用。
// weapon 用于统计归类；killerTank 用于排除自伤统计。慢动作与统计的
// 模式分流集中在这一处（单人模式多敌人：非终局击杀不慢镜、不进终身统计）。
// 返回 true=击杀成功，false=被盾挡下。
function hitPlayer(p, weapon, killerTank) {
  const killerIndex = players.findIndex((pp) => pp.tank === killerTank);
  if (p.tank.shield) {
    p.tank.shield = false;
    p.tank.shieldTimer = 0;
    effects.push(new ShieldBreak(p.tank.x, p.tank.y, THEME.shieldRing));
    addShake(3, 0.2);
    playSfx("shieldBreak");
    if (!soloMode() && killerIndex >= 0 && killerTank !== p.tank) recordHit(killerIndex, weapon);
    return false;
  }
  p.tank.alive = false;
  // 被**自己的跳弹**打死：新玩家的第一死因，而画面上没有任何东西说明
  // 「反弹后的子弹不认主人」。**判据必须按武器分流**（见 hints.isRicochetSelfKill）：
  // `hitPlayer` 有三个调用者，地雷传 `m.owner`、激光传 `shooter.tank`，所以只看
  // 「凶手 === 自己」会把「踩自己的雷」和「贴墙激光弹回来」也算成跳弹——而一次性
  // 提示当场写盘，讲错一次就永远没机会讲对。
  if (p === players[0] && isRicochetSelfKill(weapon, killerTank, p.tank)) maybeHint("ricochet");
  effects.push(new TankExplosion(p.tank.x, p.tank.y, p.color));
  addShake(5, 0.3);
  playSfx("kill");
  if (!soloMode()) slowmoTimer = SLOWMO.duration; // 1v1 任何击杀=终杀
  else pendingSoloSlowmo = true; // 单人模式：是否终局由胜负段确认后再慢镜
  if (!soloMode() && killerIndex >= 0 && killerTank !== p.tank) recordKill(killerIndex, weapon);
  // 波次战绩：敌人被击破就 +1（含互相误伤/踩雷——场是你控的，算你的）
  if (currentMode === "wave" && p !== players[0]) {
    waveKills++;
    // 战场回收（阶段 25 的 salvage 卡）：按概率在尸体位置掉一个启用类型的道具。
    // 绕开 spawner.cap（它是刷新器的节流阀，不是事件掉落的闸门），但留一道软顶——
    // 后期一波 12 个配额，不然打到中段地上能铺满道具。
    const m = players[0].tank.mods;
    if (m.salvage > 0 && spawner.types.length
        && powerups.length < fieldCapOf(m) + UPGRADE.salvageSlack
        && Math.random() < m.salvage) {
      const type = spawner.types[Math.floor(Math.random() * spawner.types.length)];
      powerups.push(new Powerup(p.tank.x, p.tank.y, type));
    }
  }
  return true;
}

function updatePlaying(dt) {
  // 0) 波间抽卡浮层门（阶段 25）：**必须排在 Esc 判定之前**——抽卡期间 Esc 被吞掉，
  //    玩家必须选一张才能继续。抽卡本身已是无限时的暂停，再叠一层暂停没有意义，
  //    还会把「浮层之上还有浮层」的层级复杂化（对齐 rebind > settingsPanel 的层级纪律）。
  //    照 introTimer 门的先例只放过 updateEffects：上一波的爆炸能播完，
  //    别在浮层弹出的瞬间硬切。物理段被整段跳过，所以抽卡期间玩家不可能死。
  if (draft.open) {
    updateDraft();
    updateEffects(dt);
    return;
  }

  // 0.1) 对战中按 Esc 进入暂停（不弃局）。暂停菜单提供「继续 / 返回主菜单」。
  //    联机 v2 这里要改成「投降/确认退出」语义，避免一人退局带走别人的对战。
  if (isJustPressed("Escape")) {
    state = STATE.PAUSED;
    return;
  }

  // 0.5) 开场倒计时门：3-2-1 期间双方全冻结——必须跳过 getControls 整段，
  //      否则 AI 的开火冷却在玩家不能动时被烧掉，GO 瞬间枪已就绪（抢先手）。
  //      特效照常推进（出生无特效，此处是习惯性保守），Esc 暂停仍可用（上面已处理）。
  if (introTimer > 0) {
    const beatBefore = Math.ceil(introTimer / ROUND_INTRO.beat);
    introTimer = Math.max(0, introTimer - dt); // 钳 0：负值残留会让 devHook/渲染判定歧义
    const beatAfter = Math.ceil(introTimer / ROUND_INTRO.beat);
    if (introTimer === 0) {
      goTimer = ROUND_INTRO.goHold; // 解冻，"GO!" 余像
      playSfx("countGo");
    } else if (beatAfter < beatBefore) {
      playSfx("countTick"); // 换拍（3→2→1）
    }
    updateEffects(dt);
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
        // 顶掉判定要在 applyPowerup **之前**抓快照——它会就地清掉旧武器槽，
        // 之后再问「原来握着什么」已经问不出来了
        const heldBefore = p === players[0] ? weaponHeld(p.tank) : null;
        p.tank.applyPowerup(pw.type);
        if (p === players[0]) {
          if (isWeaponSwap(heldBefore, pw.type)) maybeHint("weaponSwap");
          // 第一次拿到激光就说清「这条线对手也看得见」——激光的整个平衡
          // 都靠意图外露，而持枪方自己看不出那条线是公开的
          if (pw.type === "laser") maybeHint("laserSeen");
        }
        pw.taken = true; // 标记，循环后统一过滤（避免边遍历边删）
        effects.push(new PickupFlash(pw.x, pw.y, pw.type));
        playSfx("pickup", { rate: PICKUP_RATE[pw.type] ?? 1 });
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
    playSfx("mineBlast");
    if (wallBreakActive()) {
      // 炸墙：波及圈内内墙被炸碎（walls/cells 原子同步，AI 下次重规划自动感知）
      const broken = destroyWallsInRadius(maze, m.x, m.y, POWERUP.mine.wallBlastRadius);
      for (const w of broken) effects.push(new WallBreak(w.x1, w.y1, w.x2, w.y2));
      if (broken.length) playSfx("wallBreak");
    }
    for (const p of players) {
      if (!p.alive) continue;
      if (Math.hypot(p.tank.x - m.x, p.tank.y - m.y) >= POWERUP.mine.blastRadius) continue;
      hitPlayer(p, "mine", m.owner);
    }
  }
  mines = mines.filter((m) => !m.exploded);

  // 3) 开炮 + 部署：开火键产子弹（单发/散射，maxAlive 限流 + 贴墙出膛修正）
  //    或激光（瞬时射线，当帧结算）；道具键走 tryDeploy 部署地雷——
  //    射击与部署解耦，各有冷却互不影响。
  for (let i = 0; i < players.length; i++) {
    const res = players[i].tank.tryFire(bullets, controls[i].fire, maze.walls);
    if (res.bullets.length > 0) {
      effects.push(new MuzzleFlash(res.bullets[0].x, res.bullets[0].y, players[i].tank.angle));
      playSfx(res.bullets.length > 1 ? "shootScatter" : "shoot"); // 散射一炮一个音
      // 单人模式不进终身统计（stats.players 定长 2，第三车会越界；口径也不同）
      if (!soloMode()) recordFired(i, res.bullets.length);
    }
    for (const b of res.bullets) bullets.push(b); // kind 已由 tank.spawnBullet 打好
    if (res.laser) {
      if (!soloMode()) recordFired(i, 1);
      fireLaser(res.laser, players[i]); // 补传射手，击杀归属统计
    }

    const mine = players[i].tank.tryDeploy(controls[i].special, maze.walls);
    if (mine) {
      mines.push(mine);
      playSfx("mineDeploy");
    }
  }

  // 4) 子弹更新（移动 + 反弹 + 磨墙）。开关开着时每次反弹削内墙 1 点耐久，
  //    归零的墙这里统一删除（walls/cells 原子同步）——不在 bullet 遍历中删。
  for (const b of bullets) {
    b.update(dt, maze.walls, wallBreakActive());
  }
  if (wallBreakActive()) {
    const crumbled = maze.walls.filter((w) => !w.border && w.hp <= 0);
    if (crumbled.length) {
      destroyWallSegments(maze, crumbled);
      for (const w of crumbled) effects.push(new WallBreak(w.x1, w.y1, w.x2, w.y2));
      playSfx("wallBreak");
    }
  }

  // 5) 击中判定：每颗活子弹 vs 每个存活坦克
  for (const b of bullets) {
    if (b.dead) continue;
    for (const p of players) {
      if (!p.alive) continue;
      if (!b.canHit(p.tank)) continue;
      if (circleVsCircle(b.x, b.y, BULLET.radius, p.tank.x, p.tank.y, TANK.radius)) {
        // 护盾挡一发即碎 / 无盾即死——统一走 hitPlayer；子弹两种结局都消失
        b.dead = true;
        hitPlayer(p, b.kind || "bullet", b.owner);
        break; // 一颗子弹只打一个
      }
    }
  }

  // 5.9) 持雷快作废：坦克本来就会闪烁示警，但没人知道闪烁的意思是「要作废了」
  //      而不是「装备好了」。阈值跟 ui.renderWeaponBadges 的闪烁门一致（<3s），
  //      所以提示与画面上开始闪的那一刻同步。
  if (players[0]?.alive && players[0].tank.mineCharges > 0
      && players[0].tank.mineHoldTimer > 0 && players[0].tank.mineHoldTimer < 3) {
    maybeHint("mineTimeout");
  }

  // 6) 清理消亡子弹 + 推进道具呼吸动画 + 推进特效（播完移除）
  bullets = bullets.filter((b) => !b.dead);
  for (const pw of powerups) pw.update(dt);
  updateEffects(dt);

  // 6.5) 波次生存专属：死敌当帧移出 players。敌人来去无常，留着尸体会让
  //      AI 世界视图与碰撞遍历越攒越长，颜色槽位也回收不了（只有 3 个可用）。
  //      爆炸是独立特效实体（已入 effects），移除不影响演出；它生前射出的
  //      子弹与布下的雷仍在场——owner 是坦克引用，不随 Player 出列而失效。
  if (currentMode === "wave") players = players.filter((p, i) => i === 0 || p.alive);

  // 7) 胜负判定
  if (currentMode === "wave") {
    // 守点进度（阶段 27）：**挂在物理段末尾**自动获得正确语义——抽卡浮层 /
    // Esc 暂停 / 3-2-1 冻结这三道门都在 updatePlaying 顶部整段早退，走不到这里，
    // 于是「浮层与冻结期间进度不涨」不需要任何额外判断。
    // 必须排在 updateWaveFlow 之前：同帧守满就同帧过波，不欠玩家一帧。
    // 传坦克本体（它自带 alive；死后不再计账，收场由 updateWaveFlow 段①管）。
    if (holdZone) holdZone.update(dt, players[0].tank);
    updateWaveFlow(dt);
    return;
  }

  if (currentMode === "challenge") {
    // 关卡模式：目标判定（1v2 下「存活≤1」语义错误——玩家死后 AI 会互殴）。
    // levelTimer 是纯粹的「本关已过秒数」，单调递增：limit/surviveTime 的比较
    // 在 objectives.js 里做（阶段 27 前这里按目标类型分流，一个变量两种语义）。
    // 用游戏时间累加而不是墙钟——慢镜时同步慢，对玩家公平
    const level = LEVELS[currentLevelIndex];
    levelTimer += dt;
    const outcome = evaluateObjective(level, {
      playerAlive: players[0].alive,
      enemiesAlive: players.filter((p, i) => i > 0 && p.alive).length,
      elapsed: levelTimer,
    });
    if (pendingSoloSlowmo) {
      if (outcome) slowmoTimer = SLOWMO.duration; // 终局击杀才慢镜
      pendingSoloSlowmo = false;
    }
    if (outcome) {
      levelOutcome = outcome;
      if (outcome === "win" && currentLevelIndex + 1 > challengeProgress) {
        challengeProgress = currentLevelIndex + 1; // 首次通过，解锁下一关
        saveChallengeProgress(challengeProgress);
      }
      state = STATE.LEVEL_OVER;
      playSfx(outcome === "win" ? "matchWin" : "roundDraw");
    }
    return;
  }

  // pvp/pve：存活 ≤1 转结算
  const alivePlayers = players.filter((p) => p.alive);
  if (alivePlayers.length <= 1) {
    winner = alivePlayers.length === 1 ? alivePlayers[0] : null;
    // 计分：转 ROUND_OVER 这一帧加一次（同归于尽 winner=null 不加分）。
    // 状态切走后不再进 updatePlaying，天然只触发一次，无需额外加锁。
    if (winner) matchScores[winner.index]++;
    recordRoundEnd(winner ? winner.index : null); // 胜场 + P1 连胜推进
    if (winner && matchScores[winner.index] >= MATCH_TARGET) {
      // 先到局胜分：整场结束，大横幅等玩家选择（无自动倒计时）
      recordMatchWin(winner.index);
      saveStats();
      state = STATE.MATCH_OVER;
      playSfx("matchWin");
    } else {
      saveStats(); // 回合级也落盘，防中途退出丢统计（每回合一次全量写可接受）
      roundOverTimer = ROUND_RESTART_DELAY; // 启动自动重开倒计时
      state = STATE.ROUND_OVER;
      playSfx(winner ? "roundWin" : "roundDraw"); // 状态切走后不再进本函数，天然只播一次
    }
  }
}

// 激光发射结算（瞬时 hitscan，当帧一次完成）：投射折线路径 → 沿路径找
// 「最早」被扫到的坦克（逐段推进，段内按参数排序）→ 命中处理（有盾消盾
// 挡住射线，无盾即死）→ 路径截断到命中点（视觉上射线止于目标/护盾）。
// origin = tank.muzzlePoint(walls)：贴墙时出膛点被钳回墙内侧，可能落在射手
// 自己的车体圆内（车贴墙时墙面恰好在车体半径上，出膛点不可能既在体外又在
// 墙内），所以首段必须显式跳过射手——否则每发贴墙激光原地自杀。
// 反弹段照旧参与判定，扫回来可以自杀——与子弹跳弹手感一致。
function fireLaser(origin, shooter = null) {
  let pts = castLaserPath(origin.x, origin.y, origin.angle, maze.walls);

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y) || 1;

    // 段内最早命中：对每辆活坦克求「圆心在段上的最近点」，够近算扫中，
    // 取沿段参数最小者（同段两车都在线上时，先扫到谁谁挨打）
    let hit = null;
    for (const p of players) {
      if (!p.alive) continue;
      if (i === 0 && shooter && p === shooter) continue; // 首段跳过射手（见上）
      const cp = closestPointOnSegment(p.tank.x, p.tank.y, a.x, a.y, b.x, b.y);
      if (Math.hypot(p.tank.x - cp.x, p.tank.y - cp.y) > TANK.radius) continue;
      const t = Math.hypot(cp.x - a.x, cp.y - a.y) / segLen;
      if (!hit || t < hit.t) hit = { p, t, x: cp.x, y: cp.y };
    }

    if (hit) {
      // 截断路径到命中点（后续段不再判定：射线被目标吸收）
      pts = pts.slice(0, i + 1);
      pts.push({ x: hit.x, y: hit.y });
      // 护盾挡激光（射线止于盾）/ 无盾即死——统一走 hitPlayer
      hitPlayer(hit.p, "laser", shooter ? shooter.tank : null);
      break;
    }
  }

  effects.push(new LaserBeam(pts));
  effects.push(new MuzzleFlash(origin.x, origin.y, origin.angle));
  addShake(4, 0.25);
  playSfx("laser");
}

function updatePaused() {
  // 暂停状态：按 Esc 继续，或点击按钮（命中判定在 ui.pauseAction）
  if (isJustPressed("Escape")) {
    state = STATE.PLAYING;
    return;
  }

  if (!isClicked()) return;
  const { x: mx, y: my } = getClickPos();
  const action = pauseAction(mx, my);
  if (action) playSfx("uiClick");
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

// 整场结算：无自动倒计时，等玩家选「再来一场 / 返回菜单」（按钮或 R/Esc 键）。
function updateMatchOver(dt) {
  updateEffects(dt); // 终杀爆炸动画播完

  let choice = null;
  if (isJustPressed("KeyR")) choice = "rematch";
  else if (isJustPressed("Escape")) choice = "menu";
  else if (isClicked()) {
    const c = getClickPos();
    choice = matchOverAction(c.x, c.y);
    if (choice) playSfx("uiClick");
  }

  if (choice === "rematch") startMatch(currentMode); // 比分清零，同模式重开整场
  else if (choice === "menu") state = STATE.MENU;
}

// 关卡结算：无自动倒计时，等玩家选（胜：下一关/重打/菜单；败：重试/菜单）。
// R = 重试当前关；胜利且有下一关时 N/点按钮进下一关。
function updateLevelOver(dt) {
  updateEffects(dt);

  const hasNext = levelOutcome === "win" && currentLevelIndex + 1 < LEVEL_COUNT;
  let choice = null;
  if (isJustPressed("KeyR")) choice = "retry";
  else if (isJustPressed("Escape")) choice = "menu";
  else if (isClicked()) {
    const c = getClickPos();
    choice = levelOverAction(c.x, c.y, { win: levelOutcome === "win", hasNext });
    if (choice) playSfx("uiClick");
  }

  if (choice === "next" && hasNext) {
    currentLevelIndex++;
    setupRound("challenge");
  } else if (choice === "retry") {
    setupRound("challenge");
  } else if (choice === "menu") {
    state = STATE.MENU;
    levelSelect.open = true; // 回到选关面板（延续闯关心流）
  }
}

// ============================================================
// 无尽波次生存（阶段 24）：一条命打无限波，看能活到第几波。
// 曲线全在 waves.js（纯函数），这里只做调度四件事：投放 / 清波 / 换图 / 结算。
// ============================================================

// 进入第 n 波：置配额 + 章节边界换图 + 开波强制补给。
// 敌人不在这里一锅端投放——由 updateWaveFlow 按同屏上限逐辆补，压力才是渐进的。
// **「这是什么波」的唯一决策点**（守点波的建立也在这里）：三个调用点
// （setupRound / 喘息结束 / devHook.forceWave）因此全部自动正确，别在调用点各写一遍。
function beginWave(n) {
  waveNo = n;
  const spec = waveSpec(n);
  waveGoal = waveObjective(n);
  // 守点波（阶段 27）：配额 = Infinity（压力不停，敌人永远补），过波只看守点进度。
  // Infinity−1 仍是 Infinity 且 Infinity<=0 为假，所以既有的投放门与 clearQuota
  // 判据天然生效，一行分支都不用加。
  waveQuotaLeft = waveGoal.type === "hold" ? Infinity : spec.quota;
  waveGapTimer = 0;
  if (shouldRemap(n)) remapWaveArena();   // 章节换图（内含 3-2-1 冻结）
  // 新一波来袭的轻提示。**两条平行 if 而不是 else if**：换图那条路也要响这第一声，
  // 它是「操作权被拿走了」的唯一听觉起点——喘息期不冻结（玩家正在跑动捡补给），
  // 直接切进冻结的 3-2-1 却全程静默，第一声反馈要等 0.45s 才到。不会双响：
  // shouldRemap(1) 恒假，所以 setupRound 那条路走不进 remap 分支，与 401 行不叠；
  // 即便将来叠上，audio.js 的同名 50ms 限流也会把同帧两声合并。
  if (n > 1) playSfx("countTick");
  // 圈必须在换图之后挑（remapWaveArena 会换一张新图、还可能换档位），否则
  // 旧坐标落到新图的墙里或图外。普通波恒清 null——不清就会把上一波的圈留在场上。
  holdZone = waveGoal.type === "hold"
    ? makeHoldZone(waveGoal.secs)
    : null;
  // 第一次遇到守点波就说清规则：圈不会写自己要守多久，而「离开只暂停不倒退」
  // 正是让它不成为隐藏失败态的那条设计（HUD 的「站进圈内才计时」只在出圈时才出现，
  // 说的也只是其中一半）
  if (holdZone) maybeHint("holdZone");
  // **挑不出圈就退回普通清场波**（守点波的唯一死局出口）。pickZoneSpot 声称永不返
  // null，但它确实有一条 return null（整张图没有一格塞得下车）；一旦命中，这一波就是
  // hold 目标 + quotaLeft=Infinity + 没有圈可站 ⇒ holdSecs 恒 0、evaluate 永不返 win、
  // 敌人无限补 = 真死局，且 HUD 会走 default 模板印出「敌 ×2+Infinity」。
  // 宁可把这一波降级成打光敌人（可完成），也不要一个过不去的波——与 maze.js
  // 「宁空旷勿无图」同一条取舍。
  if (waveGoal.type === "hold" && !holdZone) {
    waveGoal = { type: "clearQuota" };
    waveQuotaLeft = spec.quota;
  }
  // 开波补给：强制刷 supplyCountOf 个（基础 spec.supply + 「补给增量」卡的层数）。
  // **场上上限必须一起抬**（spawner.cap）——不然多刷的补给会被 forceSpawn 的
  // 「场上已满」那道门静默吃掉，那张卡就是一张空卡。算式与 arena 共用同一份出口。
  const mods = players[0].tank.mods;
  spawner.cap = fieldCapOf(mods);
  const tanks = players.filter((p) => p.alive).map((p) => p.tank);
  const supply = supplyCountOf(spec, mods);
  for (let i = 0; i < supply; i++) spawner.forceSpawn(maze, powerups, tanks);
}

// 在当前地图上挑一个守点区域（选点纯函数在 zone.js）。挑不出来返回 null——
// 那会让这一波永远过不去，但比让圈落在墙里好；实测 3×3 图都挑得出来（smoke 有断言）。
function makeHoldZone(secs) {
  const spot = pickZoneSpot(maze, players[0].tank);
  return spot ? new HoldZone(spot.x, spot.y, secs) : null;
}

// 章节换图（每 WAVE.remapEvery 波，且只在空场的波次边界发生）：
// 新图 + 玩家挪回 tl + 清场上实体，但**保留玩家坦克本体**——武器槽与护盾
// 是上一章打出来的战果，不该被换图没收（挪坐标即可，零状态搬运代码）。
// 3-2-1 冻结复用 introTimer，给玩家看清新地形的时间。
function remapWaveArena() {
  const corner = buildArena(waveSpec(waveNo).tier, pickStyle("wave"));
  const hero = players[0];
  hero.tank.x = corner.tl.x;
  hero.tank.y = corner.tl.y;
  hero.tank.angle = corner.tl.a;
  players = [hero];   // 旧图上不该有残敌（换图在空场边界），保险起见一并清掉
  bullets = [];
  effects = [];
  // 换图也要排空屏幕震动——阶段 27.1 修的是 setupRound 那一处，**漏了这一处**。
  // 喘息期刻意不冻结（玩家要能捡补给、挪位），所以他能在喘息最后 0.35s 内做出
  // 带震动的动作（开激光 / 踩雷破盾），随后章界换图就把余震带进了 3-2-1 冻结开场；
  // 更阴的是 addShake 的闸门是 `mag >= remain`，一段冻结着的 mag 6 余震会**吞掉**
  // 新章第一次 mag 5 的击杀震动 —— 症状是「有时候击杀不抖」而不是「开局乱抖」。
  // 窗口比 27.1 那条窄（要卡在 0.35s 里），但形状与症状完全相同。
  // slowmoTimer **刻意不清**：它只在非单人击杀(746)或单人终局(983/1266)赋值，
  // 三处都通向终局态，走不到换图——清一个到不了的东西只会让人以为它能到。
  resetShake();
  powerups = [];
  mines = [];
  introTimer = ROUND_INTRO.beat * 3;
  goTimer = 0;
  // 圈的坐标绑在**这一张图**上（新图可能是另一个档位：large 13×8 vs medium 9×7），
  // 旧坐标留着就可能落在墙里或图外。正常流程里守点波落在章尾、换图发生在下一波
  // 开头，所以 remap 时 holdZone 已经是 null；但 devHook 空降与将来的节奏改动会
  // 踩到，照「双数据源原子同步」的先例在这里显式处理：有圈就重挑（进度不带走
  // ——图都换了，攒在旧图某个角落的秒数没有意义），没圈就保持 null。
  if (holdZone) holdZone = makeHoldZone(holdZone.need);
}

// 投放一辆敌人：颜色槽位取当前空闲的 1..ENEMY_COLORS.length（阶段 28 起敌人有自己
// 的配色表，所以槽位不再被玩家的青绿占去 0 号，同屏上限由 concurrentCap 说话），
// 位置取离玩家约 spawnIdealCells 格的空格（pickSpawnSpot），出生朝向对着玩家（别对着墙发呆）。
// 槽位 → 颜色差一位（slot 1 = ENEMY_COLORS[0]）：slot 仍从 1 起是因为它同时喂
// Player.index（→ label "P2(AI)"），而 players[0] 恒为玩家。
function spawnWaveEnemy(spec) {
  const hero = players[0].tank;
  const used = new Set(players.slice(1).map((p) => p.index));
  let slot = 1;
  while (used.has(slot) && slot < ENEMY_COLORS.length) slot++;
  const spot = pickSpawnSpot(maze, hero, players.filter((p) => p.alive).map((p) => p.tank));
  if (!spot) return; // 图太挤（理论上不会）：本帧跳过，下帧再试
  const level = pickEnemyLevel(spec.mix);
  const angle = Math.atan2(hero.y - spot.y, hero.x - spot.x);
  players.push(new Player(slot, ENEMY_COLORS[slot - 1], null, spot.x, spot.y, angle, true, level));
  // 敌人词条（阶段 25）：同一辆车随波次变强。确定性（同波同档同激光配额恒等）——玩家能
  // 学会「第 21 波起场上有一把激光」。装备走 applyPowerup，所以 ai.js 自动会用。
  // 激光按同屏配额发（阶段 26），所以要先数场上还有几把上膛的。
  const armed = countArmedLasers(players.slice(1).filter((p) => p.alive).map((p) => p.tank));
  applyElite(players[players.length - 1].tank, eliteSpec(waveNo, level, armed));
  waveQuotaLeft--;
}

// 本波的判定 ctx（喂 objectives.evaluate）。**刻意不给 elapsed**——波次的两个
// 条件（clearQuota / hold）都不读它，加一个没人读的计时器只会让人以为波次有时限。
const waveCtx = (enemiesAlive) => ({
  playerAlive: players[0].alive,
  enemiesAlive,
  quotaLeft: waveQuotaLeft,
  holdSecs: holdZone ? holdZone.progress : 0,
});

// 每帧波次调度（updatePlaying 段 7 的 wave 分支，早退不落到 pvp 结算）。
// 五步顺序是承重的，别重排：
//   ① 死亡检查（早退）—— 与 objectives.evaluate 第一行「玩家死优先」是同一条规则
//      的两处体现：这里还要做写盘/慢镜/状态切换这些 evaluate 不表达的副作用
//   ② 清 pendingSoloSlowmo  ③ 喘息分支（必须在④之前，否则 roundWin 与抽卡每帧重触发）
//   ④ 过波判定（走 evaluate）  ⑤ 投放
function updateWaveFlow(dt) {
  // 玩家死 = 本次生存结束（场上还剩几辆敌人不再关心）
  if (!players[0].alive) {
    if (pendingSoloSlowmo) {
      slowmoTimer = SLOWMO.duration; // 只有终局这一杀值得慢镜
      pendingSoloSlowmo = false;
    }
    const rec = { wave: waveNo, kills: waveKills };
    // **先记住「之前有没有记录」再覆盖它**。少了这一笔，横幅第三条文案
    // 「首战告负，再来一把」在构造上永远显示不出来：它要求 newRecord===false
    // 且 best.wave===0，而 best.wave===0 只在全新档成立，那时任何一次结束都
    // wave>=1>0 ⇒ newRecord 必为 true，两个条件互斥。症状是第一次玩死在第 1 波
    // 也报「🏆 新纪录！」+ 胜利琶音——给「立刻就死」发奖杯。
    waveHadRecord = waveBest.wave > 0;
    waveNewRecord = isBetterRecord(rec, waveBest);
    if (waveNewRecord) {
      waveBest = normalizeWaveBest(rec);
      saveWaveBest(waveBest);   // 记录照旧落盘（首战也存），只是不吹号
    }
    state = STATE.WAVE_OVER;
    // 奖杯与琶音只给「打破了一个真的存在过的记录」；首战一律中性收场音
    playSfx(waveNewRecord && waveHadRecord ? "matchWin" : "roundDraw");
    return;
  }
  pendingSoloSlowmo = false; // 打掉敌人是波次里的日常，一局几十个，不给慢镜

  const enemiesAlive = players.length - 1; // 死敌已在段 6.5 出列，这个数是精确的
  if (waveGapTimer > 0) {
    // 波间喘息：**不冻结**——玩家保有控制权，可趁空场捡补给、挪到有利位置。
    // 冻结的是它前面那一步（抽卡浮层）与章界换图的 3-2-1；喘息本身刻意留给玩家动。
    waveGapTimer = Math.max(0, waveGapTimer - dt);
    if (waveGapTimer === 0) beginWave(waveNo + 1);
    return;
  }
  if (evaluate(waveGoal, waveCtx(enemiesAlive)) === "win") {
    playSfx("roundWin");
    // **过波即清场**（阶段 27）。普通波要 enemiesAlive===0 才判过，所以这段在普通波
    // 恒是空操作；守点波却可能在场上还有 3 辆的时候达成——残敌必须清掉，否则：
    //   ① 「喘息是空场」这条全局不变量破了（remapWaveArena 的注释写的就是「换图在
    //      空场边界」），而 HUD 那 1.5s 已经在写「清空」；
    //   ② 玩家会在明明打完了第 5 波之后、被残敌在庆祝时间里打死，记录还记成第 5 波。
    // 不计 waveKills（不是玩家打掉的）、不走 hitPlayer（那条路会牵动统计与慢镜），
    // 只留爆炸与震动当过波的收尾反馈——守满的那一刻圈本身不加特效，反馈全在这里。
    for (const p of players.slice(1)) {
      p.tank.alive = false;
      effects.push(new TankExplosion(p.tank.x, p.tank.y, p.color));
    }
    if (players.length > 1) addShake(5, 0.3);
    players = [players[0]];
    // 连敌方**已出膛的子弹**一起丢掉（阶段 28 补）。清掉车不清弹，①那条不变量只补了一半：
    // 抽卡浮层是冻结的所以子弹不动，但它后面那 1.5s 喘息刻意不冻结，鬼弹会在庆祝时间里
    // 接着飞——守点波达成那一瞬场上可能有 3 辆车正对着站桩的玩家开火，「已经过波了还被
    // 一个不存在的敌人打死」比被残敌打死更不讲理（章界换图确实清子弹，但那在喘息**之后**）。
    // 普通波恒是清掉最后一辆时那一两发，同一条路径不开特例。
    // 三条边界刻意留着：玩家自己的子弹留下（被自己的跳弹打死是既有物理，讲理）、
    // 地雷不清（雷阵跨波保留是阶段 24 刻意的，且雷是静态危险得自己开过去）、
    // 激光不必清（hitscan 瞬时，不存在“在飞”的激光）。
    bullets = bullets.filter((b) => b.owner === players[0].tank);
    // 清波 → 先抽卡（冻结），选完才进喘息。无卡可抽（全满层 / 道具全关到没有
    // 一张卡满足 requires）时 openDraft 返回 false，直接进喘息，不弹空浮层。
    if (!openDraft()) waveGapTimer = WAVE.gap;
    return;
  }
  // 场上不满同屏上限且配额有余 → 补一辆（一帧只补一辆，避免同点挤压）
  const spec = waveSpec(waveNo);
  if (enemiesAlive < spec.concurrent && waveQuotaLeft > 0) spawnWaveEnemy(spec);
}

// ============================================================
// 波间强化抽卡（阶段 25）：清波后弹三选一，选完才进喘息。
// 时序（含章界）：
//   清空第 5 波 → roundWin 音 → 抽卡（冻结，Esc 无效）
//     → 1.5s 喘息（不冻结，可捡补给） → beginWave(6) → 换图 + 3-2-1 → 第 6 波
// 章界前那 1.5s 喘息里捡的道具会被换图清掉（武器槽保留）——阶段 24 既有行为，
// 不为它加特例分支：多一条 shouldRemap 判断换 1.5 秒不值。
// ============================================================

// 开抽卡浮层。返回是否真开起来了——没有任何可抽的卡（全满层 / 道具与地形全关
// 导致 requires 全不满足）时返回 false，调用方直接进喘息。
function openDraft() {
  const ctxOffer = { types: enabledPowerups, wallBreak: wallBreakActive() };
  const offers = pickOffers(taken, ctxOffer);
  if (!offers.length) return false;
  draft.open = true;
  draft.offers = offers;
  draft.hover = -1;
  return true;
}

// 抽卡浮层的每帧输入（冻结期唯一活着的交互）。两条路等价：数字键 1/2/3 与点击。
function updateDraft() {
  const mouse = getMousePos();
  const hovered = draftAction(mouse.x, mouse.y, draft.offers.length);
  draft.hover = hovered ? hovered.index : -1;

  for (let i = 0; i < draft.offers.length; i++) {
    if (isJustPressed(`Digit${i + 1}`)) { applyDraftPick(i); return; }
  }
  // 点击命中按**点击当时**的坐标重算，不复用上面那个 hover 命中：click 之后、本帧
  // 消费之前还会来 mousemove，hover 可能已经漂到隔壁那张卡上了。
  // 选卡是不可撤销的（当场施加到坦克上，浮层也没有关闭出口），误选的代价最高——
  // 这一处是整个游戏里最该按点击坐标判的地方
  if (isClicked()) {
    const c = getClickPos();
    const picked = draftAction(c.x, c.y, draft.offers.length);
    if (picked) applyDraftPick(picked.index);
  }
}

// 选定一张：施加 → 收浮层 → 进喘息（下一帧调度器落进现成的喘息分支）
function applyDraftPick(i) {
  const card = draft.offers[i];
  if (!card) return;
  applyUpgrade(players[0].tank, card.id, taken);
  // 补给增量卡当场生效：场上道具上限立刻抬高，不必等下一波 beginWave
  spawner.cap = fieldCapOf(players[0].tank.mods);
  draft.open = false;
  draft.offers = [];
  draft.hover = -1;
  playSfx("pickup"); // 借道具拾取的上行双音（语义就是「拿到了东西」）；
                     // matchWin 的琶音留给破纪录，别在这里把它用廉价了
  waveGapTimer = WAVE.gap;
}

// 波次结算：无自动倒计时（照 LEVEL_OVER 范式）。R/按钮重来，Esc/按钮回菜单。
function updateWaveOver(dt) {
  updateEffects(dt); // 终局爆炸播完

  let choice = null;
  if (isJustPressed("KeyR")) choice = "retry";
  else if (isJustPressed("Escape")) choice = "menu";
  else if (isClicked()) {
    const c = getClickPos();
    choice = waveOverAction(c.x, c.y);
    if (choice) playSfx("uiClick");
  }

  if (choice === "retry") setupRound("wave");
  else if (choice === "menu") state = STATE.MENU;
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
      renderMenu(ctx, { mouse: getMousePos(), showHelp });
      // 浮层叠加顺序与 updateMenu 分流顺序相反：后画的在上（rebind 最顶）
      if (settingsPanel.open) {
        renderSettingsOverlay(ctx, {
          mouse: getMousePos(),
          aiLevel,
          enabledPowerups,
          wallBreakEnabled,
          muted: isMuted(),
          stats: (() => {
            const p1 = getStats().players[0];
            return {
              kills: Object.values(p1.kills).reduce((a, b) => a + b, 0),
              accuracy: accuracy(p1),
              favorite: favoriteWeapon(p1),
              bestStreak: getStats().bestStreak,
            };
          })(),
        });
      }
      if (levelSelect.open) {
        renderLevelSelectOverlay(ctx, { mouse: getMousePos(), progress: challengeProgress });
      }
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
      // 开场倒计时大数字 / GO 余像（叠在场地上，HUD 之上）
      if (introTimer > 0) renderCountdown(ctx, Math.ceil(introTimer / ROUND_INTRO.beat));
      else if (goTimer > 0) renderCountdown(ctx, 0); // 0 = "GO!"
      // 波间抽卡浮层（最顶层，且此时物理已冻结——见 updatePlaying 的 0) 门）
      if (draft.open) {
        renderDraftOverlay(ctx, {
          offers: draft.offers,
          taken,
          wave: waveNo,
          hover: draft.hover,
          mouse: getMousePos(),
        });
      }
      break;
    case STATE.PAUSED:
      renderArena();
      renderPauseOverlay(ctx, getMousePos());
      break;
    case STATE.ROUND_OVER:
      renderArena();
      renderRoundOverBanner(ctx, { winner, secondsLeft: roundOverTimer });
      break;
    case STATE.MATCH_OVER:
      renderArena();
      renderMatchOverBanner(ctx, {
        winner, matchScores, players, mouse: getMousePos(),
        // 本场命中率（对基线做差；无基线或没开过火显示跳过）。
        // 算式与钳位都收在 stats.accuracyDelta 一处——原先这里是内联的一份，
        // 与 stats.accuracy 的钳位不同步，于是同一个游戏里「终身 ≤100%」而
        // 「本场 200%」。地雷口径见 stats.js 头部。
        matchAccuracy: matchStatsBase
          ? getStats().players.map((p, i) => accuracyDelta(p, matchStatsBase[i]))
          : [null, null],
      });
      break;
    case STATE.LEVEL_OVER:
      renderArena();
      renderLevelOverBanner(ctx, {
        win: levelOutcome === "win",
        level: LEVELS[currentLevelIndex],
        hasNext: levelOutcome === "win" && currentLevelIndex + 1 < LEVEL_COUNT,
        mouse: getMousePos(),
      });
      break;
    case STATE.WAVE_OVER:
      renderArena();
      renderWaveOverBanner(ctx, {
        wave: waveNo, kills: waveKills, best: waveBest,
        // newRecord 单独一条不够：waveBest 此刻已经被本次成绩覆盖了，横幅无从
        // 分辨「破了旧记录」与「这是第一把、本来就没有记录」，见 updateWaveFlow
        newRecord: waveNewRecord, hadRecord: waveHadRecord, mouse: getMousePos(),
      });
      break;
  }

  // 提示条画在**最后、switch 之外**：它要跨状态活着。
  // 最该被看见的那条（跳弹自杀）在死亡那一刻触发，而死亡紧接着就是
  // ROUND_OVER / LEVEL_OVER / WAVE_OVER——只在 PLAYING 里画它就等于永远看不见。
  // 排除 MENU（提示是对局内容）与 PAUSED（整屏遮罩，底下什么都不该露）——
  // 判据与计时共用 hintsVisible()，**不许在这里再写一份状态比较**。
  if (hintNow && hintsVisible()) {
    renderHintToast(ctx, hintText(hintNow));
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

  // 内墙：按剩余耐久渐淡（满血实线 → 残血 0.35，快碎的墙一眼可见）
  ctx.strokeStyle = WALL.color;
  ctx.lineWidth = WALL.thickness;
  ctx.lineCap = "round";
  for (const w of maze.walls) {
    ctx.globalAlpha = w.border || w.hp === undefined ? 1 : 0.35 + 0.65 * Math.max(0, w.hp) / WALL.hp;
    ctx.beginPath();
    ctx.moveTo(w.x1, w.y1);
    ctx.lineTo(w.x2, w.y2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 外框：沿竞技场四周叠一条更粗的边，框住整个场地（贴近原版醒目灰框）。
  // 外圈本就有物理墙（子弹靠它反弹），这里只是渲染层加粗，不改碰撞。
  ctx.strokeStyle = THEME.arenaBorder;
  ctx.lineWidth = WALL.borderThickness;
  ctx.lineJoin = "round";
  ctx.strokeRect(0, 0, arenaW, arenaH);

  // 守点区域（阶段 27）：**地面标记层**——墙之上、道具之下，于是子弹/坦克/道具/
  // 特效全部盖在它上面。圈是地形语义（告诉你该站哪），要是它盖住战况就本末倒置了。
  // 传竞技场尺寸做裁剪：圈半径 0.95 格 > 半格，贴边的圈会溢出场外（见 zone.js）
  if (holdZone) holdZone.render(ctx, arenaW, arenaH);
  // 道具在地上（墙之上、子弹/坦克之下，坦克碾过去盖住它）
  for (const pw of powerups) pw.render(ctx);
  // 地雷贴地（道具之上、子弹之下；坦克开过顶时盖住雷，贴近"碾在脚下"）
  for (const m of mines) m.render(ctx);
  // 激光预瞄虚线（贴地层）：持激光的活坦克炮口路径预览，随转向实时变化
  for (const p of players) {
    if (p.alive && p.tank.laserShots > 0) renderLaserPreview(ctx, p.tank, maze.walls);
  }
  // 子弹在坦克下层
  for (const b of bullets) b.render(ctx);
  for (const p of players) p.tank.render(ctx);
  // 波次生存：敌方坦克头顶画小号武器图标（阶段 25 词条层的可读性配套）。
  // **这是故意引入的信息不对称**：pvp/pve 里看不到对手的改装槽，别当 bug 修回去。
  // 理由是波次生存的 1v3 里敌人装备是每辆车独立抽的，同屏 3 辆哪辆是激光兵必须
  // 一眼看出来，否则等于随机死亡。只画武器不画护盾——护盾环是坦克自身渲染就有的
  // 既有暴露信号，再画一遍是纯冗余。
  if (currentMode === "wave") {
    for (let i = 1; i < players.length; i++) {
      const t = players[i].tank;
      if (!players[i].alive) continue;
      const type = t.laserShots > 0 ? "laser" : t.scatterShots > 0 ? "scatter" : t.mineCharges > 0 ? "mine" : null;
      if (type) drawPowerupIcon(ctx, type, t.x, t.y - TANK.radius - 11, 7);
    }
  }
  // 特效最上层（爆炸烟团盖住尸体位置）
  for (const e of effects) e.render(ctx);

  ctx.restore();

  renderHud(ctx, {
    players, matchScores, isPlaying: state === STATE.PLAYING,
    // 关卡模式右侧改聚合显示（第 N 关/剩余敌人/限时），不走双人比分布局
    challenge: currentMode === "challenge" ? {
      levelId: LEVELS[currentLevelIndex].id,
      enemiesAlive: players.filter((p, i) => i > 0 && p.alive).length,
      // 限时/生存关一律显示**剩余**秒数（两者同一个式子——阶段 27 前 levelTimer
      // 一个变量两种语义，这里得靠 objective 字符串二次分流）；歼灭关无 secs → 不显示
      timer: challengeSecs() > 0 ? Math.max(0, challengeSecs() - levelTimer) : null,
    } : null,
    // 波次模式右侧同样走聚合显示（第 N 波/场上敌/本波剩余/击杀），与 challenge 槽同路子
    wave: currentMode === "wave" ? {
      wave: waveNo,
      enemiesAlive: players.length - 1,
      left: waveQuotaLeft,
      kills: waveKills,
      gap: waveGapTimer,
      taken, // 左下角「已获强化」条（renderUpgradeBar 消费）
      // 守点波（阶段 27）：hold 非空 = 这一波换规则了，HUD 要当场说清（进波第一眼
      // 就得知道）。ui 侧凭它切模板——**守点波的 left 是 Infinity，绝不能印**。
      hold: holdZone ? { progress: holdZone.progress, need: holdZone.need, inside: holdZone.inside } : null,
    } : null,
  });
}

requestAnimationFrame(loop);
