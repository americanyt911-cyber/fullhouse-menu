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
  const known = new Set([...cat.drinks, ...cat.snacks].map((x) => x.id));
  for (const id of Object.keys(s.stock)) if (!known.has(id)) delete s.stock[id];   // позиции убрали из меню
  s.flavorsOff = s.flavorsOff.filter((id) => cat.flavors.some((f) => f.id === id));   // вкусы, которых больше нет в меню
  if (!s.bookings) s.bookings = [];
  if (!s.nextBk) s.nextBk = 1;
  return s;
}

export const isAdmin = (s, userId) => !!userId && s.admins.includes(userId);

/** Что видит приложение. Заказы отдаются только кассе. */
export function view(s, userId, now) {
  const busy = {};
  for (const n in s.busy) if (s.busy[n] > now) busy[n] = s.busy[n];
  const admin = isAdmin(s, userId);
  const booked = {};                                   // занятые интервалы без имён: их видят все
  s.bookings.filter(isActive).forEach((b) => (booked[b.n] = booked[b.n] || []).push([b.start, b.end]));
  const mine = userId ? s.bookings.filter((b) => !b.byAdmin && b.by.id === userId) : [];
  return { now, busy, hookahFree: s.hookahFree, flavorsOff: s.flavorsOff, stock: s.stock, admin, user: !!userId,
    orders: admin ? s.orders : [], booked, mine, bookings: admin ? s.bookings : [] };
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
    const next = s.bookings.filter((b) => isActive(b) && b.n === Number(n) && b.start < now + h * HOUR && b.end > now).sort((a, b) => a.start - b.start)[0];
    if (next) fail(next.start <= now ? `Кабинка №${n} сейчас забронирована. Выберите другую.`
      : `Кабинка №${n} забронирована с ${fmtTime(next.start, cat.booking.tzMin)}. Возьмите её на меньшее время или выберите другую.`);
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
      if (!cat.flavors.some((f) => f.id === p.f)) fail('Такого вкуса нет в меню.');
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

/* ───────────── Бронь кабинок на время ───────────── */
const pad = (n) => String(n).padStart(2, '0');
const DOW = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
/** Время клуба не зависит от часового пояса телефона или сервера. */
export function fmtTime(ms, tz) { const d = new Date(ms + tz * MIN); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }
export function fmtDay(ms, tz) { const d = new Date(ms + tz * MIN); return DOW[d.getUTCDay()] + ' ' + pad(d.getUTCDate()) + '.' + pad(d.getUTCMonth() + 1); }
export const fmtSpan = (b, tz) => `${fmtDay(b.start, tz)}, ${fmtTime(b.start, tz)}–${fmtTime(b.end, tz)}`;

export const isActive = (b) => b.status === 'pending' || b.status === 'confirmed' || b.status === 'arrived';

/** Закрывает брони, срок которых вышел. Возвращает true, если что-то изменилось. */
export function sweep(s, cat, now) {
  let changed = false;
  for (const b of s.bookings) {
    const was = b.status;
    if (b.status === 'pending' && now >= b.start) b.status = 'expired';                               // не успели подтвердить
    else if (b.status === 'confirmed' && now > b.start + cat.booking.graceMin * MIN) b.status = 'noshow'; // гость не пришёл
    else if (b.status === 'arrived' && now >= b.end) b.status = 'done';
    if (b.status !== was) changed = true;
  }
  const keep = s.bookings.filter((b) => isActive(b) || b.end > now - 24 * HOUR);
  if (keep.length !== s.bookings.length) { s.bookings = keep; changed = true; }
  return changed;
}

// Время занято, если кабинка сейчас занята дольше начала брони или на него уже есть другая бронь.
const overlaps = (s, n, start, end, now) =>
  (s.busy[n] > now && s.busy[n] > start) || s.bookings.some((b) => isActive(b) && b.n === n && b.start < end && b.end > start);

export function book(s, cat, idx, req, user, now) {
  if (!user) fail('Бронь оформляется в Telegram. Откройте меню через бота.');
  const B = cat.booking, n = int(req.n), start = int(req.start), h = int(req.h);
  const byAdmin = !!req.asAdmin && isAdmin(s, user.id);
  const c = idx.cabins[n];
  if (!c) fail('Такой кабинки нет. Обновите меню.');
  if (!B.hours.includes(h)) fail('Выберите длительность из списка.');
  if (!(start > 0) || start % (B.stepMin * MIN) !== 0) fail('Выберите время из списка.');
  if (start < now + (byAdmin ? 0 : B.leadMin * MIN)) fail('Это время уже прошло. Выберите другое.');
  if (start > now + B.days * 24 * HOUR) fail(`Бронь открыта на ${B.days} дня вперёд.`);
  const end = start + h * HOUR;
  if (overlaps(s, n, start, end, now)) fail('Это время уже занято. Выберите другое.');
  if (!byAdmin && s.bookings.filter((b) => !b.byAdmin && b.by.id === user.id && (b.status === 'pending' || b.status === 'confirmed')).length >= B.perGuest)
    fail(`У вас уже ${B.perGuest} брони. Отмените одну из них или дождитесь её окончания.`);
  const name = byAdmin ? String(req.name || '').trim().slice(0, 40) || 'Гость по телефону' : user.name || 'Гость';
  const b = { id: s.nextBk++, n, start, end, h, price: c.price * h, status: byAdmin ? 'confirmed' : 'pending', by: { id: user.id, name }, byAdmin, t: now };
  s.bookings.push(b);
  return b;
}

/** confirm / decline / arrive — касса; cancel — касса или сам гость. */
export function bookingAction(s, cat, idx, user, action, id, now, asAdmin) {
  if (!user) fail('Откройте меню через бота.');
  const admin = isAdmin(s, user.id), acting = admin && !!asAdmin;
  const b = s.bookings.find((x) => x.id === id) || fail('Бронь не найдена.');
  const own = !b.byAdmin && b.by.id === user.id;
  if (action === 'cancel') {
    if (!acting && !own) fail('Это не ваша бронь.');
    if (!isActive(b) || (!acting && b.status === 'arrived')) fail('Эта бронь уже закрыта.');
    if (b.status === 'arrived' && s.busy[b.n] === b.end) delete s.busy[b.n];
    b.status = 'cancelled';
    return { b, byGuest: !acting };
  }
  if (!admin) fail('Нет доступа к кассе.');
  if (action === 'confirm' || action === 'decline') {
    if (b.status !== 'pending') fail('Эта заявка уже обработана.');
    if (action === 'confirm' && now >= b.start) fail('Время этой брони уже прошло.');
    b.status = action === 'confirm' ? 'confirmed' : 'declined';
    return { b };
  }
  if (action === 'arrive') {
    if (b.status !== 'confirmed') fail('Отметить приход можно только у подтверждённой брони.');
    if (now < b.start - 30 * MIN) fail('Отметить приход можно не раньше чем за 30 минут до начала.');
    b.status = 'arrived';
    s.busy[b.n] = b.end;
    const c = idx.cabins[b.n];
    s.orders.unshift({ no: s.nextNo++, t: now, place: String(b.n), pay: 'cash', status: 'done', total: b.price,
      lines: [[`Кабинка №${b.n} · ${c.gen}, бронь ${b.h} ч`, 1, b.price]], raw: { items: {}, cabins: {} }, by: { id: b.by.id, name: b.by.name } });
    return { b };
  }
  fail('Неизвестное действие.');
}
