# 坦克回廊 | Tank Trouble

本地多人对战坦克小游戏，迷宫随机生成 + 子弹反弹 + 人机 AI。

Local multiplayer tank combat game with procedural maze generation, bullet ricochet, and AI opponent.

---

## 游戏特色 | Features

- 🎮 **双人对战 + 人机模式** | PvP & PvE modes
- 🗺️ **随机迷宫生成** | Procedural maze generation with 3 size tiers
- 💥 **子弹反弹物理** | Realistic bullet ricochet off walls
- 🤖 **三档难度 AI** | AI with Easy/Normal/Hard difficulty levels
  - 智能躲弹 + 拦截预判射击 | Adaptive dodging + predictive aim
  - 近战反打决策 | Close-combat counter-attack logic
- 🎯 **回合制计分** | Round-based scoring system
- ✨ **爆炸特效** | Tank explosion effects
- 📐 **自适应窗口** | Responsive viewport scaling

---

## 按键操作 | Controls

### 玩家 1 | Player 1
- **移动** | Move: `W` `A` `S` `D`
- **开炮** | Fire: `Space`

### 玩家 2 | Player 2
- **移动** | Move: `↑` `←` `↓` `→`
- **开炮** | Fire: `Enter`

### 通用 | Common
- **返回菜单** | Back to menu: `Esc`
- **重开局** | Restart round: `R`

---

## 下载与安装 | Download & Installation

### Windows 用户 | For Windows Users

前往 [Releases](https://github.com/AbyssWhalen/tank-trouble/releases) 页面下载最新版 `.exe` 安装包，双击运行即可。

Go to the [Releases](https://github.com/AbyssWhalen/tank-trouble/releases) page, download the latest `.exe` installer, and run it.

### 从源码运行 | Run from Source

需要 Node.js 18+ 和 npm。

Requires Node.js 18+ and npm.

```bash
# 克隆仓库 | Clone repository
git clone https://github.com/AbyssWhalen/tank-trouble.git
cd tank-trouble

# 安装依赖 | Install dependencies
npm install

# 启动游戏 | Launch game
npm start
```

---

## 开发 | Development

```bash
# 开发模式（热重载）| Dev mode with hot reload
npm start

# 打包 Windows 安装包 | Build Windows installer
npm run dist
```

### 项目结构 | Project Structure

```
tank-trouble/
├── src/              # 游戏逻辑模块 | Game logic modules
│   ├── main.js       # 主循环 + 状态机 | Main loop & state machine
│   ├── ai.js         # AI 控制器 | AI controller
│   ├── maze.js       # 迷宫生成 | Maze generation
│   ├── tank.js       # 坦克物理 | Tank physics
│   ├── bullet.js     # 子弹 + 反弹 | Bullet & ricochet
│   ├── collision.js  # 碰撞检测 | Collision detection
│   └── effects.js    # 视觉特效 | Visual effects
├── electron/         # Electron 主进程 | Electron main process
├── index.html        # 渲染进程入口 | Renderer entry
└── CLAUDE.md         # 开发文档 | Development docs
```

---

## 技术栈 | Tech Stack

- **渲染引擎** | Rendering: HTML5 Canvas + Vanilla JavaScript (ES Modules)
- **桌面框架** | Desktop: Electron
- **打包工具** | Build: electron-builder

零运行时依赖，纯前端实现。

Zero runtime dependencies, pure frontend implementation.

---

## 开发日志 | Development Log

- **阶段 0-4**：坦克移动、迷宫生成、子弹反弹、双人对战
- **阶段 5**：回合制计分 + 三档地图自适应缩放
- **阶段 6**：人机模式 + AI（BFS 寻路、八向躲弹、拦截预判、近战反打）+ 爆炸特效
- **阶段 7**：Windows 安装包打包

详见 [CLAUDE.md](./CLAUDE.md)。

---

## 许可 | License

MIT License

---

## 致谢 | Credits

灵感来源于经典 Flash 游戏 [Tank Trouble](https://tanktrouble.com/)。

Inspired by the classic Flash game [Tank Trouble](https://tanktrouble.com/).

代码与素材完全原创。

All code and assets are original.
