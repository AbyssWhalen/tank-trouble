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
// forward/back/left/right/fire/special（special=道具键：部署类道具用，如布雷；
// 开火键=射击，道具键=部署，语义分离。P1 取 E 贴 WASD 手位、P2 取右 Shift 贴方向键手位）
export const KEY_BINDINGS = [
  { forward: "KeyW", back: "KeyS", left: "KeyA", right: "KeyD", fire: "Space", special: "KeyE" },
  { forward: "ArrowUp", back: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", fire: "Enter", special: "ShiftRight" },
  { forward: "KeyI", back: "KeyK", left: "KeyJ", right: "KeyL", fire: "KeyU", special: "KeyO" },
  { forward: "Numpad8", back: "Numpad5", left: "Numpad4", right: "Numpad6", fire: "Numpad0", special: "NumpadAdd" },
];

// 回合结束到下一局重开的延迟（秒）
export const ROUND_RESTART_DELAY = 1.5;

// 局胜制：先到这个胜场数赢得整场（MATCH_OVER 大结算，可再来一场或回菜单）。
// 同归于尽不加分，所以整场时长有自然上限但无固定局数。
export const MATCH_TARGET = 5;

// 回合开场倒计时（3-2-1-GO）：倒计时期间双方全冻结——包括跳过 AI 的
// getControls（否则 AI 开火冷却在玩家不能动时被烧掉，GO 瞬间枪已就绪=抢先手）。
export const ROUND_INTRO = {
  beat: 0.7,   // 每拍时长（秒）：3/2/1 各一拍，总冻结 2.1s
  goHold: 0.5, // "GO!" 余像显示时长（此时已解冻，纯视觉）
};

// 击杀慢动作：终杀瞬间时间放慢（1v1 任何击杀都终结回合，直接挂在击杀点）。
// duration 按真实秒计（自身衰减用真实 dt，否则慢动作把自己也拖慢 1/scale 倍）。
export const SLOWMO = {
  scale: 0.35,    // 游戏时间倍率
  duration: 0.55, // 持续真实秒：覆盖爆炸碎片飞散最精彩的前半段
};

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

  // —— 敌方激光预瞄线感知（激光是 hitscan，杀伤线全程等危险，见 ai.js）——
  laserHazardStep: 40,      // 沿预瞄线采样危险圈的步长（像素）
  laserHazardRadius: 34,    // 采样危险圈半径（像素）；步长 < 2×半径保证沿线无缝
  laserMuzzleExempt: 1.2,   // 近炮口豁免半径（格）：这圈内采样不进寻路封锁——
                            //   交战终归要接近持枪人，封死其所在格会致全图不可达
  laserVirtualSpeed: 600,   // 预瞄线各段注入闪避评分的虚拟弹速（像素/秒）：
                            //   只用于给闪避航向提供"远离线"的梯度，非真实弹速
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
//   bounceAim      跳弹吊射开关：无视线时用镜像法找一次反弹解，停车转炮隔墙
//                  吊射（阵地射击）；持激光时同时解锁全路径反弹判定（反弹激光狙）。
//                  原版高手核心技能，仅困难档启用——这是三档的质变分水岭
export const AI_DIFFICULTY = {
  easy:   { label: "简单", aimSkill: 2.0, fireCooldown: [1.0, 1.8],   replanInterval: 0.7,  dodgeHorizon: 0,    dodgeMargin: 0,  ammoBudget: 2, leadFactor: 0,    powerupRange: 0, bounceAim: false },
  normal: { label: "普通", aimSkill: 1.4, fireCooldown: [0.55, 1.1],  replanInterval: 0.4,  dodgeHorizon: 0.4,  dodgeMargin: 5,  ammoBudget: 3, leadFactor: 0.75, powerupRange: 4, bounceAim: false },
  hard:   { label: "困难", aimSkill: 0.75, fireCooldown: [0.2, 0.45], replanInterval: 0.2,  dodgeHorizon: 1.1,  dodgeMargin: 16, ammoBudget: 4, leadFactor: 1.0,  powerupRange: 7, bounceAim: true },
};

// 墙体渲染 + 耐久
export const WALL = {
  color: "#2b2b33",       // 深炭灰细线，在浅灰场地上利落分明（原版风）
  thickness: 5,           // 内墙线宽
  borderThickness: 8,     // 外框线宽（比内墙粗，框住整个竞技场，贴近截图的醒目灰框）
  hp: 5,                  // 内墙耐久：被子弹撞击这么多次后碎掉（渲染按血量渐淡）；
                          //   外墙 border 不受侵蚀；地雷炸墙无视血量直接炸
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

// 道具系统（菜单可按类型开关）。道具在地图随机刷新，坦克碾过即捡取。
// 种类：scatter 散射弹（一炮变扇形多发，给若干次开火机会）、
//       shield 护盾（挡一次致命伤害，或限时自动消失，先到先算）、
//       laser 激光（接下来几发开火变瞬时射线：沿墙反弹、命中即杀，
//         持有时炮口延伸预瞄虚线——威力大但意图外露，平衡设计）、
//       mine 地雷（道具键在车尾布雷，布防后近敌即炸，主人也会踩）。
// scatter/laser/mine 同属「武器改装槽」互斥：同类拾取叠次数、
// 异类拾取清旧换新；shield 独立并存。
// 效果全作用在 tank 状态上，控制指令 {turn,move,fire,special} 不变 → AI 自动受益。
export const POWERUP = {
  spawnInterval: [6, 10], // 距上次刷新多久再刷（秒，随机区间）
  maxOnField: 2,          // 场上同时最多几个道具
  radius: 16,             // 拾取圈半径（≈坦克半径，碾过即吃）
  types: ["scatter", "shield", "laser", "mine"], // 全部种类（实际启用集合由菜单选择）

  scatter: {
    shots: 3,             // 捡一次给几次「扇形开火」机会
    pellets: 3,           // 每次扇形几发（奇数才有正中那发）
    spreadAngle: 0.26,    // 相邻两发夹角（弧度，≈15°）
  },
  shield: {
    duration: 5,          // 护盾最长持续（秒），到点自动消失防一直龟
  },
  laser: {
    shots: 1,             // 捡一次给几发激光（瞬时射线命中即杀——稀缺大招定位）
    maxBounces: 4,        // 射线最多反弹几次
    maxLength: 960,       // 射线总长上限（像素，= CELL_SIZE×10，防无限折返）
    beamDuration: 0.25,   // 亮线特效淡出时长（秒）
    // 平衡设计：持有时预瞄虚线全程可见（含全部反弹段，与实弹完全一致）——
    // 威力不削但意图全暴露，对手可绕线走位，「暗杀」变「明枪」（原版同款哲学）
  },
  mine: {
    charges: 2,           // 捡一次给几次布雷机会（道具键消耗）
    armDelay: 1.0,        // 布防延迟（秒）：落地后过这么久才进入警戒（给主人逃逸时间，
                          //   坦克 120px/s × 1s = 120px，足够离开 40px 触发圈）
    triggerRadius: 40,    // 警戒后任何坦克圆心距小于此即引爆（含主人，雷不认人）
    blastRadius: 60,      // 爆炸波及半径（圆心距），圈内坦克有盾消盾、无盾即死
    discRadius: 9,        // 雷盘视觉/落点修正半径（像素）
    visibleTime: 2,       // 警戒后保持可见的时长（秒），之后开始淡出
    fadeTime: 1,          // 淡出时长（秒），结束后完全隐形——同屏约束下主人也看不见，
                          //   布雷位置靠记忆（原版同款设计）；隐形不影响引爆判定
    holdTimeout: 10,      // 持雷超时（秒）：拾取后一直不部署则存货作废（防捏着白占
                          //   武器槽），每次成功部署刷新计时
    wallBlastRadius: 60,  // 炸墙半径（圆心距，与 blastRadius 同值起步）：圈内内墙被炸碎
                          //   （外墙 border 永不破）；菜单「墙体破坏」开关可整体关闭
  },
};

// 墙碎裂特效（地雷炸墙）：沿被炸墙段撒碎片，比坦克爆炸更小更快更干脆。
// 独立于 EXPLOSION——坦克爆炸手感已调好不动它。
export const WALL_BREAK = {
  duration: 0.5,          // 总时长（秒）
  shardPerSeg: [5, 8],    // 每段墙的碎片数量随机区间
  shardSpeed: [40, 140],  // 碎片初速（沿墙法线 ± 随机散布）
  shardSize: [3, 7],      // 碎片外接半径
  shardDrag: 4.0,         // 线性阻尼（比坦克碎片停得更快）
  shardSpin: 8,           // 最大自旋角速度
  fadeStart: 0.4,         // 进度超此比例后整体淡出
};

// ============================================================
// 音效 spec 表（程序合成，零素材文件；接线在 audio.js，此处纯数据）
// 每个事件 = 层数组（1~3 层叠加出厚度），两类层：
//   振荡器层 { type:"tone", wave, freq:[f0,f1], dur, gain, attack?, delay? }
//     freq 从 f0 指数滑到 f1（Hz），滑音是"游戏感"的核心
//   噪声层   { type:"noise", dur, gain, attack?, delay?, filter?:{kind, freq:[f0,f1]} }
//     白噪声过 biquad 滤波，截止频率 f0→f1 指数扫频（爆炸的"轰隆收尾"）
// 公共字段：dur 时长(秒)、gain 峰值(主音量前)、attack 起音(默认 0.002)、
//           delay 层起播偏移(默认 0，错开即琶音)
// 音量层次：击杀/爆炸(0.5~0.6) > 激光(0.28) > 开炮(0.22~0.28) > 拾取/结算(≈0.2) > UI(0.1)
// ============================================================
export const SFX = {
  // 普通开炮：短促「砰」——方波下滑 + 一点噪声气声
  shoot: [
    { type: "tone", wave: "square", freq: [520, 160], dur: 0.09, gain: 0.22 },
    { type: "noise", dur: 0.05, gain: 0.1, filter: { kind: "lowpass", freq: [3000, 800] } },
  ],
  // 散射开炮：更低更长更「重」（一炮多发是一个音，不是 pellets 次 shoot）
  shootScatter: [
    { type: "tone", wave: "square", freq: [300, 90], dur: 0.16, gain: 0.28 },
    { type: "noise", dur: 0.12, gain: 0.18, filter: { kind: "lowpass", freq: [2500, 500] } },
  ],
  // 激光：能量 zap——锯齿大跨度下扫 + 高八度方波「电流嘶鸣」
  laser: [
    { type: "tone", wave: "sawtooth", freq: [1600, 220], dur: 0.35, gain: 0.28, attack: 0.01 },
    { type: "tone", wave: "square", freq: [3200, 440], dur: 0.25, gain: 0.1, attack: 0.01 },
  ],
  // 坦克击杀：噪声爆 + 正弦低频「胸腔感」轰
  kill: [
    { type: "noise", dur: 0.5, gain: 0.5, filter: { kind: "lowpass", freq: [4000, 200] } },
    { type: "tone", wave: "sine", freq: [220, 50], dur: 0.4, gain: 0.5 },
  ],
  // 破盾（护盾挡下=击破是同一事件，全游戏只此一音）：清脆下滑 + 高通噪声碎裂
  shieldBreak: [
    { type: "tone", wave: "triangle", freq: [2000, 500], dur: 0.28, gain: 0.3 },
    { type: "noise", dur: 0.15, gain: 0.13, filter: { kind: "highpass", freq: [2000, 2000] } },
  ],
  // 道具拾取：上行双音确认；四种道具靠 PICKUP_RATE 整体变调区分
  pickup: [
    { type: "tone", wave: "triangle", freq: [660, 660], dur: 0.07, gain: 0.2 },
    { type: "tone", wave: "triangle", freq: [990, 990], dur: 0.12, gain: 0.2, delay: 0.08 },
  ],
  // 布雷：低频闷「咚」+ 延迟短咔哒——与 mineBlast 同低频域（家族感呼应）
  mineDeploy: [
    { type: "tone", wave: "sine", freq: [180, 120], dur: 0.12, gain: 0.25 },
    { type: "tone", wave: "square", freq: [1200, 1200], dur: 0.03, gain: 0.07, delay: 0.05 },
  ],
  // 地雷爆炸：比 kill 更深更长（对应全场最大震动 addShake(6)）
  mineBlast: [
    { type: "noise", dur: 0.7, gain: 0.6, filter: { kind: "lowpass", freq: [2500, 120] } },
    { type: "tone", wave: "sine", freq: [120, 35], dur: 0.6, gain: 0.55 },
  ],
  // 墙被炸碎：高频碎裂补充层（同帧必有 mineBlast 轰底，这里只补"石屑"质感）
  wallBreak: [
    { type: "noise", dur: 0.22, gain: 0.22, filter: { kind: "highpass", freq: [1500, 3000] } },
    { type: "tone", wave: "triangle", freq: [900, 300], dur: 0.15, gain: 0.12 },
  ],
  // 回合胜利：C5-E5-G5 上行琶音
  roundWin: [
    { type: "tone", wave: "triangle", freq: [523, 523], dur: 0.12, gain: 0.22 },
    { type: "tone", wave: "triangle", freq: [659, 659], dur: 0.12, gain: 0.22, delay: 0.12 },
    { type: "tone", wave: "triangle", freq: [784, 784], dur: 0.3, gain: 0.22, delay: 0.24 },
  ],
  // 整场获胜（先到 MATCH_TARGET）：roundWin 的加长版——C5-E5-G5-C6 四音上行，
  // 末音拉长收尾，比单回合胜利更隆重（家族感：同波形同音区，只是更长更高）
  matchWin: [
    { type: "tone", wave: "triangle", freq: [523, 523], dur: 0.12, gain: 0.25 },
    { type: "tone", wave: "triangle", freq: [659, 659], dur: 0.12, gain: 0.25, delay: 0.12 },
    { type: "tone", wave: "triangle", freq: [784, 784], dur: 0.12, gain: 0.25, delay: 0.24 },
    { type: "tone", wave: "triangle", freq: [1047, 1047], dur: 0.5, gain: 0.25, delay: 0.36 },
  ],
  // 同归于尽：下行双音（低落感）
  roundDraw: [
    { type: "tone", wave: "triangle", freq: [440, 440], dur: 0.15, gain: 0.18 },
    { type: "tone", wave: "triangle", freq: [330, 330], dur: 0.3, gain: 0.18, delay: 0.16 },
  ],
  // UI：菜单/暂停点击轻 tick；改键冲突/保留键低沉 buzz
  uiClick: [{ type: "tone", wave: "triangle", freq: [700, 700], dur: 0.045, gain: 0.1 }],
  uiError: [{ type: "tone", wave: "square", freq: [220, 180], dur: 0.18, gain: 0.13 }],
  // 开场倒计时：每拍短 tick；GO 上扬双音（解冻信号）
  countTick: [{ type: "tone", wave: "triangle", freq: [880, 880], dur: 0.08, gain: 0.18 }],
  countGo: [{ type: "tone", wave: "triangle", freq: [988, 1319], dur: 0.18, gain: 0.25 }],
};

// 拾取音的道具变调（playbackRate 式整体倍率）：攻击性越强音越高，
// 地雷偏低沉与其音效家族一致（1 / 大二度 / 大三度 / 下小六度附近取值）。
export const PICKUP_RATE = { scatter: 1, shield: 1.125, laser: 1.25, mine: 0.84 };

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
  powLaserBg: "#d0353f",   // 激光道具底色（深红，危险感）
  powIcon: "#ffffff",      // 道具图标线条（白，压在底色上）
  powRing: "#2b2b33",      // 道具圆底描边
  shieldRing: "#3ad4e8",   // 坦克护盾光环色（半透明在 render 里加）
  laserBeam: "#e63946",    // 激光亮线色（内芯，外圈光晕同色低透明）
  laserPreview: "rgba(230,57,70,0.45)", // 预瞄虚线（半透明红）
  powMineBg: "#5d6d7e",    // 地雷道具底色（灰蓝，低调中带危险感）
  mineBody: "#3a3a4a",     // 落地雷盘主体色（与履带同色系的深灰）
  mineBlink: "#e63946",    // 雷警戒指示灯（红，sin 闪烁）
};
