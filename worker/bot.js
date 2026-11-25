/**
 * Full House — сервер (Cloudflare Worker).
 *
 * 1. Бот: отвечает на /start, выдаёт доступ к кассе по /kassa, присылает кассе новые заказы.
 * 2. API для мини-приложения: общие остатки, кабинки и заказы для всех телефонов.
 *
 * Секрет BOT_TOKEN (токен из BotFather) задаётся в настройках воркера, в коде его нет.
 * После каждого изменения списка команд открыть один раз:  https://<адрес-воркера>/setup
 */
import { DurableObject } from 'cloudflare:workers';
import catalog from '../catalog.json';
import * as core from './core.js';

const APP_URL = 'https://americanyt911-cyber.github.io/fullhouse-menu/';
const idx = core.indexCatalog(catalog);
const money = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ' + catalog.currency;

const WELCOME =
  'Добро пожаловать в Full House — smoke & play.\n\n' +
  'В меню видно, какие кабинки PlayStation свободны и сколько они стоят, какие кальяны, напитки и снеки есть в наличии. ' +
  'Там же можно собрать заказ.\n\n' +
  'Администратор: +998 90 816 47 37';
const HINT = 'Меню открывается кнопкой ниже.';
const openButton = (text) => ({ inline_keyboard: [[{ text, web_app: { url: APP_URL } }]] });

/** Общее состояние клуба. Один объект на весь клуб, поэтому два заказа не могут забрать один и тот же последний товар. */
export class Club extends DurableObject {
  async load() {
    if (!this.s) this.s = core.ensureState(await this.ctx.storage.get('state'), catalog);
    return this.s;
  }
  async run(fn) {
    const s = await this.load();
    try {
      const out = fn(s, Date.now());
      await this.ctx.storage.put('state', s);
      return { ok: true, ...out };
    } catch (e) {
      if (e && e.user) return { ok: false, error: e.message };
      this.s = null; // не доверяем наполовину изменённой копии в памяти
      throw e;
    }
  }
  async sync(userId) { return core.view(await this.load(), userId, Date.now()); }
  order(req, user) {
    return this.run((s, now) => {
      const order = core.placeOrder(s, catalog, idx, req, user, now);
      return { order, state: core.view(s, user.id, now), notify: s.admins };
    });
  }
  admin(userId, action, payload) {
    return this.run((s, now) => {
      core.adminAction(s, catalog, idx, userId, action, payload, now);
      return { state: core.view(s, userId, now) };
    });
  }
  kassa(user) { return this.run((s) => ({ result: core.requestAccess(s, user), owner: s.owner })); }
  decide(ownerId, targetId, allow) { return this.run((s) => ({ done: core.decideAccess(s, ownerId, targetId, allow), name: s.names[targetId] || 'Сотрудник' })); }
  async staff(userId) {
    const s = await this.load();
    return { owner: s.owner === userId, list: s.admins.map((id) => ({ id, name: s.names[id] || String(id), owner: id === s.owner })) };
  }
}

const club = (env) => env.CLUB.get(env.CLUB.idFromName('main'));

const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json()).catch((e) => ({ ok: false, description: String(e) }));
const send = (env, chat_id, text, reply_markup) => tg(env, 'sendMessage', { chat_id, text, reply_markup });

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const hmac = async (key, data) => {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
};

// Telegram присылает этот ключ в заголовке каждого запроса: так воркер отличает Telegram от посторонних.
async function webhookSecret(token) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('fullhouse:' + token))).slice(0, 48);
}

/** Проверяет подпись Telegram у данных мини-приложения и возвращает пользователя. Подделать её без токена бота нельзя. */
export async function verifyInitData(initData, token, nowMs = Date.now()) {
  if (!initData || typeof initData !== 'string' || initData.length > 4096) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = await hmac(new TextEncoder().encode('WebAppData'), token);
  if (hex(await hmac(secret, check)) !== hash) return null;
  if (nowMs / 1000 - Number(p.get('auth_date')) > 86400) return null;
  try {
    const u = JSON.parse(p.get('user') || 'null');
    return u && u.id ? { id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' ') } : null;
  } catch (e) { return null; }
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS } });
const text = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

function orderMessage(o) {
  const place = o.place === 'hall' ? 'Зал' : 'Кабинка №' + o.place;
  return `Новый заказ №${o.no}\nКуда: ${place}\nГость: ${o.by.name}\n\n` +
    o.lines.map((l) => `• ${l[0]}${l[1] > 1 ? ' × ' + l[1] : ''} — ${money(l[2])}`).join('\n') +
    `\n\nИтого: ${money(o.total)}, оплата на кассе`;
}

