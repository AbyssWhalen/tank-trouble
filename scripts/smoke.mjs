// ============================================================
// smoke.mjs — 纯逻辑模块冒烟测试(node 直跑,无需浏览器/Electron)
// 运行:npm run smoke
// 覆盖:激光路径几何、tryFire 契约、武器槽互斥、布雷/持雷超时、
//       地雷可见度时间线、子弹反弹、键位表完整性、AI 三档指令冒烟、
//       AI 躲激光预瞄线(全路径感知/反弹段/压线反打让位/线上饵过滤)。
// 只测纯逻辑(config/collision/maze/bullet/tank/mine/laser/ai);
// 渲染与交互仍靠 npm start 手动过验收点;AI 强度量化看 npm run arena。
// ============================================================

import { Tank } from "../src/tank.js";
import { Bullet } from "../src/bullet.js";
import { Mine } from "../src/mine.js";
import { castLaserPath } from "../src/laser.js";
import { generateMaze, destroyWallsInRadius, destroyWallSegments } from "../src/maze.js";
import { AiController, findBounceShot } from "../src/ai.js";
import { closestPointOnSegment, resolveCircleWalls } from "../src/collision.js";
import { POWERUP, TANK, KEY_BINDINGS, BULLET, CELL_SIZE, SFX, PICKUP_RATE, MATCH_TARGET, MAZE_TIERS, MAZE_STYLES, WALL } from "../src/config.js";

let pass = 0;
let fail = 0;
let group = "";

function section(name) {
  group = name;
  console.log(`\n—— ${name} ——`);
}

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  ok ? pass++ : fail++;
}

const near = (a, b, eps = 1.5) => Math.abs(a - b) < eps;
const idleCtrl = { turn: 0, move: 0 };

// ============================================================
section("键位表");
{
  const allCodes = KEY_BINDINGS.flatMap((b) => Object.values(b));
  check("四套键位含全部动作字段", KEY_BINDINGS.every(
    (b) => ["forward", "back", "left", "right", "fire", "special"].every((a) => typeof b[a] === "string")
  ));
  check("键位无重复", new Set(allCodes).size === allCodes.length);
}

// ============================================================
section("激光路径几何 (castLaserPath)");
{
  const wallV = { x1: 300, y1: -1000, x2: 300, y2: 1000 };
  // 45° 入射竖墙:撞点 (300,300),反射镜像,总长受 maxLength 约束
  const pts = castLaserPath(100, 100, Math.PI / 4, [wallV], { maxBounces: 1, maxLength: 600 });
  check("45° 入射撞点", pts.length === 3 && near(pts[1].x, 300) && near(pts[1].y, 300));
  check("反射方向镜像", pts[2].x < pts[1].x && pts[2].y > pts[1].y);
  const total = Math.hypot(pts[1].x - 100, pts[1].y - 100)
    + Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y);
  check("总长约束", near(total, 600, 3), `len=${total.toFixed(1)}`);

  // 平行双墙水平往返:4 次反弹 → 6 顶点,撞点交替两墙
  const walls2 = [
    { x1: 100, y1: -1000, x2: 100, y2: 1000 },
    { x1: 300, y1: -1000, x2: 300, y2: 1000 },
  ];
  const pts2 = castLaserPath(200, 0, 0, walls2, { maxBounces: 4, maxLength: 5000 });
  check("平行墙往返顶点数", pts2.length === 6, `n=${pts2.length}`);
  const xs = pts2.slice(1).map((p) => Math.round(p.x));
  check("撞点交替", JSON.stringify(xs) === JSON.stringify([300, 100, 300, 100, 300]));

  // 无墙走满长度
  const pts3 = castLaserPath(0, 0, 0, [], { maxLength: 480 });
  check("无墙走满长度", pts3.length === 2 && near(pts3[1].x, 480));
}

// ============================================================
section("tryFire 契约 (普通/散射/激光 + maxAlive)");
{
  const t = new Tank(200, 200, 0, "#111");
  let r = t.tryFire([], true, []);
  check("普通单发", r.bullets.length === 1 && r.laser === null && r.bullets[0] instanceof Bullet);

  t.cooldown = 0;
  t.applyPowerup("scatter");
  r = t.tryFire([], true, []);
  check("散射多发", r.bullets.length === POWERUP.scatter.pellets && r.laser === null
    && t.scatterShots === POWERUP.scatter.shots - 1);

  // 满弹药:普通弹被限流,激光绕开
  const full = Array.from({ length: BULLET.maxAlive }, () => ({ owner: t, dead: false }));
  t.scatterShots = 0;
  t.cooldown = 0;
  r = t.tryFire(full, true, []);
  check("普通弹受 maxAlive 限流", r.bullets.length === 0 && r.laser === null);

  t.applyPowerup("laser");
  t.cooldown = 0;
  r = t.tryFire(full, true, []);
  check("激光绕开限流并返回发射意图",
    r.laser !== null && typeof r.laser.angle === "number" && t.laserShots === POWERUP.laser.shots - 1);
  const d = Math.hypot(r.laser.x - t.x, r.laser.y - t.y);
  check("激光出膛点在炮口", d > 30 && d < 45, `d=${d.toFixed(1)}`);

  t.cooldown = 0;
  r = t.tryFire([], false, []);
  check("不开火返回 NO_FIRE", r.bullets.length === 0 && r.laser === null);
}

// ============================================================
section("武器改装槽互斥");
{
  const t = new Tank(0, 0, 0, "#111");
  t.applyPowerup("scatter");
  t.applyPowerup("laser");
  check("捡激光清散射", t.scatterShots === 0 && t.laserShots === POWERUP.laser.shots);
  t.applyPowerup("laser");
  check("同类叠加", t.laserShots === POWERUP.laser.shots * 2);
  t.applyPowerup("mine");
  check("捡雷清激光", t.laserShots === 0 && t.mineCharges === POWERUP.mine.charges);
  t.applyPowerup("shield");
  check("护盾独立并存", t.shield === true && t.mineCharges === POWERUP.mine.charges);
}

// ============================================================
section("布雷 (tryDeploy) 与持雷超时");
{
  const t = new Tank(200, 200, 0, "#111");
  t.applyPowerup("mine");

  const s = t.tryFire([], true, []);
  check("持雷仍可开炮", s.bullets.length === 1);

  const m1 = t.tryDeploy(true, []);
  const backDist = TANK.radius + POWERUP.mine.discRadius + 4;
  check("布雷落车尾", m1 instanceof Mine && near(m1.x, 200 - backDist, 0.1) && near(m1.y, 200, 0.1));
  check("部署冷却拦截", t.tryDeploy(true, []) === null && t.mineCharges === 1);
  t.update(0.3, [], idleCtrl);
  check("冷却后可再丢", t.tryDeploy(true, []) instanceof Mine && t.mineCharges === 0);
  t.deployCooldown = 0;
  check("无存货不部署", t.tryDeploy(true, []) === null);

  // 持雷超时:10s 不部署作废;部署刷新计时
  t.applyPowerup("mine");
  t.update(POWERUP.mine.holdTimeout - 0.5, [], idleCtrl);
  check("超时前存货仍在", t.mineCharges === POWERUP.mine.charges);
  t.update(1.0, [], idleCtrl);
  check("超时清空存货", t.mineCharges === 0);
  t.applyPowerup("mine");
  t.update(POWERUP.mine.holdTimeout - 0.5, [], idleCtrl);
  t.deployCooldown = 0;
  t.tryDeploy(true, []);
  t.update(POWERUP.mine.holdTimeout - 0.5, [], idleCtrl);
  check("部署刷新持雷计时", t.mineCharges === 1);
}

// ============================================================
section("地雷可见度时间线 (visibility)");
{
  const m = new Mine(0, 0, null);
  check("布防期半透明", m.visibility() === 0.45 && !m.armed);
  m.update(POWERUP.mine.armDelay + 0.05);
  check("警戒亮相实色", m.visibility() === 0.95 && m.armed);
  m.update(POWERUP.mine.visibleTime);
  const mid = m.visibility();
  check("淡出中", mid > 0 && mid < 0.95, `vis=${mid.toFixed(2)}`);
  m.update(POWERUP.mine.fadeTime);
  check("完全隐形且仍警戒", m.visibility() === 0 && m.armed);
}

