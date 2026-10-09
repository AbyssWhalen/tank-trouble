// ============================================================
// hints.js — 上下文一次性提示（纯数据 + 纯函数，零浏览器依赖进 smoke）
//
// 解决的问题：这个游戏有几条规则**在屏幕上完全看不见，而且只能靠死一次学会**。
// 阶段 28.4 把它们写进了玩法说明页，但那只解决「我忘了规则」——没人会在开打前
// 先读帮助页，所以「我还不知道有这条规则」那一半还空着。这一层补的就是那一半：
// 在规则**第一次真的作用在你身上**的那一刻，用一行字说清它。
//
// 三条刻意的设计，每一条都能用一个「更完整」的实现改坏：
//   · **一次性且跨局持久**（见过就永不再提，存 settings）。做成「每局提醒」会从
//     教学变成噪音——老玩家每把都要被告知自己的跳弹会杀自己。
//   · **不冻结、不需要点、不挡操作**（一个 4.5 秒自动消失的条）。做成需要确认的
//     弹窗就等于在战斗中间插一个暂停，而这几条规则恰好都在交战瞬间触发。
//   · **只给玩家 1 触发**（人类位）。AI 的拾取/死亡不该教任何人东西；pvp 里
//     两人共屏，所以文案一律用「自己/手上」这种不指名的说法。
//
// 为什么表放这里而常量放 config：与 upgrades.js 同一范式——文案是内容（随玩法演进），
// 时长与队列上限是旋钮（随手感调）。渲染在 ui.renderHintToast，触发接线在 main。
// ============================================================

// 「武器改装槽」三方互斥的那三类（tank.applyPowerup：异类清旧换新、同类叠加）。
// 护盾**不在此列**，它是独立槽——这正是 weaponSwap 那条提示必须说清的后半句。
export const WEAPON_TYPES = Object.freeze(["scatter", "laser", "mine"]);

// 提示表。每条都必须满足两个条件才配占一行：① 规则在画面上看不见；
// ② 不知道它会让你白死或白亏。只是「不熟练」的东西不进这张表（那是练出来的）。
export const HINTS = Object.freeze([
  {
    id: "ricochet",
    // 第一死因。新玩家几乎都会先被自己的跳弹打死，而画面上没有任何东西说明这件事
    text: "自己的跳弹也会打死自己——反弹后的子弹不认主人",
  },
  {
    id: "weaponSwap",
    // 看不见的代价：刚攒的激光被一个顺路捡的散射顶掉。后半句同样重要，
    // 否则玩家会以为捡护盾也会顶掉武器，从此绕着护盾走
    text: "武器类道具互相替换：新的顶掉了手上那件（护盾是独立槽，不冲突）",
  },
  {
    id: "laserSeen",
    // 激光的平衡设计全靠「意图外露」，而持枪方看不到自己那条线对别人也可见
    text: "激光的红虚线对手也看得见——架着不动等于把弹道告诉他",
  },
  {
    id: "mineTimeout",
    // 坦克会闪烁示警，但没人知道闪烁是「要作废了」而不是「装备好了」
    text: "地雷握着超过 10 秒会作废，按道具键放下它",
  },
  {
    id: "holdZone",
    // 圈不会写自己要守多久；而「离开只暂停不倒退」是让守点波不成为隐藏失败态的
    // 那条设计，不说清玩家会以为自己每次被逼出圈都白干了
    text: "守点波：站进圈里才计时，离开只是暂停、不会倒退",
  },
]);

export const HINT_IDS = Object.freeze(HINTS.map((h) => h.id));

// id → 文案；未知 id 返回 null（调用方据此跳过，不抛）
export function hintText(id) {
  const h = HINTS.find((x) => x.id === id);
  return h ? h.text : null;
}

// 存档宽松校验（照 settings.js 的纪律）：只留认识的 id、去重、顺序按表走。
// **按表排序而不是按存档顺序**是刻意的：存档里的顺序没有语义，规范化成确定的
// 顺序之后「写盘→读回」是幂等的，smoke 才能断言往返一致。
export function normalizeSeen(raw) {
  if (!Array.isArray(raw)) return [];
  const set = new Set(raw.filter((x) => typeof x === "string" && HINT_IDS.includes(x)));
  return HINT_IDS.filter((id) => set.has(id));
}

// 这条提示现在该不该弹：id 认识、且没见过
export function shouldShow(id, seen) {
  if (!HINT_IDS.includes(id)) return false;
  return !(Array.isArray(seen) && seen.includes(id));
}

// 标记已见（**纯函数，返回新数组**，不改入参）。已见过则原样返回同一份，
// 调用方可以用 `next === seen` 判断「有没有变化」来决定是否写盘。
export function markSeen(id, seen) {
  const cur = normalizeSeen(seen);
  if (!HINT_IDS.includes(id) || cur.includes(id)) return cur;
  return normalizeSeen([...cur, id]);
}

// 坦克当前占着武器槽的是哪一类（没有则 null）。
// 口径与 tank.applyPowerup 的互斥实现同源：三者互斥，所以最多命中一个。
export function weaponHeld(tank) {
  if (!tank) return null;
  if (tank.scatterShots > 0) return "scatter";
  if (tank.laserShots > 0) return "laser";
  if (tank.mineCharges > 0) return "mine";
  return null;
}

// 这次拾取是否构成「顶掉」：捡的是武器类，而手上原本握着**另一类**武器。
// 同类叠加不算（那是加量不是替换），手上空着也不算，捡护盾更不算。
export function isWeaponSwap(heldBefore, pickedType) {
  return WEAPON_TYPES.includes(pickedType)
    && heldBefore !== null
    && heldBefore !== pickedType;
}
