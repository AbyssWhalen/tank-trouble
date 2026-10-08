// ============================================================
// input.js — 键盘输入状态管理
// 监听 keydown/keyup，维护一张"当前按下了哪些键"的表。
// 主循环每帧用 isDown(code) 查询，而不是在事件回调里写逻辑——
// 这样移动是"持续按住持续生效"，手感才顺。
// ============================================================

import { CANVAS } from "./config.js";

// 当前按下的键集合，元素是 KeyboardEvent.code（如 "KeyW"、"Space"）
const pressed = new Set();

// 本帧"刚按下"的键（用于开炮这种边沿触发，按一下打一发，不连发）
// 每帧主循环消费后清空。
const justPressed = new Set();

// 鼠标状态：**两份坐标，刻意不合并**——实时 hover 一份，本帧那次点击一份。
// 菜单用逻辑坐标画按钮，命中检测也用逻辑坐标，所以这里存逻辑坐标即可（映射见 bindMouse）。
//
// 为什么点击要自己留一份：事件是异步到的，命中检测是**下一帧**才消费的，于是
// 「click 已经发生、这一帧还没消费」这段窗口里照旧会来一串 mousemove。只存一份
// 坐标的话，按下去的是 A 按钮、手滑到 B 再等一帧，执行的就是 B——
// 菜单上还能退回来，抽卡浮层上是不可撤销的误选（选中那张卡当场就施加到坦克上了）。
const mouse = { x: 0, y: 0 };      // 实时 hover：按钮高亮、抽卡卡面 hover 用
const clickPos = { x: 0, y: 0 };   // 本帧那次点击发生时的坐标（仅 justClicked 为真时有意义）
let justClicked = false;

window.addEventListener("keydown", (e) => {
  // 防止方向键、空格滚动页面
  if (
    ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)
  ) {
    e.preventDefault();
  }
  // repeat 为 true 表示系统的"长按重复"，不算新的一次按下
  if (!e.repeat) {
    justPressed.add(e.code);
  }
  pressed.add(e.code);
});

window.addEventListener("keyup", (e) => {
  pressed.delete(e.code);
});

// 窗口失焦时清空，避免"按着键切走再回来键还卡着"
window.addEventListener("blur", () => {
  pressed.clear();
  justPressed.clear();
});

// 鼠标事件坐标 → 逻辑坐标系 (CANVAS.width/height = 960×720)，与 render 用的坐标一致。
// 关键：HiDPI 适配后 canvas.width 是物理像素(960×dpr)，绝不能用它做映射目标——
// 否则鼠标会被映射到物理系，和按钮的逻辑坐标错位、点击必偏。
// rect 是 canvas 在屏幕上的实际 CSS 尺寸，按它把光标位置归一化后乘逻辑尺寸即可。
// mousemove 与 click 共用这一个函数：两条路径的算式必须逐字相同，否则 hover 高亮
// 与实际命中会差一个比例（小窗缩放下才显形，是最难查的那种偏移）。
function toLogical(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * CANVAS.width,
    y: ((e.clientY - rect.top) / rect.height) * CANVAS.height,
  };
}

// 绑定鼠标到 canvas：菜单交互用。hover 与点击各存一份坐标，见文件上方注释。
export function bindMouse(canvas) {
  canvas.addEventListener("mousemove", (e) => {
    const p = toLogical(canvas, e);
    mouse.x = p.x;
    mouse.y = p.y;
  });
  canvas.addEventListener("click", (e) => {
    const p = toLogical(canvas, e);
    // hover 也对齐到点击位置：鼠标确实就在那儿，顺带让「不发 mousemove 的合成点击」
    // （CDP 驱动、无障碍工具）也能正确命中，不再依赖"点击前先 mouseMoved"这条潜规则
    mouse.x = p.x;
    mouse.y = p.y;
    // 一帧只消费一次点击动作（justClicked 是布尔量），所以同帧的第二次点击**整条丢掉**、
    // 连坐标也不覆盖：先按下的那一下才是玩家的意思，后到的被丢弃与改动前同形
    if (justClicked) return;
    clickPos.x = p.x;
    clickPos.y = p.y;
    justClicked = true;
  });
}

// 某个键当前是否按住（持续状态，用于移动/转向）
export function isDown(code) {
  return pressed.has(code);
}

// 某个键这一帧是否刚按下（边沿触发，用于开炮）
export function isJustPressed(code) {
  return justPressed.has(code);
}

// 本帧任意刚按下的键（改键捕获用）：返回第一个 code，没有则 null。
// Set 保持插入序，同帧按多个键时取最先按下的那个。
export function getAnyJustPressed() {
  for (const code of justPressed) return code;
  return null;
}

// 把键位表转成统一控制指令 { turn, move, fire, special }——
// 这是「控制源抽象」的键盘实现：Tank 只消费指令不读键盘，
// AI 玩家由 ai.js 产出同构指令（接口与此对齐），主循环对人/AI 无感知。
//   turn: -1 左转 / 1 右转 / 0 不转    move: 1 前进 / -1 后退 / 0 停
//   fire: 边沿触发（本帧刚按下才 true，保持"按一下打一发"的手感）
//   special: 边沿触发，道具键（部署类道具，如布雷）
export function readControls(keys) {
  let turn = 0;
  if (isDown(keys.left)) turn -= 1;
  if (isDown(keys.right)) turn += 1;

  let move = 0;
  if (isDown(keys.forward)) move += 1;
  if (isDown(keys.back)) move -= 1;

  return {
    turn,
    move,
    fire: isJustPressed(keys.fire),
    special: isJustPressed(keys.special),
  };
}

// 鼠标当前坐标（逻辑坐标系）——**只给 hover 用**（按钮高亮、卡面高亮）。
// 命中检测请用 getClickPos()，理由见文件上方 clickPos 的注释。
export function getMousePos() {
  return { x: mouse.x, y: mouse.y };
}

// 本帧那次点击**发生时**的坐标（命中检测用）。只在 isClicked() 为真时有意义。
export function getClickPos() {
  return { x: clickPos.x, y: clickPos.y };
}

// 本帧是否刚点击鼠标（边沿触发，用于点按钮），endFrame 后复位
export function isClicked() {
  return justClicked;
}

// 每帧主循环末尾调用，清空"刚按下"集合，为下一帧做准备
export function endFrame() {
  justPressed.clear();
  justClicked = false;
}
