// ============================================================
// layout.js — 竞技场自适应缩放布局
// 职责：给定竞技场像素尺寸，算出「缩放比 + 居中偏移」，让任意大小的图
//       都恰好放进画布可用区。小图(放得下)原样显示(scale=1)，
//       大图(超出)按比例缩到刚好放下，再居中。
//
// 为什么单独成模块：main.js 顶层有副作用(取 canvas、起 raf)，不宜被测试直接 import；
// 这里是纯函数、零副作用、零 DOM 依赖，可被冒烟测试单独 import 验证缩放正确性。
//
// 坐标约定：返回的 scale 用于 ctx.scale()，offsetX/Y 用于 ctx.translate()，
// 先 translate 再 scale，之后所有绘制仍用「世界坐标」，物理代码一行不动。
// ============================================================

import { CANVAS, VIEWPORT_PADDING } from "./config.js";

// 计算把 arenaW×arenaH 的竞技场放进画布可用区的布局。
// 返回 { scale, offsetX, offsetY }：
//   scale   —— 缩放比，∈(0,1]，1 表示原样不缩
//   offsetX —— 居中后竞技场左上角的 x（逻辑像素，已含左边距）
//   offsetY —— 同上 y
export function fitArena(arenaW, arenaH) {
  const { top, right, bottom, left } = VIEWPORT_PADDING;
  const availW = CANVAS.width - left - right;
  const availH = CANVAS.height - top - bottom;

  // 放得下就不放大(上限 1)，放不下就取「宽缩比/高缩比」里更狠的那个，保证两维都进框
  const scale = Math.min(1, availW / arenaW, availH / arenaH);

  const drawnW = arenaW * scale;
  const drawnH = arenaH * scale;

  // 在可用区内居中，再补上左/上边距换算到画布坐标
  const offsetX = left + (availW - drawnW) / 2;
  const offsetY = top + (availH - drawnH) / 2;

  return { scale, offsetX, offsetY };
}