// ============================================================
section("子弹反弹回归");
{
  const wall = { x1: 300, y1: -1000, x2: 300, y2: 1000, border: false };
  const b = new Bullet(200, 0, BULLET.speed, 0, null);
  let bounced = false;
  for (let i = 0; i < 240; i++) {
    b.update(1 / 120, [wall]);
    if (b.vx < 0) { bounced = true; break; }
  }
  check("普通弹撞墙反弹", bounced && b.x < 300 && b.bounces === 1);
}

// ============================================================
section("跳弹吊射解算 (findBounceShot)");
{
  // 水平墙 y=0,自己 (-100,100) 目标 (100,100) 同侧:镜像法解出反弹点 (0,0),
  // 开火角 -45°,总路程 2×√2×100
  const wall = { x1: -200, y1: 0, x2: 200, y2: 0 };
  const shot = findBounceShot(-100, 100, 100, 100, [wall]);
  check("单墙反弹解存在", shot !== null);
  check("反弹角 -45°", shot && near(shot.angle, -Math.PI / 4, 0.01), shot && `angle=${shot.angle.toFixed(3)}`);
  check("总路程正确", shot && near(shot.dist, 200 * Math.SQRT2, 1), shot && `dist=${shot.dist.toFixed(1)}`);

  // 入射路径被第二堵墙遮挡 → 无解
  const blocker = { x1: -50, y1: -10, x2: -50, y2: 120 };
  check("遮挡时无解", findBounceShot(-100, 100, 100, 100, [wall, blocker]) === null);

  // 目标在墙另一侧(反弹路径=穿墙,物理不成立)→ 无解
  check("异侧无解", findBounceShot(-100, 100, 100, -100, [wall]) === null);
}

// ============================================================
section("AI 激光 hitscan 开火判定");
{
  // 空旷场地(无墙,有视线,不触发 BFS/躲弹),敌人在正东 300px
  const mkWorld = (bot, enemy) => ({
    maze: { cols: 5, rows: 4, walls: [], cells: null },
    players: [enemy, bot],
    bullets: [], powerups: [], mines: [],
  });
  const mkP = (tank) => ({ tank, get alive() { return this.tank.alive; } });

  // 炮口正对敌人:持激光 → 首段扫中 → 必开火
  {
    const bot = mkP(new Tank(100, 100, 0, "#222"));
    const enemy = mkP(new Tank(400, 100, Math.PI, "#111"));
    const ai = new AiController(bot, "normal");
    bot.tank.applyPowerup("laser");
    ai.fireTimer = -1; // 冷却就绪
    const c = ai.update(1 / 60, mkWorld(bot, enemy));
    check("正对敌人扫中即开", c.fire === true);
  }
  // 炮口背对敌人:路径扫不中 → 绝不浪费
  {
    const bot = mkP(new Tank(100, 100, Math.PI, "#222"));
    const enemy = mkP(new Tank(400, 100, Math.PI, "#111"));
    const ai = new AiController(bot, "normal");
    bot.tank.applyPowerup("laser");
    ai.fireTimer = -1;
    const c = ai.update(1 / 60, mkWorld(bot, enemy));
    check("背对敌人不开火", c.fire === false);
  }
}

// ============================================================
section("AI 捡道具机会成本");
{
  const mkP = (tank) => ({ tank, get alive() { return this.tank.alive; } });
  const world = (players, powerups) => ({
    maze: { cols: 7, rows: 5, walls: [], cells: null },
    players, powerups, bullets: [], mines: [],
  });
  const bot = mkP(new Tank(200, 200, 0, "#222"));
  const enemy = mkP(new Tank(200 + CELL_SIZE * 1.6, 200, Math.PI, "#111")); // 敌人 1.6 格,有视线
  const ai = new AiController(bot, "hard");

  // 道具比敌人还远(2.5 格 > 敌距×0.8)→ 对峙中不值得转身去拿
  const farPw = { x: 200 - CELL_SIZE * 2.5, y: 200, type: "shield", taken: false };
  check("对峙中放弃更远的道具",
    ai.pickPowerupTarget(bot.tank, [farPw], world([enemy, bot], [farPw]), false) === null);

  // 道具明显更近(0.8 格 < 敌距×0.8)→ 顺手可拿
  const nearPw = { x: 200 - CELL_SIZE * 0.8, y: 200, type: "shield", taken: false };
  check("明显更近的道具仍然拿",
    ai.pickPowerupTarget(bot.tank, [nearPw], world([enemy, bot], [nearPw]), false) === nearPw);
}

// ============================================================
section("AI 隔墙不对撞 (counterAttack 可达门 + 卡住脱困)");
{
  // 5×3 场地，中间一段竖内墙把 bot 和敌人隔开。敌人贴墙自由端附近静止
  // （零宽 LOS 从端点泄漏带可能判通视，但车身过不去——阶段 22 之前 AI
  // 会在这里无限顶墙）。跑 600 帧断言 AI 不死锁：要么净位移离开（绕路/
  // 脱困生效），要么压墙帧占比受控。
  const COLS = 5, ROWS = 3;
  const S = CELL_SIZE;
  const W = COLS * S, H = ROWS * S;
  const walls = [
    { x1: 0, y1: 0, x2: W, y2: 0, border: true },
    { x1: W, y1: 0, x2: W, y2: H, border: true },
    { x1: W, y1: H, x2: 0, y2: H, border: true },
    { x1: 0, y1: H, x2: 0, y2: 0, border: true },
    // 竖内墙：格(2,1) 的 left（x=2S，跨 y=[S,2S]）——中排中间一堵孤立墙桩
    { x1: 2 * S, y1: S, x2: 2 * S, y2: 2 * S, border: false, hp: 5 },
  ];
  const cells = Array.from({ length: ROWS }, (_, r) =>
    Array.from({ length: COLS }, (_, c) => ({
      top: r === 0, bottom: r === ROWS - 1, left: c === 0, right: c === COLS - 1,
    }))
  );
  cells[1][2].left = true;
  cells[1][1].right = true;

  const mkP = (tank) => ({ tank, get alive() { return this.tank.alive; } });
  // 敌人贴内墙东侧、靠近墙北端（自由端泄漏带位置），静止不动
  const enemyTank = new Tank(2 * S + TANK.radius + 6, S + 26, Math.PI, "#e63946");
  // bot 在内墙西侧同高度——距敌 ~44px，远小于 closeCombatRange(130)
  const botTank = new Tank(2 * S - TANK.radius - 6, S + 30, 0, "#1ba39c");
  const bot = mkP(botTank);
  const foe = mkP(enemyTank);
  const world = { maze: { cols: COLS, rows: ROWS, walls, cells }, players: [bot, foe], bullets: [], powerups: [], mines: [] };

  const ai = new AiController(bot, foe, "hard"); // hard 提前量最大，最容易触发旧 bug
  const x0 = botTank.x, y0 = botTank.y;
  let pressFrames = 0;   // 想动却没动的帧
  let unstickEdges = 0;  // 脱困触发次数
  let prevUnstick = 0;
  let maxExcursion = 0;  // 距起点最远距离（是否真的离开过墙边）
  let ok = true, err = "";
  try {
    for (let f = 0; f < 600; f++) {
      const px = botTank.x, py = botTank.y;
      const c = ai.update(1 / 60, world);
      botTank.update(1 / 60, walls, c);
      const moved = Math.hypot(botTank.x - px, botTank.y - py);
      if (c.move !== 0 && moved < 0.3) pressFrames++;
      if (ai.unstickTimer > 0 && prevUnstick <= 0) unstickEdges++;
      prevUnstick = ai.unstickTimer;
      maxExcursion = Math.max(maxExcursion, Math.hypot(botTank.x - x0, botTank.y - y0));
    }
  } catch (e) {
    ok = false;
    err = e.stack.split("\n")[0];
  }
  check("600 帧无异常", ok, err);
  // 死锁特征 = 压墙帧占绝对多数且从未离开。修复后：要么绕路（远离），要么脱困循环在动
  check("未陷入顶墙死锁（压墙帧 < 55% 或曾离开 1 格远）",
    pressFrames < 330 || maxExcursion > CELL_SIZE,
    `press=${pressFrames}/600 excursion=${maxExcursion.toFixed(0)}px unstick=${unstickEdges}`);
  check("卡住脱困可触发（不再被反打豁免锁死）", unstickEdges >= 1 || pressFrames < 60,
    `unstick=${unstickEdges} press=${pressFrames}`);
}

