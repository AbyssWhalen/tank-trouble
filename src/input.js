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

// 鼠标状态：当前坐标（相对 canvas 左上角的 CSS 像素）+ 本帧是否刚点击。
// 菜单用屏幕坐标画按钮，命中检测也用屏幕坐标，所以这里存 CSS 像素即可。
const mouse = { x: 0, y: 0 };
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

// 绑定鼠标到 canvas：菜单交互用。
// 坐标映射到「逻辑坐标系」(CANVAS.width/height = 960×720)，与 render 用的坐标一致。
// 关键：HiDPI 适配后 canvas.width 是物理像素(960×dpr)，绝不能用它做映射目标——
// 否则鼠标会被映射到物理系，和按钮的逻辑坐标错位、点击必偏。
// rect 是 canvas 在屏幕上的实际 CSS 尺寸，按它把光标位置归一化后乘逻辑尺寸即可。
export function bindMouse(canvas) {
  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * CANVAS.width;
    mouse.y = ((e.clientY - rect.top) / rect.height) * CANVAS.height;
  });
  canvas.addEventListener("click", () => {
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

// 把键位表转成统一控制指令 { turn, move, fire }——
// 这是「控制源抽象」的键盘实现：Tank 只消费指令不读键盘，
// AI 玩家由 ai.js 产出同构指令（接口与此对齐），主循环对人/AI 无感知。
//   turn: -1 左转 / 1 右转 / 0 不转    move: 1 前进 / -1 后退 / 0 停
//   fire: 边沿触发（本帧刚按下才 true，保持"按一下打一发"的手感）
export function readControls(keys) {
  let turn = 0;
  if (isDown(keys.left)) turn -= 1;
  if (isDown(keys.right)) turn += 1;

  let move = 0;
  if (isDown(keys.forward)) move += 1;
  if (isDown(keys.back)) move -= 1;

  return { turn, move, fire: isJustPressed(keys.fire) };
}

// 鼠标当前坐标（canvas 内部像素坐标），菜单命中检测用
export function getMousePos() {
  return { x: mouse.x, y: mouse.y };
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
