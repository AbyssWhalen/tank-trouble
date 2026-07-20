// ============================================================
// smoke.mjs — 纯逻辑模块冒烟测试(node 直跑,无需浏览器/Electron)
// 运行:npm run smoke
// 覆盖:激光路径几何、tryFire 契约、武器槽互斥、布雷/持雷超时、
//       地雷可见度时间线、子弹反弹、键位表完整性、AI 三档指令冒烟。
// 只测纯逻辑(config/collision/maze/bullet/tank/mine/laser/ai);
// 渲染与交互仍靠 npm start 手动过验收点。
// ============================================================

import { Tank } from "../src/tank.js";
import { Bullet } from "../src/bullet.js";
import { Mine } from "../src/mine.js";
import { castLaserPath } from "../src/laser.js";
import { generateMaze } from "../src/maze.js";
import { AiController } from "../src/ai.js";
import { POWERUP, TANK, KEY_BINDINGS, BULLET } from "../src/config.js";

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
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
