/**
 * Full House — сервер бота (Cloudflare Worker).
 *
 * Что делает: отвечает на /start и любое сообщение приветствием с кнопкой, которая открывает меню.
 * Секрет: BOT_TOKEN (токен из BotFather) задаётся в настройках воркера, в коде его нет.
 * Подключение: один раз открыть в браузере  https://<адрес-воркера>/setup
 */
const APP_URL = 'https://americanyt911-cyber.github.io/fullhouse-menu/';

const WELCOME =
  'Добро пожаловать в Full House — smoke & play.\n\n' +
  'В меню видно, какие кабинки PlayStation свободны и сколько они стоят, какие кальяны, напитки и снеки есть в наличии. ' +
  'Там же можно собрать заказ.\n\n' +
  'Администратор: +998 90 816 47 37';
const HINT = 'Меню открывается кнопкой ниже.';
const OPEN_BUTTON = { inline_keyboard: [[{ text: 'Открыть меню', web_app: { url: APP_URL } }]] };

const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

// Telegram присылает этот ключ в заголовке каждого запроса: так воркер отличает Telegram от посторонних.
async function webhookSecret(token) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('fullhouse:' + token));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

async function onUpdate(update, env) {
  const msg = update && update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const isStart = typeof msg.text === 'string' && msg.text.startsWith('/start');
  await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: isStart ? WELCOME : HINT, reply_markup: OPEN_BUTTON });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN) return new Response('Не задан секрет BOT_TOKEN в настройках воркера.', { status: 500 });
    const secret = await webhookSecret(env.BOT_TOKEN);

    if (request.method === 'POST' && url.pathname === '/webhook') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) return new Response('forbidden', { status: 403 });
      try { await onUpdate(await request.json(), env); } catch (e) { console.log('update failed', e && e.message); }
      return new Response('ok');
    }

    if (url.pathname === '/setup') {
      const hook = await tg(env, 'setWebhook', { url: url.origin + '/webhook', secret_token: secret, allowed_updates: ['message'] });
      const cmds = await tg(env, 'setMyCommands', { commands: [{ command: 'start', description: 'Открыть меню' }] });
      const ok = hook.ok && cmds.ok;
      return new Response(ok ? 'Готово. Бот подключён, нажмите Start в Telegram.' : 'Не получилось: ' + JSON.stringify({ hook, cmds }),
        { status: ok ? 200 : 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    return new Response('Full House bot работает.', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};