// ============================================================
section("AI 躲激光预瞄线 (全路径感知)");
{
  // 10×5 开阔场地（只有边界墙）：宽度 960 = 激光总长上限，可测最远端感知。
  // cells 用真实开阔格子图——AI 会对激光带做 BFS 绕行，null 会崩。
  const COLS = 10, ROWS = 5;
  const W = COLS * CELL_SIZE, H = ROWS * CELL_SIZE;
  const walls = [
    { x1: 0, y1: 0, x2: W, y2: 0 },
    { x1: W, y1: 0, x2: W, y2: H },
    { x1: W, y1: H, x2: 0, y2: H },
    { x1: 0, y1: H, x2: 0, y2: 0 },
  ];
  const cells = Array.from({ length: ROWS }, (_, r) =>
    Array.from({ length: COLS }, (_, c) => ({
      top: r === 0, bottom: r === ROWS - 1, left: c === 0, right: c === COLS - 1,
    }))
  );
  const mkP = (tank) => ({ tank, get alive() { return this.tank.alive; } });
  const mkWorld = (a, b) => ({
    maze: { cols: COLS, rows: ROWS, walls, cells },
    players: [a, b], bullets: [], powerups: [], mines: [],
  });
  // 持激光的敌人在东侧朝西架线（预瞄线沿 y=240 贯穿全场）
  const holder = () => {
    const t = new Tank(864, 240, Math.PI, "#111");
    t.applyPowerup("laser");
    return t;
  };
  // 真实激光路径此刻能否杀掉 bot（与 main.fireLaser 同判定）
  const killable = (camper, bot) => {
    const m = camper.muzzlePoint();
    const pts = castLaserPath(m.x, m.y, m.angle, walls);
    for (let i = 0; i < pts.length - 1; i++) {
      const cp = closestPointOnSegment(bot.x, bot.y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      if (Math.hypot(bot.x - cp.x, bot.y - cp.y) < TANK.radius) return true;
    }
    return false;
  };

  // 压线即警觉，与离炮口距离无关（旧实现 normal 只感知炮口前 2.5 格）；
  // easy 保持无感是设计（不躲弹的档位好欺负）
  for (const [level, expect] of [["easy", false], ["normal", true], ["hard", true]]) {
    const E = mkP(holder());
    const bot = mkP(new Tank(96, 240, 0, "#222")); // 在线上，离炮口 7.6 格
    const ai = new AiController(bot, level);
    ai.update(1 / 60, mkWorld(E, bot));
    check(`${level} 压线远端${expect ? "触发闪避" : "无感(设计)"}`, (ai.dodgeTimer > 0) === expect);
  }

  // 反弹段同样感知：敌人 45° 打南墙，bot 恰在反弹段上（首段不指向它）
  {
    const E = mkP(new Tank(480, 384, Math.PI / 4, "#111"));
    E.tank.applyPowerup("laser");
    const bot = mkP(new Tank(624, 432, Math.PI, "#222"));
    const ai = new AiController(bot, "normal");
    ai.update(1 / 60, mkWorld(E, bot));
    check("normal 压反弹段触发闪避", ai.dodgeTimer > 0, killable(E.tank, bot.tank) ? "" : "夹具失效:不在线上");
  }

  // 压线时反打让位：贴脸+有视线+枪就绪本该反打，但正对架好的枪口时改为闪避下线
  {
    const E = mkP(holder());
    const bot = mkP(new Tank(864 - CELL_SIZE * 1.2, 240, 0, "#222"));
    const ai = new AiController(bot, "hard");
    ai.fireTimer = -1;
    ai.update(1 / 60, mkWorld(E, bot));
    check("贴脸压线不反打而是闪避", ai.dodgeTimer > 0);
  }

  // 离线不误报：距线 140px、场上无真实子弹 → 不触发闪避（防"永久闪避"回归）
  {
    const E = mkP(holder());
    const bot = mkP(new Tank(480, 100, 0, "#222"));
    const ai = new AiController(bot, "hard");
    ai.update(1 / 60, mkWorld(E, bot));
    check("离线不误报闪避", ai.dodgeTimer <= 0);
  }

  // 线上的道具是饵：压线道具被过滤，离线道具照捡
  {
    const E = mkP(holder());
    const bot = mkP(new Tank(300, 400, 0, "#222"));
    const ai = new AiController(bot, "hard");
    const w = mkWorld(E, bot);
    ai.update(1 / 60, w); // 先跑一帧填 enemyLaserPath
    const bait = { x: 400, y: 240, type: "shield", taken: false };
    const safe = { x: 400, y: 430, type: "shield", taken: false };
    check("压线道具被过滤", ai.pickPowerupTarget(bot.tank, [bait], w, false) === null);
    check("离线道具照捡", ai.pickPowerupTarget(bot.tank, [safe], w, false) === safe);
  }

  // 行为回归：静止架线正对走廊，AI 从线上远端自主行动 10 秒——
  // 「连续 0.2s 可杀」窗口至多 1 个（出生在线上的逃离瞬态；旧实现 normal 5 个）
  for (const level of ["normal", "hard"]) {
    const E = mkP(holder());
    const bot = mkP(new Tank(96, 240, 0, "#222"));
    const ai = new AiController(bot, level);
    const w = mkWorld(E, bot);
    let streak = 0, windows = 0;
    for (let f = 0; f < 600; f++) {
      const c = ai.update(1 / 60, w);
      bot.tank.update(1 / 60, walls, c);
      if (killable(E.tank, bot.tank)) {
        streak++;
        if (streak === 12) windows++;
      } else streak = 0;
    }
    check(`${level} 架线接近 10s 稳杀窗口≤1`, windows <= 1, `windows=${windows}`);
  }
}

// ============================================================
section("AI 三档冒烟 (含雷/弹世界 300 帧)");
for (const level of ["easy", "normal", "hard"]) {
  const maze = generateMaze(5, 4);
  const human = { tank: new Tank(48, 48, 0, "#111"), alive: true };
  const bot = { tank: new Tank(48 + 96 * 4, 48 + 96 * 3, Math.PI, "#222"), alive: true };
  const ai = new AiController(bot, level);
  bot.tank.applyPowerup("mine");
  const mines = [new Mine(48 + 96 * 2, 48 + 96 * 1.5, null)];
  mines[0].age = 5; // 已警戒(且已隐形——AI 读数据不受隐形影响)
  const bullets = [new Bullet(48 + 96 * 2, 48 + 96 * 3, 120, 0, human.tank)];
  const world = { maze, players: [human, bot], bullets, powerups: [], mines };

  let ok = true;
  let err = "";
  try {
    for (let i = 0; i < 300; i++) {
      const c = ai.update(1 / 60, world);
      if (![-1, 0, 1].includes(c.turn) || ![-1, 0, 1].includes(c.move)
        || typeof c.fire !== "boolean" || typeof c.special !== "boolean") {
        ok = false;
        err = `帧${i} 非法指令 ${JSON.stringify(c)}`;
        break;
      }
      bot.tank.update(1 / 60, maze.walls, c);
      const nm = bot.tank.tryDeploy(c.special, maze.walls);
      if (nm) world.mines.push(nm);
      for (const bl of bullets) bl.update(1 / 60, maze.walls);
      for (const m of world.mines) m.update(1 / 60);
    }
  } catch (e) {
    ok = false;
    err = e.stack.split("\n")[0];
  }
  check(`${level} 档 300 帧`, ok, err);
}

// ============================================================
section("可破坏墙 (destroyWallsInRadius)");
{
  // 手工造 2×2 迷宫：中间一堵竖内墙 (S,0)-(S,S)，外圈全 border。
  // cells 与 walls 一致（walls/cells 双数据源必须成对维护的最小夹具）。
  const S = CELL_SIZE;
  const mkMaze = () => ({
    cols: 2, rows: 2, cellSize: S,
    cells: [
      [{ top: true, left: true, bottom: false, right: true }, { top: true, left: true, bottom: false, right: true }],
      [{ top: false, left: true, bottom: true, right: false }, { top: false, left: false, bottom: true, right: true }],
    ],
    walls: [
      { x1: 0, y1: 0, x2: 2 * S, y2: 0, border: true },          // 上外墙（简化为一段）
      { x1: 0, y1: 0, x2: 0, y2: 2 * S, border: true },          // 左外墙
      { x1: S, y1: 0, x2: S, y2: S, border: false },             // 中间竖内墙：格(1,0)的 left
    ],
  });

  {
    // 爆心贴着内墙 → 内墙被删，cells 两侧面同步清掉
    const mz = mkMaze();
    const gone = destroyWallsInRadius(mz, S + 10, S * 0.5, 60);
    check("内墙被炸掉（返回 1 段）", gone.length === 1 && gone[0].x1 === S && !gone[0].border);
    check("walls 数组同步变短", mz.walls.length === 2);
    check("cells 两侧面同步清除", mz.cells[0][1].left === false && mz.cells[0][0].right === false);
  }
  {
    // 爆心在外墙上 → border 护栏：外墙不删
    const mz = mkMaze();
    const gone = destroyWallsInRadius(mz, 0, S, 60);
    check("border 外墙在半径内也不删", gone.length === 0 && mz.walls.length === 3);
  }
  {
    // 爆心远离一切 → 无事发生
    const mz = mkMaze();
    const gone = destroyWallsInRadius(mz, 2 * S - 10, 2 * S - 10, 40);
    check("半径外内墙保留", gone.length === 0 && mz.walls.length === 3);
  }
  {
    // cells: null 夹具兼容（arena/smoke 有些夹具不带 cells）
    const mz = mkMaze();
    mz.cells = null;
    let ok = true;
    try { destroyWallsInRadius(mz, S + 10, S * 0.5, 60); } catch { ok = false; }
    check("cells 为 null 不抛异常", ok && mz.walls.length === 2);
  }
  {
    // destroyWallSegments 直接删除：cells 同步 + border 跳过
    const mz = mkMaze();
    const inner = mz.walls[2];
    const outer = mz.walls[0];
    const gone = destroyWallSegments(mz, [inner, outer]);
    check("destroyWallSegments 删内墙跳过外墙",
      gone.length === 1 && gone[0] === inner && mz.walls.length === 2 && mz.cells[0][1].left === false);
  }
}

// ============================================================
section("子弹磨墙 (bullet erode)");
{
  // 内墙竖在 x=100，子弹从左直射：每次反弹削 1 hp；erode=false 不削
  const mkWalls = () => [{ x1: 100, y1: -200, x2: 100, y2: 200, border: false, hp: 3 }];
  const shoot = (walls, erode) => {
    // 从 x=40 向右直射，反弹后往回飞——重置位置速度打三轮
    const b = new Bullet(40, 0, 200, 0, null);
    for (let hits = 0; hits < 3; hits++) {
      b.x = 40; b.y = 0; b.vx = 200; b.vy = 0;
      for (let i = 0; i < 40; i++) b.update(1 / 60, walls, erode);
    }
    return b;
  };

  {
    const walls = mkWalls();
    shoot(walls, true);
    check("三次撞击削 3 点耐久", walls[0].hp === 0, `hp=${walls[0].hp}`);
  }
  {
    const walls = mkWalls();
    shoot(walls, false);
    check("erode=false 时耐久不动", walls[0].hp === 3, `hp=${walls[0].hp}`);
  }
  {
    const walls = [{ x1: 100, y1: -200, x2: 100, y2: 200, border: true }];
    let ok = true;
    try { shoot(walls, true); } catch { ok = false; }
    check("border 墙无 hp 字段免疫侵蚀", ok && walls[0].hp === undefined);
  }
}

// ============================================================
section("音效 spec 表 (SFX/PICKUP_RATE)");
{
  // audio.js 是浏览器专属（Web Audio），smoke 只验 config 里的纯数据表：
  // 事件齐全 + 每层参数在合法区间，接线正确性靠 npm start 实听。
  const expected = [
    "shoot", "shootScatter", "laser", "kill", "shieldBreak", "pickup",
    "mineDeploy", "mineBlast", "wallBreak", "roundWin", "matchWin", "roundDraw", "uiClick", "uiError",
    "countTick", "countGo",
  ];
  const names = Object.keys(SFX);
  check("16 个事件名双向齐全",
    expected.every((n) => names.includes(n)) && names.every((n) => expected.includes(n)),
    `实有 ${names.length} 个`);

  const WAVES = ["sine", "square", "sawtooth", "triangle"];
  const FILTERS = ["lowpass", "highpass", "bandpass"];
  let layersOk = true;
  let bad = "";
  for (const [name, layers] of Object.entries(SFX)) {
    if (!Array.isArray(layers) || layers.length < 1 || layers.length > 4) {
      layersOk = false; bad = `${name} 层数非法`; break;
    }
    for (const l of layers) {
      const durOk = l.dur > 0 && l.dur <= 2;
      const gainOk = l.gain > 0 && l.gain <= 0.7;
      const delayOk = l.delay === undefined || (l.delay >= 0 && l.delay < 1);
      const freqOk = (f) => Array.isArray(f) && f.length === 2 && f.every((v) => v >= 30 && v <= 8000);
      let typeOk = false;
      if (l.type === "tone") typeOk = WAVES.includes(l.wave) && freqOk(l.freq);
      else if (l.type === "noise") typeOk = l.filter === undefined || (FILTERS.includes(l.filter.kind) && freqOk(l.filter.freq));
      if (!(durOk && gainOk && delayOk && typeOk)) {
        layersOk = false; bad = `${name}: ${JSON.stringify(l)}`; break;
      }
    }
    if (!layersOk) break;
  }
  check("所有层参数在合法区间", layersOk, bad);

  const peak = (name) => Math.max(...SFX[name].map((l) => l.gain));
  check("音量层次 kill > shoot > uiClick",
    peak("kill") > peak("shoot") && peak("shoot") > peak("uiClick"));

  check("PICKUP_RATE 覆盖全部道具类型且倍率合理",
    POWERUP.types.every((t) => typeof PICKUP_RATE[t] === "number" && PICKUP_RATE[t] > 0.5 && PICKUP_RATE[t] < 2));

  check("MATCH_TARGET 是合理的局胜分",
    Number.isInteger(MATCH_TARGET) && MATCH_TARGET >= 2 && MATCH_TARGET <= 20, `= ${MATCH_TARGET}`);
}

// ============================================================
section("地图生成 (generateMaze 三风格)");
{
  // 每 tier × style 生成 30 张，验证结构不变量（不测美感，只测契约）
  const bfs = (cells, cols, rows) => {
    // 与 maze.floodReachable 同逻辑，独立重写防实现耦合
    const seen = Array.from({ length: rows }, () => new Array(cols).fill(false));
    const D = [{ dc: 0, dr: -1, w: "top" }, { dc: 1, dr: 0, w: "right" }, { dc: 0, dr: 1, w: "bottom" }, { dc: -1, dr: 0, w: "left" }];
    const stack = [{ c: 0, r: 0 }];
    seen[0][0] = true;
    let n = 1;
    while (stack.length) {
      const { c, r } = stack.pop();
      for (const d of D) {
        const nc = c + d.dc, nr = r + d.dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows || seen[nr][nc]) continue;
        if (cells[r][c][d.w]) continue;
        seen[nr][nc] = true; n++;
        stack.push({ c: nc, r: nr });
      }
    }
    return { n, seen };
  };

  for (const style of Object.keys(MAZE_STYLES)) {
    let allOk = true;
    let detail = "";
    outer:
    for (const [tier, { cols, rows }] of Object.entries(MAZE_TIERS)) {
      for (let trial = 0; trial < 30; trial++) {
        const mz = generateMaze(cols, rows, style);
        const { cells, walls } = mz;

        // 1) cells 双向一致（最核心不变量，共享墙两面必须同值）
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols - 1; c++) {
            if (cells[r][c].right !== cells[r][c + 1].left) { allOk = false; detail = `${tier} 竖边双向不一致`; break outer; }
          }
        }
        for (let r = 0; r < rows - 1; r++) {
          for (let c = 0; c < cols; c++) {
            if (cells[r][c].bottom !== cells[r + 1][c].top) { allOk = false; detail = `${tier} 横边双向不一致`; break outer; }
          }
        }

        // 2) 全图连通 + 出生点互达
        const { n, seen } = bfs(cells, cols, rows);
        if (n !== cols * rows) { allOk = false; detail = `${tier} 不连通 ${n}/${cols * rows}`; break outer; }
        if (!seen[rows - 1][cols - 1]) { allOk = false; detail = `${tier} 出生点不互达`; break outer; }

        // 3) 外边界完整（border 段数 = 周长格边数）
        const borders = walls.filter((w) => w.border).length;
        if (borders !== 2 * (cols + rows)) { allOk = false; detail = `${tier} 外边界 ${borders}≠${2 * (cols + rows)}`; break outer; }

        // 4) hp 继承 + 内墙段方向不变量（保护 destroyWallSegments 反解）
        for (const w of walls) {
          if (w.border && w.hp !== undefined) { allOk = false; detail = "外墙带 hp"; break outer; }
          if (!w.border) {
            if (w.hp !== WALL.hp) { allOk = false; detail = "内墙 hp 缺失"; break outer; }
            const horizontal = w.y1 === w.y2;
            const c = Math.round(w.x1 / CELL_SIZE), r = Math.round(w.y1 / CELL_SIZE);
            if (horizontal ? r <= 0 : c <= 0) { allOk = false; detail = "内墙段落在外圈坐标"; break outer; }
          }
        }

        // 5) 密度区间（内墙数/内部边总数）
        const innerEdges = rows * (cols - 1) + cols * (rows - 1);
        const innerWalls = walls.filter((w) => !w.border).length;
        const density = innerWalls / innerEdges;
        if (density < 0.05 || density > 0.65) { allOk = false; detail = `${tier} 密度 ${density.toFixed(2)} 出界`; break outer; }

        // 6) symmetric 专项：四面镜像
        if (style === "symmetric") {
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const m = cells[rows - 1 - r][cols - 1 - c];
              if (cells[r][c].top !== m.bottom || cells[r][c].left !== m.right) {
                allOk = false; detail = `${tier} (${c},${r}) 不对称`; break outer;
              }
            }
          }
        }
      }
    }
    check(`${style} 风格 3 档 × 30 张结构不变量全过`, allOk, detail);
  }
}

