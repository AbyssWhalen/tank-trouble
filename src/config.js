// ============================================================
// config.js — 全局常量与配置
// 所有"魔法数字"集中在此，方便调参。改这里不改逻辑。
// ============================================================

// 画布尺寸（逻辑像素，实际渲染会按地图缩放居中）
export const CANVAS = {
  width: 960,
  height: 720,
};

// 迷宫格子边长（像素）。格子越大，坦克活动空间越开阔。
export const CELL_SIZE = 96;

// 地图档位（tier）→ 尺寸（列数 cols × 行数 rows）。
// 三档全是矩形（非正方），尺寸递增；具体墙体布局仍由 generateMaze 随机生成。
//   small  7×5 = 672×480  比 medium 小一圈，1v1 更紧凑、贴脸快
//   medium 9×7 = 864×672  阶段 0-4 的原始尺寸，刚好放进画布不缩放
//   large 13×8 = 1248×768 明显更大更扁（贴近横屏原版），超画面 → 触发自适应缩放
// 像素 = cols/rows × CELL_SIZE(96)。
export const MAZE_TIERS = {
  small: { cols: 7, rows: 5 },
  medium: { cols: 9, rows: 7 },
  large: { cols: 13, rows: 8 },
};

// 对战模式 → 可抽取的地图档位池。每回合 setupRound 从对应池随机抽一档。
//   pvp(1v1) / pve(人机)：small / medium 二选一，回合间换图增加变化
//   3p / 4p：归入联机 v2，档位已就绪（medium+large / large），本地版暂不可达
// 注意：3p/4p 模式尚未实现，large 目前游戏内抽不到，仅由冒烟测试覆盖其缩放正确性。
export const TIER_POOL_BY_MODE = {
  pvp: ["small", "medium"],
  pve: ["small", "medium"],
  "3p": ["medium", "large"],
  "4p": ["large"],
};

// 内部每条格子边放墙的概率（稀疏格栅的核心参数）。
// 越小越空旷、越适合追逐跳弹；越大越接近走迷宫。0.25~0.35 比较像原版。
export const WALL_DENSITY = 0.28;

// 坦克参数
// 外观模仿 Tank Trouble 原版：俯视角，上下两条履带夹着车体，中央圆炮塔伸出圆头炮管。
// 坐标约定：车体朝向 +x（炮管指向右），渲染时已 rotate 到 angle。
//   长(length) = 沿炮管方向(x)的尺寸；宽(width) = 垂直方向(y)的尺寸。
export const TANK = {
  radius: 16,            // 车体碰撞半径

  moveSpeed: 120,        // 像素/秒
  turnSpeed: 3.0,        // 弧度/秒

  // 车体（中间的彩色方块）
  bodyLength: 26,        // 沿炮管方向
  bodyWidth: 20,         // 垂直方向（不含履带）

  // 履带（上下两条深色横条，比车体略长、两端探出）
  treadLength: 34,       // 沿炮管方向，比车体长 → 两端露出
  treadWidth: 7,         // 单条履带的厚度
  treadInset: 1,         // 履带内缘与车体边缘的重叠/间隙微调

  // 炮塔（中央圆盘）
  turretRadius: 8,

  // 炮管（从炮塔伸出的圆头短管）
  barrelLength: 18,      // 从炮塔中心向前伸出的长度
  barrelWidth: 5,        // 炮管粗细
};

// 子弹参数
// 数值取向：还原原版 Tank Trouble 的"小黑点 + 暴躁跳弹"手感。
// 限流不靠冷却，而靠 maxAlive（同屏子弹上限）——这是原版的核心机制。
// 消亡只靠 lifetime（时间）这一道闸门：原版子弹无限反弹，纯靠寿命到点消失。
// cooldown 仅压到极小值防手滑狂点，几乎无感（≈ 模型 A）。
export const BULLET = {
  radius: 3,            // 直径 6px，约车体宽的 1/4~1/5，贴合原版小黑点比例
  speed: 180,           // 像素/秒（子弹变小后视觉显慢，略提一点补手感）
  maxBounces: Infinity, // 无限反弹（还原原版：子弹不因反弹次数消失，只因寿命到点）
  lifetime: 10.0,       // 寿命（秒）（原版实测值，时间是唯一的消亡闸门）
  cooldown: 0.15,       // 开炮微冷却（秒），仅防手滑狂点，真正限流靠 maxAlive
  maxAlive: 5,          // 单个玩家同屏最大子弹数（原版核心限流，去冷却后唯一闸门）
  selfHitGrace: 0.25,   // 子弹出膛后这段时间内不会打中发射者（防贴墙自爆）
};

