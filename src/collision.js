// ============================================================
// collision.js — 纯几何碰撞工具
// 全是无状态函数，不依赖游戏对象，方便单独推理与复用。
//
// 用途：
//   - circleVsSegment：坦克(圆)/子弹(圆) 撞墙(线段) 检测
//   - resolveCircleWalls：把圆推出所有相交的墙，实现"撞墙不穿 + 沿墙滑动"
//   - reflect：子弹撞墙的反射向量（阶段 3 用）
// ============================================================

// 求点 P 到线段 AB 的最近点
export function closestPointOnSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: x1, y: y1 }; // 退化成点
  // 投影参数 t，夹到 [0,1] 限制在线段内
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: x1 + t * dx, y: y1 + t * dy };
}

// 圆(cx,cy,r) 是否与线段相交。相交则返回穿透信息，否则返回 null。
// 返回 { nx, ny, depth }：nx,ny 是从墙指向圆心的单位法线，depth 是穿透深度。
export function circleVsSegment(cx, cy, r, x1, y1, x2, y2) {
  const cp = closestPointOnSegment(cx, cy, x1, y1, x2, y2);
  let nx = cx - cp.x;
  let ny = cy - cp.y;
  const distSq = nx * nx + ny * ny;

  if (distSq >= r * r) return null; // 没碰到

  const dist = Math.sqrt(distSq);
  if (dist === 0) {
    // 圆心正好落在线段上：退化，用线段法线方向兜底
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    nx = -dy / len;
    ny = dx / len;
    return { nx, ny, depth: r };
  }

  return { nx: nx / dist, ny: ny / dist, depth: r - dist };
}

// 把圆从所有相交的墙里推出来。
// 逐墙解算并把圆心沿法线推出穿透深度——多墙时迭代几遍收敛，
// 角落里被两面墙夹住也能稳定停住（这就是"沿墙滑动"的来源：
// 沿墙方向的分量不被抵消，只消掉朝墙里钻的分量）。
// 返回修正后的 { x, y }。
export function resolveCircleWalls(cx, cy, r, walls, iterations = 3) {
  let x = cx;
  let y = cy;
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (const w of walls) {
      const hit = circleVsSegment(x, y, r, w.x1, w.y1, w.x2, w.y2);
      if (hit) {
        x += hit.nx * hit.depth;
        y += hit.ny * hit.depth;
        moved = true;
      }
    }
    if (!moved) break; // 这一轮没有任何穿透，已收敛
  }
  return { x, y };
}

// 反射向量：入射速度 (vx,vy) 碰到单位法线 (nx,ny) 后的反射速度。
// v' = v - 2(v·n)n   （阶段 3 子弹反弹用）
export function reflect(vx, vy, nx, ny) {
  const dot = vx * nx + vy * ny;
  return { vx: vx - 2 * dot * nx, vy: vy - 2 * dot * ny };
}

// 两圆是否相交（子弹击中坦克用）
export function circleVsCircle(x1, y1, r1, x2, y2, r2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const rr = r1 + r2;
  return dx * dx + dy * dy <= rr * rr;
}
