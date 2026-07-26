// ============================================================
// settings.js — 设置持久化（键位 + 启用的道具组合）
// 存储介质：localStorage（Electron file:// 下可用；异常时静默降级
// 为内存态，游戏照常跑，只是重启不记忆）。
//
// 键位生效方式：原地覆写 KEY_BINDINGS[0..1] 的属性——Player 持有键位
// 对象的引用、readControls 每帧读属性，所以改完立即生效，零管线改动。
// 恢复默认用模块加载时的深拷贝快照（在任何覆写发生之前抓取）。
//
// schema（版本号防未来结构变更时读坏旧数据；字段各自宽松校验，
// 缺失/非法的字段落默认——老存档天然向前兼容）：
//   localStorage["tank-trouble.settings.v1"] = {
//     version: 1,
//     bindings: [{forward,back,left,right,fire,special} × 2],
//     powerups: ["scatter", ...],  // 菜单启用的道具类型
//     audio: { muted: false }      // 音效静音开关
//   }
// ============================================================

import { KEY_BINDINGS, POWERUP } from "./config.js";

const STORE_KEY = "tank-trouble.settings.v1";
const ACTIONS = ["forward", "back", "left", "right", "fire", "special"];

// 默认键位快照：必须在 initSettings 覆写之前抓，故放模块顶层
export const DEFAULT_BINDINGS = Object.freeze(
  KEY_BINDINGS.slice(0, 2).map((b) => Object.freeze({ ...b }))
);

// 读 localStorage（只验版本号，字段由各消费方自验），坏数据一律当没有
function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.version !== 1) return null;
    return data;
  } catch (e) {
    console.warn("settings: 读取失败，使用默认设置", e);
    return null;
  }
}

// 读-改-写：只更新给定字段，别的字段原样保留（键位和道具组合互不覆盖）
function writeStore(patch) {
  try {
    const cur = readStore() || {};
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...cur, ...patch, version: 1 }));
  } catch (e) {
    console.warn("settings: 保存失败（本次运行内仍生效）", e);
  }
}

// 启动时调用一次：有合法存档则覆写前两套键位（后两套 3p/4p 预留不动）。
// 逐字段校验：老存档缺 special 等新字段时，对应键位保持默认。
export function initSettings() {
  const data = readStore();
  if (!data || !Array.isArray(data.bindings)) return;
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
  writeStore({ bindings: KEY_BINDINGS.slice(0, 2).map((b) => ({ ...b })) });
}

// 恢复默认键位并写盘
export function resetBindings() {
  DEFAULT_BINDINGS.forEach((d, i) => Object.assign(KEY_BINDINGS[i], d));
  saveBindings();
}

// 读启用的道具组合：过滤掉不认识的类型；没存过返回 null（调用方落默认全启）。
// 注意空数组是合法值（玩家就是全关了道具），不能和"没存过"混为一谈。
export function loadEnabledPowerups() {
  const data = readStore();
  if (!data || !Array.isArray(data.powerups)) return null;
  return data.powerups.filter((t) => POWERUP.types.includes(t));
}

// 菜单勾选变化时写盘
export function saveEnabledPowerups(types) {
  writeStore({ powerups: types });
}

// 读音效静音状态：没存过/非法返回 null（调用方落默认有声）
export function loadAudioMuted() {
  const data = readStore();
  if (!data || typeof data.audio !== "object" || !data.audio) return null;
  return typeof data.audio.muted === "boolean" ? data.audio.muted : null;
}

// 静音开关切换时写盘
export function saveAudioMuted(m) {
  writeStore({ audio: { muted: !!m } });
}