// ============================================================
section("关卡表与过关判定 (levels)");
{
  const { LEVELS, LEVEL_COUNT, evaluateObjective, normalizeProgress } = await import("../src/levels.js");
  const { MAZE_STYLES, AI_DIFFICULTY } = await import("../src/config.js");

  {
    const idsOk = LEVELS.every((l, i) => l.id === i + 1);
    const tiersOk = LEVELS.every((l) => MAZE_TIERS[l.map.tier] && MAZE_STYLES[l.map.style]);
    const enemiesOk = LEVELS.every((l) =>
      l.enemies.length >= 1 && l.enemies.length <= 3 &&
      l.enemies.every((e) => AI_DIFFICULTY[e.level] && ["tl", "tr", "bl", "br"].includes(e.spawn)));
    const powupsOk = LEVELS.every((l) => l.powerups.every((t) => POWERUP.types.includes(t)));
    const objOk = LEVELS.every((l) => ["eliminate", "survive", "eliminateTimed"].includes(l.objective));
    const mutOk = LEVELS.every((l) =>
      (l.objective !== "survive" || l.mutators.surviveTime > 0) &&
      (l.objective !== "eliminateTimed" || l.mutators.timeLimit > 0));
    check("关卡表结构不变量（id/tier/style/敌人/道具/目标/mutator）",
      idsOk && tiersOk && enemiesOk && powupsOk && objOk && mutOk, `共 ${LEVEL_COUNT} 关`);
  }
  {
    const elim = { objective: "eliminate", mutators: {} };
    check("歼灭关真值表",
      evaluateObjective(elim, { playerAlive: true, enemiesAlive: 0, levelTimer: 0 }) === "win" &&
      evaluateObjective(elim, { playerAlive: true, enemiesAlive: 1, levelTimer: 0 }) === null &&
      evaluateObjective(elim, { playerAlive: false, enemiesAlive: 1, levelTimer: 0 }) === "lose" &&
      evaluateObjective(elim, { playerAlive: false, enemiesAlive: 0, levelTimer: 0 }) === "lose"); // 同归=败
  }
  {
    const surv = { objective: "survive", mutators: { surviveTime: 45 } };
    check("生存关真值表（含歼灭提前过关）",
      evaluateObjective(surv, { playerAlive: true, enemiesAlive: 1, levelTimer: 44 }) === null &&
      evaluateObjective(surv, { playerAlive: true, enemiesAlive: 1, levelTimer: 45 }) === "win" &&
      evaluateObjective(surv, { playerAlive: true, enemiesAlive: 0, levelTimer: 10 }) === "win" &&
      evaluateObjective(surv, { playerAlive: false, enemiesAlive: 1, levelTimer: 50 }) === "lose");
  }
  {
    const timed = { objective: "eliminateTimed", mutators: { timeLimit: 90 } };
    check("限时歼灭关真值表",
      evaluateObjective(timed, { playerAlive: true, enemiesAlive: 0, levelTimer: 10 }) === "win" &&
      evaluateObjective(timed, { playerAlive: true, enemiesAlive: 1, levelTimer: 10 }) === null &&
      evaluateObjective(timed, { playerAlive: true, enemiesAlive: 1, levelTimer: 0 }) === "lose");
  }
  {
    check("进度宽松校验",
      normalizeProgress(null) === 0 && normalizeProgress(-2) === 0 &&
      normalizeProgress(3.7) === 3 && normalizeProgress(999) === LEVEL_COUNT &&
      normalizeProgress("bad") === 0);
  }
}

