// ============================================================
// arena.mjs — headless AI 对打竞技场（node 直跑，无渲染）
// 用途：AI 改动的量化验证。CLAUDE.md 验证纪律：AI 调参/行为改动
// 以「同档新旧对打」的胜率对比为准（跨档胜率无参考意义）。
//
// 如实复刻 main.js updatePlaying 的结算顺序（控制→移动→车距分离→
// 道具刷新拾取→地雷引爆→开火/激光结算/布雷→子弹运动→击中判定→胜负），
// 只去掉渲染与特效。改 main.js 的结算逻辑时同步这里。
//
// 用法：
//   node scripts/arena.mjs                                # 当前 AI 自打 100 回合(normal)
//   node scripts/arena.mjs --rounds 200 --level hard      # 指定回合数与难度(双方同档)
//   node scripts/arena.mjs --aiB /tmp/ai-old.mjs          # B 侧挂旧版 AI 模块做新旧对比
//   node scripts/arena.mjs --powerups laser,shield        # 限定道具池（none=无道具）
// 注意：挂仓库外的 AI 模块副本时，其相对 import 需先改写为绝对 file:// 路径
// （git show 旧版本后用 sed 替换，见 CLAUDE.md）。
// ============================================================

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
  CELL_SIZE, TANK, BULLET, POWERUP, MAZE_TIERS, TIER_POOL_BY_MODE,
} from "../src/config.js";

// —— 参数解析（--key value 形式，全部可选）——
const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[i + 1];
}
const ROUNDS = Number(opt.rounds ?? 100);
const LEVEL_A = opt.levelA ?? opt.level ?? "normal";
const LEVEL_B = opt.levelB ?? opt.level ?? "normal";
const TIMEOUT = Number(opt.timeout ?? 90); // 单回合模拟时长上限（秒），到点判超时
const TYPES = opt.powerups === "none" ? []
  : (opt.powerups ? opt.powerups.split(",") : [...POWERUP.types]);

// AI 模块可替换（新旧对比的关键）：默认双方都用当前仓库版
async function loadAi(p) {
  if (!p) return (await import("../src/ai.js")).AiController;
  return (await import(pathToFileURL(resolve(p)).href)).AiController;
}
const AiA = await loadAi(opt.aiA);
const AiB = await loadAi(opt.aiB);

