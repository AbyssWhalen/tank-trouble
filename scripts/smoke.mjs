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
import { POWERUP, TANK, KEY_BINDINGS, BULLET, CELL_SIZE, SFX, PICKUP_RATE, MATCH_TARGET, MAZE_TIERS, MAZE_STYLES, WALL, MAZE_FLOOR, RESERVED_KEYS, UPGRADE, CANVAS } from "../src/config.js";

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

  // —— 界面快捷键黑名单（本次审查修的缺陷）——
  // 原先 RESERVED_KEYS 只有 Esc+F11（「系统语义键」），漏掉了游戏自己在状态机里
  // 硬编码消费的键。KeyR 是四个终局态的「重开」：把移动键绑到 R，结算横幅一出来
  // 手上再点一下前进，刚打完的整场大比分就静默清零重开。
  check("黑名单含四个终局态的重开键 KeyR", RESERVED_KEYS.includes("KeyR"));
  check("黑名单含系统键 Esc/F11", ["Escape", "F11"].every((k) => RESERVED_KEYS.includes(k)));
  // 抽卡浮层的消费处是 `isJustPressed(\`Digit${i+1}\`)`（模板串，grep 搜不到），
  // 上界是 draft.offers.length ⇐ UPGRADE.offers。**这条断言就是那个联动本身**：
  // 把 offers 调到 4 而黑名单写死三个的话，第 4 张卡的数字键会静默脱钩。
  const draftKeys = Array.from({ length: UPGRADE.offers }, (_, i) => `Digit${i + 1}`);
  check(`黑名单覆盖全部抽卡数字键（offers=${UPGRADE.offers}）`,
    draftKeys.every((k) => RESERVED_KEYS.includes(k)), draftKeys.join(","));
  // 默认键位本身不许撞黑名单（撞了就是出厂即坏）
  check("默认四套键位都不在黑名单里",
    !allCodes.some((c) => RESERVED_KEYS.includes(c)));
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

  // —— 阶段 28.3：弹药预算不该拦激光 ——
  // 激光是 hitscan，不产生实体弹也不占 maxAlive（tank.js 的限流对持激光者
  // 整段跳过），所以「自留弹预算」那套立论对它一条都不成立。焊在一起时
  // 「场上自弹占满预算」会让那唯一一发必中激光也开不出来。
  {
    const bot = mkP(new Tank(100, 100, 0, "#222"));
    const enemy = mkP(new Tank(400, 100, Math.PI, "#111"));
    const ai = new AiController(bot, "normal");
    bot.tank.applyPowerup("laser");
    ai.fireTimer = -1;
    // 场上塞满自己的普通弹（非 scatter 才计入预算），把弹药门顶死
    const world = mkWorld(bot, enemy);
    for (let i = 0; i < BULLET.maxAlive + 2; i++) {
      world.bullets.push({ dead: false, owner: bot.tank, kind: "bullet", x: 900, y: 900, vx: 0, vy: 0 });
    }
    const c = ai.update(1 / 60, world);
    check("弹药预算占满时激光照开（激光不占 maxAlive）", c.fire === true,
      `场上自弹 ${world.bullets.length} 发 vs maxAlive ${BULLET.maxAlive}`);
  }
  // 对照：同样占满预算，持普通弹时必须**不**开火（弹药门对普通弹照旧生效）
  {
    const bot = mkP(new Tank(100, 100, 0, "#222"));
    const enemy = mkP(new Tank(400, 100, Math.PI, "#111"));
    const ai = new AiController(bot, "normal");
    ai.fireTimer = -1; // 不发激光，纯普通弹
    const world = mkWorld(bot, enemy);
    for (let i = 0; i < BULLET.maxAlive + 2; i++) {
      world.bullets.push({ dead: false, owner: bot.tank, kind: "bullet", x: 900, y: 900, vx: 0, vy: 0 });
    }
    const c = ai.update(1 / 60, world);
    check("对照：普通弹仍受弹药预算约束（只给激光开的口子）", c.fire === false);
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
section("离散碰撞与出膛钳位 (阶段 28.3)");
{
  // —— ① 子弹分步：60fps 下位移 3px < 弹径 6px 不穿墙，但 main.js 的 dt
  // 钳位上界 0.05s（20fps）对应 9px > 6px——**钳位本身是触发源**。
  // DT_CLAMP 与 main.js:432 的 Math.min(..., 0.05) 是同一个数，改那边要改这里
  const DT_CLAMP = 0.05;
  const perFrame60 = BULLET.speed / 60;
  const perFrameClamp = BULLET.speed * DT_CLAMP;
  check("60fps 下单步位移小于弹径（正常帧率本就不穿墙）",
    perFrame60 < BULLET.radius * 2,
    `${perFrame60.toFixed(1)}px < 弹径 ${BULLET.radius * 2}px`);
  check("dt 钳位上界处位移超过弹径（分步的前提成立，钳位即触发源）",
    perFrameClamp > BULLET.radius * 2,
    `dt=${DT_CLAMP}s → ${perFrameClamp.toFixed(1)}px > 弹径 ${BULLET.radius * 2}px`);

  // 构造那个相位：出发点距墙 4px（落在 3~6px 的穿墙窗口内）。
  // 整步走 9px 会落到墙后 5px——两端都不与墙重叠，中间从未采样 = 穿墙。
  // stepMove 是修复前的行为（单步），update 是修复后（分步），同一发子弹对照。
  {
    const WALLX = 300;
    const mkWall = () => [{ x1: WALLX, y1: -200, x2: WALLX, y2: 200, border: true }];
    // 修复前：直接调 stepMove 走整步
    const bOld = new Bullet(WALLX - 4, 0, BULLET.speed, 0, null);
    bOld.stepMove(DT_CLAMP, mkWall(), false);
    check("整步走会相位穿墙（修复前的病，用 stepMove 复现）",
      bOld.x > WALLX && bOld.vx > 0,
      `x=${bOld.x.toFixed(1)} > 墙 ${WALLX} 且 vx=${bOld.vx.toFixed(0)} 未反弹`);

    // 修复后：同样的 dt 走 update，分步把它拦住
    const bNew = new Bullet(WALLX - 4, 0, BULLET.speed, 0, null);
    bNew.update(DT_CLAMP, mkWall(), false);
    check("分步后同一相位被拦住并反弹（修复生效）",
      bNew.vx < 0 && bNew.x <= WALLX,
      `x=${bNew.x.toFixed(1)} vx=${bNew.vx.toFixed(0)}`);

    // 相位扫描：单个相位过不代表全过——子步长取错（>radius）时，
    // 一部分相位会「跨到墙背面被采到→法线反向→二次反弹回原方向」，
    // 净效果是撞墙不减速穿过去。扫遍 0.1px 精度的全部出发距离。
    //
    // 判据是**否命题**「不许停在墙背面且仍朝墙飞」，不是「必须已反弹」：
    // 还没够着墙的相位本来就不该反弹（circleVsSegment 用 distSq >= r*r，
    // 距离恰好等于弹径算「没碰到」），要求它反弹会把正确行为判成错。
    let swept = 0, tunneled = [];
    for (let d = 0.1; d <= perFrameClamp + BULLET.radius * 2; d += 0.1) {
      const bs = new Bullet(WALLX - d, 0, BULLET.speed, 0, null);
      bs.update(DT_CLAMP, mkWall(), false);
      swept++;
      if (bs.x > WALLX && bs.vx > 0) tunneled.push(`d=${d.toFixed(1)}→x=${bs.x.toFixed(1)}`);
    }
    check("相位扫描：钳位 dt 下无任何相位穿到墙背面",
      tunneled.length === 0,
      `扫 ${swept} 个相位，穿墙 ${tunneled.length}${tunneled.length ? " 例: " + tunneled.slice(0, 3).join(" ") : ""}`);

    // 同一扫描对整步走（修复前）必须**大面积**红——否则这条护栏在测空气
    let oldTunneled = 0;
    for (let d = 0.1; d <= perFrameClamp + BULLET.radius * 2; d += 0.1) {
      const bs = new Bullet(WALLX - d, 0, BULLET.speed, 0, null);
      bs.stepMove(DT_CLAMP, mkWall(), false);
      if (bs.x > WALLX && bs.vx > 0) oldTunneled++;
    }
    check("反证：整步走在同一扫描下确实大量穿墙（护栏不是在测空气）",
      oldTunneled > 20, `整步走穿墙 ${oldTunneled} 个相位`);
  }

  // 分步不改变正常帧率下的物理：60fps 恒为单步，arena 固定 dt 跑分逐字节不变
  {
    const WALLX = 300;
    const walls = [{ x1: WALLX, y1: -200, x2: WALLX, y2: 200, border: true }];
    const b = new Bullet(100, 0, BULLET.speed, 0, null);
    const steps = Math.max(1, Math.ceil((BULLET.speed / 60) / BULLET.radius));
    check("60fps 恒为单步（正常帧零额外开销、跑分逐字节不变）", steps === 1, `steps=${steps}`);
    // 200px 距离 / 3px 每帧 ≈ 67 帧才够走到墙，给 100 帧留余量
    for (let i = 0; i < 100; i++) b.update(1 / 60, walls, false);
    check("正常帧率下照旧反弹（分步是细化不是改物理）",
      b.vx < 0 && b.x < WALLX,
      `x=${b.x.toFixed(1)} vx=${b.vx.toFixed(0)}`);
  }

  // —— ② 出膛钳位：炮口伸出 > 车体半径，贴墙时越到墙背面 = 隔墙杀 ——
  const muzzleReach = TANK.bodyLength / 2 + TANK.barrelLength + BULLET.radius + 2;
  check("炮口伸出确实超过车体半径（钳位的前提成立）",
    muzzleReach > TANK.radius,
    `炮口 ${muzzleReach}px > 车体 ${TANK.radius}px`);

  {
    const WALLX = 200;
    const walls = [{ x1: WALLX, y1: 0, x2: WALLX, y2: 400, hp: 5 }];
    const t = new Tank(WALLX - TANK.radius, 200, 0, "#1ba39c"); // 朝右正顶墙
    const raw = t.muzzlePoint();
    const clamped = t.muzzlePoint(walls);

    check("不传 walls 时贴墙炮口越到墙背面（钳位前的病）",
      raw.x > WALLX, `x=${raw.x.toFixed(1)} 墙在 ${WALLX}`);
    check("传 walls 时出膛点被钳回墙内侧",
      clamped.x < WALLX, `x=${clamped.x.toFixed(1)} < ${WALLX}`);

    // 钳回后出膛点落在射手车体圆内——这正是 fireLaser 必须跳过首段射手的理由
    const dSelf = Math.hypot(clamped.x - t.x, clamped.y - t.y);
    check("钳位后出膛点落在射手车体圆内（首段必须跳过射手）",
      dSelf < TANK.radius, `到车心 ${dSelf.toFixed(1)}px < 半径 ${TANK.radius}px`);

    // 反弹段仍扫回射手：贴墙开激光照旧自杀，与子弹「怼墙开炮弹回来」一致
    const pts = castLaserPath(clamped.x, clamped.y, clamped.angle, walls);
    const bounceSweepsSelf = pts.length > 2 && pts[2].x < t.x && t.x < pts[1].x;
    check("反弹段照旧扫回射手（贴墙开激光仍会自杀，对齐子弹手感)",
      bounceSweepsSelf, `pts[1].x=${pts[1]?.x.toFixed(1)} pts[2].x=${pts[2]?.x.toFixed(1)} 车心=${t.x}`);

    // 远离墙时钳位是空操作——旧调用点语义逐字节不变
    const far = new Tank(50, 200, 0, "#1ba39c");
    const fRaw = far.muzzlePoint();
    const fClamp = far.muzzlePoint(walls);
    check("远离墙时钳位是空操作（旧调用点语义不变）",
      fRaw.x === fClamp.x && fRaw.y === fClamp.y && fRaw.angle === fClamp.angle,
      `${fRaw.x.toFixed(2)} === ${fClamp.x.toFixed(2)}`);
  }

  // —— ③ tryFire 的激光分支必须消费钳位后的出膛点（与预瞄同源）——
  {
    const WALLX = 200;
    const walls = [{ x1: WALLX, y1: 0, x2: WALLX, y2: 400, hp: 5 }];
    const t = new Tank(WALLX - TANK.radius, 200, 0, "#1ba39c");
    t.applyPowerup("laser");
    const res = t.tryFire([], true, walls);
    check("tryFire 激光出膛点已钳位（所见即所打）",
      res.laser !== null && res.laser.x < WALLX,
      `laser.x=${res.laser?.x.toFixed(1)} 墙在 ${WALLX}`);
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

        // 5) 密度区间（内墙数/内部边总数）。下界**引用生成器保证的那个常量**而不是
        //    自己写一个数：阶段 28.1 之前这里硬编码 0.05，而生成器并不保证它——
        //    symmetric×small 有 0.069% 的图落在下面（最薄的是 0 堵内墙的空箱子），
        //    于是这条断言约 2% 的概率在没人改错东西时变红。护栏挪进 generateMaze
        //    （低于下限就重抽）之后，这一条才是确定性的。
        const innerEdges = rows * (cols - 1) + cols * (rows - 1);
        const innerWalls = walls.filter((w) => !w.border).length;
        const density = innerWalls / innerEdges;
        if (density < MAZE_FLOOR.minDensity || density > 0.65) { allOk = false; detail = `${tier} 密度 ${density.toFixed(2)} 出界`; break outer; }

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

  {
    // 退化护栏专项（阶段 28.1）：symmetric×small 是唯一会撞下限的组合（放墙概率的
    // 尾巴 + ensureConnected/enforceSymmetry 只删不加的复利），未修之前 10 万张里
    // 有 69 张低于 0.05、其中 3 张一堵内墙都没有。这里拿 400 张压最坏那一格——
    // 未修的代码在这个样本量下约 24% 会红，修好之后是**构造上**不可能红（生成器
    // 返回前自己检查）。顺带钉住「宁空旷勿无图」：永远拿得到一张图。
    const { cols, rows } = MAZE_TIERS.small;
    const innerEdges = rows * (cols - 1) + cols * (rows - 1);
    let worst = Infinity;
    let always = true;
    for (let i = 0; i < 400; i++) {
      const mz = generateMaze(cols, rows, "symmetric");
      if (!mz || !mz.walls.length) { always = false; break; }
      worst = Math.min(worst, mz.walls.filter((w) => !w.border).length / innerEdges);
    }
    check("空箱子护栏：symmetric×small 400 张的最薄一张也达到 MAZE_FLOOR.minDensity",
      always && worst >= MAZE_FLOOR.minDensity,
      `最薄密度 ${worst.toFixed(3)} ≥ ${MAZE_FLOOR.minDensity}`);
  }
}

// ============================================================
section("胜负条件 (objectives)");
{
  const { OBJECTIVES, evaluate } = await import("../src/objectives.js");
  const { LEVELS: LVS, evaluateObjective: evalObj, objectiveOf } = await import("../src/levels.js");

  // 通用 ctx 骨架：每条断言只覆盖自己关心的字段
  const base = { playerAlive: true, enemiesAlive: 1, quotaLeft: 0, elapsed: 0, holdSecs: 0 };
  const ev = (obj, over) => evaluate(obj, { ...base, ...over });

  {
    check("五型齐备且无多余型",
      Object.keys(OBJECTIVES).sort().join(",") === "clearQuota,eliminate,eliminateTimed,hold,survive",
      Object.keys(OBJECTIVES).join("/"));
  }
  {
    const o = { type: "eliminate" };
    check("eliminate 真值表",
      ev(o, { enemiesAlive: 0 }) === "win" &&
      ev(o, { enemiesAlive: 1 }) === null &&
      ev(o, { enemiesAlive: 3 }) === null);
  }
  {
    const o = { type: "survive", secs: 45 };
    check("survive 真值表（清场提前过关 + 恰好到点算赢）",
      ev(o, { elapsed: 44.99 }) === null &&
      ev(o, { elapsed: 45 }) === "win" &&
      ev(o, { elapsed: 60 }) === "win" &&
      ev(o, { enemiesAlive: 0, elapsed: 1 }) === "win");
  }
  {
    const o = { type: "eliminateTimed", secs: 120 };
    check("eliminateTimed 真值表（清场优先于超时）",
      ev(o, { elapsed: 119.99 }) === null &&
      ev(o, { elapsed: 120 }) === "lose" &&
      ev(o, { enemiesAlive: 0, elapsed: 999 }) === "win");
  }
  {
    const o = { type: "clearQuota" };
    check("clearQuota 真值表（配额清零但场上有敌不算过）",
      ev(o, { quotaLeft: 0, enemiesAlive: 0 }) === "win" &&
      ev(o, { quotaLeft: 0, enemiesAlive: 1 }) === null &&
      ev(o, { quotaLeft: 3, enemiesAlive: 0 }) === null &&
      ev(o, { quotaLeft: Infinity, enemiesAlive: 0 }) === null); // 守点波的无限配额
  }
  {
    const o = { type: "hold", secs: 12 };
    check("hold 真值表（差 0.01 秒不算过，且无失败态）",
      ev(o, { holdSecs: 11.99 }) === null &&
      ev(o, { holdSecs: 12 }) === "win" &&
      ev(o, { holdSecs: 12.5 }) === "win" &&
      ev(o, { holdSecs: 0, elapsed: 9999, enemiesAlive: 3 }) === null); // 熬多久都不判负
  }
  {
    // 红线：玩家死优先于任何达成——五型 × 各自「本该赢」的 ctx 必须全部 lose。
    // 同时反向确认那些 ctx 在活着时**真的**是 win（否则这条会因为写错 ctx 而空过）
    const wins = [
      [{ type: "eliminate" }, { enemiesAlive: 0 }],
      [{ type: "survive", secs: 45 }, { elapsed: 99 }],
      [{ type: "eliminateTimed", secs: 120 }, { enemiesAlive: 0 }],
      [{ type: "clearQuota" }, { quotaLeft: 0, enemiesAlive: 0 }],
      [{ type: "hold", secs: 12 }, { holdSecs: 99 }],
    ];
    check("玩家死优先于达成（五型全覆盖）",
      wins.length === Object.keys(OBJECTIVES).length &&
      wins.every(([o, over]) => ev(o, { ...over, playerAlive: false }) === "lose") &&
      wins.every(([o, over]) => ev(o, over) === "win"),
      `${wins.length} 型`);
  }
  {
    check("坏输入不抛：未知型退化 eliminate / 空 ctx 判负 / 缺 secs 不白送",
      ev({ type: "nope" }, { enemiesAlive: 0 }) === "win" &&
      ev({ type: "nope" }, { enemiesAlive: 1 }) === null &&
      ev(undefined, { enemiesAlive: 0 }) === "win" &&
      ev({}, { enemiesAlive: 0 }) === "win" &&
      evaluate({ type: "eliminate" }, null) === "lose" &&
      evaluate({ type: "eliminate" }, undefined) === "lose" &&
      // 缺 secs 的计时型：宁可继续跑，不白送一个 win 也不白判一个 lose
      ev({ type: "survive" }, { elapsed: 1e9 }) === null &&
      ev({ type: "eliminateTimed" }, { elapsed: 1e9 }) === null &&
      ev({ type: "hold" }, { holdSecs: 1e9 }) === null &&
      ev({ type: "survive", secs: "45" }, { elapsed: 1e9 }) === null);
  }
  {
    // 桥接封闭性：8 关翻出来的 type 必须都在表里（关卡表加新目标时这条先红）
    const mapped = LVS.map((l) => objectiveOf(l).type);
    const secsOk = LVS.every((l) => {
      const o = objectiveOf(l);
      return o.type === "eliminate" ? o.secs === undefined : o.secs > 0;
    });
    check("关卡表 → objectives 映射封闭且秒数齐备",
      mapped.every((t) => t in OBJECTIVES) && secsOk, [...new Set(mapped)].join("/"));
  }
  {
    // 等价护栏（钉住阶段 27 的重构本身）：8 关 × ctx 网格跑薄壳化后的
    // evaluateObjective，与照旧 switch 手写的参照实现逐格比对。这条一红说明
    // **重构改了语义**，与「新功能没做完」是两种不同的失败，必须能分开。
    const ref = (level, c) => {
      if (!c.playerAlive) return "lose";
      const m = level.mutators || {};
      if (level.objective === "survive") {
        if (c.enemiesAlive === 0) return "win";
        return c.elapsed >= (m.surviveTime ?? 60) ? "win" : null;
      }
      if (level.objective === "eliminateTimed") {
        if (c.enemiesAlive === 0) return "win";
        return c.elapsed >= (m.timeLimit ?? 120) ? "lose" : null;
      }
      return c.enemiesAlive === 0 ? "win" : null;
    };
    let cases = 0, bad = null;
    for (const level of LVS) {
      const secs = objectiveOf(level).secs ?? 60;
      for (const playerAlive of [true, false])
        for (const enemiesAlive of [0, 1, 2])
          for (const elapsed of [0, secs - 0.1, secs, secs + 5]) {
            const c = { playerAlive, enemiesAlive, elapsed };
            cases++;
            const got = evalObj(level, c), want = ref(level, c);
            if (got !== want && !bad) bad = `第 ${level.id} 关 ${JSON.stringify(c)} → ${got} ≠ ${want}`;
          }
    }
    check("等价护栏：8 关 × ctx 网格与参照实现逐格全等", !bad, bad || `${cases} 格`);
  }
}

// ============================================================
section("关卡表与过关判定 (levels)");
{
  const { LEVELS, LEVEL_COUNT, evaluateObjective, normalizeProgress } = await import("../src/levels.js");
  const { MAZE_STYLES, AI_DIFFICULTY, PLAYER_COLORS } = await import("../src/config.js");

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
    // 配色不撞玩家：`setupRound` 的关卡分支给敌人发 `PLAYER_COLORS[(i+1) % 4]`。
    // 关卡照旧用玩家表（阶段 28 明确不换挑战关配色，`ENEMY_COLORS` 前三位与
    // `PLAYER_COLORS[1..3]` 逐字节相同，所以现状渲染两者等价），但那个 `%` 意味着
    // **第 4 个敌人会拿到 0 号 = 玩家的青绿**，屏幕上分不出哪辆是自己。
    // 现在关卡表最多 3 个敌人所以够用，这条门是给「以后有人加第 4 个敌人」留的：
    // 与其改一处现在没病的代码，不如让越界那一刻有个说得清原因的红。
    const maxFoes = Math.max(...LEVELS.map((l) => l.enemies.length));
    check("关卡敌人数不会让配色回绕撞上玩家色",
      maxFoes + 1 <= PLAYER_COLORS.length,
      `最多 ${maxFoes} 敌 + 玩家 vs ${PLAYER_COLORS.length} 色`);
  }
  {
    const elim = { objective: "eliminate", mutators: {} };
    check("歼灭关真值表",
      evaluateObjective(elim, { playerAlive: true, enemiesAlive: 0, elapsed: 0 }) === "win" &&
      evaluateObjective(elim, { playerAlive: true, enemiesAlive: 1, elapsed: 0 }) === null &&
      evaluateObjective(elim, { playerAlive: false, enemiesAlive: 1, elapsed: 0 }) === "lose" &&
      evaluateObjective(elim, { playerAlive: false, enemiesAlive: 0, elapsed: 0 }) === "lose"); // 同归=败
  }
  {
    const surv = { objective: "survive", mutators: { surviveTime: 45 } };
    check("生存关真值表（含歼灭提前过关）",
      evaluateObjective(surv, { playerAlive: true, enemiesAlive: 1, elapsed: 44 }) === null &&
      evaluateObjective(surv, { playerAlive: true, enemiesAlive: 1, elapsed: 45 }) === "win" &&
      evaluateObjective(surv, { playerAlive: true, enemiesAlive: 0, elapsed: 10 }) === "win" &&
      evaluateObjective(surv, { playerAlive: false, enemiesAlive: 1, elapsed: 50 }) === "lose");
  }
  {
    // 注意 elapsed 是**已过**秒数（阶段 27 起单一语义）：超时 = elapsed 追上上限，
    // 不再是「倒计时归零」
    const timed = { objective: "eliminateTimed", mutators: { timeLimit: 90 } };
    check("限时歼灭关真值表",
      evaluateObjective(timed, { playerAlive: true, enemiesAlive: 0, elapsed: 10 }) === "win" &&
      evaluateObjective(timed, { playerAlive: true, enemiesAlive: 1, elapsed: 10 }) === null &&
      evaluateObjective(timed, { playerAlive: true, enemiesAlive: 1, elapsed: 89.9 }) === null &&
      evaluateObjective(timed, { playerAlive: true, enemiesAlive: 1, elapsed: 90 }) === "lose");
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
  const {
    normalizeStats, accuracy, accuracyDelta, favoriteWeapon, updateStreak,
    FIRED_WEAPONS, DEPLOY_WEAPONS, recordFired, recordKill, recordHit, getStats,
  } = await import("../src/stats.js");

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

  // —— 命中率口径：分子分母必须同口径（本次审查修的缺陷）——
  // 原先 recordKill 无条件 hits+1，而地雷不计 fired，于是「1 发子弹命中 + 1 次雷杀」
  // 算出 2/1 = 200%。修法不是把显示钳到 100%（那是遮住统计错误），而是把地雷
  // 移出分子。这两条护栏一起把「钳位」和「口径」分开钉死。
  {
    check("本场命中率：没开过火返回 null（横幅据此跳过，与 0% 不是一回事）",
      accuracyDelta({ fired: 0, hits: 0 }, { fired: 0, hits: 0 }) === null
      && accuracyDelta({ fired: 5, hits: 2 }, { fired: 5, hits: 2 }) === null);
    check("本场命中率与 accuracy 同源钳位（不会出现终身 100% 而本场 200%）",
      accuracyDelta({ fired: 1, hits: 2 }, { fired: 0, hits: 0 }) === 1
      && accuracyDelta({ fired: 4, hits: 3 }, { fired: 0, hits: 0 }) === 0.75);
    // 基线做差：负数（理论上不该出现）也钳到 0，不显示负命中率
    check("本场命中率负值钳到 0", accuracyDelta({ fired: 2, hits: 0 }, { fired: 1, hits: 1 }) === 0);
  }
  {
    // 结构护栏：两张表无交（部署型的雷不算发射数，射击型不算部署数）
    const overlap = FIRED_WEAPONS.filter((w) => DEPLOY_WEAPONS.includes(w));
    check("射击型与部署型武器表无交", overlap.length === 0, overlap.join(","));
    // 结构护栏：两张表并起来**恰好**是 normalizeStats 认得的全部武器键。
    // 这条是防「新增武器忘了登记」：漏登记会让新武器静默落进命中率分子或分母，
    // 把这个刚修好的 bug 原样放回来。写黑名单（`weapon !== "mine"`）就没有这道门。
    const allKeys = Object.keys(normalizeStats(null).players[0].kills).sort();
    const covered = [...FIRED_WEAPONS, ...DEPLOY_WEAPONS].sort();
    check("武器分流表覆盖全部击杀键且无遗漏",
      covered.length === allKeys.length && covered.every((w, i) => w === allKeys[i]),
      covered.join(","));
    check("地雷被归为部署型（不进命中率分子）", DEPLOY_WEAPONS.includes("mine"));
  }
  {
    // 端到端口径复现：原先这一串算出 200%
    const base = getStats().players[0];
    const b0 = { fired: base.fired, hits: base.hits, mine: base.kills.mine };
    recordFired(0, 1);            // 1 发子弹
    recordKill(0, "bullet");      // 打死了 → 进分子
    recordKill(0, "mine");        // 雷杀 → 只记 kills.mine，**不进**分子
    const p = getStats().players[0];
    check("1 发命中 + 1 次雷杀 = 100%（不是 200%）",
      p.fired - b0.fired === 1 && p.hits - b0.hits === 1
      && p.kills.mine - b0.mine === 1,
      `fired+${p.fired - b0.fired} hits+${p.hits - b0.hits} mine+${p.kills.mine - b0.mine}`);
    check("地雷击杀照旧计入 favoriteWeapon 的击杀数（只是不进分子）",
      p.kills.mine === b0.mine + 1);
  }
  {
    // 破盾那条路径与击杀同源：地雷破盾同样不进分子（只修击杀会漏掉这条）。
    // **两条各自重新取基线**：共用一个基线的话，前一条一旦红掉就会把后一条
    // 也带红（stats 是模块单例，前一条的副作用留在里头）——那是假红，
    // 会让人去修一个没坏的东西（阶段 28.2 的变异测试教训）。
    const hitsNow = () => getStats().players[0].hits;
    const beforeMine = hitsNow();
    recordHit(0, "mine");
    check("地雷破盾不进命中率分子", hitsNow() === beforeMine);
    const beforeBullet = hitsNow();
    recordHit(0, "bullet");
    check("子弹破盾照常进分子", hitsNow() === beforeBullet + 1);
  }
}

// ============================================================
section("统计接线静态扫描 (recordHit/recordKill 调用点)");
{
  // recordHit 从 (playerIndex) 改成 (playerIndex, weapon) 之后，**漏传 weapon 是
  // 静默的**：countsAsHit(undefined) 为假 ⇒ 这一发命中直接不计，命中率悄悄偏低，
  // 不崩不报错，跑分也看不出来（arena 压根不写 stats）。这正是本仓库「静态属性
  // 扫描」那条门针对的同一族缺陷（阶段 28.2 的 TANK.speed），所以用同一个办法。
  const { readFileSync, readdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const ROOT2 = join(dirname(fileURLToPath(import.meta.url)), "..");
  const srcFiles = readdirSync(join(ROOT2, "src")).filter((f) => f.endsWith(".js"));

  const bad = [];
  let callSites = 0;
  for (const f of srcFiles) {
    readFileSync(join(ROOT2, "src", f), "utf8").replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // 整行注释跳过
      for (const fn of ["recordHit", "recordKill"]) {
        const re = new RegExp("\\b" + fn + "\\(([^)]*)\\)", "g");
        let m;
        while ((m = re.exec(line))) {
          callSites++;
          // 两个参数都是简单表达式（索引与武器名），顶层逗号计数就够判
          if (m[1].split(",").length !== 2) bad.push(`src/${f}:${i + 1} ${fn}(${m[1]})`);
        }
      }
    });
  }
  // 取样面非空：这条门自己得先证明它扫到了东西，否则是一条恒绿的空断言
  check("扫到了 recordHit/recordKill 的调用点与定义", callSites >= 4, `${callSites} 处`);
  check("recordHit/recordKill 的每一处都传了 weapon（漏传会静默少计命中）",
    bad.length === 0, bad.slice(0, 3).join(" / "));
}

// ============================================================
section("波次曲线 (waves)");
{
  const {
    waveSpec, pickEnemyLevel, chapterOf, shouldRemap, pickSpawnSpot,
    normalizeWaveBest, isBetterRecord, MIX_KEYS, WAVE_TIERS,
  } = await import("../src/waves.js");
  const { WAVE, TIER_POOL_BY_MODE, PLAYER_COLORS, ENEMY_COLORS } = await import("../src/config.js");

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
    // —— 同屏曲线：冻结表 + 尾段台阶（阶段 28）——
    // 硬顶从 3 抬到 5，但**最重要的断言不是「尾段能爬」而是「中段一个字节没动」**：
    // CLAUDE.md 记的阶段 26/27/27.1 全部基线都是波次 1~35 的读数，它们要继续当回归
    // 护栏就必须逐位不变。这一条一红 = 尾段改动漏进了中段（例如漏掉 concurrentEarlyCap）。
    const long = Array.from({ length: 60 }, (_, i) => waveSpec(i + 1).concurrent);
    const frozen = [...Array(5).fill(1), ...Array(5).fill(2), ...Array(25).fill(3)];
    check("波次 1~35 同屏数逐位冻结（阶段 26/27 基线仍是回归护栏）",
      long.slice(0, 35).every((v, i) => v === frozen[i]),
      `1~35: ${long.slice(0, 35).join(",")}`);
    check("尾段台阶：36~45 恒 4、46~60 恒 5",
      long.slice(35, 45).every((v) => v === 4) && long.slice(45).every((v) => v === 5),
      `36/41/46/60 → ${[long[35], long[40], long[45], long[59]].join(",")}`);
    check("同屏硬顶 ≤ 敌人配色数（替代旧的「PLAYER_COLORS 只有 4 色」耦合）",
      WAVE.concurrentCap <= ENEMY_COLORS.length,
      `cap ${WAVE.concurrentCap} vs ${ENEMY_COLORS.length} 色`);
    check("尾段台阶落在章节第一波上（台阶落章界这条既有规则照旧）",
      shouldRemap(WAVE.concurrentLateFrom), `lateFrom=${WAVE.concurrentLateFrom}`);
  }
  {
    // 敌人配色表（阶段 28）：前三位与 PLAYER_COLORS[1..3] 逐字节相同，所以波次 1~35
    // 与挑战关的每一帧渲染都不变。这一条一红 = 有人重排了配色表 = 那些帧被动了。
    check("ENEMY_COLORS 前三位 === PLAYER_COLORS[1..3]（旧帧渲染逐字节不变）",
      ENEMY_COLORS.slice(0, 3).join(",") === PLAYER_COLORS.slice(1, 4).join(","),
      `${ENEMY_COLORS.slice(0, 3).join("/")} vs ${PLAYER_COLORS.slice(1, 4).join("/")}`);
    const hex = /^#[0-9a-f]{6}$/;
    check("敌人配色：五色互不相同、格式合法、且都不是玩家青绿",
      new Set(ENEMY_COLORS).size === ENEMY_COLORS.length &&
      ENEMY_COLORS.every((c) => hex.test(c)) &&
      ENEMY_COLORS.every((c) => c !== PLAYER_COLORS[0]),
      ENEMY_COLORS.join("/"));
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
section("守点区域 (zone/hold)");
{
  const { isHoldWave, holdNeed, waveObjective, waveSpec, shouldRemap } = await import("../src/waves.js");
  const { pickZoneSpot, HoldZone } = await import("../src/zone.js");
  const { HOLD, WAVE } = await import("../src/config.js");
  const { OBJECTIVES } = await import("../src/objectives.js");

  const holdWaves = [];
  for (let n = 1; n <= 40; n++) if (isHoldWave(n)) holdWaves.push(n);

  {
    // 相位：从 HOLD 常量推期望集合（改旋钮时断言跟着走），再单独钉住出厂节奏
    const expect = [];
    for (let n = 1; n <= 40; n++) if (n >= HOLD.from && (n - HOLD.from) % HOLD.every === 0) expect.push(n);
    const notHold = [1, 2, 3, 4, 6, 7, 8, 9, 11, 31].every((n) => !isHoldWave(n));
    check("守点波相位与 HOLD 常量一致，非守点波为假",
      holdWaves.join(",") === expect.join(",") && notHold, `hold: ${holdWaves.join("/")}`);
    check("出厂节奏恰好是 5/10/15/20/25/30",
      holdWaves.slice(0, 6).join("/") === "5/10/15/20/25/30");
    check("非整数/非法波号不误判", !isHoldWave(4.9) && isHoldWave(5.4) && !isHoldWave(0) && !isHoldWave(-5));
  }
  {
    // 承重不变量：守点波恒落在章尾 → 守住过关 → 抽卡 → 下一波换图进新章
    const atTail = holdWaves.every((n) => shouldRemap(n + 1));
    check("守点波恒落在章尾（下一波必换图）", atTail && HOLD.every === WAVE.remapEvery,
      `every=${HOLD.every} remapEvery=${WAVE.remapEvery}`);
  }
  {
    const needs = holdWaves.map((n) => holdNeed(n));
    const mono = needs.every((v, i) => i === 0 || v >= needs[i - 1]);
    const capped = needs.every((v) => v <= HOLD.needCap);
    const zeroed = [1, 4, 6, 11, 31].every((n) => holdNeed(n) === 0);
    check("守点秒数单调不减、钳在 needCap、非守点波为 0",
      mono && capped && zeroed && holdNeed(HOLD.from) === HOLD.needBase,
      `needs: ${needs.join("/")} cap ${HOLD.needCap}`);
    check("秒数按「第几个守点波」算而不是按波号",
      holdNeed(HOLD.from + HOLD.every) === HOLD.needBase + HOLD.needStep);
  }
  {
    const typeOk = [];
    for (let n = 1; n <= 40; n++) {
      const o = waveObjective(n);
      typeOk.push(o.type === (isHoldWave(n) ? "hold" : "clearQuota"));
      if (o.type === "hold" && o.secs !== holdNeed(n)) typeOk.push(false);
      if (o.type === "clearQuota" && "secs" in o) typeOk.push(false);
    }
    const inTable = [...new Set([1, 5, 10].map((n) => waveObjective(n).type))].every((t) => t in OBJECTIVES);
    check("waveObjective 与相位/秒数一致且类型在 OBJECTIVES 表内",
      typeOk.every(Boolean) && inTable);
  }
  {
    // 结构护栏（照 neutralMods 那条的范式）：守点字段不许塞进 waveSpec 的返回值。
    // 「这一波什么规格」与「这一波什么规则」是两个出口，搅在一起以后必然有人只改一处
    const FROZEN = ["wave", "quota", "concurrent", "mix", "tier", "supply"].sort().join(",");
    const keysOk = [1, 5, 10, 16, 31].every((n) => Object.keys(waveSpec(n)).sort().join(",") === FROZEN);
    check("waveSpec 键集合逐字不变（守点走独立出口）", keysOk,
      `keys=${Object.keys(waveSpec(10)).sort().join(",")}`);
  }
  {
    // 选点：3 风格 × 3 档 × 30 张图。玩家在左上角时严格落在 [minCells, maxCells]
    const tiers = ["small", "medium", "large"];
    let nullCount = 0, wallBad = 0, bandBad = 0, total = 0;
    for (let t = 0; t < 30; t++) {
      for (const tier of tiers) {
        const { cols, rows } = MAZE_TIERS[tier];
        const mz = generateMaze(cols, rows, ["sparse", "symmetric", "rooms"][t % 3]);
        const hero = { x: CELL_SIZE * 0.5, y: CELL_SIZE * 0.5 };
        const spot = pickZoneSpot(mz, hero, () => 0.5);
        total++;
        if (!spot) { nullCount++; continue; }
        const fixed = resolveCircleWalls(spot.x, spot.y, TANK.radius, mz.walls);
        if (Math.hypot(fixed.x - spot.x, fixed.y - spot.y) > 0.5) wallBad++;
        const d = Math.hypot(spot.x - hero.x, spot.y - hero.y) / CELL_SIZE;
        if (d < HOLD.minCells - 1e-9 || d > HOLD.maxCells + 1e-9) bandBad++;
      }
    }
    check("选点永不 null、不嵌墙、严格落在距离区间",
      nullCount === 0 && wallBad === 0 && bandBad === 0,
      `${total} 图 null=${nullCount} 嵌墙=${wallBad} 越界=${bandBad}`);
  }
  {
    // 玩家站图心的小图：严格区间可能空 → 放宽档生效，但仍不许贴脸、不许嵌墙
    const { cols, rows } = MAZE_TIERS.small;
    let ok = true;
    for (let t = 0; t < 20; t++) {
      const mz = generateMaze(cols, rows, ["sparse", "symmetric", "rooms"][t % 3]);
      const hero = { x: (cols / 2) * CELL_SIZE, y: (rows / 2) * CELL_SIZE };
      const spot = pickZoneSpot(mz, hero, () => 0.9);
      if (!spot) { ok = false; continue; }
      const d = Math.hypot(spot.x - hero.x, spot.y - hero.y) / CELL_SIZE;
      if (d < HOLD.minCells * 0.7 - 1e-9) ok = false;
      const fixed = resolveCircleWalls(spot.x, spot.y, TANK.radius, mz.walls);
      if (Math.hypot(fixed.x - spot.x, fixed.y - spot.y) > 0.5) ok = false;
    }
    check("玩家居中的小图：放宽后仍不贴脸不嵌墙", ok);
  }
  {
    // 兜底：极小图 + 玩家在图心（严格区间与放宽档都空）也必须给出一个点
    const mz = generateMaze(3, 3, "sparse");
    const spot = pickZoneSpot(mz, { x: CELL_SIZE * 1.5, y: CELL_SIZE * 1.5 }, () => 0);
    check("3×3 极小图也不返回 null（圈是唯一过波途径，null = 死局）", !!spot);
  }
  {
    const mz = generateMaze(MAZE_TIERS.medium.cols, MAZE_TIERS.medium.rows, "sparse");
    const hero = { x: CELL_SIZE * 0.5, y: CELL_SIZE * 0.5 };
    const a = pickZoneSpot(mz, hero, () => 0.31);
    const b = pickZoneSpot(mz, hero, () => 0.31);
    check("选点确定性（同 rand 同解）", a.x === b.x && a.y === b.y);
  }
  {
    const z = new HoldZone(500, 500, 12);
    const r = z.radius;
    check("圈半径按 HOLD.radius 换算，按车心判定",
      Math.abs(r - HOLD.radius * CELL_SIZE) < 1e-9 &&
      z.contains(500, 500) && z.contains(500 + r - 1, 500) && !z.contains(500 + r + 1, 500));
  }
  {
    const z = new HoldZone(0, 0, 3);
    const inHero = { x: 0, y: 0, alive: true };
    for (let i = 0; i < 10; i++) z.update(1 / 60, inHero);
    const after = z.progress;
    check("圈内累计（10 帧 ≈ 0.167s）且 inside 为真",
      near(after, 10 / 60, 1e-6) && z.inside === true, `progress=${after.toFixed(4)}`);
    // 出圈冻结：多帧 update 后逐位不变（不是「衰减很慢」，是一点不动）
    const outHero = { x: 9999, y: 0, alive: true };
    for (let i = 0; i < 30; i++) z.update(1 / 60, outHero);
    check("出圈冻结不衰减（30 帧后 progress 逐位不变）",
      z.progress === after && z.inside === false);
  }
  {
    const z = new HoldZone(0, 0, 2);
    const hero = { x: 0, y: 0, alive: true };
    check("未守满时 done 为假、ratio 在 [0,1]", !z.done && z.ratio === 0);
    for (let i = 0; i < 60; i++) z.update(1 / 30, hero);   // 2s 需求，喂 2s
    check("恰好守满即 done，progress 钳在 need 不越界",
      z.done && z.progress === 2 && z.ratio === 1);
    for (let i = 0; i < 60; i++) z.update(1 / 30, hero);   // 再喂 2s
    check("守满后继续 update 不越界", z.progress === 2 && z.ratio === 1);
  }
  {
    const z = new HoldZone(0, 0, 5);
    z.update(0.5, { x: 0, y: 0, alive: false });           // 死人不记账
    const dead = z.progress;
    z.update(0.5, null);                                    // 缺 hero 不抛
    z.update(0.5, undefined);
    check("死亡/缺失的 hero 不累计且不抛", dead === 0 && z.progress === 0 && z.inside === false);
    const bad = new HoldZone(0, 0, -3);                     // 坏 need 退化成 0
    check("坏 need 退化成 0 且 ratio 不 NaN", bad.need === 0 && bad.ratio === 1 && bad.done);
  }
  {
    // 守点条件本身没有失败态：站在圈外挨打 9999 秒也只是「继续打」
    const c = { playerAlive: true, enemiesAlive: 3, quotaLeft: Infinity, elapsed: 9999, holdSecs: 0 };
    check("hold 无失败态（唯一的失败仍然是死）",
      OBJECTIVES.hold(c, { secs: 12 }) === null &&
      OBJECTIVES.hold({ ...c, holdSecs: 12 }, { secs: 12 }) === "win");
  }
}

// ============================================================
// 转场清理与渲染契约：两条都是「一个模块级单例 / 一个 ctx 调用顺序」，
// 单元级能钉死，而实机只能看出「画面在抖」「圈溢出去了」这种模糊症状。
section("转场清理与渲染裁剪 (effects/zone)");
{
  const { addShake, updateShake, shakeOffset, resetShake } = await import("../src/effects.js");
  const { HoldZone } = await import("../src/zone.js");

  // shakeOffset 每帧随机方向，单帧可能恰好接近 0 → 采样取最大绝对值
  const peak = (n = 40) => {
    let m = 0;
    for (let i = 0; i < n; i++) {
      const o = shakeOffset();
      m = Math.max(m, Math.abs(o.x), Math.abs(o.y));
    }
    return m;
  };

  {
    resetShake();
    check("初始态无震动", peak() === 0);
    addShake(6, 0.5);
    check("addShake 后有偏移", peak() > 0);
    updateShake(0.6);                       // 自然排空（updateEffects 的正常路径）
    check("updateShake 排空后归零", peak() === 0);
  }
  {
    // 本体：MENU 不跑 updateEffects、PAUSED 刻意不推进，所以「击杀后立刻 Esc 回菜单
    // 再开一局」只能靠 resetShake 排空——否则余震漏进新一局的 3-2-1 冻结开场
    addShake(6, 0.5);
    resetShake();
    check("resetShake 立刻抹平（新一局不继承上一局的镜头状态）", peak() === 0);
    // 顺带钉住 addShake 的 `mag >= remain` 闸门没被冻结的余量堵住：
    // 不清的话 mag 6 的余震会吞掉新一局第一次 mag 5 的击杀震动
    addShake(5, 0.4);
    check("清空后新震动能注册（不被旧余量吞掉）", peak() > 0);
    resetShake();
  }
  {
    // ctx 录音机：zone.render 只调 ctx 的方法/写属性，故可用 Proxy 全记
    const mkCtx = () => {
      const calls = [];
      const ctx = new Proxy({}, {
        get: (t, k) => (k in t ? t[k] : (...a) => { calls.push(k); return undefined; }),
        set: (t, k, v) => { t[k] = v; return true; },
      });
      return { ctx, calls };
    };
    const z = new HoldZone(100, 100, 12);

    const withClip = mkCtx();
    z.render(withClip.ctx, 864, 672);
    const noClip = mkCtx();
    z.render(noClip.ctx);

    check("传竞技场尺寸时裁剪（圈半径 0.95 格 > 半格，贴边的圈会溢出场外）",
      withClip.calls.includes("clip") && withClip.calls.includes("rect"));
    check("不传尺寸时不裁剪（默认参数 0 = 不裁，旧调用点语义不变）",
      !noClip.calls.includes("clip"));
    // 顺序是承重的：clip 必须在 translate 之前，否则裁剪矩形落在圈局部坐标系里
    check("裁剪在 translate 之前（矩形是世界坐标不是圈局部坐标）",
      withClip.calls.indexOf("clip") < withClip.calls.indexOf("translate"));
    check("裁剪不影响三层绘制本身",
      withClip.calls.includes("arc") && withClip.calls.includes("fill") &&
      withClip.calls.includes("stroke") && withClip.calls.includes("restore"));
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
  const { eliteStep, eliteCreep, eliteSpec, applyElite, laserCapAt, countArmedLasers } = await import("../src/waves.js");
  const { ENEMY_TRAIT, WAVE } = await import("../src/config.js");
  const TIERS = ["easy", "normal", "hard"];
  const mkTank = () => new Tank(100, 100, 0, "#fff");

  {
    const steps = Array.from({ length: 40 }, (_, i) => eliteStep(i + 1));
    const zeroEarly = steps.slice(0, ENEMY_TRAIT.from - 1).every((s) => s === 0);
    const mono = steps.every((s, i) => i === 0 || s >= steps[i - 1]);
    const capped = steps.every((s) => s <= ENEMY_TRAIT.stepCap);
    // 台阶落在 6/11/16/21/26/31（与 remapEvery 同相位：换一张图升一档）
    const edges = [6, 11, 16, 21, 26, 31].every((w, i) => eliteStep(w) === i + 1 && eliteStep(w - 1) === i);
    check("档位：前 5 波恒 0、单调不减、不超 cap、台阶在章界", zeroEarly && mono && capped && edges, steps.slice(0, 30).join(""));
  }
  {
    const zero = Array.from({ length: ENEMY_TRAIT.creepFrom }, (_, i) => eliteCreep(i + 1)).every((c) => c === 0);
    // ceil：creepRate 不必是 1/整数（0.045 → 22.2 波爬满），波号只取整数，所以取上界那一波
    const full = eliteCreep(ENEMY_TRAIT.creepFrom + Math.ceil(1 / ENEMY_TRAIT.creepRate));
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
  {
    // 激光配额（阶段 26）：同屏已上膛激光兵上限 0 → 1(21波) → 2(26波) → 3(31波起)，
    // 且永不超过同屏上限（否则配额写了个到不了的数）
    const caps = [1, 6, 11, 16, 21, 26, 31, 45].map((n) => laserCapAt(eliteStep(n)));
    const mono = caps.every((c, i) => i === 0 || c >= caps[i - 1]);
    const bounded = caps.every((c) => c <= WAVE.concurrentCap);
    check("激光配额：21/26/31 波 1/2/3 把，之前恒 0，单调且不超同屏上限",
      caps.join(",") === "0,0,0,0,1,2,3,3" && mono && bounded, caps.join(","));
  }
  {
    // 阶段 28 起硬顶是 5，于是 laserCapAt 里那个 Math.min(…, concurrentCap) 变成空操作，
    // 「第 4 位同屏 hitscan 狙击手不许存在」这条护栏必须**显式**挂一次（原先是靠 cap
    // 顺手夹住的）。第 4 位同屏激光兵正是阶段 26 拆掉的那道断崖，别让它从配色表这边回来。
    const all = Array.from({ length: ENEMY_TRAIT.stepCap + 2 }, (_, i) => laserCapAt(i));
    check("激光配额全档 ≤ 3（硬顶不再夹它之后的显式护栏）",
      all.every((c) => c <= 3), `step 0..${ENEMY_TRAIT.stepCap + 1}: ${all.join(",")}`);
  }
  {
    // 错相位护栏（把阶段 26 的双重计数教训写成测试）：尾段同屏台阶那一波不许同时
    // 有装备档位或连续倍率的变化——否则读数无法归因，而那正是断崖的来源。
    const w = WAVE.concurrentLateFrom;
    check(`第 ${w} 波只加一具身体：装备档与倍率都不变`,
      eliteStep(w) === eliteStep(w - 1) && eliteCreep(w) === eliteCreep(w - 1),
      `step ${eliteStep(w - 1)}→${eliteStep(w)} creep ${eliteCreep(w - 1)}→${eliteCreep(w)}`);
  }
  {
    // 配额满了的同档友军退回**加量散射**（而不是空手，也不是第二把激光）
    const first = eliteSpec(31, "hard", 0), third = eliteSpec(31, "hard", 2), over = eliteSpec(31, "hard", 3);
    const fallback = eliteSpec(21, "hard", 1);
    check("配额未满拿激光 / 配额已满退回加量散射",
      first.weapon === "laser" && third.weapon === "laser" && over.weapon === "scatter"
      && fallback.weapon === "scatter" && fallback.scatterBonus === ENEMY_TRAIT.scatterBonus * 2,
      `${first.weapon}/${third.weapon}/${over.weapon}/${fallback.weapon}`);
  }
  {
    // 计数口：只数**还上膛**的（打完那发就不算——配额限的是同屏瞬时狙击手数量）。
    // main 与 arena 共用这一个出口，两边各写一份必跑偏
    const armed = mkTank(), spent = mkTank(), plain = mkTank();
    armed.applyPowerup("laser");
    spent.applyPowerup("laser");
    spent.laserShots = 0;
    check("countArmedLasers 只数上膛的激光兵（含 null 容错）",
      countArmedLasers([armed, spent, plain, null]) === 1 && countArmedLasers([]) === 0
      && countArmedLasers(null) === 0);
  }
}

// ============================================================
section("波次结算横幅分支 (ui)");
{
  // 本文件第一次 import `ui.js`——它只读 config/powerup/levels/upgrades，
  // 对画布的访问全是 ctx 方法调用，所以拿 `zone.render` 那套 Proxy 录音机就能在
  // node 里断言**画出来的文案**，不必上 CDP。
  //
  // 钉的是「首战不发奖杯」：`isBetterRecord(任何成绩, {wave:0})` 恒为真（新档必须
  // 存得下第一笔记录），于是只看 newRecord 的话，**第一次玩死在第 1 波也会打出
  // 🏆 新纪录！+ 胜利琶音**——给「立刻就死」发奖杯。所以横幅要靠 hadRecord
  // 区分「破了一个真的存在过的记录」与「这是第一把」。
  const { renderWaveOverBanner } = await import("../src/ui.js");
  const texts = [];
  const recorder = new Proxy({}, {
    get: (_t, k) => (k === "measureText" ? () => ({ width: 0 })
      : (...a) => { if (k === "fillText") texts.push(String(a[0])); }),
    set: () => true,
  });
  const shot = (view) => {
    texts.length = 0;
    renderWaveOverBanner(recorder, { kills: 0, mouse: { x: -1, y: -1 }, ...view });
    return texts.join("\n");
  };

  const first = shot({ wave: 1, best: { wave: 1, kills: 0 }, newRecord: true, hadRecord: false });
  check("首战告负：不发奖杯", !first.includes("🏆"), first.replace(/\n/g, " | "));
  check("首战告负：也不印「历史最高」（那会自比自）", !first.includes("历史最高"));

  const broke = shot({ wave: 9, best: { wave: 9, kills: 4 }, newRecord: true, hadRecord: true });
  check("真破纪录：发奖杯", broke.includes("🏆"));

  const lost = shot({ wave: 3, best: { wave: 9, kills: 4 }, newRecord: false, hadRecord: true });
  check("没破纪录：印历史最高、不发奖杯",
    lost.includes("历史最高：第 9 波") && !lost.includes("🏆"));

  // 默认参数向后兼容：老调用点不传 hadRecord 时按「有记录」走（原行为）
  check("hadRecord 缺省 = true（旧调用点语义不变）",
    shot({ wave: 9, best: { wave: 9, kills: 4 }, newRecord: true }).includes("🏆"));
}

// ============================================================
section("config 属性读取静态扫描");
{
  // 全仓扫一遍「对 config 导出对象的属性读取是否真的存在」。
  // 这条门是本次审查的产物：`scripts/arena.mjs` 读了 `TANK.speed`（真名是
  // `TANK.moveSpeed`），于是 `moved < NaN` 恒为 false，把守点寻路替身的
  // 「撞墙 0.8s 就交还控制权」这条脱困闸门整个变成死代码——**注释就写在那一行
  // 上面，说它已经处理了**。这类缺陷没有任何运行时症状：不崩、不报错、跑分也只是
  // 悄悄偏低，靠读代码和跑分都抓不到，只能靠这种机械核对。
  // 只扫「对象型」导出（数组/标量没有属性名可查），逐行正则匹配 `TABLE.prop`。
  const { readFileSync, readdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  // 仓库根按**本文件位置**算而不是 cwd：这是全文件唯一读磁盘的地方，
  // 挂在 cwd 上的话换个目录跑就直接 ENOENT 把整轮 smoke 崩掉。
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const CFG = await import("../src/config.js");
  const tables = {};
  for (const [name, val] of Object.entries(CFG)) {
    if (val && typeof val === "object" && !Array.isArray(val)) tables[name] = new Set(Object.keys(val));
  }
  // 长名优先：防 `WALL_BREAK.x` 被短名 `WALL` 抢先匹配成 `WALL` 的属性
  const names = Object.keys(tables).sort((a, b) => b.length - a.length);
  const BUILTIN = ["hasOwnProperty", "toString", "valueOf", "constructor"];
  const files = [
    ...readdirSync(join(ROOT, "src")).filter((f) => f.endsWith(".js")).map((f) => "src/" + f),
    ...readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".mjs")).map((f) => "scripts/" + f),
  ];
  // 「这道门还在扫东西」自身也要有门：目录改名/扩展名换了会让扫描范围静默变空，
  // 而一个恒绿的护栏比没有护栏更坏（阶段 28.1 那条 1/50 误报是同一个教训的另一面）。
  check("静态扫描的取样面非空（文件与表都找得到）",
    files.length >= 20 && names.length >= 10, `${files.length} 文件 / ${names.length} 表`);
  const bad = [];
  for (const f of files) {
    readFileSync(join(ROOT, f), "utf8").replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // 整行注释跳过
      for (const t of names) {
        const re = new RegExp("\\b" + t + "\\.([A-Za-z_$][\\w$]*)", "g");
        let m;
        while ((m = re.exec(line))) {
          if (tables[t].has(m[1]) || BUILTIN.includes(m[1])) continue;
          bad.push(`${f}:${i + 1} ${t}.${m[1]}`);
        }
      }
    });
  }
  check(`src/ 与 scripts/ 对 config 的属性读取全部命中（扫了 ${files.length} 个文件、${names.length} 张表）`,
    bad.length === 0, bad.slice(0, 4).join(" / "));
}

// ============================================================
section("玩法说明浮层排版 (ui.renderHelpOverlay)");
{
  // 用 Proxy 当 ctx 录音机（阶段 28.2 的办法）把这一页画出来的每一次 fillText 录下来。
  // 这一页是**纯 ctx 调用**，所以 node 里就能跑，不必起 Electron。
  const { renderMenu } = await import("../src/ui.js");
  const texts = [];
  const pts = [];
  const rec = (x, y) => { if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y }); };
  const ctx = new Proxy({}, {
    get(_t, k) {
      if (k === "measureText") return () => ({ width: 0 });
      if (k === "fillText") return (text, x, y) => { texts.push({ text, x, y }); rec(x, y); };
      if (k === "canvas") return { width: CANVAS.width, height: CANVAS.height };
      return (...a) => { if (a.length >= 2) rec(a[0], a[1]); };
    },
    set() { return true; },
  });
  renderMenu(ctx, { mouse: { x: -1, y: -1 }, showHelp: true });

  // **只取说明页那一段**：renderMenu 先画菜单、再把说明页叠在上面，而 Proxy 把
  // 底下菜单的 fillText 一并录了。初版没切这一刀，于是「末行」取到的是「波次生存」
  // 按钮的标签——断言在测一个跟说明页无关的东西（抬 ph 反而让它更红，因为提示
  // 下移后又把按钮的副标题纳入了「内容」）。说明页是最后画的，所以从标题切开即可。
  const start = texts.findIndex((t) => t.text === "玩法说明");
  check("说明页确实画出来了（标题在录音里）", start >= 0);
  const help = start >= 0 ? texts.slice(start) : [];

  check("录到了说明页的文字", help.length >= 15, `${help.length} 段`);

  // —— 这一页该有的「看不见的规则」——
  // 判据是「玩家不死一次学不会」：三方武器槽互斥、持雷超时、守点计时语义。
  // 阶段 28.4 之前这三条在全游戏任何地方都没写过。
  const all = help.map((t) => t.text).join("\n");
  const must = [
    ["武器槽互斥（捡新的顶掉旧的）", /顶掉/],
    ["护盾独立不冲突", /护盾独立|不冲突/],
    ["地雷不认主人", /不认主人/],
    ["持雷超时作废", /10 秒作废|超过 10 秒/],
    ["守点要站进圈里", /站进圈里/],
    ["守点离开只暂停不倒退", /不倒退/],
  ];
  const missing = must.filter(([, re]) => !re.test(all)).map(([n]) => n);
  check("说明页覆盖「看不见就学不会」的那几条规则", missing.length === 0, missing.join(" / "));

  // —— 行宽：相对比较，不依赖字体度量 ——
  // node 没有 measureText，但**相对**判据不需要它：阶段 28.4 之前最长那行
  // （旧版「地雷：…」）在实机 CDP 里量到宽 504.85px，而正文可用内宽是 508px
  // （文字起点 px+52 到面板右界 px+560）——即它是一条**已知刚好放得下**的线。
  // 所以只要每行的估算宽度都 ≤ 它的估算宽度，就不可能溢出，字体误差整体抵消。
  const REF = "地雷：捡取后按道具键在车尾布雷（共 2 颗），1 秒布防后近敌即炸（不认主人）";
  const estW = (s) => [...s].reduce((w, ch) => w + (/[⺀-￿　-〿＀-￯]/.test(ch) ? 1 : 0.56), 0);
  const refW = estW(REF);
  const tooWide = help.filter((t) => estW(t.text) > refW).map((t) => `${t.text}(${estW(t.text).toFixed(1)}>${refW.toFixed(1)})`);
  check(`说明页每行都不超过「已知刚好放得下」的那条基准线（${refW.toFixed(1)} 字宽）`,
    tooWide.length === 0, tooWide.slice(0, 2).join(" / "));
  // 反证：基准线自己确实接近上界——拿它加三个字必须判超宽，否则这条断言太松
  check("反证：基准线加三个字就会判超宽", estW(REF + "三个字") > refW);

  // —— 垂直排版：末行与底部关闭提示不许压在一起 ——
  // 阶段 28.4 加规则前，ph=480 下末行基线 py+422、提示 py+452，只剩一行的余量；
  // 再加四行就会叠上去。这条断言把「加行必须同步抬 ph」变成可执行的门。
  const hint = help.find((t) => /点击任意处关闭/.test(t.text));
  check("说明页有底部关闭提示", !!hint);
  if (hint) {
    const content = help.filter((t) => t !== hint && t.y < hint.y).map((t) => t.y);
    const lastY = Math.max(...content);
    check("末行与关闭提示之间留够一行间距（加行忘了抬面板高度就会红）",
      hint.y - lastY >= 24, `末行 y=${lastY} 提示 y=${hint.y} 间距 ${hint.y - lastY}`);
  }
  // 面板连边框带文字整体不许画出画布（ph 抬过头会从上下溢出）
  const outOfCanvas = pts.filter((p) => p.y < 0 || p.y > CANVAS.height || p.x < 0 || p.x > CANVAS.width);
  check("说明页所有绘制坐标都落在画布内", outOfCanvas.length === 0,
    outOfCanvas.slice(0, 2).map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(" "));
  // —— 结构护栏：清 effects 的地方必须同时排空震动 ——
  // `effects` 数组与 effects.js 的**模块级**震动是同一份「表现层残留」的两半，
  // 而只有数组那一半在转场时被显式清掉，另一半靠 resetShake() 手动调。
  // 阶段 27.1 补了 setupRound 那一处、**漏了 remapWaveArena**（章界换图），
  // 于是喘息最后 0.35s 的震动会漏进新章的 3-2-1，还会吞掉新章第一次击杀的震动。
  // 把「两半必须一起清」写成可执行的门：以后再多一个转场点也不会只清一半。
  {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const ROOT4 = join(dirname(fileURLToPath(import.meta.url)), "..");
    const mainSrc = readFileSync(join(ROOT4, "src", "main.js"), "utf8").replace(/\r\n/g, "\n");
    // 按 `\nfunction ` 切出函数体，模块顶层那句 `let effects = []` 自然落在第 0 段
    const bodies = mainSrc.split("\nfunction ");
    const clearing = bodies.slice(1).filter((b) => /^\s*effects = \[\];/m.test(b));
    check("反证：真的扫到了清 effects 的函数", clearing.length >= 2, `${clearing.length} 处`);
    const half = clearing
      .filter((b) => !/resetShake\(\)/.test(b))
      .map((b) => b.slice(0, b.indexOf("(")));
    check("每个清 effects 的转场点都同时排空了屏幕震动（两半必须一起清）",
      half.length === 0, half.join(","));
  }
}