// ============================================================
section("战绩统计 (stats 纯函数)");
{
  const { normalizeStats, accuracy, favoriteWeapon, updateStreak } = await import("../src/stats.js");

  {
    const s = normalizeStats(null);
    check("空档落默认（双玩家零值）",
      s.players.length === 2 && s.players[0].fired === 0 && s.players[1].kills.laser === 0
      && s.bestStreak === 0 && s.curStreak === 0);
  }
  {
    const s = normalizeStats({ players: [{ fired: "bad", hits: -3, kills: { laser: 7 } }], bestStreak: 4.0 });
    check("坏字段各自落默认、好字段保留",
      s.players[0].fired === 0 && s.players[0].hits === 0 && s.players[0].kills.laser === 7
      && s.bestStreak === 4 && s.players[1].fired === 0);
  }
  {
    check("命中率除零保护", accuracy({ fired: 0, hits: 0 }) === 0);
    check("命中率正常与钳位", accuracy({ fired: 10, hits: 4 }) === 0.4 && accuracy({ fired: 2, hits: 5 }) === 1);
  }
  {
    const none = favoriteWeapon({ kills: { bullet: 0, scatter: 0, laser: 0, mine: 0 } });
    const laser = favoriteWeapon({ kills: { bullet: 2, scatter: 0, laser: 5, mine: 1 } });
    check("最爱武器 argmax（全零 null）", none === null && laser === "激光");
  }
  {
    let s = updateStreak(2, 3, 0);
    check("P1 赢连胜 +1 并刷新纪录", s.curStreak === 3 && s.bestStreak === 3);
    s = updateStreak(3, 5, 1);
    check("P1 输连胜清零纪录保留", s.curStreak === 0 && s.bestStreak === 5);
    s = updateStreak(2, 5, null);
    check("同归于尽连胜不动", s.curStreak === 2 && s.bestStreak === 5);
  }
}

