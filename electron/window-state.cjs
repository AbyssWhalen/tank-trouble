// ============================================================
// window-state.cjs — 窗口状态文件的**校验**（纯函数，不 require electron）
// 文件读取与 app.getPath 留在 main.cjs，这里只回答一个问题：
// 「读到的那串 JSON 能不能当窗口态用」。
//
// 为什么单独一个文件：主进程的 .cjs 一 require 就会跑 app.whenReady，node 直跑
// 必崩，于是里面的容错分支永远进不了 smoke。拆出纯函数后，smoke 能直接喂
// null / 数字 / 数组 / 对象，把每条退化路径都钉死——与 stats.js「纯计算与
// 存储访问分离」是同一条纪律（那边是为了让命中率算式可断言，这边是为了让
// 坏档容错可断言）。
// ============================================================

// 把 JSON.parse 的结果规范成窗口态对象。**只认非空对象**：
// "null" / "3" / '"x"' / "[]" / "true" 都是合法 JSON，parse 不抛，但返回的
// 不是一个能读属性的对象，紧接着取 .fullscreen 会抛 TypeError。而那行代码在
// createWindow 里、whenReady 之后——抛出去的后果不是「全屏状态没恢复」，
// 而是**窗口建不出来、游戏打不开**。代价这么不对称，校验就值得写死。
//
// 写盘路径（saveWindowState）只会写对象，所以这是坏档容错：磁盘损坏、
// 被手改、被别的程序覆盖。正常使用走不到，但它一旦发生就是启动即黑屏。
function normalizeWindowState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return {
    // 只放行布尔：别让 0 / 1 / "true" 之类渗进 BrowserWindow 的选项
    fullscreen: typeof raw.fullscreen === 'boolean' ? raw.fullscreen : false,
  };
}

module.exports = { normalizeWindowState };
