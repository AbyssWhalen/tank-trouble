// ============================================================
// arena.mjs — headless AI 对打竞技场（node 直跑，无渲染）
// 用途一：AI 改动的量化验证。CLAUDE.md 验证纪律：AI 调参/行为改动
//         以「同档新旧对打」的胜率对比为准（跨档胜率无参考意义）。
// 用途二：挑战关卡的难度曲线验证（--challenge）——AI 替身代打各关出通关率。
// 用途三：无尽波次生存的曲线验证（--waves）——AI 替身代打，出「活到第几波」分布。
//
// 如实复刻 main.js updatePlaying 的结算顺序（控制→移动→车距分离→
// 道具刷新拾取→地雷引爆→开火/激光结算/布雷→子弹运动→击中判定→胜负），
// 只去掉渲染与特效。改 main.js 的结算逻辑时同步这里（simulate 一处）。
//
// 用法：
//   node scripts/arena.mjs                                # 当前 AI 自打 100 回合(normal)
//   node scripts/arena.mjs --rounds 200 --level hard      # 指定回合数与难度(双方同档)
//   node scripts/arena.mjs --aiB /tmp/ai-old.mjs          # B 侧挂旧版 AI 模块做新旧对比
//   node scripts/arena.mjs --powerups laser,shield        # 限定道具池（none=无道具）
//   node scripts/arena.mjs --wallbreak off                # 关掉地形破坏（默认开）
//   node scripts/arena.mjs --challenge                    # 挑战关卡全关跑分（每关 30 次）
//   node scripts/arena.mjs --challenge 8 --tries 50       # 只跑第 8 关，50 次
//   node scripts/arena.mjs --challenge --proxy hard       # 换玩家位替身档位（默认 normal）
//   node scripts/arena.mjs --waves --tries 30             # 波次生存代打 30 次，出到达波次分布
//   node scripts/arena.mjs --waves --startwave 8          # 空降第 8 波起跑（量单波致死率）
//   node scripts/arena.mjs --waves --maxwave 40           # 抬高波次封顶（默认 30，防替身活太久）
//   node scripts/arena.mjs --waves --wavegap 1.5          # 波间喘息（默认 0，见 WAVE_GAP 注释）
//   node scripts/arena.mjs --waves --draft off            # 关掉波间抽卡（阶段 24 行为，控制组）
//   node scripts/arena.mjs --waves --draft first          # 抽卡永远拿第 1 张（对卡池均匀采样）
//   node scripts/arena.mjs --waves --elite off            # 关掉敌人词条（单层隔离实验）
//   node scripts/arena.mjs --waves --startwave 16 --pregrant 15  # 空降并预发 15 张卡
// 注意：挂仓库外的 AI 模块副本时，其相对 import 需先改写为绝对 file:// 路径
// （git show 旧版本后用 sed 替换，见 CLAUDE.md）。
// ============================================================

// 注：开场倒计时/击杀慢动作/战绩统计为表现层（main.js），arena 不复刻。
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { generateMaze, destroyWallsInRadius, destroyWallSegments } from "../src/maze.js";
import { Tank } from "../src/tank.js";
import { PowerupSpawner, Powerup } from "../src/powerup.js";
import { castLaserPath } from "../src/laser.js";
import {
  circleVsCircle, separateCircles, resolveCircleWalls, closestPointOnSegment,
} from "../src/collision.js";
import {
  CELL_SIZE, TANK, BULLET, POWERUP, MAZE_TIERS, TIER_POOL_BY_MODE, STYLE_POOL_BY_MODE, WAVE, HOLD,
  UPGRADE,
} from "../src/config.js";
import { LEVELS, evaluateObjective, objectiveOf } from "../src/levels.js";
import { evaluate } from "../src/objectives.js";
import {
  waveSpec, pickEnemyLevel, shouldRemap, pickSpawnSpot, eliteSpec, applyElite, countArmedLasers,
  waveObjective, holdNeed, chapterOf,
} from "../src/waves.js";
import { pickZoneSpot, HoldZone } from "../src/zone.js";
// 只借 ai.js 那条**纯栅格最短路**给 --holdseek 的寻点层用（AiController 仍走
// loadAi 动态导入，以便 --aiA/--aiB 挂旧版模块）。findPath 不含任何 AI 决策，
// 目标格由调用方给，所以这里静态导入当前版不会污染新旧对比。
import { findPath } from "../src/ai.js";
import {
  pickOffers, applyUpgrade, fieldCapOf, supplyCountOf, UPGRADES,
} from "../src/upgrades.js";

// —— 参数解析（--key value 形式，全部可选；后面没跟值的当开关 true）——
const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const next = argv[i + 1];
  // 光秃秃的旗标（--challenge）与「下一个也是旗标」都记 true，
  // 否则 `--challenge --tries 50` 会把 "--tries" 当成关卡号
  opt[argv[i].slice(2)] = next === undefined || next.startsWith("--") ? true : next;
}
const ROUNDS = Number(opt.rounds ?? 100);
const LEVEL_A = opt.levelA ?? opt.level ?? "normal";
const LEVEL_B = opt.levelB ?? opt.level ?? "normal";
const TIMEOUT = Number(opt.timeout ?? 90); // 单回合模拟时长上限（秒），到点判超时
const TYPES = opt.powerups === "none" ? []
  : (opt.powerups ? String(opt.powerups).split(",") : [...POWERUP.types]);
