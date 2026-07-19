const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// 窗口状态持久化（目前只记全屏与否）。渲染进程无 IPC 摸不到 setFullScreen，
// 所以全屏的切换(F11)与记忆都放主进程，存 userData 下的小 JSON。
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {}; // 首次运行/文件损坏都当默认窗口态
  }
}

function saveWindowState(fullscreen) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ fullscreen }));
  } catch {
    // 写盘失败不致命：本次全屏照常，仅重启后不记忆
  }
}

// 开发自检开关:CDP 驱动的后台验证(窗口被终端完全遮挡时)需要关掉
// Chromium 的「窗口被遮挡即冻结渲染」优化,否则 rAF 停摆、页面无法驱动。
// 仅设置 TANK_DEV_KEEP_PAINTING=1 时生效,正常启动/打包运行零影响。
if (process.env.TANK_DEV_KEEP_PAINTING) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

function createWindow() {
  const saved = loadWindowState();
  const win = new BrowserWindow({
    width: 1000,
    height: 780,
    minWidth: 700,
    minHeight: 540,
    // 尺寸按"内容区"算而非外框——否则标题栏吃掉 ~40px 高度，
    // 内容区不足 720，大地图（medium 底边在画布 y≈712）下边和外框被裁掉
    useContentSize: true,
    center: true,
    fullscreen: !!saved.fullscreen, // 恢复上次退出时的全屏状态
    backgroundColor: '#e8e8ec',
    title: '坦克回廊',
    webPreferences: {
      // 游戏纯前端，不需要 Node 集成，关掉更安全
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // 去掉默认菜单栏（File/Edit/View...），游戏不需要
  win.setMenuBarVisibility(false);

  // 开发期：每次启动清掉 session 缓存，避免改了源码但 Chromium 仍用旧模块
  // （ES module 缓存曾导致"改了文件却报旧的导出不存在"）
  win.webContents.session.clearCache().finally(() => {
    win.loadFile(path.join(__dirname, '..', 'index.html'));
  });

  // 开发时按 Ctrl+Shift+I 开 DevTools（避开部分笔记本 F12=计算器的厂商映射）；
  // F11 切换全屏（游戏没有菜单栏，快捷键只能在这拦）
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
    } else if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault(); // 拦下浏览器默认的 HTML 全屏语义，统一走窗口全屏
    }
  });

  // 全屏状态变化即写盘（比退出时写更稳：崩溃/强杀也不丢）。
  // 直接写事件对应的目标状态——事件触发瞬间 isFullScreen() 在 Windows 上
  // 可能还没翻转（过渡中查询会拿到旧值），查询版有竞态。
  win.on('enter-full-screen', () => saveWindowState(true));
  win.on('leave-full-screen', () => saveWindowState(false));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
