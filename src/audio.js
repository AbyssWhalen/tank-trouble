// ============================================================
// audio.js — 程序合成音效（Web Audio，零素材文件）
// 风格对齐 effects.js 的屏幕震动：模块级单例 + fire-and-forget 触发函数，
// 调用方零管理（不进 effects 数组——音效无 render/done，节点播完自动 GC）。
// 音色数据全在 config.js 的 SFX 表（纯数据可被 smoke 断言），本模块只做接线。
// 容错哲学同 settings.js：任何 Web Audio 异常静默降级为无声，绝不崩游戏。
// 依赖方向：main → audio（单向）；静音持久化由 main 串 settings，本模块不碰存储。
// ============================================================

import { SFX } from "./config.js";

let ctx = null;      // AudioContext，惰性创建（顶层 new 会以 suspended 出生并留控制台警告）
let master = null;   // 主音量节点，静音 = gain 0（比逐音效判断干净，且切换可平滑防爆音）
let noiseBuf = null; // 1s 白噪声 buffer，全部噪声层复用
let muted = false;
const lastPlay = {}; // 事件名 → 上次触发时刻（ms），做同名限流

// 同名音效最小触发间隔（ms）：双方同帧开炮/地雷双杀合并为一声。
// 同音色零相位叠加只会更响不会更厚，合并语义正确。
const MIN_REPLAY_MS = 50;

// 初始化：记录静音初值 + 挂一次性手势解锁监听。
// Chromium autoplay policy 要求用户手势后才能出声——pointerdown 先于
// input.js 的 click 触发，所以玩家第一次点菜单时 ctx 已就绪。
export function initAudio(initialMuted) {
  muted = !!initialMuted;
  const unlock = () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
    try {
      ensureCtx();
      if (ctx && ctx.state === "suspended") ctx.resume();
    } catch { /* 无声降级 */ }
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

function ensureCtx() {
  if (ctx) return;
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 1;
  master.connect(ctx.destination);
}

function getNoiseBuffer() {
  if (noiseBuf) return noiseBuf;
  const len = ctx.sampleRate; // 1 秒
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

// 播放一个音效事件。rate 整体变调（如拾取音按道具类型区分）。
// 解锁前调用静默丢弃——回合可在首次点击前就被 AI 打响，丢音无害。
export function playSfx(name, { rate = 1 } = {}) {
  try {
    if (!ctx || ctx.state !== "running") return;
    const spec = SFX[name];
    if (!spec) return;

    const now = performance.now();
    if (lastPlay[name] !== undefined && now - lastPlay[name] < MIN_REPLAY_MS) return;
    lastPlay[name] = now;

    for (const layer of spec) playLayer(layer, rate);
  } catch { /* 无声降级 */ }
}

function playLayer(layer, rate) {
  const t0 = ctx.currentTime + (layer.delay || 0);
  const attack = layer.attack ?? 0.002;

  // 增益包络：0 → 线性起音到峰值 → 指数衰减到近零（expRamp 目标不能为 0）
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(layer.gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + layer.dur);
  g.connect(master);

  if (layer.type === "tone") {
    const osc = ctx.createOscillator();
    osc.type = layer.wave;
    osc.frequency.setValueAtTime(layer.freq[0] * rate, t0);
    osc.frequency.exponentialRampToValueAtTime(layer.freq[1] * rate, t0 + layer.dur);
    osc.connect(g);
    osc.start(t0);
    osc.stop(t0 + layer.dur + 0.05);
  } else {
    const src = ctx.createBufferSource();
    src.buffer = getNoiseBuffer();
    src.loop = true; // buffer 1s，层最长 0.7s，loop 只是保险
    if (layer.filter) {
      const bq = ctx.createBiquadFilter();
      bq.type = layer.filter.kind;
      bq.frequency.setValueAtTime(layer.filter.freq[0] * rate, t0);
      bq.frequency.exponentialRampToValueAtTime(layer.filter.freq[1] * rate, t0 + layer.dur);
      src.connect(bq);
      bq.connect(g);
    } else {
      src.connect(g);
    }
    src.start(t0);
    src.stop(t0 + layer.dur + 0.05);
  }
}

// 静音开关：主 gain 平滑过渡（瞬切在有声播放中会"咔"一声）。返回新状态供持久化。
export function toggleMuted() {
  muted = !muted;
  try {
    if (master) master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.01);
  } catch { /* 无声降级 */ }
  return muted;
}

export function isMuted() {
  return muted;
}