// ============================================================
section("波次曲线 (waves)");
{
  const {
    waveSpec, pickEnemyLevel, chapterOf, shouldRemap, pickSpawnSpot,
    normalizeWaveBest, isBetterRecord, MIX_KEYS, WAVE_TIERS,
  } = await import("../src/waves.js");
  const { WAVE, TIER_POOL_BY_MODE } = await import("../src/config.js");

  const specs = Array.from({ length: 40 }, (_, i) => waveSpec(i + 1));

  {
    // 纯函数：同一 n 恒等（arena 跑分与 smoke 断言全靠这点）
    const a = waveSpec(7), b = waveSpec(7);
    check("waveSpec 确定性（同 n 同解）", JSON.stringify(a) === JSON.stringify(b));
    check("非法 n 钳到第 1 波", waveSpec(0).wave === 1 && waveSpec(-5).wave === 1 && waveSpec(2.9).wave === 2);
  }
  {
    const mono = specs.every((s, i) => i === 0 || s.quota >= specs[i - 1].quota);
    const capped = specs.every((s) => s.quota <= WAVE.quotaCap);
    check("配额单调不减且不超上限", mono && capped,
      `quota: ${specs.slice(0, 8).map((s) => s.quota).join(",")} … cap ${WAVE.quotaCap}`);
  }
  {
    const capped = specs.every((s) => s.concurrent <= WAVE.concurrentCap && s.concurrent >= 1);
    // 同屏数被配额压住：第 1 波总共 1 辆，同屏不可能 2 辆
    const byQuota = specs.every((s) => s.concurrent <= s.quota);
    const mono = specs.every((s, i) => i === 0 || s.concurrent >= specs[i - 1].concurrent);
    check("同屏上限 ≤ 硬顶且 ≤ 配额、单调不减", capped && byQuota && mono,
      `concurrent: ${specs.slice(0, 8).map((s) => s.concurrent).join(",")}`);
  }
  {
    const sums = specs.every((s) => Math.abs(MIX_KEYS.reduce((a, k) => a + s.mix[k], 0) - 1) < 1e-9);
    const nonNeg = specs.every((s) => MIX_KEYS.every((k) => s.mix[k] >= -1e-12));
    const easyDown = specs.every((s, i) => i === 0 || s.mix.easy <= specs[i - 1].mix.easy + 1e-12);
    const hardUp = specs.every((s, i) => i === 0 || s.mix.hard >= specs[i - 1].mix.hard - 1e-12);
    check("mix 权重和为 1、非负、easy 只降 hard 只升", sums && nonNeg && easyDown && hardUp);
    check("第 1 波纯 easy、高波次 easy 归零且 hard 到顶",
      specs[0].mix.easy === 1 && specs[39].mix.easy === 0 &&
      Math.abs(specs[39].mix.hard - WAVE.hardCap) < 1e-9);
  }
  {
    const inPool = specs.every((s) => WAVE_TIERS.includes(s.tier));
    // 档位只能在换图边界变——波内换档位等于波内换图，会抹掉玩家打出来的破洞
    const onlyAtRemap = specs.every((s, i) => i === 0 || s.tier === specs[i - 1].tier || shouldRemap(s.wave));
    check("档位在模式池内且只在换图边界升档", inPool && onlyAtRemap,
      `pool=${TIER_POOL_BY_MODE.wave.join("/")} largeFrom=${WAVE.largeFrom}`);
  }
  {
    check("章节与换图边界一致",
      chapterOf(1) === 0 && chapterOf(WAVE.remapEvery) === 0 && chapterOf(WAVE.remapEvery + 1) === 1 &&
      !shouldRemap(1) && shouldRemap(WAVE.remapEvery + 1) && !shouldRemap(WAVE.remapEvery + 2));
    check("补给每 supplyBonusEvery 波翻倍",
      waveSpec(WAVE.supplyBonusEvery).supply === 2 && waveSpec(WAVE.supplyBonusEvery + 1).supply === 1);
  }
  {
    // 加权抽取边界：rand=0 落第一个有权重的档，rand→1 落最后一个
    const mixEasy = waveSpec(1).mix;      // { easy:1, normal:0, hard:0 }
    const mixLate = waveSpec(40).mix;     // easy 归零
    check("pickEnemyLevel 边界与零权重跳过",
      pickEnemyLevel(mixEasy, () => 0) === "easy" && pickEnemyLevel(mixEasy, () => 0.999) === "easy" &&
      pickEnemyLevel(mixLate, () => 0) === "normal" && pickEnemyLevel(mixLate, () => 0.999) === "hard");
  }
  {
    check("最高记录宽松校验",
      JSON.stringify(normalizeWaveBest(null)) === '{"wave":0,"kills":0}' &&
      JSON.stringify(normalizeWaveBest({ wave: 7.9, kills: "bad" })) === '{"wave":7,"kills":0}' &&
      JSON.stringify(normalizeWaveBest({ wave: -3, kills: 12 })) === '{"wave":0,"kills":12}');
    check("破纪录判定（先波次后击杀）",
      isBetterRecord({ wave: 5, kills: 1 }, { wave: 4, kills: 99 }) &&
      isBetterRecord({ wave: 5, kills: 10 }, { wave: 5, kills: 9 }) &&
      !isBetterRecord({ wave: 5, kills: 9 }, { wave: 5, kills: 9 }) &&
      !isBetterRecord({ wave: 4, kills: 99 }, { wave: 5, kills: 0 }) &&
      isBetterRecord({ wave: 1, kills: 0 }, null)); // 首战即纪录
  }
  {
    // 刷点：避墙 + 不贴脸 + 朝远端偏。medium 档 30 张图逐张验。
    const { cols, rows } = MAZE_TIERS.medium;
    let wallOk = true, farOk = true, nullCount = 0;
    for (let t = 0; t < 30; t++) {
      const mz = generateMaze(cols, rows, ["sparse", "symmetric", "rooms"][t % 3]);
      const hero = { x: CELL_SIZE * 0.5, y: CELL_SIZE * 0.5 };            // 玩家在左上角
      const occupied = [hero, { x: CELL_SIZE * 1.5, y: CELL_SIZE * 0.5 }]; // 再放一辆挡着
      const spot = pickSpawnSpot(mz, hero, occupied, () => 0.5);
      if (!spot) { nullCount++; continue; }
      // 落点不嵌墙（resolveCircleWalls 推不动）
      const fixed = resolveCircleWalls(spot.x, spot.y, TANK.radius, mz.walls);
      if (Math.hypot(fixed.x - spot.x, fixed.y - spot.y) > 0.5) wallOk = false;
      // 不贴脸：至少 1 格（最松那级闸门）
      if (occupied.some((o) => Math.hypot(o.x - spot.x, o.y - spot.y) < CELL_SIZE)) wallOk = false;
      // 偏远端：玩家在左上，刷点该落在右下半区（超过对角线一半）
      if (Math.hypot(spot.x - hero.x, spot.y - hero.y) < Math.hypot(cols, rows) * CELL_SIZE * 0.4) farOk = false;
    }
    check("刷点避墙、不贴脸、偏离玩家", wallOk && farOk && nullCount === 0, `null=${nullCount}/30`);
  }
  {
    // 极端场景：满场坦克塞住所有安全距 → 允许放宽，但绝不返回墙里的点
    const mz = generateMaze(MAZE_TIERS.small.cols, MAZE_TIERS.small.rows, "sparse");
    const all = [];
    for (let cy = 0; cy < mz.rows; cy++) {
      for (let cx = 0; cx < mz.cols; cx++) all.push({ x: (cx + 0.5) * CELL_SIZE, y: (cy + 0.5) * CELL_SIZE });
    }
    const spot = pickSpawnSpot(mz, all[0], all, () => 0);
    check("全图被占时返回 null 而不是墙里的点", spot === null);
  }
}