// 地图风格：--style sparse|symmetric|rooms|all（all=每回合从 pve 池随机，同实机）
const STYLE = opt.style ?? "sparse";
// 地形破坏（子弹磨墙 + 地雷炸墙）：默认开，与阶段 18 之后的调参基准一致；
// 关掉可对比「破墙对 AI 行为的影响」。关卡模式无视此项，按关卡表 wallBreak。
const ERODE = opt.wallbreak !== "off";
// 挑战关卡跑分：true=全关 / "5"=只跑第 5 关（1-based，同关卡 id）
const CHALLENGE = opt.challenge ?? null;
// 波次生存跑分（--waves）：AI 替身代打，看能活到第几波
const WAVES = opt.waves ?? null;
const MAXWAVE = Number(opt.maxwave ?? 30); // 波次封顶：替身活太久就收，别把跑分变成挂机
const CHAPTER_SECS = Number(opt.chaptersecs ?? 60); // 每波给的模拟秒数预算（一章 ×remapEvery）
// 起始波号（默认 1 = 从头打）。>1 时是「空降第 N 波」——一条命的模式里
// 无条件分布会被逐场胜率的几何衰减吃干（替身对同档 AI 约 5 成，打到第 5 波要连赢
// 十几场），所以单波致死率得靠空降采样才量得出来。
const STARTWAVE = Math.max(1, Number(opt.startwave ?? 1));
// 波间喘息（秒）。**arena 默认压到 0，与实机的 WAVE.gap 有意不同**：ai.js 在
// 场上没有活敌时直接 return idle（见 ai.js 的「没有则待机」），替身于是在空场
// 里一动不动，被自己刚打出去还在跳的子弹打死——实测 20 次里 16 次死在清完第
// 1 波之后的那 1.5s（杀 1 / 3s，场上零敌）。人类玩家在喘息里照样会躲，这纯粹
// 是替身的行为缺陷，不是波次曲线的难度。压到 0 让替身全程有目标；
// --wavegap 1.5 可复现该伪影量级。
const WAVE_GAP = Number(opt.wavegap ?? 0);
const TRIES = Number(opt.tries ?? 30);      // 每关代打次数
const PROXY = opt.proxy ?? "normal";        // 玩家位 AI 替身的难度档

// —— 阶段 25 的两层成长（只对 --waves 生效）——
// 两层都必须进跑分，否则跑的是一个不存在的游戏。可分别关掉做单层隔离实验。
const ELITE = opt.elite !== "off";          // 敌人词条
// 抽卡策略：off=不抽（阶段 24 行为，控制组）/ first=永远拿第 1 张（对卡池均匀
// 采样，量「平均一张卡值多少」）/ priority=按下面的静态排序挑最优（量上界）
const DRAFT = opt.draft ?? "priority";
// 空降时预发几张卡（默认对齐空降波号）。**这不是可选糖**：敌人词条第 6 波才起、
// 连续倍率第 11 波才爬，而替身从第 1 波跑中位只到第 2~3 波，根本活不到两层生效
// 的波段。所以主实验必须空降，而空降的玩家若身上没有本该攒下的卡，测的就是一个
// 不存在的局面。
const PREGRANT = Math.max(0, Number(opt.pregrant ?? STARTWAVE - 1));

// —— 阶段 27 的守点波（只对 --waves 生效）——
// `--hold off` 关掉守点波（第 5/10/… 波退回普通清场波）。**这个开关是控制组的命根**：
// 不留它，阶段 26 那条基线（`12.8/7.1/8.6/7.4/6.2/5.9/4.8/3.9`s）在守点波上线后
// 就永久失去了可比对象。照 `--draft off` / `--elite off` 的先例。
const HOLD_ON = opt.hold !== "off";
// `--holdseek on` 给玩家位替身加一层**harness 层**的粗糙寻点：不在圈里就朝圈心走。
// **绝不进 ai.js**——ai.js 只认「锁敌决斗」，让它长出区域概念是给一个玩家侧规则
// 造 AI 能力，代价是永久多一条要维护的行为分支。默认 off，因为它会污染普通波的
// 基线读数（普通波压根没有圈，但这条策略的存在会让人误以为读数可比）。
//
// **偏差声明（与第 4 关虚高、第 5 关偏低同一类失效）**：这个替身**不会边守边躲弹**
// ——它在圈内时用的是 ai.js 的躲弹，可一出圈就被强行拉回来，等于自愿踩线。
// 所以守点波的**通过率 arena 量不出来**，`holdCleared/holdWaves` 绝不可当人类通过率。
// 可用的只有相对量：同参数下「中位守点进度秒数」随波次单调不增，以及改
// needBase/needStep 前后的位移。
const HOLDSEEK = opt.holdseek === "on";
// priority 策略的排序表：越前越优先。按「对 AI 替身有用」排的，**不等于对人类有用**——
// ricochet 排第一是因为替身死于自己跳弹的比例极高（见 WAVE_GAP 注释里的伪影），
// 人类玩家远没那么频繁自杀；laserUp/mineUp 垫底是因为互搏中激光/地雷死因恒为 0。
const DRAFT_PRIORITY = [
  "ricochet", "ammo", "speed", "turn", "shieldUp", "supply",
  "scatterUp", "salvage", "drill", "laserUp", "mineUp",
];

// AI 模块可替换（新旧对比的关键）：默认双方都用当前仓库版
async function loadAi(p) {
  if (!p) return (await import("../src/ai.js")).AiController;
  return (await import(pathToFileURL(resolve(p)).href)).AiController;
}
const AiA = await loadAi(opt.aiA);
const AiB = await loadAi(opt.aiB);

// —— 参与者：AI 控制器只要求 { tank, alive }，不碰 Player 的渲染字段 ——
const mkActor = (side, c) => ({
  side, tank: new Tank(c.x, c.y, c.a, "#000"),
  get alive() { return this.tank.alive; },
});

// 四角出生位（与 main.setupRound 同一套换算：tl 恒给玩家，敌人取其余三角）
function corners(cols, rows) {
  const half = CELL_SIZE / 2;
  return {
    tl: { x: half, y: half, a: 0 },
    tr: { x: (cols - 1) * CELL_SIZE + half, y: half, a: Math.PI },
    bl: { x: half, y: (rows - 1) * CELL_SIZE + half, a: 0 },
    br: { x: (cols - 1) * CELL_SIZE + half, y: (rows - 1) * CELL_SIZE + half, a: Math.PI },
  };
}

