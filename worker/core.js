/**
 * Правила клуба без привязки к Cloudflare: остатки, кабинки, заказы, доступ к кассе.
 * Все функции получают состояние и меняют его на месте. При ошибке бросают Error с текстом для гостя.
 */
export const HOUR = 36e5;
export const MIN = 6e4;

const fail = (msg) => { throw Object.assign(new Error(msg), { user: true }); };
const int = (v) => (Number.isInteger(v) ? v : NaN);

export function indexCatalog(cat) {
  const items = {};
  cat.hookahs.forEach((x) => (items[x.id] = { ...x, type: 'hookah' }));
  cat.drinks.forEach((x) => (items[x.id] = { ...x, type: 'drinks' }));
  cat.snacks.forEach((x) => (items[x.id] = { ...x, type: 'snacks' }));
  const cabins = {};
  cat.cabins.forEach((c) => (cabins[c.n] = c));
  return { items, cabins };
}

export const itemName = (it) =>
  it.type === 'hookah' ? `Кальян «${it.name}»` : it.name + (it.unit ? ' ' + it.unit.join(' ') : '');

/** Новое состояние, либо дополнение старого позициями, которые появились в меню. */
export function ensureState(state, cat) {
  const s = state || { busy: {}, hookahFree: cat.hookahTotal, flavorsOff: [], stock: {}, orders: [], nextNo: 1, owner: null, admins: [], names: {} };
  [...cat.drinks, ...cat.snacks].forEach((x) => { if (!(x.id in s.stock)) s.stock[x.id] = x.stock === undefined ? null : x.stock; });
  return s;
}

export const isAdmin = (s, userId) => !!userId && s.admins.includes(userId);

/** Что видит приложение. Заказы отдаются только кассе. */
export function view(s, userId, now) {
  const busy = {};
  for (const n in s.busy) if (s.busy[n] > now) busy[n] = s.busy[n];
  const admin = isAdmin(s, userId);
  return { now, busy, hookahFree: s.hookahFree, flavorsOff: s.flavorsOff, stock: s.stock, admin, user: !!userId, orders: admin ? s.orders : [] };
}

export function placeOrder(s, cat, idx, req, user, now) {
  if (!user) fail('Заказ оформляется в Telegram. Откройте меню через бота.');
  const items = req.items && typeof req.items === 'object' ? req.items : {};
  const cabins = req.cabins && typeof req.cabins === 'object' ? req.cabins : {};
  const place = String(req.place || 'hall');
  if (place !== 'hall' && !idx.cabins[place]) fail('Не понял, куда принести заказ.');
  if (s.orders.filter((o) => o.status === 'new' && o.by && o.by.id === user.id).length >= 3)
    fail('У вас уже три заказа ждут выдачи. Дождитесь их или подойдите к администратору.');

  const lines = [];
  let total = 0, hookahs = 0;
  for (const n of Object.keys(cabins)) {
    const c = idx.cabins[n], h = int(cabins[n]);
    if (!c || !(h >= 1 && h <= 8)) fail('В заказе неверная кабинка. Обновите меню.');
    if (s.busy[n] > now) fail(`Кабинка №${n} уже занята. Выберите другую.`);
    lines.push([`Кабинка №${n} · ${c.gen}, ${h} ч`, 1, c.price * h]);
    total += c.price * h;
  }
  for (const id of Object.keys(items)) {
    const it = idx.items[id], q = int(items[id]);
    if (!it || !(q >= 1 && q <= 20)) fail('В заказе неверная позиция. Обновите меню.');
    if (it.type === 'hookah') hookahs += q;
    else if (s.stock[id] !== null && q > s.stock[id])
      fail(s.stock[id] > 0 ? `«${itemName(it)}»: осталось ${s.stock[id]} шт.` : `«${itemName(it)}» закончилось.`);
    lines.push([itemName(it), q, it.price * q]);
    total += it.price * q;
  }
  if (!lines.length) fail('Заказ пуст.');
  if (hookahs > s.hookahFree) fail(s.hookahFree > 0 ? `Свободных кальянов осталось ${s.hookahFree}.` : 'Свободных кальянов сейчас нет.');

  const raw = { items: {}, cabins: {} };
  for (const id of Object.keys(items)) {
    const it = idx.items[id], q = items[id];
    if (it.type === 'hookah') s.hookahFree -= q; else if (s.stock[id] !== null) s.stock[id] -= q;
    raw.items[id] = q;
  }
  for (const n of Object.keys(cabins)) { s.busy[n] = now + cabins[n] * HOUR; raw.cabins[n] = s.busy[n]; }

  const order = { no: s.nextNo++, t: now, place, pay: 'cash', status: 'new', total, lines, raw, by: { id: user.id, name: user.name || 'Гость' } };
  s.orders.unshift(order);
  if (s.orders.length > 300) s.orders.length = 300;
  return order;
}