// ============================================================
section("玩家强化池 (upgrades)");
{
  const {
    UPGRADES, neutralMods, pickOffers, applyUpgrade, upgradeById,
    isOfferable, TOTAL_STACKS, fieldCapOf, supplyCountOf,
  } = await import("../src/upgrades.js");
  const { UPGRADE, POWERUP } = await import("../src/config.js");
  const ALL = { types: new Set(POWERUP.types), wallBreak: true };
  const NONE = { types: new Set(), wallBreak: false };
  const mkTank = () => new Tank(100, 100, 0, "#fff");
  // 把某张卡刷到满层（返回实际生效层数）
  const maxOut = (tank, id, taken) => {
    let n = 0;
    while (applyUpgrade(tank, id, taken)) n++;
    return n;
  };

  {
    const ids = UPGRADES.map((u) => u.id);
    const uniq = new Set(ids).size === ids.length;
    const shaped = UPGRADES.every(
      (u) => u.id && u.label && u.desc && Number.isInteger(u.cap) && u.cap >= 1 && typeof u.apply === "function"
    );
    check("卡池 id 唯一、字段齐全、cap ≥ 1", uniq && shaped, `${ids.length} 张 / ${TOTAL_STACKS} 层`);
  }
  {
    // 中性值逐项钉死。这条是**结构护栏**：以后给 Tank 加了 mod 字段却忘了在
    // neutralMods 登记，或偷偷把中性值改成非中性，这里会红。
    const m = neutralMods();
    const ok =
      m.speed === 1 && m.turn === 1 && m.maxAlive === 0 && m.erode === 0 &&
      m.selfSafe === false && m.scatterBonus === 0 && m.laserBonus === 0 &&
      m.mineBonus === 0 && m.shieldBonus === 0 && m.supplyBonus === 0 && m.salvage === 0;
    check("neutralMods 中性值逐项钉死", ok && Object.keys(m).length === 11, `${Object.keys(m).length} 个字段`);
  }
  {
    // 新 Tank 即中性 → pvp/pve/challenge 三个模式的算式退化为原常量
    const a = JSON.stringify(mkTank().mods), b = JSON.stringify(neutralMods());
    check("新建 Tank 的 mods 即中性", a === b);
  }
  {
    // 抽卡：不重复、数量对、注入 rand 后确定
    const offers = pickOffers(new Map(), ALL, 3, () => 0);
    const ids = offers.map((o) => o.id);
    const again = pickOffers(new Map(), ALL, 3, () => 0).map((o) => o.id);
    check("pickOffers 不重复 + 注入 rand 确定", new Set(ids).size === 3 && ids.join() === again.join(), ids.join("/"));
  }
  {
    // 满层的卡不再出现
    const taken = new Map(), t = mkTank();
    maxOut(t, "speed", taken);
    let seen = false;
    for (let i = 0; i < 200; i++) {
      if (pickOffers(taken, ALL, 3, Math.random).some((o) => o.id === "speed")) seen = true;
    }
    check("满层卡不再进抽卡池", !seen && taken.get("speed") === upgradeById("speed").cap);
  }
  {
    // requires：道具全关 + 地形关 → 只剩无条件卡
    const pool = UPGRADES.filter((u) => isOfferable(u, new Map(), NONE)).map((u) => u.id);
    const bad = pool.filter((id) => ["scatterUp", "laserUp", "mineUp", "shieldUp", "supply", "salvage", "drill"].includes(id));
    check("requires 生效（道具/地形全关时空卡缺席）", bad.length === 0 && pool.length > 0, `剩 ${pool.join("/")}`);
  }
  {
    // 全满层 → 抽不出卡（main 走「静默跳过抽卡」分支）
    const taken = new Map(), t = mkTank();
    let total = 0;
    for (const u of UPGRADES) total += maxOut(t, u.id, taken);
    const empty = pickOffers(taken, ALL, 3, Math.random);
    check("全满层返回空数组", empty.length === 0 && total === TOTAL_STACKS, `共 ${total} 层`);
  }
  {
    // 可选卡不足 count 时出剩下的，不补空、不重复
    const taken = new Map(), t = mkTank();
    for (const u of UPGRADES) if (u.id !== "speed" && u.id !== "ammo") maxOut(t, u.id, taken);
    const offers = pickOffers(taken, ALL, 3, Math.random);
    check("可选卡不足时只出剩下的", offers.length === 2 && new Set(offers.map((o) => o.id)).size === 2);
  }
  {
    // 每张卡把目标字段推向预期方向，且到 cap 后不再生效
    const t = mkTank(), taken = new Map();
    const base = neutralMods();
    const dirs = [];
    for (const u of UPGRADES) {
      const before = JSON.stringify(t.mods);
      applyUpgrade(t, u.id, taken);
      dirs.push(JSON.stringify(t.mods) !== before); // 每张卡至少改了一个字段
    }
    const grew =
      t.mods.speed > base.speed && t.mods.turn > base.turn && t.mods.maxAlive > base.maxAlive &&
      t.mods.erode > base.erode && t.mods.selfSafe === true && t.mods.scatterBonus > 0 &&
      t.mods.laserBonus > 0 && t.mods.mineBonus > 0 && t.mods.shieldBonus > 0 &&
      t.mods.supplyBonus > 0 && t.mods.salvage > 0;
    check("每张卡各推一个字段、方向正确", dirs.every(Boolean) && grew);
  }
  {
    const t = mkTank(), taken = new Map();
    const n = maxOut(t, "ammo", taken);
    const refused = applyUpgrade(t, "ammo", taken) === false && taken.get("ammo") === n;
    const unknown = applyUpgrade(t, "nope", taken) === false;
    check("到 cap 后拒绝、未知 id 拒绝", refused && unknown && n === upgradeById("ammo").cap);
  }
  {
    // **一发致死护栏**：全部卡刷到满层后，mods 的键集合必须与中性完全相同，
    // 且 alive 不被任何卡触碰——挡住以后偷偷加「多一条命 / 装甲挡两发」。
    const t = mkTank(), taken = new Map();
    for (const u of UPGRADES) maxOut(t, u.id, taken);
    const keys = Object.keys(t.mods).sort().join(",");
    const neutralKeys = Object.keys(neutralMods()).sort().join(",");
    const noLife = !/lives|hp|armor|health|revive/i.test(JSON.stringify(t.mods) + Object.keys(t.mods).join());
    check("满层后键集合不变 + alive 未被触碰 + 无命值字段", keys === neutralKeys && t.alive === true && noLife);
  }
  {
    // 极速护栏：ai.js interceptTime 的唯一正根前提是「坦克极速 < 弹速」，
    // 满层 speed 必须守住这条，否则 AI 的拦截预判会解出双根/无根。
    const t = mkTank(), taken = new Map();
    maxOut(t, "speed", taken);
    const top = TANK.moveSpeed * t.mods.speed;
    check("满层移速仍低于弹速（拦截预判前提）", top < BULLET.speed, `${top.toFixed(1)} < ${BULLET.speed}`);
  }
  {
    // 扩容卡只加**拾取时的给予量**，不给凭空存货
    const t = mkTank(), taken = new Map();
    maxOut(t, "scatterUp", taken); maxOut(t, "laserUp", taken);
    maxOut(t, "mineUp", taken); maxOut(t, "shieldUp", taken);
    const idle = t.scatterShots === 0 && t.laserShots === 0 && t.mineCharges === 0 && !t.shield;
    t.applyPowerup("scatter");
    const s = t.scatterShots === POWERUP.scatter.shots + UPGRADE.scatterAdd * 2;
    t.applyPowerup("shield");
    const sh = Math.abs(t.shieldTimer - (POWERUP.shield.duration + UPGRADE.shieldAdd * 2)) < 1e-9;
    t.applyPowerup("laser");
    const l = t.laserShots === POWERUP.laser.shots + UPGRADE.laserAdd * 2 && t.scatterShots === 0;
    t.applyPowerup("mine");
    const mn = t.mineCharges === POWERUP.mine.charges + UPGRADE.mineAdd * 2 && t.laserShots === 0;
    check("扩容卡只在拾取时生效 + 武器槽仍互斥", idle && s && sh && l && mn, `散${t.scatterShots}/雷${t.mineCharges}`);
  }
  {
    // 破障弹头：写到子弹实例上（默认 1 = 阶段 18 原行为）
    const plain = new Bullet(0, 0, 1, 0, null);
    const t = mkTank(), taken = new Map();
    const n = maxOut(t, "drill", taken);
    const b = t.spawnBullet(0, []);
    const b0 = mkTank().spawnBullet(0, []);
    check("erodePower 默认 1、破障弹头写实例", plain.erodePower === 1 && b0.erodePower === 1 && b.erodePower === 1 + n);
  }
  {
    // 跳弹免疫：只改「自己的弹能否打自己」，对别人零影响
    const t = mkTank(), taken = new Map();
    const other = mkTank();
    const b = t.spawnBullet(0, []);
    b.bounces = 3; b.age = 5;                       // 已反弹、宽限期早过
    const beforeSelf = b.canHit(t), beforeOther = b.canHit(other);
    applyUpgrade(t, "ricochet", taken);
    check("跳弹免疫只豁免自己", beforeSelf === true && beforeOther === true && b.canHit(t) === false && b.canHit(other) === true);
  }
  {
    // 补给类卡的共同出口（main 与 arena 必须读同一份算式）
    const m = neutralMods();
    const base = fieldCapOf(m) === POWERUP.maxOnField && supplyCountOf({ supply: 1 }, m) === 1;
    m.supplyBonus = 2;
    const up = fieldCapOf(m) === POWERUP.maxOnField + 2 && supplyCountOf({ supply: 2 }, m) === 4;
    const nullSafe = fieldCapOf(null) === POWERUP.maxOnField && supplyCountOf(null, null) === 1;
    check("fieldCapOf/supplyCountOf 单一出口", base && up && nullSafe);
  }
  {
    // PowerupSpawner 的两道门都读实例 cap（否则 supply 卡静默失效）
    const { PowerupSpawner } = await import("../src/powerup.js");
    const sp = new PowerupSpawner(["shield"]);
    const mz = generateMaze(MAZE_TIERS.small.cols, MAZE_TIERS.small.rows, "sparse");
    const field = [];
    while (sp.forceSpawn(mz, field, [])) {}
    const atDefault = field.length === POWERUP.maxOnField;
    sp.cap = POWERUP.maxOnField + 2;
    while (sp.forceSpawn(mz, field, [])) {}
    check("spawner 场上上限走实例 cap", atDefault && field.length === sp.cap, `${field.length} 个`);
  }



}

