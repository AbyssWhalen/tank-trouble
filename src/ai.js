// ============================================================
// ai.js — AI 控制器（阶段 6 基础 AI）
// 接口与 input 对齐：每帧 update(dt, world) 返回与 readControls
// 同构的控制指令 { turn, move, fire }，Tank/主循环对人机无感知。
//
// 三层逻辑（取向是"街机陪练"，会追人、会开枪、能被打死）：
//   躲弹 —— 对场上全部子弹相对运动外推，8 个候选航向打"安全分"
//           （沿该向开车未来离任何子弹的最近距离），朝墙重罚、取最高分；
//           航向锁定 dodgeCommit 秒防抖动；屁股更朝逃生方向时直接倒车。
//           躲弹灵敏度（预判窗/安全余量）随难度变化，简单档不躲
//   寻路 —— 有视线直接朝敌人本体走；没视线 BFS 走格子图
//           （maze.cells 自带四面墙开关，天然邻接表），定期重算
//   移动 —— 朝目标转向（取最短旋转方向），大致对准才前进（边转边走）；
//           持续想动却没挪窝 → 判卡住，倒车+随机转向脱困
//   开火 —— 三道门：节奏冷却（随机化防狙神）、弹药预算（不一梭子倒光）、
//           命中质量（窗口 = 几何必中角×难度技巧系数，近大远小——
//           贴脸窗口极宽，近战边追边连续还手，无需特殊缠斗机动）
// 不做的：弹道预判射击、跳弹瞄准（难度升级留给后续阶段）。
// ============================================================

import { AI, AI_DIFFICULTY, CELL_SIZE, TANK, BULLET } from "./config.js";
import { segmentVsSegment } from "./collision.js";
import { DIRS } from "./maze.js";

// [min, max] 区间取随机数（AI 开火节奏抖动用）
function randRange([min, max]) {
  return min + Math.random() * (max - min);
}

