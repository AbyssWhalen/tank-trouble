// ============================================================
// maze.js — 随机地图生成（稀疏规整格栅）
// Tank Trouble 的"迷宫"不是标准迷宫，而是稀疏格栅：
//   - 规整网格，每条格子边界"可能有墙也可能没有"，墙都横平竖直、整格长
//   - 墙稀疏、大量缺口 → 空间开阔、四通八达，适合追逐和跳弹绕射
//   （标准 DFS 迷宫恰恰相反：墙密、通道窄、基本无环，像走迷宫而非打仗）
//
// 生成流程：
//   1) 从"全开放"起步（内部无墙），外边界封闭
//   2) 每条内部边按 WALL_DENSITY 概率放一堵墙
//   3) 连通性修复：泛洪检查，把被围出的孤立区域打通
//      （顺带消除"四面被围死"的格子）
//
// 坐标约定：格 (c, r) 的左上角世界坐标 = (c*CELL_SIZE, r*CELL_SIZE)。
// 每个格用四面墙的开关表示：top/right/bottom/left。相邻两格共享一堵墙。
// ============================================================

import { CELL_SIZE, WALL_DENSITY } from "./config.js";

// 四方向表：格间邻接 + 对应墙面名。maze 自用（泛洪/敲墙），ai.js 寻路也复用。
export const DIRS = [
  { dc: 0, dr: -1, wall: "top", opposite: "bottom" },
  { dc: 1, dr: 0, wall: "right", opposite: "left" },
  { dc: 0, dr: 1, wall: "bottom", opposite: "top" },
  { dc: -1, dr: 0, wall: "left", opposite: "right" },
];

// 生成地图，返回 { cols, rows, cells, walls, cellSize }
// cells[r][c] = { top, right, bottom, left }，true 表示该面有墙
// walls = 去重后的线段数组 [{x1,y1,x2,y2}, ...]，世界坐标
export function generateMaze(cols, rows) {
  // --- 1) 全开放起步，仅封闭外边界 ---
  const cells = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push({
        top: r === 0,            // 最上行的 top 是外墙
        bottom: r === rows - 1,  // 最下行的 bottom 是外墙
        left: c === 0,           // 最左列的 left 是外墙
        right: c === cols - 1,   // 最右列的 right 是外墙
      });
    }
    cells.push(row);
  }

  // --- 2) 内部边按概率放墙 ---
  // 垂直内墙：格 (c,r) 的 right ↔ 格 (c+1,r) 的 left
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      if (Math.random() < WALL_DENSITY) {
        cells[r][c].right = true;
        cells[r][c + 1].left = true;
      }
    }
  }
  // 水平内墙：格 (c,r) 的 bottom ↔ 格 (c,r+1) 的 top
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      if (Math.random() < WALL_DENSITY) {
        cells[r][c].bottom = true;
        cells[r + 1][c].top = true;
      }
    }
  }

  // --- 3) 连通性修复 ---
  ensureConnected(cells, cols, rows);

  const walls = buildWallSegments(cells, cols, rows);
  return { cols, rows, cells, walls, cellSize: CELL_SIZE };
}

// 拆掉两相邻格之间的墙
function knockWall(cells, c, r, d) {
  cells[r][c][d.wall] = false;
  cells[r + d.dr][c + d.dc][d.opposite] = false;
}

// 从 (0,0) 泛洪，标记所有可达格
function floodReachable(cells, cols, rows) {
  const reached = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const stack = [{ c: 0, r: 0 }];
  reached[0][0] = true;
  while (stack.length) {
    const { c, r } = stack.pop();
    for (const d of DIRS) {
      const nc = c + d.dc;
      const nr = r + d.dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      if (reached[nr][nc]) continue;
      if (cells[r][c][d.wall]) continue; // 这面有墙，过不去
      reached[nr][nc] = true;
      stack.push({ c: nc, r: nr });
    }
  }
  return reached;
}

// 反复泛洪：每轮找一个"不可达但紧邻可达区"的格，敲掉中间墙打通，
// 直到全图连通。这样既保证连通，又只在必要处开口，保持稀疏。
function ensureConnected(cells, cols, rows) {
  // 上限防死循环（理论上每轮至少接通一格）
  for (let guard = 0; guard < cols * rows + 5; guard++) {
    const reached = floodReachable(cells, cols, rows);

    let opened = false;
    let allReached = true;
    for (let r = 0; r < rows && !opened; r++) {
      for (let c = 0; c < cols && !opened; c++) {
        if (reached[r][c]) continue;
        allReached = false;
        // 找一个已可达的邻居，敲掉中间的墙接通
        for (const d of DIRS) {
          const nc = c + d.dc;
          const nr = r + d.dr;
          if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
          if (reached[nr][nc]) {
            knockWall(cells, c, r, d);
            opened = true;
            break;
          }
        }
      }
    }
    if (allReached) break; // 全连通，收工
  }
}

// 把格子的墙转成世界坐标线段（去重）。
// 只在"本格"负责 top 和 left，外圈的 right(最后一列)、bottom(最后一行) 另算，
// 避免相邻格共享墙被画两次。
// border 标记：外边界墙（初始化后永不被敲）为 true——穿墙弹只穿内墙，
// 靠这个标记保证物理上不可能飞出场外。
function buildWallSegments(cells, cols, rows) {
  const segs = [];
  const S = CELL_SIZE;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[r][c];
      const x = c * S;
      const y = r * S;

      if (cell.top)
        segs.push({ x1: x, y1: y, x2: x + S, y2: y, border: r === 0 });
      if (cell.left)
        segs.push({ x1: x, y1: y, x2: x, y2: y + S, border: c === 0 });
      if (c === cols - 1 && cell.right)
        segs.push({ x1: x + S, y1: y, x2: x + S, y2: y + S, border: true });
      if (r === rows - 1 && cell.bottom)
        segs.push({ x1: x, y1: y + S, x2: x + S, y2: y + S, border: true });
    }
  }

  return segs;
}