// ============================================================
section("敌人词条 (waves elite)");
{
  const { eliteStep, eliteCreep, eliteSpec, applyElite } = await import("../src/waves.js");
  const { ENEMY_TRAIT } = await import("../src/config.js");
  const TIERS = ["easy", "normal", "hard"];
  const mkTank = () => new Tank(100, 100, 0, "#fff");

  {
    const steps = Array.from({ length: 40 }, (_, i) => eliteStep(i + 1));
    const zeroEarly = steps.slice(0, ENEMY_TRAIT.from - 1).every((s) => s === 0);
    const mono = steps.every((s, i) => i === 0 || s >= steps[i - 1]);
    const capped = steps.every((s) => s <= ENEMY_TRAIT.stepCap);
    // 台阶落在 6/11/16/21/26（与 remapEvery 同相位：换一张图升一档）
    const edges = [6, 11, 16, 21, 26].every((w, i) => eliteStep(w) === i + 1 && eliteStep(w - 1) === i);
    check("档位：前 5 波恒 0、单调不减、不超 cap、台阶在章界", zeroEarly && mono && capped && edges, steps.slice(0, 30).join(""));
  }
  {
    const zero = Array.from({ length: ENEMY_TRAIT.creepFrom }, (_, i) => eliteCreep(i + 1)).every((c) => c === 0);
    const full = eliteCreep(ENEMY_TRAIT.creepFrom + 1 / ENEMY_TRAIT.creepRate);
    const bounded = Array.from({ length: 60 }, (_, i) => eliteCreep(i + 1)).every((c) => c >= 0 && c <= 1);
    check("连续倍率：creepFrom 前恒 0、上界 1、第 31 波打满", zero && bounded && Math.abs(full - 1) < 1e-9);
  }
  {
    // 难度必须**一路都在动**：这是整个阶段 25 的存在理由。任何相邻两个章界之间
    // 「装备与倍率逐字相同」就是躺平——第 16 波与第 26 波原本就是这样（阶段 24 的
    // 封顶），修掉它才有这一期。把 6/11/16/21/26/31 六个采样点两两钉住。
    const fp = (n) => TIERS.map((t) => JSON.stringify(eliteSpec(n, t))).join("|");
    const marks = [1, 6, 11, 16, 21, 26, 31];
    const moving = marks.every((n, i) => i === 0 || fp(n) !== fp(marks[i - 1]));
    // 而第 31 波之后是刻意的终点（装备到顶 + 倍率打满），必须真的不再变
    const settled = fp(31) === fp(45);
    check("章界处必有增量（1/6/11/16/21/26/31 两两不同），第 31 波后封顶", moving && settled);
  }
  {
    // 第 1~5 波：坦克状态与 mods 逐字不变（词条层对早期波次零影响）
    let same = true;
    for (let n = 1; n < ENEMY_TRAIT.from; n++) {
      for (const tier of TIERS) {
        const t = mkTank(), before = JSON.stringify(t);
        applyElite(t, eliteSpec(n, tier));
        if (JSON.stringify(t) !== before) same = false;
      }
    }
    check("词条前的波次坦克状态逐字不变", same);
  }
  {
    // hard 永不带盾（berserkMode 会让它放弃躲弹，那是它最强的资产）
    // 只有 hard 带激光（低档持激光对玩家不可读）
    let ok = true;
    for (let n = 1; n <= 60; n++) {
      for (const tier of TIERS) {
        const e = eliteSpec(n, tier);
        if (tier === "hard" && e.shield) ok = false;
        if (e.weapon === "laser" && tier !== "hard") ok = false;
        if (e.weapon === "mine") ok = false;              // 敌人永不带雷
      }
    }
    check("档位白名单：hard 无盾 / 激光仅 hard / 永不带雷", ok);
  }
  {
    // 武器互斥 + 永不写 mods.maxAlive（ai.js 把 BULLET.maxAlive-1 硬编码成自己的
    // 弹药预算，给敌人加弹容它不会用，白给）
    let exclusive = true, ammoUntouched = true, capOk = true;
    for (let n = 1; n <= 60; n++) {
      for (const tier of TIERS) {
        const t = mkTank();
        applyElite(t, eliteSpec(n, tier));
        const armed = [t.scatterShots, t.laserShots, t.mineCharges].filter((v) => v > 0).length;
        if (armed > 1) exclusive = false;
        if (t.mods.maxAlive !== 0 || t.mods.selfSafe !== false) ammoUntouched = false;
        if (t.mods.speed > 1 + ENEMY_TRAIT.speedCap + 1e-9 || t.mods.turn > 1 + ENEMY_TRAIT.turnCap + 1e-9) capOk = false;
        if (TANK.moveSpeed * t.mods.speed >= BULLET.speed) capOk = false; // 拦截预判前提
      }
    }
    check("武器互斥 / 不碰弹容与跳弹免疫 / 倍率守界", exclusive && ammoUntouched && capOk);
  }
  {
    // 满档 hard = 激光；满档 normal = 盾 + 加量散射（第 4 档起加量翻倍 → 3+6=9 发）
    const h = mkTank(), nm = mkTank();
    applyElite(h, eliteSpec(40, "hard"));
    applyElite(nm, eliteSpec(40, "normal"));
    const hardOk = h.laserShots > 0 && !h.shield && h.scatterShots === 0;
    const normOk = nm.shield && nm.scatterShots === POWERUP.scatter.shots + ENEMY_TRAIT.scatterBonus * 2
      && nm.laserShots === 0;
    check("满档：hard 持激光无盾 / normal 盾 + 双倍加量散射", hardOk && normOk, `hard 激光${h.laserShots} / normal 散${nm.scatterShots}`);
  }
  {
    // 散射加量分两级：第 3 档 +1 单位、第 4 档起 +2 单位（换成激光后归零）
    const at = (n) => eliteSpec(n, "normal").scatterBonus;
    const laserGone = eliteSpec(26, "hard").scatterBonus === 0;
    check("散射加量两级：16 波 +3 / 21 波起 +6 / 持激光归零",
      at(11) === 0 && at(16) === ENEMY_TRAIT.scatterBonus
      && at(21) === ENEMY_TRAIT.scatterBonus * 2 && at(31) === ENEMY_TRAIT.scatterBonus * 2 && laserGone,
      `${at(11)}/${at(16)}/${at(21)}/${at(31)}`);
  }
  {
    // 持雷超时不适用（敌人不带雷）；带雷时若有人直写 mineCharges 会被 update 清掉，
    // 所以这条顺手把「发装备必须走 applyPowerup」钉住：mineHoldTimer 必须被设上
    const t = mkTank();
    t.applyPowerup("mine");
    t.update(0.016, [], { turn: 0, move: 0 });
    check("发装备走 applyPowerup 才不会被超时清掉", t.mineCharges > 0 && t.mineHoldTimer > 0);
  }
}

// ============================================================
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
