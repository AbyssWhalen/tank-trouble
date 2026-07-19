// ============================================================
// settings.js — 设置持久化（最小版：只管键位）
// 存储介质：localStorage（Electron file:// 下可用；异常时静默降级
// 为内存态，游戏照常跑，只是重启不记忆）。
//
// 生效方式：原地覆写 KEY_BINDINGS[0..1] 的属性——Player 持有键位
// 对象的引用、readControls 每帧读属性，所以改完立即生效，零管线改动。
// 恢复默认用模块加载时的深拷贝快照（在任何覆写发生之前抓取）。
//
// schema（版本号防未来结构变更时读坏旧数据）：
//   localStorage["tank-trouble.settings.v1"] =
//     { version: 1, bindings: [{forward,back,left,right,fire} × 2] }
// ============================================================

import { KEY_BINDINGS } from "./config.js";

const STORE_KEY = "tank-trouble.settings.v1";
const ACTIONS = ["forward", "back", "left", "right", "fire"];

// 默认键位快照：必须在 initSettings 覆写之前抓，故放模块顶层
export const DEFAULT_BINDINGS = Object.freeze(
  KEY_BINDINGS.slice(0, 2).map((b) => Object.freeze({ ...b }))
);

// 读 localStorage 并做 shape 校验，坏数据一律当没有
function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || !Array.isArray(data.bindings)) return null;
    return data;
  } catch (e) {
    console.warn("settings: 读取失败，使用默认设置", e);
    return null;
  }
}

// 启动时调用一次：有合法存档则覆写前两套键位（后两套 3p/4p 预留不动）
export function initSettings() {
  const data = readStore();
  if (!data) return;
  data.bindings.slice(0, 2).forEach((saved, i) => {
    if (!saved || typeof saved !== "object") return;
    for (const a of ACTIONS) {
      if (typeof saved[a] === "string" && saved[a]) {
        KEY_BINDINGS[i][a] = saved[a];
      }
    }
  });
}

// 每次成功改键/恢复默认后调用，把当前前两套键位写盘
export function saveBindings() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        version: 1,
        bindings: KEY_BINDINGS.slice(0, 2).map((b) => ({ ...b })),
      })
    );
  } catch (e) {
    console.warn("settings: 保存失败（本次运行内仍生效）", e);
  }
}

// 恢复默认键位并写盘
export function resetBindings() {
  DEFAULT_BINDINGS.forEach((d, i) => Object.assign(KEY_BINDINGS[i], d));
  saveBindings();
}