// ============================================================
section("上下文一次性提示 (hints)");
{
  const {
    HINTS, HINT_IDS, WEAPON_TYPES, hintText, normalizeSeen, shouldShow, markSeen,
    weaponHeld, isWeaponSwap,
  } = await import("../src/hints.js");
  const { HINT } = await import("../src/config.js");

  // —— 表本身 ——
  check("提示表非空且 id 互异",
    HINTS.length >= 4 && new Set(HINT_IDS).size === HINT_IDS.length, HINT_IDS.join(","));
  check("每条提示都有非空文案", HINTS.every((h) => typeof h.text === "string" && h.text.length > 6));
  check("hintText 认识的返回文案、不认识的返回 null",
    hintText(HINT_IDS[0]) === HINTS[0].text && hintText("nope") === null && hintText(undefined) === null);
  check("武器互斥表恰好是三类（护盾不在其中——那是独立槽）",
    WEAPON_TYPES.length === 3 && !WEAPON_TYPES.includes("shield")
    && ["scatter", "laser", "mine"].every((t) => WEAPON_TYPES.includes(t)));

  // —— 存档宽松校验 + 往返幂等 ——
  check("normalizeSeen 容错（非数组/脏值/未知 id/重复一律过滤）",
    normalizeSeen(null).length === 0 && normalizeSeen("x").length === 0
    && normalizeSeen([1, null, {}, "nope"]).length === 0
    && normalizeSeen([HINT_IDS[0], HINT_IDS[0]]).length === 1);
  {
    // 规范化成「按表顺序」之后写盘→读回是幂等的，否则 settings 的往返会来回抖
    const once = normalizeSeen([HINT_IDS[1], HINT_IDS[0]]);
    check("normalizeSeen 幂等且顺序确定（按表序，不按存档序）",
      JSON.stringify(normalizeSeen(once)) === JSON.stringify(once)
      && once[0] === HINT_IDS[0], once.join(","));
  }

  // —— 一次性语义 ——
  {
    const id = HINT_IDS[0];
    check("没见过就该弹、未知 id 永不弹",
      shouldShow(id, []) === true && shouldShow("nope", []) === false
      && shouldShow(id, null) === true);
    const seen = markSeen(id, []);
    check("标记后就不再弹", seen.includes(id) && shouldShow(id, seen) === false);
    // 纯函数：不许改入参（main 靠「返回的是不是同一份」判断要不要写盘）
    const before = [];
    markSeen(id, before);
    check("markSeen 不改入参（纯函数）", before.length === 0);
    check("重复标记不会产生重复项", markSeen(id, seen).length === seen.length);
    check("标记未知 id 不改变集合", markSeen("nope", seen).length === seen.length);
  }

  // —— 顶掉判定的真值表（这条提示的全部正确性都在这里）——
  {
    const tank = (s, l, m) => ({ scatterShots: s, laserShots: l, mineCharges: m });
    check("weaponHeld 认出三类与空手",
      weaponHeld(tank(2, 0, 0)) === "scatter" && weaponHeld(tank(0, 1, 0)) === "laser"
      && weaponHeld(tank(0, 0, 2)) === "mine" && weaponHeld(tank(0, 0, 0)) === null
      && weaponHeld(null) === null);
    check("异类拾取算顶掉", isWeaponSwap("laser", "scatter") === true);
    check("同类叠加不算顶掉（那是加量）", isWeaponSwap("scatter", "scatter") === false);
    check("空手拾取不算顶掉", isWeaponSwap(null, "laser") === false);
    check("捡护盾永不算顶掉（独立槽）",
      isWeaponSwap("laser", "shield") === false && isWeaponSwap(null, "shield") === false);
  }

  // —— 结构护栏：每条提示都必须真的被接线 ——
  // 一条没有任何触发点的提示是**静默死码**：表里有、文案写得好好的，但永远不会弹，
  // 而没有任何现象能暴露它（与阶段 28.2 的 TANK.speed 同一族）。所以用静态扫描
  // 把「表」与「接线」钉在一起：加一条提示却忘了找地方触发它，这里就红。
  {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const ROOT3 = join(dirname(fileURLToPath(import.meta.url)), "..");
    const mainSrc = readFileSync(join(ROOT3, "src", "main.js"), "utf8").replace(/\r\n/g, "\n");
    const unwired = HINT_IDS.filter((id) => !mainSrc.includes(`maybeHint("${id}")`));
    check("每条提示都有触发点（没接线的提示是静默死码）", unwired.length === 0, unwired.join(","));
    // 反向：别触发表里没有的 id（拼错 ⇒ shouldShow 恒 false ⇒ 同样静默）
    const called = [...mainSrc.matchAll(/maybeHint\("([^"]+)"\)/g)].map((m) => m[1]);
    const bogus = called.filter((id) => !HINT_IDS.includes(id));
    check("没有触发表里不存在的提示 id（拼错同样是静默无效）", bogus.length === 0, bogus.join(","));
    // 反证：扫描面非空，否则上面两条是空断言
    check("反证：真的扫到了触发点", called.length >= HINT_IDS.length, `${called.length} 处`);
    // **按实体的触发点必须带 players[0] 守卫**：拾取/死亡/持雷都是「发生在某辆车身上」
    // 的事，不排除 AI 的话敌人踩雷也会教玩家「你的跳弹会杀你」。
    // holdZone **刻意不在此列**——守点波开波是全局事件，根本没有实体可谈
    // （它在 beginWave 里，而 beginWave 只在 wave 模式跑，那里 players[0] 恒为人类）。
    const PER_ENTITY = ["ricochet", "weaponSwap", "laserSeen", "mineTimeout"];
    const unguarded = PER_ENTITY.filter((id) => {
      const at = mainSrc.indexOf(`maybeHint("${id}")`);
      return at < 0 || !/players\[0\]/.test(mainSrc.slice(Math.max(0, at - 500), at));
    });
    check("按实体的触发点都带 players[0] 守卫（否则 AI 的动作也会教玩家）",
      unguarded.length === 0, unguarded.join(","));
    // 反证：这条扫描真的能抓住缺守卫的情况——holdZone 就是一个无守卫的例子，
    // 把它放进 PER_ENTITY 必须判红，否则上面那条是永绿的空断言
    const holdAt = mainSrc.indexOf('maybeHint("holdZone")');
    check("反证：同一扫描对无守卫的触发点确实判红",
      holdAt >= 0 && !/players\[0\]/.test(mainSrc.slice(Math.max(0, holdAt - 500), holdAt)));
  }

  // —— 旋钮与排版 ——
  check("HINT 旋钮区间合理（时长够读完一行、队列上限有界）",
    HINT.duration >= 2.5 && HINT.duration <= 8 && HINT.maxQueue >= 1 && HINT.maxQueue <= 6,
    `duration=${HINT.duration} maxQueue=${HINT.maxQueue}`);
  {
    const { renderHintToast, hintToastBand } = await import("../src/ui.js");
    const band = hintToastBand();
    // 底部那一带已被占掉两处：左下「强化」条 y=height−42（跨 ±10）、
    // 底部中央「Esc 退出对战」 y=height−16。提示条不许叠上任何一处。
    const upgradeBar = { top: CANVAS.height - 52, bottom: CANVAS.height - 32 };
    const footer = { top: CANVAS.height - 24, bottom: CANVAS.height - 8 };
    const overlaps = (a, b) => a.top < b.bottom && b.top < a.bottom;
    check("提示条不叠左下「强化」条", !overlaps(band, upgradeBar),
      `提示 ${band.top}..${band.bottom} vs 强化 ${upgradeBar.top}..${upgradeBar.bottom}`);
    check("提示条不叠底部「Esc 退出对战」", !overlaps(band, footer));
    check("提示条整条落在画布内", band.top >= 0 && band.bottom <= CANVAS.height);

    // Proxy 录音机：画得出文字、坐标在画布内；空文案什么都不画
    const drawn = [];
    const tctx = new Proxy({}, {
      get(_t, k) {
        if (k === "measureText") return (s) => ({ width: s.length * 12 });
        if (k === "fillText") return (text, x, y) => drawn.push({ text, x, y });
        return () => {};
      },
      set() { return true; },
    });
    renderHintToast(tctx, hintText(HINT_IDS[0]));
    check("提示条画出了文案且坐标在画布内",
      drawn.length === 1 && drawn[0].text === HINTS[0].text
      && drawn[0].x > 0 && drawn[0].x < CANVAS.width
      && drawn[0].y > 0 && drawn[0].y < CANVAS.height);
    drawn.length = 0;
    renderHintToast(tctx, null);
    renderHintToast(tctx, "");
    check("空文案不画任何东西（调用方不必先判）", drawn.length === 0);
  }
  {
    // 行宽：药丸宽度 = 文字实测 + 2×padX，钳在 maxW=620 ⇒ 文字可用 584px。
    // node 没有 measureText，沿用说明页那条标定（全角 1 字宽 ≈ 13.72px，
    // 由「旧地雷行 36.80 字宽 = 实机 504.85px」反推）。
    const estW = (s) => [...s].reduce((w, ch) => w + (/[⺀-￿　-〿＀-￯]/.test(ch) ? 1 : 0.56), 0);
    const PX = 504.85 / 36.80;
    const budget = 620 - 18 * 2;
    const widest = HINTS.reduce((a, h) => Math.max(a, estW(h.text) * PX), 0);
    check(`每条提示都放得进药丸（最宽 ${widest.toFixed(0)}px / 可用 ${budget}px）`,
      widest <= budget, HINTS.map((h) => (estW(h.text) * PX).toFixed(0)).join(","));
  }
  // —— 跳弹自杀的判据必须按武器分流（28.5 的回归，自己写出来的）——
  // `hitPlayer` 有三个调用者：子弹传 `b.owner`、地雷传 `m.owner`、激光传
  // `shooter.tank`。只看「凶手 === 受害者」会把「踩自己的雷」和「贴墙激光被反弹段
  // 扫回来」也判成跳弹，而提示是**一次性且当场写盘**的 ⇒ 讲错一次就永远没机会讲对。
  {
    const { isRicochetSelfKill, RICOCHET_WEAPONS } = await import("../src/hints.js");
    const me = { id: "me" };
    const foe = { id: "foe" };
    check("弹丸类表恰好是子弹与散射（激光/地雷不在其中）",
      RICOCHET_WEAPONS.length === 2 && RICOCHET_WEAPONS.includes("bullet")
      && RICOCHET_WEAPONS.includes("scatter")
      && !RICOCHET_WEAPONS.includes("laser") && !RICOCHET_WEAPONS.includes("mine"));
    check("自己的子弹/散射打死自己 → 算跳弹自杀",
      isRicochetSelfKill("bullet", me, me) === true
      && isRicochetSelfKill("scatter", me, me) === true);
    check("踩自己的雷 / 贴墙激光弹回来 → **不**算跳弹自杀（那是两件别的事）",
      isRicochetSelfKill("mine", me, me) === false
      && isRicochetSelfKill("laser", me, me) === false);
    check("被别人的子弹打死 → 不算自杀",
      isRicochetSelfKill("bullet", foe, me) === false);
    check("凶手为 null（无主弹/无主爆）不算自杀，也不抛",
      isRicochetSelfKill("bullet", null, me) === false
      && isRicochetSelfKill("bullet", undefined, me) === false);
  }

  // —— 结构护栏：提示层那两处「两半必须一致」的地方 ——
  {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const ROOT5 = join(dirname(fileURLToPath(import.meta.url)), "..");
    const mainSrc = readFileSync(join(ROOT5, "src", "main.js"), "utf8").replace(/\r\n/g, "\n");

    // ① 跳弹触发必须走 isRicochetSelfKill,不许裸写「凶手 === 自己」
    const ricoLine = mainSrc.split("\n").find((l) => l.includes('maybeHint("ricochet")'));
    check("跳弹提示的触发走 isRicochetSelfKill（不是裸比凶手）",
      !!ricoLine && ricoLine.includes("isRicochetSelfKill"), (ricoLine || "").trim().slice(0, 70));

    // ② 可见性判据只许有一处：计时与渲染都来问 hintsVisible()。
    // 它们分开写时，「暂停去读提示」会让一条永不再现的提示凭空消失。
    const defs = (mainSrc.match(/function hintsVisible\(\)/g) || []).length;
    const uses = (mainSrc.match(/hintsVisible\(\)/g) || []).length;
    check("hintsVisible 只定义一次，且至少被两处消费（计时 + 渲染）",
      defs === 1 && uses >= 3, `定义 ${defs} 次 / 出现 ${uses} 次`);
    // advanceHints 的函数体里必须问它（否则看不见也在走表）
    const advBody = mainSrc.split("\nfunction advanceHints")[1] || "";
    check("advanceHints 开头就问可见性（看不见不走表、不出队）",
      /hintsVisible\(\)/.test(advBody.slice(0, 400)));
    // 渲染那一处不许再写一份状态比较（那正是两半漂开的方式）。
    // **按 renderHintToast 的调用点往前取**：早一版按 "hintNow &&" 找行，结果
    // 匹配到了 advanceHints 里的 `!hintNow && hintQueue.length`——断言在看另一处代码。
    const callAt = mainSrc.indexOf("renderHintToast(ctx");
    const gate = callAt >= 0 ? mainSrc.slice(Math.max(0, callAt - 200), callAt) : "";
    check("渲染门不内联状态比较，只读 hintsVisible()",
      callAt >= 0 && /hintNow && hintsVisible\(\)/.test(gate) && !/STATE\.PAUSED/.test(gate),
      gate.split("\n").pop().trim().slice(0, 70));
  }
}

// ============================================================
section("投放与拾取的接缝 (阶段 28.6)");
{
  const { PowerupSpawner, Powerup, TYPE_BG } = await import("../src/powerup.js");
  const { pickSpawnSpot } = await import("../src/waves.js");
  const { Mine } = await import("../src/mine.js");
  const { TANK, POWERUP, MAZE_STYLES, WALL_DENSITY, WAVE } = await import("../src/config.js");

  // —— ① pickSpot 必须避雷 ——
  // 警戒后的雷完全隐形（mine.visibility），补给刷进触发圈 = 一个看起来白捡、
  // 走过去必死的诱饵，而且玩家读不出原因。AI 读 world.mines 有完美记忆所以免疫，
  // **只坑真人**——这正是最该有门的一类。
  {
    const mz = generateMaze(MAZE_TIERS.small.cols, MAZE_TIERS.small.rows, "sparse");
    const cy = Math.floor(mz.rows / 2), cx = Math.floor(mz.cols / 2);
    const mine = new Mine((cx + 0.5) * CELL_SIZE, (cy + 0.5) * CELL_SIZE, null);
    const sp = new PowerupSpawner(["shield"]);
    const clearWant = POWERUP.mine.triggerRadius + POWERUP.radius;
    let hits = 0, produced = 0;
    for (let i = 0; i < 200; i++) {
      const spot = sp.pickSpot(mz, [], [], [mine]);
      if (!spot) continue;
      produced++;
      if (Math.hypot(spot.x - mine.x, spot.y - mine.y) < clearWant) hits++;
    }
    check("反证：pickSpot 确实产出了点（不是空跑）", produced >= 150, `${produced}/200`);
    check("pickSpot 不把道具刷进地雷的触发圈（隐形雷 + 诱饵 = 讲不清的死）",
      hits === 0, `${hits} 例落在 ${clearWant}px 内`);
    // 反向：不给 mines 时它确实会落在那一格上——否则上一条是永绿的空断言
    let hitsNoMine = 0;
    for (let i = 0; i < 200; i++) {
      const spot = sp.pickSpot(mz, [], []);
      if (spot && Math.hypot(spot.x - mine.x, spot.y - mine.y) < clearWant) hitsNoMine++;
    }
    check("反证：不传 mines 时同一格确实会被选中（这条门抓的是真东西）",
      hitsNoMine > 0, `命中 ${hitsNoMine}/200`);
  }

  // —— ② 敌人刷点的小净空（避补给）——
  // 不传 avoid 时那一格会被选中；传了就必须避开。同时确认净空**只**排除那一格，
  // 不会像 occupied 那样大改分布（那会推翻 CLAUDE.md 里的波次基线）。
  //
  // **反证要先把「本来会被选中的格子」扫出来**：pickSpawnSpot 只从「离理想距离
  // 最近的三分之一」里挑，随手拿地图正中当靶子的话它本来就不在候选池里——
  // 那样「不传 avoid 也选不中」是必然的，反证会变成永假的空断言（初版就踩了）。
  {
    const mz = generateMaze(MAZE_TIERS.medium.cols, MAZE_TIERS.medium.rows, "sparse");
    const hero = { x: CELL_SIZE * 0.5, y: CELL_SIZE * 0.5 };
    const cellOf = (s) => `${Math.floor(s.x / CELL_SIZE)},${Math.floor(s.y / CELL_SIZE)}`;

    // 第一遍：不传 avoid，统计哪些格真的会被选中
    const tally = new Map();
    for (let i = 0; i < 400; i++) {
      const s = pickSpawnSpot(mz, hero, [], () => i / 400);
      if (s) tally.set(cellOf(s), (tally.get(cellOf(s)) || 0) + 1);
    }
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    check("反证前置：扫出了会被选中的格子（候选池非空）", !!top && top[1] > 0,
      top ? `${top[0]} ×${top[1]}` : "无");

    if (top) {
      const [ccx, ccy] = top[0].split(",").map(Number);
      const marked = { x: (ccx + 0.5) * CELL_SIZE, y: (ccy + 0.5) * CELL_SIZE };
      const clearAvoid = POWERUP.radius + TANK.radius;
      let withAvoid = 0, without = 0, tooClose = 0;
      for (let i = 0; i < 400; i++) {
        const r = i / 400;
        const s1 = pickSpawnSpot(mz, hero, [], () => r, [marked]);
        const s2 = pickSpawnSpot(mz, hero, [], () => r);
        if (s1 && cellOf(s1) === top[0]) withAvoid++;
        if (s2 && cellOf(s2) === top[0]) without++;
        if (s1 && Math.hypot(s1.x - marked.x, s1.y - marked.y) < clearAvoid) tooClose++;
      }
      check("敌人刷点避开补给所在格（applyElite 的确定性词条不该被随机拾取抹掉）",
        withAvoid === 0 && tooClose === 0, `avoid 命中 ${withAvoid} / 过近 ${tooClose}`);
      check("反证：同一格不传 avoid 时确实会被选中（净空不是空断言）",
        without > 0, `无 avoid 命中 ${without}/400`);
      check("净空很小：occupied 的贴脸门保持不变（没把两件事混成一条判据）",
        WAVE.spawnSafeCells * CELL_SIZE > clearAvoid * 5,
        `净空 ${clearAvoid}px vs 贴脸门 ${WAVE.spawnSafeCells * CELL_SIZE}px`);
    }
  }

  // —— ③ 结构护栏：一帧只吃一个（两份副本必须同改）——
  {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const R = join(dirname(fileURLToPath(import.meta.url)), "..");
    const grab = (p) => readFileSync(join(R, p), "utf8").replace(/\r\n/g, "\n");
    for (const [f, label] of [["src/main.js", "main"], ["scripts/arena.mjs", "arena"]]) {
      const src = grab(f);
      const at = src.indexOf("pw.taken = true;");
      const win = at >= 0 ? src.slice(at, at + 400) : "";
      check(`${label}: 拾取后 break（否则同帧双吃会静默销毁刚装上的武器槽）`,
        at >= 0 && /pw\.taken = true;[\s\S]{0,400}?\bbreak;/.test(win));
    }
  }

  // —— ④ 结构护栏：四处「两处各写一遍」都收成了单一来源 ——
  {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const R2 = join(dirname(fileURLToPath(import.meta.url)), "..");
    const src = (p) => readFileSync(join(R2, p), "utf8").replace(/\r\n/g, "\n");

    // 死旋钮：sparse 的密度必须与生成器读的是同一个来源。
    // **判据用 import 语句而不是裸文本**：初版写成 `!/WALL_DENSITY/.test(整个文件)`，
    // 而那段解释「不直读 WALL_DENSITY」的注释里就有这个词——扫描把注释也算进去了。
    // 注释不是代码，这类假红与「测空气」是同一族（都在测你以为自己在测的东西之外）。
    const mazeSrc = src("src/maze.js");
    const mazeImport = (mazeSrc.split("\n").find((l) => /^import .*from "\.\/config\.js";/.test(l)) || "");
    check("sparse 密度不是死旋钮（风格表与 WALL_DENSITY 同源）",
      MAZE_STYLES.sparse.density === WALL_DENSITY,
      `sparse=${MAZE_STYLES.sparse.density} WALL_DENSITY=${WALL_DENSITY}`);
    check("maze.js 不再从 config 导入 WALL_DENSITY（否则改风格表零效果）",
      !/WALL_DENSITY/.test(mazeImport) && /MAZE_STYLES\.sparse\.density/.test(mazeSrc),
      mazeImport.trim().slice(0, 80));

    // 道具色表只此一份
    check("effects.js 不再抄第二份道具色表（复用 powerup.TYPE_BG）",
      /TYPE_BG/.test(src("src/effects.js"))
      && !/powShieldBg:/.test(src("src/effects.js"))
      && !/scatter: THEME\.powScatterBg/.test(src("src/effects.js")));

    // 地雷冲击环半径接常量，不写死
    check("地雷爆炸环半径接 POWERUP 常量（不写死 70）",
      /POWERUP\.mine\.blastRadius/.test(src("src/effects.js")) && !/12 \+ p \* 58/.test(src("src/effects.js")));

    // 护盾闪烁阈值两处共读
    check("护盾闪烁阈值两处共读 POWERUP.shield.blinkUnder",
      /blinkUnder/.test(src("src/tank.js")) && /blinkUnder/.test(src("src/ui.js"))
      && !/shieldTimer < 1\.5/.test(src("src/tank.js"))
      && !/shieldTimer < 1\.5/.test(src("src/ui.js")));

    // arena 参数校验（未知类型必须拒绝，而不是静默刷出零效力道具）
    check("arena --powerups 校验类型（未知值报错退出，不静默失真）",
      /POWERUP\.types\.includes\(t\)/.test(src("scripts/arena.mjs"))
      && /process\.exit\(1\)/.test(src("scripts/arena.mjs")));
  }
}

// ============================================================
section("设置加载期校验 (settings)");
{
  // settings.js 平时是浏览器专属（摸 localStorage），但它对存储的访问全在 try 里，
  // 装一个内存 stub 就能在 node 里驱动真实的 initSettings——于是「加载期过滤」
  // 这条不变量有了确定性的门，不必靠 CDP。
  // **必须先快照 KEY_BINDINGS 再改**：initSettings 是原地覆写全局表（那正是它
  // 「改完即时生效」的实现方式），不还原会污染后面所有读键位的断言。
  const snapshot = KEY_BINDINGS.slice(0, 2).map((b) => ({ ...b }));
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const { initSettings, saveBindings } = await import("../src/settings.js");

  // 造一份「前进被绑成 KeyR」的存量存档——黑名单扩容之前的玩家就是这个状态。
  // 只堵改键面板的捕获路径的话，这份存档重启后照旧把 R 装回去，而结算横幅上
  // 点一下前进就会静默清零整场比分：**唯一会踩到的那批人永远修不好**。
  store.set("tank-trouble.settings.v1", JSON.stringify({
    version: 1,
    bindings: [
      { forward: "KeyR", back: "KeyS", left: "KeyA", right: "KeyD", fire: "Space", special: "KeyE" },
      { forward: "Digit2", back: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", fire: "Enter", special: "ShiftRight" },
    ],
  }));
  initSettings();
  check("加载期过滤：存档里的黑名单键落回默认，不照收",
    KEY_BINDINGS[0].forward === snapshot[0].forward
    && KEY_BINDINGS[1].forward === snapshot[1].forward,
    `P1.forward=${KEY_BINDINGS[0].forward} P2.forward=${KEY_BINDINGS[1].forward}`);
  check("加载期过滤只挑黑名单键，合法自定义键照旧生效",
    KEY_BINDINGS[0].back === "KeyS" && KEY_BINDINGS[1].fire === "Enter");

  // 坏档不炸（本文件既有的「宽松校验」纪律）：非字符串/空串/缺字段一律落默认。
  // **先把表还原再造坏档**，两条断言各自独立才说明得了各自的事（阶段 28.2 的
  // 变异测试教训：不还原的话上一条红了这条必然连坐红）。
  snapshot.forEach((b, i) => Object.assign(KEY_BINDINGS[i], b));
  store.set("tank-trouble.settings.v1", JSON.stringify({
    version: 1,
    bindings: [{ forward: 42, back: "", left: null }, null],
  }));
  let threw = false;
  try { initSettings(); } catch (e) { threw = true; }
  check("坏档（数字/空串/null/缺字段）不抛且落默认",
    !threw && KEY_BINDINGS[0].forward === snapshot[0].forward && KEY_BINDINGS[0].back === snapshot[0].back);

  // —— 整套自洽校验（本次审查修的缺陷）——
  // 逐字段「非法落默认」会合出一张每个字段单独合法、合起来却失灵的表，而且
  // 失灵得毫无提示：前进存 KeyR（黑名单）落回默认 KeyW，后退存的就是 KeyW ⇒
  // readControls 算出 move = +1 −1 = 0，车一动不动。只砸在改过键的老玩家头上，
  // 新建存档怎么测都测不出来。
  const ACTS = Object.keys(snapshot[0]);
  const setStore = (p1, p2) => store.set("tank-trouble.settings.v1",
    JSON.stringify({ version: 1, bindings: [p1, p2] }));
  // 判据写成独立的 oracle（不复用实现）：12 个动作全是非空字符串、不含黑名单键、零重复
  const sane = () => {
    const codes = KEY_BINDINGS.slice(0, 2).flatMap((b) => ACTS.map((a) => b[a]));
    return codes.every((c) => typeof c === "string" && c && !RESERVED_KEYS.includes(c))
      && new Set(codes).size === codes.length;
  };

  const killer = { forward: "KeyR", back: "KeyW", left: "KeyA", right: "KeyD", fire: "Space", special: "KeyE" };
  {
    // 反证：这份存档确实是致命形状——照旧的逐字段逻辑合出来前进与后退同键。
    // 没有这一条，上面那条断言可能只是在测一份本来就无害的夹具（测空气）。
    const naive = { ...snapshot[0] };
    for (const a of ACTS) {
      const v = killer[a];
      if (typeof v === "string" && v && !RESERVED_KEYS.includes(v)) naive[a] = v;
    }
    check("反证：逐字段落默认会把这份存档合成「前进 = 后退」（按 W 则 move=0）",
      naive.forward === naive.back, `forward=${naive.forward} back=${naive.back}`);
  }
  snapshot.forEach((b, i) => Object.assign(KEY_BINDINGS[i], b));
  setStore(killer, { ...snapshot[1] });
  initSettings();
  check("黑名单键落默认后与另一个动作撞键 → 整套落默认（不留一个失灵的动作）",
    sane() && KEY_BINDINGS[0].forward === snapshot[0].forward
    && KEY_BINDINGS[0].back === snapshot[0].back,
    `forward=${KEY_BINDINGS[0].forward} back=${KEY_BINDINGS[0].back}`);

  // 同一个洞的另一个入口：special 是后来加的字段，老存档里根本没有它，
  // 于是它落默认 KeyE——而那个玩家当年把开火绑的就是 KeyE。
  snapshot.forEach((b, i) => Object.assign(KEY_BINDINGS[i], b));
  setStore({ forward: "KeyW", back: "KeyS", left: "KeyA", right: "KeyD", fire: "KeyE" }, { ...snapshot[1] });
  initSettings();
  check("老存档缺 special：落默认后与开火撞键 → 整套落默认（道具键不会静默失灵）",
    sane() && KEY_BINDINGS[0].fire !== KEY_BINDINGS[0].special,
    `fire=${KEY_BINDINGS[0].fire} special=${KEY_BINDINGS[0].special}`);

  // 跨玩家撞键：改键面板的 findBindingConflict 扫的是两套玩家的全部动作，
  // 加载期必须用同一把尺子，否则「面板里绑不上的组合」能从存档绕进来
  snapshot.forEach((b, i) => Object.assign(KEY_BINDINGS[i], b));
  setStore({ ...snapshot[0], fire: snapshot[1].forward }, { ...snapshot[1] });
  initSettings();
  check("跨玩家撞键也不许从存档绕进来（与改键面板同一把尺子）",
    sane() && KEY_BINDINGS[0].fire === snapshot[0].fire,
    `P1.fire=${KEY_BINDINGS[0].fire}`);

  // 反向护栏：**不许顺手把合法存档也拒了**。只断言「坏档落默认」的话，
  // 一个无条件返回默认的实现也能全绿——那就把改键功能整个废了。
  snapshot.forEach((b, i) => Object.assign(KEY_BINDINGS[i], b));
  const custom = { forward: "KeyT", back: "KeyG", left: "KeyF", right: "KeyH", fire: "KeyV", special: "KeyB" };
  setStore(custom, { ...snapshot[1] });
  initSettings();
  check("整套自洽的自定义键位逐字生效",
    sane() && ACTS.every((a) => KEY_BINDINGS[0][a] === custom[a]),
    ACTS.map((a) => KEY_BINDINGS[0][a]).join(","));

  // 后置条件：调用之后一定是一张自洽的表，与调用前的脏状态无关。
  // 故意先人为制造一个重键（模拟上一局改键留下的状态），再喂那份不自洽的存档——
  // 落默认那条路若只是 `return`，这张脏表就会原样留着。
  KEY_BINDINGS[0].back = KEY_BINDINGS[0].forward;
  setStore(killer, { ...snapshot[1] });
  initSettings();
  check("后置条件：落默认那条路显式写回全局表（不是 return 了事）",
    sane() && KEY_BINDINGS[0].back === snapshot[0].back,
    `back=${KEY_BINDINGS[0].back}`);

  // 还原全局表，别把污染带给后面的 section
  snapshot.forEach((b, i) => Object.assign(KEY_BINDINGS[i], b));

  // —— 提示已读列表的往返（阶段 28.5）——
  // 一次性提示的全部价值就是「只弹一次」，所以读写必须真的闭环。
  // 这里用的是同一个内存 stub，驱动的是真实的 loadHintsSeen/saveHintsSeen。
  {
    const { loadHintsSeen, saveHintsSeen } = await import("../src/settings.js");
    const { normalizeSeen, HINT_IDS } = await import("../src/hints.js");
    store.delete("tank-trouble.settings.v1");
    check("没存过时返回 null（调用方交给 normalizeSeen 落空集）", loadHintsSeen() === null);
    saveHintsSeen([HINT_IDS[1], HINT_IDS[0]]);
    const back = normalizeSeen(loadHintsSeen());
    check("写盘→读回→规范化，内容与顺序都稳定",
      back.length === 2 && back[0] === HINT_IDS[0] && back[1] === HINT_IDS[1], back.join(","));
    // 读-改-写合并：写提示不许把键位那些字段冲掉（settings 的既有纪律）
    saveBindings();
    saveHintsSeen([HINT_IDS[0]]);
    const raw = JSON.parse(store.get("tank-trouble.settings.v1"));
    check("写提示不冲掉同一份存档里的键位（读-改-写合并）",
      Array.isArray(raw.bindings) && raw.bindings.length === 2
      && Array.isArray(raw.hintsSeen) && raw.hintsSeen.length === 1);
    // 坏档不抛：非数组一律当没存过
    store.set("tank-trouble.settings.v1", JSON.stringify({ version: 1, hintsSeen: "oops" }));
    check("hintsSeen 坏档当没存过（不抛）", loadHintsSeen() === null);
  }

  delete globalThis.localStorage;
}

// ============================================================
section("鼠标点击坐标 (input)");
{
  // input.js 在模块顶层挂 window 事件（keydown/keyup/blur），装个 stub 就能在
  // node 里驱动真实的 bindMouse/getClickPos——于是「点 A 执行 B」这条不变量
  // 有了确定性的门，不必靠 CDP 手动比对。
  globalThis.window = { addEventListener: () => {} };
  const on = {};
  const canvas = {
    addEventListener: (type, fn) => { on[type] = fn; },
    // 1:1 映射（rect 尺寸 = 逻辑尺寸），于是 clientX/Y 直接就是逻辑坐标
    getBoundingClientRect: () => ({ left: 0, top: 0, width: CANVAS.width, height: CANVAS.height }),
  };
  const { bindMouse, getMousePos, getClickPos, isClicked, endFrame } = await import("../src/input.js");
  bindMouse(canvas);

  // 复现：同一帧里 mousemove(A) → click(A) → mousemove(B)。
  // 事件是异步到的、命中检测是下一帧才消费的，所以这段窗口真实存在；
  // 旧实现只存一份坐标，这一帧消费到的是 B——按下 A 按钮、执行 B 按钮。
  // 菜单上还能退回来，抽卡浮层上是不可撤销的误选（选中那张卡当场施加）。
  on.mousemove({ clientX: 100, clientY: 200 });
  on.click({ clientX: 100, clientY: 200 });
  on.mousemove({ clientX: 700, clientY: 600 });
  check("点击坐标不被 click 之后到达的 mousemove 推走",
    isClicked() && getClickPos().x === 100 && getClickPos().y === 200,
    `clickPos=(${getClickPos().x},${getClickPos().y})`);
  check("hover 坐标照旧跟手（按钮高亮要跟着动，这一份不能也被钉住）",
    getMousePos().x === 700 && getMousePos().y === 600);
  // 反证：夹具确实是致命形状——hover 真的漂到了另一个位置，旧实现必然读到它
  check("反证：旧实现读的那份坐标确实已经漂走",
    getMousePos().x !== getClickPos().x);

  endFrame();
  check("endFrame 复位点击边沿", !isClicked());

  // 合成点击（CDP 驱动 / 无障碍工具）不发 mousemove，坐标也必须对：
  // 点击事件自带 clientX/Y，不再依赖「点击前先 mouseMoved」这条潜规则
  on.click({ clientX: 333, clientY: 444 });
  check("不发 mousemove 的合成点击也带坐标",
    isClicked() && getClickPos().x === 333 && getClickPos().y === 444
    && getMousePos().x === 333, `clickPos=(${getClickPos().x},${getClickPos().y})`);

  // 一帧只消费一次点击动作（justClicked 是布尔量），所以同帧第二次点击整条丢掉、
  // 连坐标也不覆盖：先按下的那一下才是玩家的意思
  on.click({ clientX: 10, clientY: 20 });
  check("同帧第二次点击整条丢掉（坐标不被覆盖）",
    getClickPos().x === 333 && getClickPos().y === 444);
  endFrame();

  // 缩放窗口（rect 比逻辑尺寸小一半）时两条路径的映射必须逐字相同，
  // 否则 hover 高亮与实际命中会差一个比例——最难查的那种偏移
  const half = {
    addEventListener: (type, fn) => { on[type] = fn; },
    getBoundingClientRect: () => ({ left: 20, top: 10, width: CANVAS.width / 2, height: CANVAS.height / 2 }),
  };
  bindMouse(half);
  on.mousemove({ clientX: 20 + 100, clientY: 10 + 50 });
  const hoverAt = getMousePos();
  on.click({ clientX: 20 + 100, clientY: 10 + 50 });
  check("小窗缩放下 click 与 mousemove 的坐标映射一致",
    getClickPos().x === hoverAt.x && getClickPos().y === hoverAt.y
    && getClickPos().x === 200 && getClickPos().y === 100,
    `click=(${getClickPos().x},${getClickPos().y}) hover=(${hoverAt.x},${hoverAt.y})`);
  endFrame();
  delete globalThis.window;
}

// ============================================================
section("窗口状态坏档容错 (electron/window-state)");
{
  // 主进程的 main.cjs 一 require 就会跑 app.whenReady，node 直跑必崩，所以它里面
  // 的容错分支原本进不了任何自动化门。校验拆成纯函数后这几条退化路径可以逐条钉死
  // （与 stats.js「纯计算与存储访问分离」同一条纪律）。
  const mod = await import("../electron/window-state.cjs");
  const { normalizeWindowState } = mod.default ?? mod;

  // JSON.parse 对这些**都不抛**（它们是合法 JSON），但返回的不是能读属性的对象。
  // 旧代码紧接着读 saved.fullscreen 就抛 TypeError，而那行在 createWindow 里、
  // whenReady 之后 —— 后果不是「全屏状态没恢复」，是窗口建不出来、游戏打不开。
  const bad = [null, 0, 3, "", "x", true, false, [], [1, 2]];
  const offenders = bad.filter((raw) => {
    const r = normalizeWindowState(raw);
    return !r || typeof r !== "object" || Array.isArray(r) || r.fullscreen;
  });
  check("非对象的合法 JSON（null/数字/字符串/布尔/数组）一律落默认窗口态",
    offenders.length === 0, JSON.stringify(offenders));
  check("fullscreen 只放行布尔，别的类型落 false",
    normalizeWindowState({ fullscreen: true }).fullscreen === true
    && normalizeWindowState({ fullscreen: false }).fullscreen === false
    && normalizeWindowState({ fullscreen: 1 }).fullscreen === false
    && normalizeWindowState({ fullscreen: "true" }).fullscreen === false
    && normalizeWindowState({}).fullscreen === false);
  check("正常存档（写盘路径写出来的那种）照旧恢复全屏",
    normalizeWindowState(JSON.parse(JSON.stringify({ fullscreen: true }))).fullscreen === true);
  // 反证：旧写法在 "null" 这份输入上确实会抛——否则上面那条断言是在测空气
  let threwOld = false;
  try { void JSON.parse("null").fullscreen; } catch (e) { threwOld = true; }
  check('反证：旧写法读 JSON.parse("null").fullscreen 确实抛 TypeError', threwOld);
}

// ============================================================
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