// 玩家颜色（按索引）
// 浅色场地配色：原 青/黄 在白底上偏淡，加深到中明度，保证坦克在浅灰场上够跳。
export const PLAYER_COLORS = [
  "#1ba39c", // P1 青绿（加深，白底显形）
  "#e63946", // P2 红（加深，更沉稳）
  "#e9a200", // P3 橙黄（黄在白底几乎隐形，换暖橙）
  "#7c4dff", // P4 紫
];

// 多套键位：每个玩家一组。值为 KeyboardEvent.code。
// forward/back/left/right/fire
export const KEY_BINDINGS = [
  { forward: "KeyW", back: "KeyS", left: "KeyA", right: "KeyD", fire: "Space" },
  { forward: "ArrowUp", back: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", fire: "Enter" },
  { forward: "KeyI", back: "KeyK", left: "KeyJ", right: "KeyL", fire: "KeyU" },
  { forward: "Numpad8", back: "Numpad5", left: "Numpad4", right: "Numpad6", fire: "Numpad0" },
];

// 回合结束到下一局重开的延迟（秒）
export const ROUND_RESTART_DELAY = 1.5;

// 坦克被击破的爆炸效果（参考原版：深色烟团 + 浅色碎片四散）。
// 时长须 < ROUND_RESTART_DELAY，保证结算横幅期间能播完整段动画。
// 联机 v2 同款复用：死亡有视觉反馈而不是凭空消失。
export const EXPLOSION = {
  duration: 0.9,         // 总时长（秒）
  shardCount: [6, 9],    // 碎片数量随机区间
  shardSpeed: [60, 200], // 碎片初速（像素/秒），随机
  shardSize: [5, 11],    // 碎片外接半径（像素），随机
  shardDrag: 3.0,        // 碎片线性阻尼（指数衰减系数/秒），飞出后迅速减速
  shardSpin: 6,          // 碎片最大自旋角速度（弧度/秒，正负随机）
  smokeCount: 3,         // 烟团数量（中心一大两小错位叠放）
  smokeRadius: [12, 22], // 烟团初始半径随机区间
  smokeGrow: 30,         // 烟团膨胀速度（像素/秒）
  fadeStart: 0.45,       // 动画进度超过此比例后开始整体淡出（0~1）
};

// AI 参数（阶段 6 基础 AI：会追人、会开枪、能被打死；不躲弹不预判）。
// 这里只放与难度无关的共享参数；随难度变化的旋钮在下方 AI_DIFFICULTY。
export const AI = {
  moveAngleGate: 1.0,       // 朝路点偏角小于此值才前进（边转边走，像人操作）
  closeCombatRange: 130,    // 近战反打距离（像素）：贴得比这近 + 有视线 + 枪已就绪时
                            // 反打优先于躲弹——近距必中角大、弹程短，干掉火力源
                            // 比躲单发子弹划算；枪没就绪才专心躲
  closeCooldownBoost: 4,    // 敌人进近战圈后开火冷却的流逝倍速：节奏门是远距防狙神的，
                            // 贴脸刀战谁都是倾泻——普通档 0.7~1.4s 实际变 0.18~0.35s/发；
                            // 也覆盖"远处刚开完炮、对方冲脸"时烧掉残余冷却
  hitSlack: 1.5,            // 几何必中角的半径余量倍数：以"偏角在敌人处的横向偏差
                            // ≤ (坦克半径+子弹半径)×此值"反推必中角，1.5 倍是给
                            // 对方挪动留的提前量。开火窗口 = 必中角 × 各难度 aimSkill
  leadSmooth: 0.35,         // 敌速度估计的指数平滑系数（逐帧差分太抖，平滑后≈半拍收敛）；
                            // 速度估计喂给拦截预判（leadFactor），让 AI 打"你将到的位置"
  dodgeCommit: 0.3,         // 闪避航向锁定时长（秒）：威胁评估逐帧重算会让 AI 左右抽搐，
                            // 锁住一条道闪到底；威胁中途消失也把机动做完（半途折返等于没躲）
  dodgeClearance: 40,       // 闪避方向探测距离（像素）：朝墙里闪等于白闪，先探路再选
  dodgeWallPenalty: 1000,   // 朝墙航向的安全分罚没值：足够大保证只有八方皆堵才选朝墙的
  stuckWindow: 0.6,         // 卡住检测时窗（秒）
  stuckMinDist: 6,          // 时窗内想动却位移低于此值（像素）→ 判卡住
  unstickTime: 0.45,        // 脱困机动时长（秒）：倒车 + 随机方向转向
};

// AI 难度三档（菜单可选，默认 normal）。难度只调决策参数、不动坦克物理：
//   aimSkill       开火窗口倍数：开火条件 = 瞄准偏角 < 几何必中角 × 此值。
//                  必中角随距离变化（近大远小），所以贴脸大家都敢秒开、
//                  远距离都要求瞄正——这是"像人"的关键；倍数 >1 的档位
//                  接受脱靶提前开（糙），<1 的要求留命中余量（稳准狠）
//   fireCooldown   开火间隔随机区间（秒）。Tank 的 0.15s 微冷却挡不住逐帧
//                  fire=true 的连发，AI 必须自带节奏闸门
//   replanInterval BFS 重算路径间隔（秒），越小追人越紧
//   dodgeHorizon   躲弹预判窗（秒）：对子弹直线外推，最近逼近时刻落在窗内才视为
//                  威胁并闪避。0 = 不躲弹（简单档保持好欺负）
//   dodgeMargin    躲弹安全余量（像素）：在"坦克半径+子弹半径"外再加的提前量，
//                  越大躲得越早越稳
//   ammoBudget     同屏自留弹上限（发）：AI 的自我开火约束（远距生效，近战放开
//                  到 maxAlive-1），留弹防身/抓近身机会，不一照面倒光也不被饿死
//   leadFactor     拦截预判提前量比例：0 = 打当前位置（简单档老实人），
//                  1 = 全量提前（打"你将到的位置"）。这是"精密计算"的核心——
//                  打高速横移目标的当前位置是计算出的必失，AI 会忍住不浪费那发
//   powerupRange   道具感知半径（格）：只有这范围内、且对自己有用的道具才会去捡。
//                  优先级低于躲弹/反打（不为道具送命或放跑人头），高于纯追敌。
//                  简单档 0=完全不主动捡、普通 4=保守安全时捡、困难 7=激进主动抢
export const AI_DIFFICULTY = {
  easy:   { label: "简单", aimSkill: 2.0, fireCooldown: [1.0, 1.8],   replanInterval: 0.7,  dodgeHorizon: 0,    dodgeMargin: 0,  ammoBudget: 2, leadFactor: 0,   powerupRange: 0 },
  normal: { label: "普通", aimSkill: 1.5, fireCooldown: [0.7, 1.4],   replanInterval: 0.55, dodgeHorizon: 0.35, dodgeMargin: 4,  ammoBudget: 2, leadFactor: 0.6, powerupRange: 4 },
  hard:   { label: "困难", aimSkill: 0.9, fireCooldown: [0.25, 0.55], replanInterval: 0.25, dodgeHorizon: 0.9,  dodgeMargin: 14, ammoBudget: 3, leadFactor: 1.0, powerupRange: 7 },
};

// 墙体渲染
export const WALL = {
  color: "#2b2b33",       // 深炭灰细线，在浅灰场地上利落分明（原版风）
  thickness: 5,           // 内墙线宽
  borderThickness: 8,     // 外框线宽（比内墙粗，框住整个竞技场，贴近截图的醒目灰框）
};

// 竞技场自适应缩放的视口预留（逻辑像素）。
// 大图(large)超出画布时按比例缩到「可用区」内并居中；small/medium 放得下则 scale=1。
// 顶部留多些避开 HUD 计分条，其余三边留窄边距，外框不贴边。
export const VIEWPORT_PADDING = {
  top: 36,
  right: 18,
  bottom: 12,
  left: 18,
};

// 道具系统（菜单可开关）。道具在地图随机刷新，坦克碾过即捡取。
// 种类：scatter 散射弹（一炮变扇形多发，给若干次开火机会）、
//       shield 护盾（挡一次致命伤害，或限时自动消失，先到先算）、
//       pierce 穿墙弹（接下来几发子弹可穿透一堵内墙，穿后恢复正常反弹）。
// scatter/pierce（以及后续 mine）同属「武器改装槽」互斥：同类拾取叠次数、
// 异类拾取清旧换新；shield 独立并存。
// 效果全作用在 tank 状态上，控制指令 {turn,move,fire} 不变 → AI 自动受益、无需特判。
export const POWERUP = {
  spawnInterval: [6, 10], // 距上次刷新多久再刷（秒，随机区间）
  maxOnField: 2,          // 场上同时最多几个道具
  radius: 16,             // 拾取圈半径（≈坦克半径，碾过即吃）
  types: ["scatter", "shield", "pierce"], // 可刷新的种类（菜单关掉则整局不刷）

  scatter: {
    shots: 3,             // 捡一次给几次「扇形开火」机会
    pellets: 3,           // 每次扇形几发（奇数才有正中那发）
    spreadAngle: 0.26,    // 相邻两发夹角（弧度，≈15°）
  },
  shield: {
    duration: 5,          // 护盾最长持续（秒），到点自动消失防一直龟
  },
  pierce: {
    shots: 2,             // 捡一次给几发穿墙弹（每发可穿 1 堵内墙）
  },
};

// ============================================================
// 主题配色（浅色风，参考原版 Tank Trouble）
// UI 颜色集中此处，render 只引用、不写死，方便整体调色。
// ============================================================
export const THEME = {
  // 场地
  pageBg: "#e8e8ec",     // 画布外底色（窗口留白处）
  arenaBg: "#dcdce2",    // 竞技场地面（浅灰，让黑点子弹与黑墙都显形）
  arenaBorder: "#2b2b33",// 竞技场外框

  // 子弹
  bullet: "#1a1a1a",     // 纯黑点

  // 文字
  textMain: "#2b2b33",   // 主文字（深炭灰）
  textDim: "#9a9aa5",    // 次要/提示文字

  // 主题色（游戏感强调色）
  accent: "#2a5a8a",     // 深蓝（按钮选中、hover、强调元素）
  accentLight: "#4a7ab0",// 浅蓝（hover 时的渐变或边框）

  // 菜单
  title: "#2b2b33",      // 标题色
  btnFill: "#ffffff",    // 按钮底（白）
  btnFillHover: "#2a5a8a",// 悬停反色改用主题色
  btnTextHover: "#ffffff",
  btnBorder: "#2b2b33",
  btnDisabledFill: "#ededf0",
  btnDisabledText: "#b8b8c0",
  btnDisabledBorder: "#d0d0d6",

  // 结算遮罩
  overlay: "rgba(232,232,236,0.82)", // 浅色半透明压层（深色遮罩在浅底上太突兀）

  // 道具（地上的拾取物 + 坦克身上的护盾环）
  powScatterBg: "#e9a200", // 散射弹底色（暖橙，地面上够跳）
  powShieldBg: "#2bb3c4",  // 护盾道具底色（青蓝）
  powPierceBg: "#7c4dff",  // 穿墙弹底色（紫，与 P4 玩家色同源但本地版用不上 P4）
  powIcon: "#ffffff",      // 道具图标线条（白，压在底色上）
  powRing: "#2b2b33",      // 道具圆底描边
  shieldRing: "#3ad4e8",   // 坦克护盾光环色（半透明在 render 里加）
  bulletPierce: "#5b2fd6", // 穿墙弹弹体色（深紫，浅场地可读；穿墙后变回黑点）
};