export function adminAction(s, cat, idx, userId, action, p, now) {
  if (!isAdmin(s, userId)) fail('Нет доступа к кассе.');
  p = p || {};
  const order = () => s.orders.find((o) => o.no === p.no) || fail('Заказ не найден.');
  switch (action) {
    case 'stock': {
      const it = idx.items[p.id];
      if (!it || it.type === 'hookah' || s.stock[p.id] === null || !Number.isInteger(p.d)) fail('Эту позицию нельзя изменить.');
      s.stock[p.id] = Math.max(0, Math.min(999, s.stock[p.id] + p.d));
      break;
    }
    case 'hookah':
      if (!Number.isInteger(p.d)) fail('Неверное значение.');
      s.hookahFree = Math.max(0, Math.min(cat.hookahTotal, s.hookahFree + p.d));
      break;
    case 'flavor': {
      if (!cat.flavors.includes(p.f)) fail('Такого вкуса нет в меню.');
      const i = s.flavorsOff.indexOf(p.f);
      if (i >= 0) s.flavorsOff.splice(i, 1); else s.flavorsOff.push(p.f);
      break;
    }
    case 'occupy':
      if (!idx.cabins[p.n] || !(int(p.h) >= 1 && p.h <= 12)) fail('Неверная кабинка.');
      s.busy[p.n] = now + p.h * HOUR;
      break;
    case 'release':
      if (!idx.cabins[p.n]) fail('Неверная кабинка.');
      delete s.busy[p.n];
      break;
    case 'extend':
      if (!idx.cabins[p.n]) fail('Неверная кабинка.');
      s.busy[p.n] = Math.max(s.busy[p.n] || 0, now) + 30 * MIN;
      break;
    case 'serve':
      order().status = 'done';
      break;
    case 'cancel': {
      const o = order();
      if (o.status !== 'new') fail('Этот заказ уже закрыт.');
      for (const id in o.raw.items) {
        const it = idx.items[id];
        if (!it) continue;
        if (it.type === 'hookah') s.hookahFree = Math.min(cat.hookahTotal, s.hookahFree + o.raw.items[id]);
        else if (s.stock[id] !== null) s.stock[id] += o.raw.items[id];
      }
      for (const n in o.raw.cabins) if (s.busy[n] === o.raw.cabins[n]) delete s.busy[n];
      o.status = 'cancelled';
      break;
    }
    case 'reset':
      s.orders = [];
      break;
    default:
      fail('Неизвестное действие.');
  }
}

/** Доступ к кассе. Первый, кто отправит боту /kassa, становится владельцем; остальных он подтверждает. */
export function requestAccess(s, user) {
  s.names[user.id] = user.name || 'Без имени';
  if (!s.owner) { s.owner = user.id; s.admins = [user.id]; return 'owner'; }
  if (s.admins.includes(user.id)) return 'already';
  return 'ask';
}
export function decideAccess(s, ownerId, targetId, allow) {
  if (ownerId !== s.owner) return false;
  s.admins = s.admins.filter((id) => id !== targetId || id === s.owner);
  if (allow && !s.admins.includes(targetId)) s.admins.push(targetId);
  return true;
}
