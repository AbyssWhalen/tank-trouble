const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    minWidth: 980,
    minHeight: 760,
    center: true,
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

  // 开发时按 Ctrl+Shift+I 开 DevTools（避开部分笔记本 F12=计算器的厂商映射）
  win.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      input.control &&
      input.shift &&
      input.key.toLowerCase() === 'i'
    ) {
      win.webContents.toggleDevTools();
    }
  });
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
