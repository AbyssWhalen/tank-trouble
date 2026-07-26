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
import { generateMaze } from "../src/maze.js";
import { AiController, findBounceShot } from "../src/ai.js";
import { closestPointOnSegment } from "../src/collision.js";
import { POWERUP, TANK, KEY_BINDINGS, BULLET, CELL_SIZE, SFX, PICKUP_RATE } from "../src/config.js";

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
section("音效 spec 表 (SFX/PICKUP_RATE)");
{
  // audio.js 是浏览器专属（Web Audio），smoke 只验 config 里的纯数据表：
  // 事件齐全 + 每层参数在合法区间，接线正确性靠 npm start 实听。
  const expected = [
    "shoot", "shootScatter", "laser", "kill", "shieldBreak", "pickup",
    "mineDeploy", "mineBlast", "roundWin", "roundDraw", "uiClick", "uiError",
  ];
  const names = Object.keys(SFX);
  check("12 个事件名双向齐全",
    expected.every((n) => names.includes(n)) && names.every((n) => expected.includes(n)),
    `实有 ${names.length} 个`);

  const WAVES = ["sine", "square", "sawtooth", "triangle"];
  const FILTERS = ["lowpass", "highpass", "bandpass"];
  let layersOk = true;
  let bad = "";
  for (const [name, layers] of Object.entries(SFX)) {
    if (!Array.isArray(layers) || layers.length < 1 || layers.length > 3) {
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
}

// ============================================================
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
