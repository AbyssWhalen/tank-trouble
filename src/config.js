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

  // 菜单
  title: "#2b2b33",      // 标题色
  btnFill: "#ffffff",    // 按钮底（白）
  btnFillHover: "#2b2b33",// 悬停反色
  btnTextHover: "#ffffff",
  btnBorder: "#2b2b33",
  btnDisabledFill: "#ededf0",
  btnDisabledText: "#b8b8c0",
  btnDisabledBorder: "#d0d0d6",

  // 结算遮罩
  overlay: "rgba(232,232,236,0.82)", // 浅色半透明压层（深色遮罩在浅底上太突兀）
};
