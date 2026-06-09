# 坦克回廊

本地多人 + 人机对战的坦克对战小游戏（玩法参考 Tank Trouble，代码与素材全部原创）。HTML5 Canvas + 原生 JS，Electron 套壳发布为 Windows 桌面 App。

## 技术栈
- 游戏本体：HTML5 Canvas + 原生 JavaScript（ES Modules），零运行时依赖
- 桌面外壳：Electron
- 打包：electron-builder（target=nsis，生成 Windows 安装向导式 .exe）

## 目录结构约定
- `electron/` —— Electron 主进程代码（`.cjs`，CommonJS）
- `src/` —— 游戏逻辑模块（ES Modules，浏览器/渲染进程里跑）
- `assets/` —— 图标、音效、图片
- `build/` —— electron-builder 输出，已 gitignore，不要手动改
- `index.html` —— 渲染进程入口，挂 canvas
- 新增模块放 `src/`，一个文件一个职责，文件名小写

## 模块职责
- `config.js` —— 全局常量：格子尺寸、速度、人数→地图尺寸映射、键位表、颜色
- `maze.js` —— 随机地图生成（稀疏格栅：概率放墙 + 泛洪连通修复），输出墙线段数组
- `collision.js` —— 纯几何工具：圆-线段碰撞、反射向量、距离判定
- `tank.js` —— 坦克：位置/朝向/移动/撞墙滑动；`tryFire` 受 maxAlive 限流（需传入全局子弹数组）
- `bullet.js` —— 子弹：直线运动 + 墙面反射 + 反弹次数/寿命；渲染为原版风格小黑点
- `input.js` —— 键盘状态，多套键位分发到对应玩家
- `player.js` —— 玩家：绑定坦克 + 键位 + 分数 + 颜色
- `ai.js` —— AI 控制器，接口与 input 对齐（阶段 6）
- `main.js` —— 主循环 + 状态机（菜单/对战/回合结算）

## 坐标与单位约定
- 世界坐标以像素为单位，原点在 canvas 左上角
- 角度用弧度，0 指向右（+x），顺时针为正
- 迷宫以「格」为逻辑单位，渲染时乘 `CELL_SIZE` 转像素

## 命令
- `npm start` —— 开发模式启动 Electron 窗口
- `npm run dist` —— 打包出 Windows 安装包到 `build/`

## 验证纪律
- 无自动化测试，靠浏览器/Electron 手动验证
- 每阶段完成后必须：窗口能开、控制台无报错、该阶段验收点逐条过
- 改完主动跑 `npm start` 看效果，不要只改不验

## 开发分期（按序推进，每期可独立验证）
0. 项目骨架 + Electron 空窗口 ✅
1. 坦克渲染 + 单套键位移动转向 ✅
2. 随机迷宫 + 撞墙不穿 ✅
3. 开炮 + 子弹反弹 + 击中判定 ✅
4. 双人对战：菜单 + 多键位 + 胜负横幅 ✅（子弹已按原版调校：小黑点 + maxAlive 限流）
5. 回合制 + 计分 + 重开
6. 人机模式 + 基础 AI（菜单「人机对战」当前置灰占位，本期开放）
7. 打包发布 Windows .exe

## 路线图调整说明
- 本地版聚焦 **1v1 双人对战 + 人机**：3/4 人同屏挤一台键盘的玩法已弃用。
- **3/4 人对战归入联机 v2**（独立大版本，需信令/同步服务器，本地版完成后再设计）。
- config 里第 3/4 套键位与 `MAZE_SIZE_BY_PLAYERS` 的 3/4 人条目暂留不删，供 v2 复用。
