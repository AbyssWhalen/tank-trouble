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
// 缺失/非法的字段落默认——老存档天然向前兼容。**例外是 bindings**：它是一张
// 有内部约束的表（跨玩家不许重键），逐字段落默认会合出单字段合法、整套失灵的
// 结果，所以它整套一起验、不自洽就整套落默认，见 initSettings）：
//   localStorage["tank-trouble.settings.v1"] = {
//     version: 1,
//     bindings: [{forward,back,left,right,fire,special} × 2],
//     powerups: ["scatter", ...],  // 菜单启用的道具类型
//     audio: { muted: false },     // 音效静音开关
//     wallBreak: true,             // 地雷炸墙开关（菜单「地形」chip）
//     challenge: 0,                // 挑战模式已通关数（0=从头开始）
//     waveBest: { wave, kills },   // 波次生存最高记录（wave=0 视为无记录）
//     hintsSeen: ["ricochet", …]   // 已看过的一次性提示 id（见 hints.js）
//   }
// ============================================================

import { KEY_BINDINGS, POWERUP, RESERVED_KEYS } from "./config.js";

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

// 一套键位（前两套玩家共 12 个动作）是否可用：字段齐全、不含黑名单键、跨玩家零重复。
// 判据与改键面板的 findBindingConflict 同源——它扫的也是两套玩家的全部动作，
// 加载期和捕获期必须用同一把尺子，否则「面板里绑不上的组合」能从存档里绕进来。
function isBindingSetSane(sets) {
  const codes = [];
  for (const b of sets) {
    for (const a of ACTIONS) {
      const c = b[a];
      if (typeof c !== "string" || !c) return false;
      if (RESERVED_KEYS.includes(c)) return false;
      codes.push(c);
    }
  }
  return new Set(codes).size === codes.length;
}

// 启动时调用一次：有合法存档则覆写前两套键位（后两套 3p/4p 预留不动）。
//
// **整套一起校验，不是逐字段**。逐字段「非法落默认」会合出一张每个字段单独合法、
// 合起来却是坏的表，而且坏得完全看不出来：
//   · 前进存的是 KeyR（黑名单）→ 落回默认 KeyW，而后退存的就是 KeyW
//     ⇒ 按 W 时 readControls 算出 move = +1 −1 = 0，车一动不动、没有任何提示
//   · 老存档没有 special 字段 → special 落默认 KeyE，而开火存的是 KeyE ⇒ 同形
// 两种都只砸在「改过键的老玩家」头上，新建存档怎么测都测不出来。
// 所以这里先把存档合成一张候选表，再按「跨两套玩家不许重键」验一次：
// 整套自洽才装；不自洽就整套落默认——默认表天然自洽，且玩家一眼看得见、能重改，
// 比「某一个动作静默失灵」好得多（这是本文件「非法落默认」纪律的整套版，不是例外）。
export function initSettings() {
  const data = readStore();
  if (!data || !Array.isArray(data.bindings)) return;

  // 候选表：默认打底 + 存档里「非空字符串且不在黑名单」的字段
  const cand = DEFAULT_BINDINGS.slice(0, 2).map((d) => ({ ...d }));
  data.bindings.slice(0, 2).forEach((saved, i) => {
    if (!saved || typeof saved !== "object") return;
    for (const a of ACTIONS) {
      if (typeof saved[a] !== "string" || !saved[a]) continue;
      // 黑名单键落默认而不是照收：黑名单原先只在改键面板的**捕获**处生效，
      // 于是在它扩容之前就把移动键绑成 KeyR 的存档，重启后照旧把 R 装回去——
      // 而结算横幅上点一下那个键就会静默清零整场比分。存量存档的洞必须在
      // 加载期闭合，否则唯一会踩到的那批人（改过键的）永远修不好。
      if (RESERVED_KEYS.includes(saved[a])) continue;
      cand[i][a] = saved[a];
    }
  });

  if (!isBindingSetSane(cand)) {
    // 整套落默认并显式写回全局表（不是 return 了事）：这样 initSettings 的后置条件
    // 无条件成立——「调用之后前两套键位一定是一张自洽的表」，与调用前的状态无关。
    DEFAULT_BINDINGS.slice(0, 2).forEach((d, i) => Object.assign(KEY_BINDINGS[i], d));
    console.warn("settings: 键位存档整套不自洽（重键/缺字段），已恢复默认键位");
    return;
  }
  cand.forEach((b, i) => Object.assign(KEY_BINDINGS[i], b));
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

// 读地雷炸墙开关：没存过/非法返回 null（调用方落默认开启）
export function loadWallBreak() {
  const data = readStore();
  if (!data || typeof data.wallBreak !== "boolean") return null;
  return data.wallBreak;
}

// 炸墙开关切换时写盘
export function saveWallBreak(v) {
  writeStore({ wallBreak: !!v });
}

// 读挑战模式进度（已通关数）：没存过/非法返回 null（调用方落 0）
export function loadChallengeProgress() {
  const data = readStore();
  if (!data || typeof data.challenge !== "number") return null;
  return data.challenge;
}

// 过关时写盘
export function saveChallengeProgress(n) {
  writeStore({ challenge: n });
}

// 读波次生存最高记录：没存过/非法返回 null（调用方交给 normalizeWaveBest 落 0）。
// 这里只做「是不是个对象」的粗筛，字段校验归 waves.normalizeWaveBest 一处管。
export function loadWaveBest() {
  const data = readStore();
  if (!data || typeof data.waveBest !== "object" || !data.waveBest) return null;
  return data.waveBest;
}

// 破纪录时写盘（是否破纪录由 waves.isBetterRecord 判，这里只负责落地）
export function saveWaveBest(rec) {
  writeStore({ waveBest: { wave: rec.wave | 0, kills: rec.kills | 0 } });
}

// 读已看过的一次性提示 id 列表：没存过/非法返回 null（调用方交给
// hints.normalizeSeen 落 []）。与 waveBest 同样只做粗筛——认不认识这些 id
// 是 hints.js 的事，这里不该知道提示表长什么样。
export function loadHintsSeen() {
  const data = readStore();
  if (!data || !Array.isArray(data.hintsSeen)) return null;
  return data.hintsSeen;
}

// 弹过一条新提示就写盘。**必须立刻写**而不是等退出时统一写：
// 一次性提示的全部价值就在「只弹一次」，而这个模式里玩家是会直接关窗口的，
// 攒着写等于下一局重新弹一遍。
export function saveHintsSeen(ids) {
  writeStore({ hintsSeen: Array.isArray(ids) ? ids.filter((x) => typeof x === "string") : [] });
}
