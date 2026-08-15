// ============================================================
// arena.mjs — headless AI 对打竞技场（node 直跑，无渲染）
// 用途一：AI 改动的量化验证。CLAUDE.md 验证纪律：AI 调参/行为改动
//         以「同档新旧对打」的胜率对比为准（跨档胜率无参考意义）。
// 用途二：挑战关卡的难度曲线验证（--challenge）——AI 替身代打各关出通关率。
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
// 注意：挂仓库外的 AI 模块副本时，其相对 import 需先改写为绝对 file:// 路径
// （git show 旧版本后用 sed 替换，见 CLAUDE.md）。
// ============================================================

// 注：开场倒计时/击杀慢动作/战绩统计为表现层（main.js），arena 不复刻。
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { generateMaze, destroyWallsInRadius, destroyWallSegments } from "../src/maze.js";
import { Tank } from "../src/tank.js";
import { PowerupSpawner } from "../src/powerup.js";
import { castLaserPath } from "../src/laser.js";
import {
  circleVsCircle, separateCircles, resolveCircleWalls, closestPointOnSegment,
} from "../src/collision.js";
import {
  CELL_SIZE, TANK, BULLET, POWERUP, MAZE_TIERS, TIER_POOL_BY_MODE, STYLE_POOL_BY_MODE,
} from "../src/config.js";
import { LEVELS, evaluateObjective } from "../src/levels.js";

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
const TRIES = Number(opt.tries ?? 30);      // 每关代打次数
const PROXY = opt.proxy ?? "normal";        // 玩家位 AI 替身的难度档

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
//   actors  [{ side, tank, alive, ctrl }]，参与者数量不限（关卡有 1v2）
//   erode   地形破坏开关（子弹磨墙 + 地雷炸墙，对应 main.wallBreakActive）
//   onFrame 每帧钩子（关卡计时用），在胜负判定之前调用
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
  // 行为质量指标（阶段 22）：每回合累计位移与卡住脱困触发次数
  const trace = actors.map((p) => ({ dist: 0, stuck: 0, lastX: p.tank.x, lastY: p.tank.y, prevUnstick: 0 }));
  const traced = () => actors.map((p, i) => ({ side: p.side, ...trace[i] }));
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
    for (let i = 0; i < actors.length; i++) {
      const tr = trace[i], tk = actors[i].tank;
      tr.dist += Math.hypot(tk.x - tr.lastX, tk.y - tr.lastY);
      tr.lastX = tk.x; tr.lastY = tk.y;
      const u = actors[i].ctrl.unstickTimer ?? 0;
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

    // 6.5) 帧钩子：关卡计时在胜负判定之前推进（同 main 的第 7 段）
    if (onFrame) onFrame(dt);

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

  // 关卡计时：survive 从 0 数上去、eliminateTimed 从上限倒数（同 main）
  let levelTimer = level.objective === "eliminateTimed" ? level.mutators.timeLimit : 0;
  const budget = level.mutators.timeLimit ?? level.mutators.surviveTime ?? 0;
  return simulate({
    maze, actors, types: [...level.powerups], erode: !!level.wallBreak,
    // 限时/生存关到点由 verdict 自然收场，TIMEOUT 只是歼灭关的兜底上限
    timeout: budget + TIMEOUT,
    onFrame: (dt) => {
      if (level.objective === "survive") levelTimer += dt;
      else if (level.objective === "eliminateTimed") levelTimer = Math.max(0, levelTimer - dt);
    },
    verdict: () => evaluateObjective(level, {
      playerAlive: hero.alive,
      enemiesAlive: actors.filter((a, i) => i > 0 && a.alive).length,
      levelTimer,
    }),
  });
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