async function api(path, request, env, ctx) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Неверный запрос.' }, 400); }
  const user = await verifyInitData(body.initData, env.BOT_TOKEN);
  const c = club(env);

  if (path === '/api/sync') return json(await c.sync(user && user.id));

  if (path === '/api/order') {
    const r = await c.order({ items: body.items, cabins: body.cabins, place: body.place }, user);
    if (!r.ok) return json({ error: r.error }, user ? 409 : 401);
    ctx.waitUntil(Promise.all(r.notify.map((id) => send(env, id, orderMessage(r.order), openButton('Открыть кассу')))));
    return json({ order: r.order, state: r.state });
  }

  if (path === '/api/admin') {
    if (!user) return json({ error: 'Касса открывается только в Telegram.' }, 401);
    const r = await c.admin(user.id, body.action, body.payload);
    return r.ok ? json(r.state) : json({ error: r.error }, 403);
  }
  return json({ error: 'Нет такого адреса.' }, 404);
}

async function onMessage(msg, env) {
  if (!msg.chat || msg.chat.type !== 'private' || !msg.from) return;
  const chat = msg.chat.id, cmd = typeof msg.text === 'string' ? msg.text.split(/[\s@]/)[0] : '';
  const user = { id: msg.from.id, name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') };

  if (cmd === '/kassa') {
    const r = await club(env).kassa(user);
    if (r.result === 'owner') return send(env, chat, 'Касса привязана к вам: вы владелец. Откройте меню — сверху появится переключатель «Касса».\n\nСотрудники получают доступ так: отправляют боту /kassa, а вы подтверждаете. Список сотрудников: /staff', openButton('Открыть кассу'));
    if (r.result === 'already') return send(env, chat, 'У вас уже есть доступ к кассе.', openButton('Открыть кассу'));
    await send(env, r.owner, `${user.name || 'Сотрудник'} просит доступ к кассе.`, { inline_keyboard: [[{ text: 'Разрешить', callback_data: 'adm:ok:' + user.id }, { text: 'Отказать', callback_data: 'adm:no:' + user.id }]] });
    return send(env, chat, 'Запрос отправлен владельцу. Как только он подтвердит, я напишу.');
  }

  if (cmd === '/staff') {
    const r = await club(env).staff(user.id);
    if (!r.owner) return send(env, chat, 'Список сотрудников видит только владелец кассы.');
    const others = r.list.filter((a) => !a.owner);
    return send(env, chat, others.length ? 'Доступ к кассе есть у этих сотрудников. Нажмите на имя, чтобы убрать доступ.' : 'Доступ к кассе пока только у вас. Сотрудник отправляет боту /kassa, вы подтверждаете.',
      others.length ? { inline_keyboard: others.map((a) => [{ text: 'Убрать: ' + a.name, callback_data: 'adm:rm:' + a.id }]) } : undefined);
  }

  return send(env, chat, cmd === '/start' ? WELCOME : HINT, openButton('Открыть меню'));
}

async function onCallback(q, env) {
  const m = /^adm:(ok|no|rm):(\d+)$/.exec(q.data || '');
  if (!m) return tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
  const target = Number(m[2]), allow = m[1] === 'ok';
  const r = await club(env).decide(q.from.id, target, allow);
  if (!r.done) return tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Это может сделать только владелец кассы.' });
  const result = allow ? `${r.name}: доступ к кассе открыт.` : `${r.name}: доступа к кассе нет.`;
  await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: result });
  if (q.message) await tg(env, 'editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text: result });
  if (m[1] !== 'rm') await send(env, target, allow ? 'Доступ к кассе открыт. Откройте меню — сверху появится переключатель «Касса».' : 'Владелец не подтвердил доступ к кассе.', allow ? openButton('Открыть кассу') : undefined);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.BOT_TOKEN) return text('Не задан секрет BOT_TOKEN в настройках воркера.', 500);

    if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
      try { return await api(url.pathname, request, env, ctx); }
      catch (e) { console.log('api failed', e && e.stack); return json({ error: 'Сервер не ответил. Попробуйте ещё раз.' }, 500); }
    }

    const secret = await webhookSecret(env.BOT_TOKEN);
    if (request.method === 'POST' && url.pathname === '/webhook') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) return text('forbidden', 403);
      try {
        const update = await request.json();
        if (update.message) await onMessage(update.message, env);
        else if (update.callback_query) await onCallback(update.callback_query, env);
      } catch (e) { console.log('update failed', e && e.stack); }
      return text('ok');
    }

    if (url.pathname === '/setup') {
      const hook = await tg(env, 'setWebhook', { url: url.origin + '/webhook', secret_token: secret, allowed_updates: ['message', 'callback_query'] });
      const cmds = await tg(env, 'setMyCommands', { commands: [{ command: 'start', description: 'Открыть меню' }] });
      const ok = hook.ok && cmds.ok;
      return text(ok ? 'Готово. Бот подключён, нажмите Start в Telegram.' : 'Не получилось: ' + JSON.stringify({ hook, cmds }), ok ? 200 : 502);
    }

    return text('Full House bot работает. Версия с общими остатками.');
  },
};