// 角度差归一化到 [-π, π]，保证转向永远取最短旋转方向
function normalizeAngle(a) {
  return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

// 世界坐标 → 所在格（夹回地图内，防止贴墙浮点误差越界）
function cellOf(tank, maze) {
  const c = Math.max(0, Math.min(maze.cols - 1, Math.floor(tank.x / CELL_SIZE)));
  const r = Math.max(0, Math.min(maze.rows - 1, Math.floor(tank.y / CELL_SIZE)));
  return { c, r };
}

// 格 → 格中心世界坐标
function cellCenter(cell) {
  return { x: (cell.c + 0.5) * CELL_SIZE, y: (cell.r + 0.5) * CELL_SIZE };
}

// 自己中心到敌人中心的连线是否不被任何墙挡（中心连线近似，够基础 AI 用）
function hasLineOfSight(self, enemy, walls) {
  return !segmentHitsWalls(self.x, self.y, enemy.x, enemy.y, walls);
}

// 线段是否撞到任意墙（视线检测 / 闪避探路共用）
function segmentHitsWalls(x1, y1, x2, y2, walls) {
  for (const w of walls) {
    if (segmentVsSegment(x1, y1, x2, y2, w.x1, w.y1, w.x2, w.y2)) {
      return true;
    }
  }
  return false;
}

// 朝指定航向操舵：取最短旋转对齐；航向更靠车尾时倒车贴合（车尾当车头），
// 省掉慢吞吞的 180° 转身——躲弹时这省出的就是命。
function steerToHeading(self, heading) {
  let diff = normalizeAngle(heading - self.angle);
  let move = 1;
  if (Math.abs(diff) > Math.PI / 2) {
    diff = normalizeAngle(diff - Math.PI); // 反向对齐
    move = -1;
  }
  const turn = Math.abs(diff) > 0.05 ? Math.sign(diff) : 0;
  return { turn, move };
}

// 选闪避航向：8 个等分候选航向逐一打"安全分"——按该航向以坦克速度开车，
// 未来 horizon 秒内离场上任何子弹的最近距离（相对运动闭式解，全弹幕一起算，
// 不是只躲最急那颗）。朝墙的航向重罚（朝墙里闪等于站桩挨打），取最高分。
// 这就是"在一堆子弹里找正确路线"：横穿、斜退、借位都可能是最优解。
// 导出供冒烟测试直接验证选路正确性。
export function pickDodgeHeading(self, bullets, walls, horizon) {
  let bestHeading = 0;
  let bestScore = -Infinity;

  for (let k = 0; k < 8; k++) {
    const heading = (k * Math.PI) / 4;
    const ux = Math.cos(heading) * TANK.moveSpeed;
    const uy = Math.sin(heading) * TANK.moveSpeed;

    // 安全分 = 沿该航向行驶时，与所有子弹未来最近距离的最小值
    let score = Infinity;
    for (const b of bullets) {
      if (b.dead) continue;
      const rx = b.x - self.x;          // 子弹相对自己的位置
      const ry = b.y - self.y;
      const wx = b.vx - ux;             // 子弹相对自己的速度
      const wy = b.vy - uy;
      const w2 = wx * wx + wy * wy;
      // 相对距离最小的时刻，夹到 [0, horizon]（过去不算，太远的未来不赌）
      let t = w2 > 1e-9 ? -(rx * wx + ry * wy) / w2 : 0;
      t = Math.max(0, Math.min(horizon, t));
      score = Math.min(score, Math.hypot(rx + wx * t, ry + wy * t));
    }

    // 朝墙航向重罚：罚值足够大，只有八方皆堵才会选到朝墙的（那就蹭墙滑）
    if (segmentHitsWalls(
      self.x, self.y,
      self.x + Math.cos(heading) * AI.dodgeClearance,
      self.y + Math.sin(heading) * AI.dodgeClearance,
      walls
    )) {
      score -= AI.dodgeWallPenalty;
    }

    if (score > bestScore) {
      bestScore = score;
      bestHeading = heading;
    }
  }
  return bestHeading;
}

// BFS 网格最短路：返回从 from 的下一格到 to 的格子序列（不含 from）。
// 同格或不可达返回 []。迷宫生成时已保证全连通，不可达只是兜底。
function findPath(maze, from, to) {
  if (from.c === to.c && from.r === to.r) return [];

  const { cols, rows, cells } = maze;
  const prev = Array.from({ length: rows }, () => new Array(cols).fill(null));
  prev[from.r][from.c] = from; // 自指标记"已访问"，回溯时作终止哨兵
  const queue = [from];

  for (let head = 0; head < queue.length; head++) {
    const { c, r } = queue[head];
    if (c === to.c && r === to.r) break;
    for (const d of DIRS) {
      const nc = c + d.dc;
      const nr = r + d.dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      if (prev[nr][nc]) continue;          // 已访问
      if (cells[r][c][d.wall]) continue;   // 这面有墙，过不去
      prev[nr][nc] = { c, r };
      queue.push({ c: nc, r: nr });
    }
  }

  if (!prev[to.r][to.c]) return []; // 不可达（理论上不会发生）

  // 从终点回溯到起点，反转得到 from→to 的途经格序列
  const path = [];
  let cur = to;
  while (!(cur.c === from.c && cur.r === from.r)) {
    path.push(cur);
    cur = prev[cur.r][cur.c];
  }
  return path.reverse();
}

export class AiController {
  // player: 本 AI 操控的 Player（从中取自己的坦克）
  // level:  难度档位 key（AI_DIFFICULTY 的 easy/normal/hard），决定瞄准/节奏/反应
  constructor(player, level = "normal") {
    this.player = player;
    this.cfg = AI_DIFFICULTY[level] || AI_DIFFICULTY.normal; // 容错兜底普通档

    this.path = [];          // 待走的格子序列，[0] 是下一个路点
    this.replanTimer = 0;    // 归零触发 BFS 重算（敌我都在动，路径很快过期）
    this.fireTimer = randRange(this.cfg.fireCooldown); // 开局先压一拍，不秒开枪

    // 闪避机动：航向选定后锁 dodgeCommit 秒（防抖），锁定期内一条道闪到底
    this.dodgeTimer = 0;     // >0 表示正在执行闪避机动
    this.dodgeHeading = 0;   // 锁定的逃生航向（弧度）

    // 卡住检测：从"开始想动"处锚定位置，持续想动却没挪窝就脱困
    this.movingTime = 0;     // 连续处于"想前进"状态的时长
    this.anchorX = 0;
    this.anchorY = 0;
    this.unstickTimer = 0;   // >0 表示正在脱困机动
    this.unstickTurn = 1;    // 脱困时的转向（随机定一边，避免左右横跳）
  }

  // 每帧调用。world = { maze, players, bullets }（bullets 暂未用，留给躲弹）。
  // 返回 { turn, move, fire }，与 input.readControls 同构。
  update(dt, world) {
    const self = this.player.tank;
    const idle = { turn: 0, move: 0, fire: false };
    if (!self.alive) return idle;

    // 目标：场上另一个存活玩家（1v1 就一个；没有则待机）
    const enemyPlayer = world.players.find((p) => p !== this.player && p.alive);
    if (!enemyPlayer) return idle;
    const enemy = enemyPlayer.tank;

    this.fireTimer -= dt;
    this.replanTimer -= dt;

    // —— 0) 脱困机动优先：倒车 + 定向转，无视寻路与开火 ——
    if (this.unstickTimer > 0) {
      this.unstickTimer -= dt;
      return { turn: this.unstickTurn, move: -1, fire: false };
    }

    const los = hasLineOfSight(self, enemy, world.maze.walls);
    const enemyDist = Math.hypot(enemy.x - self.x, enemy.y - self.y);

    // —— 1) 躲弹优先于追击：选定逃生航向后锁 dodgeCommit 秒 ——
    // 不锁的话脱靶向量随双方移动逐帧翻面，AI 会左右抽搐；
    // 锁定期内威胁消失也把机动做完（半途折返等于没躲）。
    let turn, move;
    this.dodgeTimer -= dt;
    const threat = this.cfg.dodgeHorizon > 0 ? this.findThreat(self, world.bullets) : null;
    if (threat && this.dodgeTimer <= 0) {
      this.dodgeHeading = pickDodgeHeading(
        self, world.bullets, world.maze.walls, this.cfg.dodgeHorizon
      );
      this.dodgeTimer = AI.dodgeCommit;
    }
    if (this.dodgeTimer > 0) {
      ({ turn, move } = steerToHeading(self, this.dodgeHeading));
      this.path = [];        // 闪避破坏走位，旧路径作废，威胁解除后重算
      this.movingTime = 0;   // 闪避不计入卡住检测（被弹幕压在墙角不算卡）
    } else {
      // —— 2) 追击：选目标点（有视线直追本体，没视线走 BFS 路点）——
      // 近战不需要特殊机动：必中角近大远小，贴脸时开火窗口极宽，
      // 边追边连续还手就是最强进攻；撞上对方有坦克碰撞顶着，无碍
      let target;
      if (los) {
        target = enemy;
        this.path = []; // 直追时旧路径作废，下次失去视线再重算
      } else {
        if (this.replanTimer <= 0 || this.path.length === 0) {
          this.replanTimer = this.cfg.replanInterval;
          this.path = findPath(world.maze, cellOf(self, world.maze), cellOf(enemy, world.maze));
        }
        // 走到路点格中心附近就弹出，奔向下一个（while：一帧可能跨过多个）
        while (this.path.length > 0) {
          const wp = cellCenter(this.path[0]);
          if (Math.hypot(wp.x - self.x, wp.y - self.y) > CELL_SIZE * 0.3) break;
          this.path.shift();
        }
        // 路径走完/不可达兜底：直接朝敌人本体怼（撞墙滑动 + 卡住脱困能兜住）
        target = this.path.length > 0 ? cellCenter(this.path[0]) : enemy;
      }

      // —— 3) 转向 + 前进：取最短旋转方向，大致对准才走 ——
      const desired = Math.atan2(target.y - self.y, target.x - self.x);
      const diff = normalizeAngle(desired - self.angle);
      turn = Math.abs(diff) > 0.05 ? Math.sign(diff) : 0; // 小死区防抖
      move = Math.abs(diff) < AI.moveAngleGate ? 1 : 0;

      // —— 4) 卡住检测：连续想动 stuckWindow 秒却没挪出 stuckMinDist → 脱困 ——
      if (move !== 0) {
        if (this.movingTime === 0) {
          this.anchorX = self.x; // 刚开始想动，锚定起点
          this.anchorY = self.y;
        }
        this.movingTime += dt;
        if (this.movingTime >= AI.stuckWindow) {
          const moved = Math.hypot(self.x - this.anchorX, self.y - this.anchorY);
          if (moved < AI.stuckMinDist) {
            this.unstickTimer = AI.unstickTime;
            this.unstickTurn = Math.random() < 0.5 ? -1 : 1;
            this.path = []; // 卡住说明旧路径不可信，脱困后重算
          }
          this.movingTime = 0; // 无论卡没卡，重开一个检测窗
        }
      } else {
        this.movingTime = 0; // 原地转向不算"想动"，不计入卡住
      }
    }

    // —— 5) 开火：像人一样打——三道门全过才扣扳机 ——
    //   ① 节奏门：自身随机冷却（fireTimer），防机枪式倾泻
    //   ② 弹药门：同屏自留弹 < ammoBudget，留弹防身/抓近身机会，
    //      不一照面把 maxAlive 一梭子倒光
    //   ③ 质量门：开火窗口 = 几何必中角 × 难度 aimSkill。必中角随距离
    //      近大远小——贴脸 ±25° 都必中就别犹豫（近战反应快的关键），
    //      远距离窗口自然收窄，杜绝朝大概方向乱泼弹
    let fire = false;
    if (los && this.fireTimer <= 0) {
      let myShots = 0;
      for (const b of world.bullets) {
        if (!b.dead && b.owner === self) myShots++;
      }
      if (myShots < this.cfg.ammoBudget) {
        const hitTol = Math.atan2((TANK.radius + BULLET.radius) * AI.hitSlack, enemyDist);
        const effTol = hitTol * this.cfg.aimSkill;
        const aimDiff = normalizeAngle(
          Math.atan2(enemy.y - self.y, enemy.x - self.x) - self.angle
        );
        if (Math.abs(aimDiff) < effTol) {
          fire = true;
          this.fireTimer = randRange(this.cfg.fireCooldown);
        }
      }
    }

    return { turn, move, fire };
  }

  // 预判最先命中自己的子弹：对每颗活子弹按当前速度直线外推（忽略未来反弹，
  // 子弹反弹后速度变了下一帧自然重判），求最近逼近时刻 t 与脱靶向量——
  // t 落在 (0, dodgeHorizon] 且脱靶距离小于安全半径才算威胁。
  // 误报（实际会先撞墙拐走的子弹）只是让 AI 多躲一下，无伤大雅。
  // 自己刚打出去的子弹在远离，t<0 天然不触发。
  findThreat(self, bullets) {
    const danger = TANK.radius + BULLET.radius + this.cfg.dodgeMargin;
    let best = null;
    for (const b of bullets) {
      if (b.dead) continue;
      const v2 = b.vx * b.vx + b.vy * b.vy;
      if (v2 === 0) continue;
      // 最近逼近时刻：把"子弹→自己"的相对位置投影到弹速方向
      const t = ((self.x - b.x) * b.vx + (self.y - b.y) * b.vy) / v2;
      if (t <= 0 || t > this.cfg.dodgeHorizon) continue; // 正在远离 / 还太远
      const mx = self.x - (b.x + b.vx * t); // 逼近点指向自己的"脱靶向量"
      const my = self.y - (b.y + b.vy * t);
      if (mx * mx + my * my >= danger * danger) continue; // 擦不到，不用理
      if (!best || t < best.t) best = { b, t, mx, my };   // 盯最急的那颗
    }
    return best;
  }
}