// 跑一个回合。sideAFirst 控制 A 占哪个出生角（逐回合轮换消除位置偏差）。
// 返回 { winner: "A"|"B"|null, cause, timeout }。
function playRound(sideAFirst) {
  const pool = TIER_POOL_BY_MODE.pve;
  const tier = pool[Math.floor(Math.random() * pool.length)];
  const { cols, rows } = MAZE_TIERS[tier];
  const maze = generateMaze(cols, rows);
  const half = CELL_SIZE / 2;

  const corner = [
    { x: half, y: half, a: 0 },
    { x: (cols - 1) * CELL_SIZE + half, y: (rows - 1) * CELL_SIZE + half, a: Math.PI },
  ];
  const mk = (c) => new Tank(c.x, c.y, c.a, "#000");
  const players = [
    { side: "A", tank: mk(corner[sideAFirst ? 0 : 1]), get alive() { return this.tank.alive; } },
    { side: "B", tank: mk(corner[sideAFirst ? 1 : 0]), get alive() { return this.tank.alive; } },
  ];
  players[0].ctrl = new AiA(players[0], LEVEL_A);
  players[1].ctrl = new AiB(players[1], LEVEL_B);

  let bullets = [];
  let powerups = [];
  let mines = [];
  const spawner = new PowerupSpawner(TYPES);
  const deathCause = []; // { side, cause: "bullet"|"laser"|"mine" }

  const kill = (tank, cause) => {
    if (tank.shield) {
      tank.shield = false;
      tank.shieldTimer = 0;
    } else {
      tank.alive = false;
      const p = players.find((pl) => pl.tank === tank);
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
      for (const p of players) {
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
  for (let t = 0; t < TIMEOUT; t += dt) {
    // 1) 全员控制指令（同一帧世界快照）
    const world = { maze, players, bullets, powerups, mines };
    const controls = players.map((p) => p.ctrl.update(dt, world));

    // 2) 移动 + 2.5) 坦克间分离
    for (let i = 0; i < players.length; i++) {
      players[i].tank.update(dt, maze.walls, controls[i]);
    }
    const aliveTanks = players.filter((p) => p.alive).map((p) => p.tank);
    if (aliveTanks.length === 2) {
      const [a, b] = aliveTanks;
      const sep = separateCircles(a.x, a.y, b.x, b.y, TANK.radius * 2);
      if (sep) {
        a.x = sep.ax; a.y = sep.ay;
        b.x = sep.bx; b.y = sep.by;
        const fa = resolveCircleWalls(a.x, a.y, TANK.radius, maze.walls);
        a.x = fa.x; a.y = fa.y;
        const fb = resolveCircleWalls(b.x, b.y, TANK.radius, maze.walls);
        b.x = fb.x; b.y = fb.y;
      }
    }

    // 2.7) 道具刷新 + 拾取
    spawner.update(dt, maze, powerups, aliveTanks);
    for (const p of players) {
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
      const tripped = players.some(
        (p) => p.alive && Math.hypot(p.tank.x - m.x, p.tank.y - m.y) < POWERUP.mine.triggerRadius
      );
      if (!tripped) continue;
      m.exploded = true;
      for (const p of players) {
        if (!p.alive) continue;
        if (Math.hypot(p.tank.x - m.x, p.tank.y - m.y) >= POWERUP.mine.blastRadius) continue;
        kill(p.tank, "mine");
      }
      // 炸墙（与 main 同步：walls/cells 原子删除；arena 默认开启，调参基准含新机制）
      destroyWallsInRadius(maze, m.x, m.y, POWERUP.mine.wallBlastRadius);
    }
    mines = mines.filter((m) => !m.exploded);

    // 3) 开火 / 激光 / 布雷
    for (let i = 0; i < players.length; i++) {
      const res = players[i].tank.tryFire(bullets, controls[i].fire, maze.walls);
      for (const b of res.bullets) bullets.push(b);
      if (res.laser) fireLaser(res.laser);
      const mine = players[i].tank.tryDeploy(controls[i].special, maze.walls);
      if (mine) mines.push(mine);
    }

    // 4) 子弹运动（含磨墙）+ 5) 击中判定
    for (const b of bullets) b.update(dt, maze.walls, true);
    {
      const crumbled = maze.walls.filter((w) => !w.border && w.hp <= 0);
      if (crumbled.length) destroyWallSegments(maze, crumbled);
    }
    for (const b of bullets) {
      if (b.dead) continue;
      for (const p of players) {
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

    // 7) 胜负
    const alive = players.filter((p) => p.alive);
    if (alive.length <= 1) {
      return {
        winner: alive.length === 1 ? alive[0].side : null,
        cause: deathCause,
        timeout: false,
      };
    }
  }
  return { winner: null, cause: [], timeout: true };
}

// —— 主循环 + 汇总 ——
const stat = { A: 0, B: 0, draw: 0, timeout: 0 };
// 分侧死因（deaths.A.laser = A 死于激光的次数——躲线能力的直接指标）
const deaths = {
  A: { bullet: 0, laser: 0, mine: 0 },
  B: { bullet: 0, laser: 0, mine: 0 },
};
for (let r = 0; r < ROUNDS; r++) {
  const res = playRound(r % 2 === 0);
  if (res.timeout) stat.timeout++;
  else if (res.winner) stat[res.winner]++;
  else stat.draw++;
  for (const c of res.cause) deaths[c.side][c.cause]++;
  if ((r + 1) % 25 === 0) process.stderr.write(`.. ${r + 1}/${ROUNDS}\n`);
}

const pct = (n) => ((n / ROUNDS) * 100).toFixed(1) + "%";
const fmt = (d) => `子弹 ${d.bullet} / 激光 ${d.laser} / 地雷 ${d.mine}`;
console.log(`\nA(${LEVEL_A}, ${opt.aiA ?? "当前版"}) vs B(${LEVEL_B}, ${opt.aiB ?? "当前版"})  共 ${ROUNDS} 回合`);
console.log(`道具池: ${TYPES.length ? TYPES.join(",") : "无"}`);
console.log(`A 胜 ${stat.A} (${pct(stat.A)})   B 胜 ${stat.B} (${pct(stat.B)})   双杀 ${stat.draw}   超时 ${stat.timeout}`);
console.log(`A 死于: ${fmt(deaths.A)}`);
console.log(`B 死于: ${fmt(deaths.B)}`);