// 通用 headless 模拟核心：逐帧推进到 verdict 收场或超时。竞技场对打与关卡
// 跑分共用这一份——两份结算副本必然各自跑偏，改 main 的结算只需同步这里。
//   actors  [{ side, tank, alive, ctrl }]，参与者数量不限（关卡有 1v2）。
//           onFrame 里可原地增删（波次投放/出列），不可重新赋值。
//   erode   地形破坏开关（子弹磨墙 + 地雷炸墙，对应 main.wallBreakActive）
//   onFrame 每帧钩子 (dt, { spawner, powerups, bullets, mines })，在胜负判定之前调用
//   verdict () => 收场值 | null，返回非 null 即结束本局
// 注：开场倒计时/击杀慢动作/战绩统计是表现层（main.js），不复刻。倒计时在
//     main 里 return 得早、关卡计时不在其内推进，跳过它不改变任何判定。
function simulate({ maze, actors, types, erode, timeout, onFrame, verdict }) {
  let bullets = [];
  let powerups = [];
  let mines = [];
  const spawner = new PowerupSpawner(types);
  const deathCause = []; // { side, cause: "bullet"|"laser"|"mine" }

  const kill = (tank, cause) => {
    if (tank.shield) {
      tank.shield = false;
      tank.shieldTimer = 0;
    } else {
      tank.alive = false;
      const p = actors.find((pl) => pl.tank === tank);
      deathCause.push({ side: p.side, cause });
    }
  };

  // 激光结算：与 main.fireLaser 同判定（沿路径最早命中即截断，护盾可挡）
  const fireLaser = (origin) => {
    const pts = castLaserPath(origin.x, origin.y, origin.angle, maze.walls);
    for (let i = 0; i < pts.length - 1; i++) {
      let hit = null;
      const a = pts[i], b = pts[i + 1];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      for (const p of actors) {
        if (!p.alive) continue;
        const cp = closestPointOnSegment(p.tank.x, p.tank.y, a.x, a.y, b.x, b.y);
        if (Math.hypot(p.tank.x - cp.x, p.tank.y - cp.y) > TANK.radius) continue;
        const t = Math.hypot(cp.x - a.x, cp.y - a.y) / segLen;
        if (!hit || t < hit.t) hit = { p, t };
      }
      if (hit) {
        kill(hit.p.tank, "laser");
        break;
      }
    }
  };

  const dt = 1 / 60;
  // 行为质量指标（阶段 22）：每回合累计位移与卡住脱困触发次数。
  // 按 actor 取（Map）而不是按开局下标——波次模式中途往 actors 里加车、
  // 打死了又出列，定长数组的下标会错位到别人头上。Map 的插入序 = actors 序，
  // 所以 traced() 的输出顺序与改造前一致（且出列的车也留着，统计不丢）。
  const trace = new Map();
  const traceOf = (p) => {
    let tr = trace.get(p);
    if (!tr) {
      tr = { side: p.side, dist: 0, stuck: 0, lastX: p.tank.x, lastY: p.tank.y, prevUnstick: 0 };
      trace.set(p, tr);
    }
    return tr;
  };
  for (const p of actors) traceOf(p); // 开局参与者先落座（零帧收场也有条目）
  const traced = () => [...trace.values()].map((tr) => ({ ...tr }));
  for (let t = 0; t < timeout; t += dt) {
    // 1) 全员控制指令（同一帧世界快照）
    const world = { maze, players: actors, bullets, powerups, mines };
    const controls = actors.map((p) => p.ctrl.update(dt, world));

    // 2) 移动
    for (let i = 0; i < actors.length; i++) {
      actors[i].tank.update(dt, maze.walls, controls[i]);
    }

    // 2.5) 坦克间分离：main 同款两两成对（关卡 1v2 有三辆车，两两都要不重叠）
    const aliveTanks = actors.filter((p) => p.alive).map((p) => p.tank);
    for (let i = 0; i < aliveTanks.length; i++) {
      for (let j = i + 1; j < aliveTanks.length; j++) {
        const a = aliveTanks[i], b = aliveTanks[j];
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

    // 行为采样（分离修正之后，位移才是净值）
    for (const p of actors) {
      const tr = traceOf(p), tk = p.tank;
      tr.dist += Math.hypot(tk.x - tr.lastX, tk.y - tr.lastY);
      tr.lastX = tk.x; tr.lastY = tk.y;
      const u = p.ctrl.unstickTimer ?? 0;
      if (u > 0 && tr.prevUnstick <= 0) tr.stuck++;
      tr.prevUnstick = u;
    }

    // 2.7) 道具刷新 + 拾取
    spawner.update(dt, maze, powerups, aliveTanks);
    for (const p of actors) {
      if (!p.alive) continue;
      for (const pw of powerups) {
        if (pw.taken) continue;
        if (circleVsCircle(p.tank.x, p.tank.y, TANK.radius, pw.x, pw.y, POWERUP.radius)) {
          p.tank.applyPowerup(pw.type);
          pw.taken = true;
        }
      }
    }
    powerups = powerups.filter((pw) => !pw.taken);

    // 2.8) 地雷
    for (const m of mines) m.update(dt);
    for (const m of mines) {
      if (m.exploded || !m.armed) continue;
      const tripped = actors.some(
        (p) => p.alive && Math.hypot(p.tank.x - m.x, p.tank.y - m.y) < POWERUP.mine.triggerRadius
      );
      if (!tripped) continue;
      m.exploded = true;
      for (const p of actors) {
        if (!p.alive) continue;
        if (Math.hypot(p.tank.x - m.x, p.tank.y - m.y) >= POWERUP.mine.blastRadius) continue;
        kill(p.tank, "mine");
      }
      // 炸墙（与 main 同步：walls/cells 原子删除，受地形开关管）
      if (erode) destroyWallsInRadius(maze, m.x, m.y, POWERUP.mine.wallBlastRadius);
    }
    mines = mines.filter((m) => !m.exploded);

    // 3) 开火 / 激光 / 布雷
    for (let i = 0; i < actors.length; i++) {
      const res = actors[i].tank.tryFire(bullets, controls[i].fire, maze.walls);
      for (const b of res.bullets) bullets.push(b);
      if (res.laser) fireLaser(res.laser);
      const mine = actors[i].tank.tryDeploy(controls[i].special, maze.walls);
      if (mine) mines.push(mine);
    }

    // 4) 子弹运动（含磨墙）+ 5) 击中判定
    for (const b of bullets) b.update(dt, maze.walls, erode);
    if (erode) {
      const crumbled = maze.walls.filter((w) => !w.border && w.hp <= 0);
      if (crumbled.length) destroyWallSegments(maze, crumbled);
    }
    for (const b of bullets) {
      if (b.dead) continue;
      for (const p of actors) {
        if (!p.alive) continue;
        if (!b.canHit(p.tank)) continue;
        if (circleVsCircle(b.x, b.y, BULLET.radius, p.tank.x, p.tank.y, TANK.radius)) {
          b.dead = true;
          kill(p.tank, "bullet");
          break;
        }
      }
    }
    bullets = bullets.filter((b) => !b.dead);
    for (const pw of powerups) pw.update(dt);

    // 6.5) 帧钩子：关卡计时 / 波次调度在胜负判定之前推进（同 main 的第 7 段）。
    //      带上本帧的实体容器——波次要往里塞补给道具、往 actors 里补敌人。
    //      注意 powerups/bullets/mines 在本函数里会被 filter 重新赋值，所以每帧
    //      现取现给；actors 是入参（同一个数组），调用方必须原地增删不能重新赋值。
    if (onFrame) onFrame(dt, { spawner, powerups, bullets, mines });

    // 7) 胜负
    const out = verdict();
    if (out !== null && out !== undefined) {
      return { outcome: out, cause: deathCause, timeout: false, trace: traced() };
    }
  }
  return { outcome: null, cause: deathCause, timeout: true, trace: traced() };
}

// 跑一个竞技场回合。sideAFirst 控制 A 占哪个出生角（逐回合轮换消除位置偏差）。
// 返回 { winner: "A"|"B"|null, cause, timeout, trace }。
function playRound(sideAFirst) {
  const pool = TIER_POOL_BY_MODE.pve;
  const tier = pool[Math.floor(Math.random() * pool.length)];
  const { cols, rows } = MAZE_TIERS[tier];
  const style = STYLE === "all"
    ? STYLE_POOL_BY_MODE.pve[Math.floor(Math.random() * STYLE_POOL_BY_MODE.pve.length)]
    : STYLE;
  const maze = generateMaze(cols, rows, style);
  const c = corners(cols, rows);
  const spots = [c.tl, c.br]; // 1v1 用对角两角（与 pvp/pve 实机一致）
  const actors = [
    mkActor("A", spots[sideAFirst ? 0 : 1]),
    mkActor("B", spots[sideAFirst ? 1 : 0]),
  ];
  actors[0].ctrl = new AiA(actors[0], LEVEL_A);
  actors[1].ctrl = new AiB(actors[1], LEVEL_B);

  const res = simulate({
    maze, actors, types: TYPES, erode: ERODE, timeout: TIMEOUT,
    // pvp/pve 判负条件：存活 ≤1（同 main 的非关卡分支）
    verdict: () => {
      const alive = actors.filter((p) => p.alive);
      if (alive.length > 1) return null;
      return alive.length === 1 ? alive[0].side : "draw";
    },
  });
  return { ...res, winner: res.outcome === "draw" ? null : res.outcome };
}

// 跑一次挑战关卡。与 main.setupRound 的 challenge 分支同构：确定性 tier+style、
// 玩家恒 tl、敌人按表落角位与档位、玩家开局强化、地形按关卡表覆写全局。
// 胜负走 levels.evaluateObjective 而不是「存活≤1」——1v2 下玩家死后 AI 还会
// 互殴，用存活数判定语义就错了（main 里同一个坑）。
// 玩家位挂 AI 替身（--proxy 档位）：它是帧级瞄准、且只锁 world.players 里第一个
// 活着的敌人，所以通关率不等于人类难度，只用于关与关之间的相对比较。
function playLevel(level) {
  const { cols, rows } = MAZE_TIERS[level.map.tier];
  const maze = generateMaze(cols, rows, level.map.style);
  const c = corners(cols, rows);

  const hero = mkActor("P", c.tl);
  const actors = [hero];
  level.enemies.forEach((e, i) => {
    const foe = mkActor("E" + (i + 1), c[e.spawn] || c.br);
    foe.ctrl = new AiB(foe, e.level); // 敌人走 B 侧模块，档位由关卡表指定
    actors.push(foe);
  });
  hero.ctrl = new AiA(hero, PROXY);

  // 玩家开局强化（同 main.setupRound 的 pc 分支）
  const pc = level.player || {};
  if (pc.weapon === "laser") hero.tank.laserShots = pc.shots ?? 1;
  else if (pc.weapon === "scatter") hero.tank.scatterShots = pc.shots ?? 3;
  else if (pc.weapon === "mine") hero.tank.mineCharges = pc.shots ?? 2;
  if (pc.shield) hero.tank.applyPowerup("shield");

  // 关卡计时：纯粹的「本关已过秒数」，单调递增（同 main）——限时/生存的秒数
  // 上限比较在 objectives.js 里做，这里不按目标类型分流
  let elapsed = 0;
  const budget = objectiveOf(level).secs ?? 0;
  return simulate({
    maze, actors, types: [...level.powerups], erode: !!level.wallBreak,
    // 限时/生存关到点由 verdict 自然收场，TIMEOUT 只是歼灭关的兜底上限
    timeout: budget + TIMEOUT,
    onFrame: (dt) => { elapsed += dt; },
    verdict: () => evaluateObjective(level, {
      playerAlive: hero.alive,
      enemiesAlive: actors.filter((a, i) => i > 0 && a.alive).length,
      elapsed,
    }),
  });
}

// —— 无尽波次生存跑分（--waves）——
// 波次换图的风格：默认随机（同实机 pickStyle("wave")），--style 显式指定则锁定
function waveStyle() {
  if (opt.style && opt.style !== "all") return String(opt.style);
  const pool = STYLE_POOL_BY_MODE.wave;
  return pool[Math.floor(Math.random() * pool.length)];
}

// 跑一次波次生存，与 main 的波次调度同构（曲线全在 waves.js，两边共用纯函数）。
// 章节换图的处理方式：**一章一次 simulate**。simulate 的 maze 是入参不可中途换，
// 所以换图 = verdict 返回 "remap" 收场 → 建新图 → 带着同一个坦克对象重新进
// simulate（对齐 main.remapWaveArena「保留玩家坦克，武器槽与护盾不被换图没收」）。
// 不另写一份结算副本——结算顺序只有 simulate 这一处。
// 返回 { wave, kills, outcome, elapsed, stuck, mix, cause, taken, holdWaves, holdCleared, holdBest }。
function playWaves() {
  let waveNo = 0, kills = 0, quotaLeft = 0, gapTimer = 0, elapsed = 0, stuck = 0;
  let inGap = false;      // 本波已清空，正在喘息（与 gapTimer 分开：gap 可为 0）
  let pendingEnter = STARTWAVE; // 待进入的波号（首波 / 换图后第一波）——onFrame 里消费
  let remapTo = null;     // 非 null = 本次 simulate 该收场换图，换完进这一波
  let capped = false;     // 撞 MAXWAVE 封顶
  const mix = { easy: 0, normal: 0, hard: 0 }; // 实际投放的档位分布（验证 mix 曲线）
  const cause = [];       // 玩家死因（子弹/激光/地雷）
  const taken = new Map();                    // 本 run 已抽的卡（id → 层数）
  // 本波过波条件（同 main 的 waveGoal）：判定走 objectives.evaluate 那一份，
  // 别在这里内联「配额清零 && 场上零敌」——两份结算副本必然跑偏
  let waveGoal = { type: "clearQuota" };
  let zone = null;        // 守点区域实体（同 main 的 holdZone；普通波恒 null）
  // 守点读数（见 HOLDSEEK 的偏差声明：只读相对量，不当通过率）
  let holdWaves = 0, holdCleared = 0, holdBest = 0;
  let seekStuck = 0;      // --holdseek 的撞墙计时：卡住就交还控制权一段时间
  // 抽卡池的 requires 上下文：与实机同源（玩家启用的道具类型 + 地形开关）
  const draftCtx = { types: new Set(TYPES), wallBreak: ERODE };

  let tier = waveSpec(STARTWAVE).tier;
  let dims = MAZE_TIERS[tier];
  let maze = generateMaze(dims.cols, dims.rows, waveStyle());
  const hero = mkActor("P", corners(dims.cols, dims.rows).tl);

  // --holdseek 的寻点层：**包在控制器外面**，不动 ai.js 的任何决策。不在圈内时把
  // {turn, move} 改成「朝下一个路点转 + 前进」，fire/special 始终交还 ai.js（开火
  // 决策与区域无关）。**在圈内时完全放手**——那时躲弹归 ai.js，替身才有一点点像人。
  //
  // 走 ai.js 的 `findPath`（纯栅格 BFS，目标格由这里给）而**不是**朝圈心直线冲：
  // 直线版实测在第 5 波跑出「中位守点进度 1.2s / 40 次 0 次守满」——替身压根走不到
  // 圈里，读数量的是「撞墙」而不是「守点」，这把仪器没有分辨率。改 BFS 后才开始
  // 量到东西。**这不是让替身变强**，它照旧不会边守边躲（偏差声明见文件头）。
  // 撞墙卡住 0.8s 仍交还控制权 1.2s，免得贴墙抖到本波结束。
  const wrapSeek = (inner) => {
    if (!HOLDSEEK) return inner;
    let lastX = hero.tank.x, lastY = hero.tank.y, yieldT = 0, replan = 0, path = [];
    const cellAt = (x, y) => ({ c: Math.floor(x / CELL_SIZE), r: Math.floor(y / CELL_SIZE) });
    return {
      get unstickTimer() { return inner.unstickTimer; },   // simulate 的卡住采样读它
      update(dt, world) {
        const c = inner.update(dt, world);
        const moved = Math.hypot(hero.tank.x - lastX, hero.tank.y - lastY);
        lastX = hero.tank.x; lastY = hero.tank.y;
        if (!zone || zone.done) return c;
        if (yieldT > 0) { yieldT -= dt; return c; }
        if (zone.contains(hero.tank.x, hero.tank.y)) { seekStuck = 0; path = []; return c; }
        seekStuck = moved < TANK.speed * dt * 0.35 ? seekStuck + dt : 0;
        if (seekStuck > 0.8) { seekStuck = 0; yieldT = 1.2; path = []; return c; }
        // 路点：BFS 下一格心；同格/不可达就退化成朝圈心直线（圈心一定在本格里）
        const from = cellAt(hero.tank.x, hero.tank.y);
        replan -= dt;
        if (replan <= 0 || !path.length) {
          path = findPath(maze, from, cellAt(zone.x, zone.y));
          replan = 0.4;   // 敌人在动、路会被雷/破洞改写，定期重算
        }
        while (path.length && path[0].c === from.c && path[0].r === from.r) path.shift();
        const tx = path.length ? (path[0].c + 0.5) * CELL_SIZE : zone.x;
        const ty = path.length ? (path[0].r + 0.5) * CELL_SIZE : zone.y;
        let d = Math.atan2(ty - hero.tank.y, tx - hero.tank.x) - hero.tank.angle;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        // 朝向差过大时先转再走（倒着冲会把车推离目标）
        return { ...c, turn: Math.abs(d) < 0.06 ? 0 : Math.sign(d), move: Math.abs(d) > 1.4 ? 0 : 1 };
      },
    };
  };
  hero.ctrl = wrapSeek(new AiA(hero, PROXY));
  const actors = [hero];  // 全程同一个数组：onFrame 原地增删，simulate 看得见

  // 抽一张卡（同 main 的清波抽卡）。返回卡 id，没抽（策略 off / 无可抽卡）返回 null。
  const draftOnce = () => {
    if (DRAFT === "off") return null;
    const offers = pickOffers(taken, draftCtx);
    if (!offers.length) return null;
    // first：拿第 1 张（pickOffers 已随机洗过，等价于对可抽池均匀采样）
    // priority：按静态排序表挑最优（量「会抽卡的玩家」的上界）
    const card = DRAFT === "priority"
      ? offers.slice().sort((a, b) => DRAFT_PRIORITY.indexOf(a.id) - DRAFT_PRIORITY.indexOf(b.id))[0]
      : offers[0];
    applyUpgrade(hero.tank, card.id, taken);
    return card.id;
  };
  // 空降预发：把本该在第 1..N-1 波攒下的卡先发掉（见 PREGRANT 注释）
  for (let i = 0; i < PREGRANT; i++) if (!draftOnce()) break;

  // 进入第 n 波：置配额 + 开波强制补给（同 main.beginWave，换图那半边在驱动循环里）
  const enterWave = (n, ctx) => {
    waveNo = n;
    // 守点波（阶段 27，同 main.beginWave）：配额 = Infinity（压力不停），
    // 过波只看守点进度。`--hold off` 退回普通清场波做控制组。
    waveGoal = HOLD_ON ? waveObjective(n) : { type: "clearQuota" };
    quotaLeft = waveGoal.type === "hold" ? Infinity : waveSpec(n).quota;
    if (waveGoal.type === "hold") {
      const spot = pickZoneSpot(maze, hero.tank);
      zone = spot ? new HoldZone(spot.x, spot.y, waveGoal.secs) : null;
      holdWaves++;
    } else {
      zone = null;   // 普通波必须清，否则上一波的圈留在图上
    }
    inGap = false;
    gapTimer = 0;
    seekStuck = 0;
    // 场上道具上限跟着 supply 卡走。**必须每波重设**：simulate 一章新建一次
    // spawner，只在开局设一次的话每次换图都退回默认 cap（那 supply 卡就半张空卡）
    ctx.spawner.cap = fieldCapOf(hero.tank.mods);
    const tanks = actors.filter((a) => a.alive).map((a) => a.tank);
    const supply = supplyCountOf(waveSpec(n), hero.tank.mods);
    for (let i = 0; i < supply; i++) ctx.spawner.forceSpawn(maze, ctx.powerups, tanks);
  };

  const onFrame = (dt, ctx) => {
    elapsed += dt;
    if (pendingEnter) { enterWave(pendingEnter, ctx); pendingEnter = null; }
    // 守点进度（同 main：挂在胜负判定之前，同帧守满同帧过波）。
    // 死了不再计账（HoldZone.update 自己认 tank.alive），收场交给 verdict。
    if (zone) {
      zone.update(dt, hero.tank);
      if (zone.progress > holdBest) holdBest = zone.progress;
    }
    if (!hero.alive) return; // 收场交给 verdict，别再调度

    // 死敌当帧出列（同 main 段 6.5）：enemiesAlive 才是精确值，颜色/编号也回收
    for (let i = actors.length - 1; i >= 1; i--) {
      if (!actors[i].alive) {
        // 战场回收：按 mods.salvage 概率在尸体位置掉一个道具（同 main.hitPlayer）。
        // 绕开 spawner 的 cap（它是刷新器的节流阀，不是事件掉落的闸门），
        // 但留一道软顶，免得后期 12 个配额把地上铺满。
        const m = hero.tank.mods;
        if (m.salvage > 0 && TYPES.length
            && ctx.powerups.length < fieldCapOf(m) + UPGRADE.salvageSlack
            && Math.random() < m.salvage) {
          const t = actors[i].tank;
          ctx.powerups.push(new Powerup(t.x, t.y, TYPES[Math.floor(Math.random() * TYPES.length)]));
        }
        actors.splice(i, 1);
        kills++;
      }
    }

    const enemiesAlive = actors.length - 1;
    if (inGap) {
      gapTimer -= dt;
      if (gapTimer <= 0) {
        inGap = false;
        const next = waveNo + 1;
        if (next > MAXWAVE) capped = true;
        else if (shouldRemap(next)) remapTo = next; // 收场换图，新图上再 enterWave
        else enterWave(next, ctx);
      }
      return;
    }
    if (evaluate(waveGoal, {
      playerAlive: hero.alive, enemiesAlive, quotaLeft,
      holdSecs: zone ? zone.progress : 0,
    }) === "win") {
      if (waveGoal.type === "hold") holdCleared++;
      // 过波即清场（同 main：守点波可能在场上还有 3 辆时达成，残敌不清就会打破
      // 「喘息/换图都在空场边界」这条两边都依赖的不变量）。不计 kills。
      for (const a of actors.slice(1)) a.tank.alive = false;   // actor.alive 是只读投影
      actors.length = 1;
      draftOnce();            // 清波抽卡（同 main：抽完才进喘息）
      inGap = true;
      gapTimer = WAVE_GAP;
      return;
    }

    // 场上不满同屏上限且配额有余 → 补一辆（一帧只补一辆，同 main）
    const spec = waveSpec(waveNo);
    if (enemiesAlive >= spec.concurrent || quotaLeft <= 0) return;
    const spot = pickSpawnSpot(maze, hero.tank, actors.filter((a) => a.alive).map((a) => a.tank));
    if (!spot) return; // 图太挤：下帧再试
    const level = pickEnemyLevel(spec.mix);
    const foe = mkActor("E", {
      x: spot.x, y: spot.y,
      a: Math.atan2(hero.tank.y - spot.y, hero.tank.x - spot.x), // 出生朝玩家
    });
    foe.ctrl = new AiB(foe, level);
    // 敌人词条（同 main.spawnWaveEnemy）：激光按同屏配额发，先数场上还有几把上膛的
    if (ELITE) {
      const armed = countArmedLasers(actors.filter((a) => a !== hero && a.alive).map((a) => a.tank));
      applyElite(foe.tank, eliteSpec(waveNo, level, armed));
    }
    actors.push(foe);
    quotaLeft--;
    mix[level]++;
  };

  const verdict = () => {
    if (!hero.alive) return "dead";
    if (capped) return "cap";
    if (remapTo !== null) return "remap";
    return null;
  };

  // 本章（下一次 simulate 覆盖的那几波）里守点波要吃掉的秒数预算。
  // **必须加**：守点波站着耗 needSecs，而统计里「超时」与「守不住」长得一模一样，
  // 不放宽就会把守点波的存在记成 tally.timeout 上涨。放 3 倍需求是留出走位/交战。
  const chapterHoldSlack = () => {
    if (!HOLD_ON) return 0;
    const start = pendingEnter ?? waveNo;
    let s = 0;
    for (let n = start; n <= MAXWAVE && chapterOf(n) === chapterOf(start); n++) s += holdNeed(n) * 3;
    return s;
  };

  // 一章一次 simulate：收场值为 "remap" 就换图续跑，其余（死/封顶/超时）收工
  for (;;) {
    const res = simulate({
      maze, actors, types: TYPES, erode: ERODE,
      // 一章 5 波、后期同屏 3 辆，90s 远不够——按章给预算（撞上就记超时）
      timeout: WAVE.remapEvery * CHAPTER_SECS + chapterHoldSlack(),
      onFrame, verdict,
    });
    for (const tr of res.trace || []) if (tr.side === "P") stuck += tr.stuck;
    for (const c of res.cause) if (c.side === "P") cause.push(c.cause);
    if (res.outcome !== "remap") {
      const outcome = res.timeout ? "timeout" : res.outcome;
      return {
        wave: waveNo, kills, outcome, elapsed, stuck, mix, cause, taken,
        holdWaves, holdCleared, holdBest,
      };
    }

    // 章节换图（同 main.remapWaveArena）：新图 + 玩家挪回 tl + 清场，
    // 但保留玩家坦克本体（武器槽/护盾是上一章打出来的战果）。
    // AI 替身的控制器重建：它缓存的路径路点是旧图的格心，换图后是陈旧数据。
    tier = waveSpec(remapTo).tier;
    dims = MAZE_TIERS[tier];
    maze = generateMaze(dims.cols, dims.rows, waveStyle());
    const tl = corners(dims.cols, dims.rows).tl;
    hero.tank.x = tl.x; hero.tank.y = tl.y; hero.tank.angle = tl.a;
    hero.ctrl = wrapSeek(new AiA(hero, PROXY));
    actors.length = 1;      // 换图在空场边界发生，本就该只剩玩家
    zone = null;            // 圈绑在旧图上（新图可能换档位）——留着就是陈旧坐标
    pendingEnter = remapTo;
    remapTo = null;
  }
}

// —— 挑战关卡跑分（--challenge）：AI 替身代打，出各关通关率曲线 ——
if (CHALLENGE) {
  const pick = CHALLENGE === true ? LEVELS : LEVELS.filter((l) => l.id === Number(CHALLENGE));
  if (!pick.length) {
    console.error(`没有第 ${CHALLENGE} 关（关卡 id 1-${LEVELS.length}）`);
    process.exit(1);
  }
  const tagOf = { eliminate: "歼灭", survive: "生存", eliminateTimed: "限时" };
  console.log(`\n关卡跑分：玩家位 = ${PROXY} 档 AI 替身(${opt.aiA ?? "当前版"})，每关 ${TRIES} 次`);
  const curve = [];
  for (const level of pick) {
    let win = 0, lose = 0, over = 0;
    for (let i = 0; i < TRIES; i++) {
      const res = playLevel(level);
      if (res.outcome === "win") win++;
      else if (res.outcome === "lose") lose++;
      else over++; // 超时未达成（歼灭关打不完）：算没过
    }
    const rate = Math.round((win / TRIES) * 100);
    curve.push(rate);
    console.log(
      `${String(level.id).padStart(2)} ${level.name.padEnd(4, "　")} ${tagOf[level.objective]}`
      + ` 敌×${level.enemies.length}  通关 ${String(win).padStart(3)}`
      + ` 失败 ${String(lose).padStart(3)}  超时 ${String(over).padStart(3)}`
      + `   通关率 ${String(rate).padStart(3)}%`
    );
    process.stderr.write(`.. 第 ${level.id} 关跑完\n`);
  }
  console.log(`曲线: ${curve.join("/")}`);
  console.log("注：替身与人类的偏差是双向的——纯激光关虚高（帧级瞄准 + hitscan 等于");
  console.log("    完美狙击手），多敌关偏低（只锁 world.players 里第一个活敌，被第二");
  console.log("    辆车背刺）。绝对值不等于人类难度，只看关与关之间的相对趋势。");
  process.exit(0);
}

// —— 波次生存跑分（--waves）：AI 替身代打 TRIES 次，出「活到第几波」分布 ——
if (WAVES) {
  console.log(`\n波次跑分：玩家位 = ${PROXY} 档 AI 替身(${opt.aiA ?? "当前版"})，${TRIES} 次，`
    + `第 ${STARTWAVE} 波起跑，封顶第 ${MAXWAVE} 波`);
  console.log(`道具池: ${TYPES.length ? TYPES.join(",") : "无"}　地形破坏: ${ERODE ? "开" : "关"}`
    + `　风格: ${opt.style && opt.style !== "all" ? opt.style : "随机(同实机)"}`);
  console.log(`两层成长：抽卡 ${DRAFT}${DRAFT === "off" ? "" : `（空降预发 ${PREGRANT} 张）`}`
    + `　敌人词条 ${ELITE ? "开" : "关"}`
    + `　—— 两项都 off 即阶段 24 行为（控制组）`);
  console.log(`守点波：${HOLD_ON ? "开" : "关（阶段 26 基线的控制组）"}`
    + `　替身寻点 ${HOLDSEEK ? "on" : "off（替身不会主动进圈，守点波必然打不过）"}`);

  const runs = [];
  const tally = { dead: 0, cap: 0, timeout: 0 };
  const mixAll = { easy: 0, normal: 0, hard: 0 };
  const causeAll = { bullet: 0, laser: 0, mine: 0 };
  for (let i = 0; i < TRIES; i++) {
    const res = playWaves();
    runs.push(res);
    tally[res.outcome] = (tally[res.outcome] ?? 0) + 1;
    for (const k of Object.keys(mixAll)) mixAll[k] += res.mix[k];
    for (const c of res.cause) causeAll[c]++;
    process.stderr.write(`.. ${i + 1}/${TRIES} 第 ${res.wave} 波(${res.outcome}) 杀 ${res.kills} / ${res.elapsed.toFixed(0)}s\n`);
  }

  const waves = runs.map((r) => r.wave).sort((a, b) => a - b);
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const q = (p) => waves[Math.min(waves.length - 1, Math.floor(p * waves.length))];
  console.log(
    `\n到达波次：中位 ${q(0.5)}　平均 ${(sum(waves) / waves.length).toFixed(1)}`
    + `　最低 ${waves[0]}　最高 ${waves[waves.length - 1]}　四分位 ${q(0.25)}/${q(0.75)}`
  );
  console.log(`清波数（到达 − 起跑）：平均 ${(sum(waves.map((w) => w - STARTWAVE)) / waves.length).toFixed(1)}`
    + `　—— 起跑波固定时这个数才是单波致死率的直接读数`);
  console.log(`收场：玩家死 ${tally.dead} / 封顶 ${tally.cap} / 超时 ${tally.timeout}`);
  // 存活时长是**空降跑分的主读数**：`--startwave` 抬到第 6 波以上时替身几乎必死在
  // 起跑波（同屏 ≥2 辆就被背刺，见文末注），「到达波次」于是恒等于起跑波、分辨率归零。
  // 秒数是连续量不会触底，能量出「同一波变难/变易」的方向与幅度。中位与均值都给：
  // 均值被偶发的长命 run 拉偏，中位才是典型局。
  const lives = runs.map((r) => r.elapsed).sort((a, b) => a - b);
  console.log(`击杀：平均 ${(sum(runs.map((r) => r.kills)) / TRIES).toFixed(1)}`
    + `　存活时长：中位 ${lives[Math.floor(lives.length / 2)].toFixed(1)}s`
    + ` 平均 ${(sum(lives) / lives.length).toFixed(1)}s`
    + `　卡住脱困：合计 ${sum(runs.map((r) => r.stuck))} 次`);

  // 到达波次直方图（每一波一行，看曲线在哪一段开始劝退）
  const hist = new Map();
  for (const w of waves) hist.set(w, (hist.get(w) ?? 0) + 1);
  const top = Math.max(...hist.values());
  for (const w of [...hist.keys()].sort((a, b) => a - b)) {
    const n = hist.get(w);
    console.log(`  第 ${String(w).padStart(2)} 波 ${"█".repeat(Math.round((n / top) * 24))} ${n}`);
  }

  const mixTotal = sum(Object.values(mixAll)) || 1;
  console.log(`投放档位：easy ${(mixAll.easy / mixTotal * 100).toFixed(0)}%`
    + ` / normal ${(mixAll.normal / mixTotal * 100).toFixed(0)}%`
    + ` / hard ${(mixAll.hard / mixTotal * 100).toFixed(0)}%（共 ${mixTotal} 辆）`);
  console.log(`玩家死于：子弹 ${causeAll.bullet} / 激光 ${causeAll.laser} / 地雷 ${causeAll.mine}`);

  // 守点波读数（阶段 27）。**单独打印、不靠 timeout 反推**：守点波吃掉的时间会让
  // tally.timeout 上涨，而「超时」与「守不住」在统计里长得一模一样，只看收场分不出来。
  //
  // 主读数是 **holdBest 的中位数**（最深那次的守点进度秒数）——它是连续量、有分辨率，
  // 能量出「同一个守点波变难/变易」的方向与幅度。holdCleared/holdWaves 只作为
  // 「替身有没有在真的尝试」的健康检查，**绝不当人类通过率**（见下方偏差声明）。
  if (HOLD_ON) {
    const met = runs.filter((r) => r.holdWaves > 0);
    const hw = sum(runs.map((r) => r.holdWaves));
    const hc = sum(runs.map((r) => r.holdCleared));
    if (!hw) {
      console.log(`守点波：${TRIES} 次里一次都没走到（起跑第 ${STARTWAVE} 波、封顶第 ${MAXWAVE} 波之间无守点波）`);
    } else {
      const best = met.map((r) => r.holdBest).sort((a, b) => a - b);
      const mid = best[Math.floor(best.length / 2)];
      console.log(`守点波：遇到 ${hw} 个 / 守满 ${hc} 个（${(hc / hw * 100).toFixed(0)}%）`
        + `　守点进度秒数：中位 ${mid.toFixed(1)}s`
        + ` 平均 ${(sum(best) / best.length).toFixed(1)}s`
        + ` 最深 ${best[best.length - 1].toFixed(1)}s`
        + `　需求 ${holdNeed(STARTWAVE >= HOLD.from ? STARTWAVE : HOLD.from).toFixed(1)}s`);
      console.log("  偏差声明：--holdseek 的替身不会边守边躲弹（出圈就被强行拉回来，等于自愿");
      console.log("    踩线），所以**守点波通过率系统性偏低**，与第 4 关虚高、第 5 关偏低同一");
      console.log("    类失效。可用的只有相对量：同参数下这一列随波次单调不增、以及改");
      console.log("    needBase 前后的位移。绝不拿「守满 N 个」当人类通过率。");
      if (!HOLDSEEK) console.log("    （本次 --holdseek off：替身压根不进圈，这一列恒近 0，只用来确认圈没挡路）");
    }
  }

  // 抽卡统计：平均抽到几张 + 各卡被抽走的总层数（验证 requires 过滤与卡池覆盖）
  if (DRAFT !== "off") {
    const layers = new Map(UPGRADES.map((u) => [u.id, 0]));
    let totalLayers = 0;
    for (const r of runs) {
      for (const [id, n] of r.taken) { layers.set(id, (layers.get(id) ?? 0) + n); totalLayers += n; }
    }
    console.log(`抽卡：平均每 run ${(totalLayers / TRIES).toFixed(1)} 张（含预发 ${PREGRANT}）`);
    console.log("  " + UPGRADES.map((u) => `${u.id} ${layers.get(u.id)}`).join(" / "));
  }
  console.log("注：替身不是人类——帧级瞄准偏强、只锁 world.players 里第一个活敌偏弱");
  console.log("    （波次里同屏最多 3 辆，被另外两辆背刺的概率比关卡更高）。绝对波次不");
  console.log("    等于人类水平，改 WAVE 数值后重跑同参数看相对位移。");
  process.exit(0);
}

// —— 竞技场主循环 + 汇总 ——
const stat = { A: 0, B: 0, draw: 0, timeout: 0 };
// 分侧死因（deaths.A.laser = A 死于激光的次数——躲线能力的直接指标）
const deaths = {
  A: { bullet: 0, laser: 0, mine: 0 },
  B: { bullet: 0, laser: 0, mine: 0 },
};
const quality = { A: { stuck: 0 }, B: { stuck: 0 } }; // 行为质量：卡住脱困总次数
for (let r = 0; r < ROUNDS; r++) {
  const res = playRound(r % 2 === 0);
  if (res.timeout) stat.timeout++;
  else if (res.winner) stat[res.winner]++;
  else stat.draw++;
  for (const c of res.cause) deaths[c.side][c.cause]++;
  for (const tr of res.trace || []) quality[tr.side].stuck += tr.stuck;
  if ((r + 1) % 25 === 0) process.stderr.write(`.. ${r + 1}/${ROUNDS}\n`);
}

const pct = (n) => ((n / ROUNDS) * 100).toFixed(1) + "%";
const fmt = (d) => `子弹 ${d.bullet} / 激光 ${d.laser} / 地雷 ${d.mine}`;
console.log(`\nA(${LEVEL_A}, ${opt.aiA ?? "当前版"}) vs B(${LEVEL_B}, ${opt.aiB ?? "当前版"})  共 ${ROUNDS} 回合`);
console.log(`道具池: ${TYPES.length ? TYPES.join(",") : "无"}`);
console.log(`A 胜 ${stat.A} (${pct(stat.A)})   B 胜 ${stat.B} (${pct(stat.B)})   双杀 ${stat.draw}   超时 ${stat.timeout}`);
console.log(`A 死于: ${fmt(deaths.A)}`);
console.log(`B 死于: ${fmt(deaths.B)}`);
console.log(`卡住脱困: A ${quality.A.stuck} 次 / B ${quality.B.stuck} 次（越少越顺滑）`);
