'use strict';
/*
 * Макет раздела «Реклама».
 *
 * Главное правило: любая цифра на странице получается из одного набора сделок
 * через aggBuy / aggSell. Итоги периода, строка «Итого» списка и сводки, клетки
 * матрицы, показатели в карточке сделки — всё это одни и те же функции над
 * разными подмножествами, поэтому разойтись между собой они не могут.
 *
 * Определения (они же — то, что должен будет считать сервер):
 *  - «Потрачено» / «Заработано» — сделки со статусом «Вышел» или «Завершён»,
 *    у которых известна сумма. CPM, у которого просмотры ещё не зафиксированы,
 *    суммы не имеет и считается отдельно («ждут фиксации»).
 *  - «Запланировано» / «Ожидается» — «В плане» и «Договорились» (для продаж —
 *    только «Договорились») с фиксированной ценой; CPM без суммы считается штуками.
 *  - Подписчики, покупки, выручка, ₽ за подписчика, ROI — только по закупам,
 *    у которых результат уже накопился. ROI = (выручка − их стоимость) / их стоимость.
 *  - Отменённые не входят ни в одну сумму и ни в одно количество.
 */
(() => {

// ================= КОНСТАНТЫ =================
const NOW = new Date(2026, 9, 8, 15, 0);        // «сейчас» макета: чт, 08.10.2026 15:00
const TODAY = new Date(2026, 9, 8);
const DATA_FROM = new Date(2026, 8, 1), DATA_TO = new Date(2026, 9, 31);

const SLOTS = [
  { k: 'morning', l: 'Утро', s: 'Утро', t: '10:00' },
  { k: 'day', l: 'День', s: 'День', t: '14:00' },
  { k: 'evening', l: 'Вечер', s: 'Вечер', t: '19:00' },
  { k: 'night', l: 'Ночь', s: 'Ночь', t: '23:00' },
  { k: 'stories', l: 'Сторис', s: 'Сторис', t: '12:00' },
  { k: 'n9', l: 'Нейтрал на 9', s: 'Н 9:00', t: '09:00' },
  { k: 'n17', l: 'Нейтрал на 17', s: 'Н 17:00', t: '17:00' },
];
const SLOT = Object.fromEntries(SLOTS.map((s, i) => [s.k, { ...s, i }]));
const NEUTRAL = new Set(['n9', 'n17']);

const PROJECTS = [
  { id: 1, name: '🫦 SATAN GAMES 18+', mono: 'SG', h: 350, kind: 'канал + бот', channel: true, mandatory: ['morning', 'day', 'evening'], check: 990, conv: .025 },
  { id: 2, name: 'VPN', mono: 'VPN', h: 205, kind: 'бот без канала', channel: false, mandatory: [], check: 299, conv: .06 },
  { id: 3, name: 'Крипто Инсайд: торговые сигналы', mono: 'КИ', h: 150, kind: 'канал', channel: true, mandatory: ['morning', 'evening'], check: 1490, conv: .015 },
];
const PJ = Object.fromEntries(PROJECTS.map(p => [p.id, p]));

const ST = {
  plan: { l: 'В плане', c: '#8A94A6' },
  agreed: { l: 'Договорились', c: '#57B6FF' },
  live: { l: 'Вышел', c: '#3DDC97' },
  done: { l: 'Завершён', c: '#8CE8C3' },
  cancel: { l: 'Отменён', c: '#5A6478' },
};
const ST_ORDER = ['plan', 'agreed', 'live', 'done', 'cancel'];
const isPub = s => s === 'live' || s === 'done';
const isFut = s => s === 'plan' || s === 'agreed';

const DOW = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const DOW_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MON_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MON_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MON_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

// ================= ДАТЫ И ФОРМАТ =================
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayDiff = (a, b) => Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()) - new Date(b.getFullYear(), b.getMonth(), b.getDate())) / 864e5);
const mondayOf = d => addDays(d, -((d.getDay() + 6) % 7));
const dm = d => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
const dmy = d => `${dm(d)}.${d.getFullYear()}`;
const hmOf = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dtLbl = d => `${dm(d)} ${hmOf(d)}`;
const startOf = (dateIso, slot) => { const [h, m] = SLOT[slot].t.split(':').map(Number); const d = parseIso(dateIso); d.setHours(h, m); return d; };
const hoursOf = f => (f === '1/48' ? 48 : 24);
const dur = mins => { const h = Math.floor(mins / 60), m = mins % 60; return h ? `${h}${NB}ч${m ? ` ${m}${NB}мин` : ''}` : `${m}${NB}мин`; };
// Неделя подписывается в границах текущего периода: в октябрьском отчёте
// неделя 28.09–04.10 — это только 1–4 октября, иначе цифры строки не сходятся с подписью.
let CUR = null;
function weekLabel(monIsoStr) {
  let m = parseIso(monIsoStr), s = addDays(m, 6);
  if (CUR) { if (m < CUR.from) m = CUR.from; if (s > CUR.to) s = CUR.to; }
  if (+m === +s) return `${m.getDate()} ${MON_SHORT[m.getMonth()]}`;
  return m.getMonth() === s.getMonth()
    ? `${m.getDate()}–${s.getDate()} ${MON_SHORT[m.getMonth()]}`
    : `${m.getDate()} ${MON_SHORT[m.getMonth()]} – ${s.getDate()} ${MON_SHORT[s.getMonth()]}`;
}

const NB = ' ';
const int = n => (n == null ? '—' : Math.round(n).toLocaleString('ru-RU'));
const rub = n => (n == null ? '—' : `${int(n)}${NB}₽`);
const rub1 = n => (n == null ? '—' : `${n.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${NB}₽`);
const signed = (v, s) => (v > 0 ? '+' : v < 0 ? '−' : '') + s;
const pct = (v, d = 0) => {
  if (v == null) return '—';
  const r = Number((v * 100).toFixed(d)); // знак — по округлённому значению: −0,2% не должно стать «−0%»
  return signed(r, `${Math.abs(r).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d })}%`);
};
const pct1 = v => pct(v, 1);
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ================= ДАННЫЕ =================
// Детерминированный генератор: при каждом открытии те же сделки и те же цифры.
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const R = mulberry32(20261008);
const pick = a => a[Math.floor(R() * a.length)];
const between = (a, b, step = 1) => a + Math.floor(R() * (Math.floor((b - a) / step) + 1)) * step;
const randHandle = () => Array.from({ length: 12 }, () => 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(R() * 56)]).join('');

// Закуп записывается на админа, у которого куплено место, а не на канал:
// каналов у одного админа обычно несколько, и важно, с кем договаривался.
// Это тот же «рекламодатель», что во вкладке «Кампании» дашборда.
const ADMINS = {
  kot: { name: 'Кот', user: 'kot_tgg', old: ['kotik_ads'] },
  farid: { name: 'Фарид', user: 'farid_promo', old: ['farid_ads'] },
  tenshi: { name: 'Тенши', user: 'tenshi' },
  max: { name: 'Макс', user: 'max_ads' },
  ira: { name: 'Ира', user: 'ira_reklama' },
  leha: { name: 'Лёха', user: 'leha_it' },
  sasha: { name: 'Саша Трейдер', user: 'sasha_trade' },
  pro: { name: 'Крипто PRO', user: 'cryptopro_ads' },
};
const ADMINS_BY_PROJECT = { 1: ['kot', 'farid', 'tenshi', 'max', 'ira'], 2: ['leha', 'kot', 'max'], 3: ['sasha', 'farid', 'ira'] };
const admLabel = id => (ADMINS[id] ? `${ADMINS[id].name} (@${ADMINS[id].user})` : '—');
const CREATIVES = { 1: ['Арт «Ночь»', 'Видео 15 с', 'Мем-подача'], 2: ['Скорость', 'Цена 99 ₽', 'Без логов'], 3: ['Сигнал дня', 'Разбор сделки'] };
const BUYERS = ['@ad_manager_77', '@promo_hunter', '@crypto_sell', '@traffic_lab', '@media_buy_pro', '@reklama_tg', '@gamedev_ads'];
const BUY_PROB = {
  1: { morning: .4, day: .22, evening: .5, night: .15, stories: .22, n9: .16, n17: .22 },
  2: { morning: .06, day: .06, evening: .22, night: .18, stories: .05, n9: .04, n17: .12 },
  3: { morning: .14, day: .06, evening: .14, night: .03, stories: .06, n9: .05, n17: .05 },
};
const CPS = {
  1: { morning: 20, day: 18, evening: 14.5, night: 31, stories: 15, n9: 16, n17: 13 },
  2: { morning: 24, day: 26, evening: 19, night: 17, stories: 28, n9: 25, n17: 21 },
  3: { morning: 23, day: 30, evening: 21, night: 38, stories: 27, n9: 22, n17: 24 },
};

function pickStatus(dateIso, slot, format) {
  if (R() < .04) return 'cancel';
  const st = startOf(dateIso, slot), end = new Date(+st + hoursOf(format) * 36e5);
  if (st > NOW) {
    const ahead = dayDiff(parseIso(dateIso), TODAY);
    return ahead <= 6 ? (R() < .78 ? 'agreed' : 'plan') : (R() < .3 ? 'agreed' : 'plan');
  }
  return end > NOW ? 'live' : 'done';
}

function makeHistory(d) {
  const st = startOf(d.date, d.slot), end = new Date(+st + hoursOf(d.format) * 36e5);
  const at = (base, dayShift, h) => { const x = addDays(base, dayShift); x.setHours(h, between(0, 59)); return x; };
  const h = [{ st: 'plan', at: at(st, -between(5, 10), between(10, 20)) }];
  if (d.status === 'cancel') { h.push({ st: 'cancel', at: at(st, -1, 18) }); return h; }
  if (d.status !== 'plan') h.push({ st: 'agreed', at: at(st, -between(1, 4), between(11, 21)) });
  if (isPub(d.status)) { const f = new Date(st); f.setMinutes(f.getMinutes() + (d.factShift || 0)); h.push({ st: 'live', at: f }); }
  if (d.status === 'done') h.push({ st: 'done', at: d.checks?.life?.ok === false ? new Date(+st + d.checks.life.lived * 6e4) : end });
  return h;
}

function makeBuy(p, date, slot) {
  const format = R() < .8 ? '1/24' : '1/48';
  const status = pickStatus(date, slot, format);
  const pm = R() < .25 ? 'cpm' : 'fix';
  const d = {
    side: 'buy', project: p, date, slot, format, status, pm,
    admin: pick(ADMINS_BY_PROJECT[p]), creative: pick(CREATIVES[p]),
    track: p === 2 ? `https://t.me/vpn_bot?start=${randHandle().slice(0, 8)}` : `https://t.me/+${randHandle()}`,
    post: '', notes: '', warns: [], checks: null, result: null,
  };
  if (pm === 'fix') d.price = p === 1 ? between(2500, 6000, 100) : p === 2 ? between(1500, 3500, 100) : between(3000, 8000, 250);
  else d.rate = between(300, 600, 10);
  const st = startOf(date, slot);
  const hours = hoursOf(format);
  if (isPub(status)) {
    d.post = `https://t.me/c/1874320511/${between(800, 9800)}`;
    const views = between(5000, 16000, 10);
    const late = NEUTRAL.has(slot) && R() < .22;
    d.factShift = late ? 25 : between(0, 5);
    const r = R();
    const early = r < .07 && status === 'done';
    const topShort = r >= .07 && r < .12 ? between(8, 40) : 0;
    const noClicks = r >= .12 && r < .145;
    const livedMin = early ? between(6 * 60, (hours - 4) * 60) : null;
    const elapsed = Math.round((NOW - st) / 6e4);
    d.checks = {
      reach: { views: early ? Math.round(views * .7) : views, ago: status === 'live' ? '5 мин назад' : 'перед снятием' },
      time: { plan: SLOT[slot].t, fact: hmOf(new Date(+st + d.factShift * 6e4)), late },
      top: elapsed < 60 ? { wait: true } : topShort ? { ok: false, short: topShort } : { ok: true },
      life: status === 'live' ? { wait: true, elapsed, hours } : early ? { ok: false, lived: livedMin, short: hours * 60 - livedMin } : { ok: true, hours },
    };
    if (pm === 'cpm') {
      if (status === 'live') { d.cpmState = 'wait'; d.viewsNow = Math.round(views * Math.min(1, elapsed / (hours * 60) + .35)); }
      else if (early && R() < .65 || R() < .05) { d.cpmState = 'failed'; d.views = d.checks.reach.views; }
      else { d.cpmState = 'fixed'; d.views = views; d.fixedAt = new Date(+st + (early ? livedMin : hours * 60) * 6e4 - 2 * 6e4); }
    }
    if (early) d.warns.push({ code: 'early', sev: 'high' });
    if (topShort) d.warns.push({ code: 'top', sev: 'high' });
    if (late) d.warns.push({ code: 'late', sev: 'mid' });
    if (d.cpmState === 'failed') d.warns.push({ code: 'cpmfail', sev: 'high' });
    const amt = amountOf(d);
    const accumulated = status === 'done' || (NOW - st) >= 18 * 36e5;
    if (accumulated && amt != null) {
      if (noClicks) { d.result = { subs: 0, buyers: 0, revenue: 0, retention: null }; d.warns.push({ code: 'noclicks', sev: 'high' }); }
      else {
        const subs = Math.max(1, Math.round(amt / (CPS[p][slot] * (0.78 + R() * 0.5))));
        const buyers = Math.round(subs * PJ[p].conv * (0.6 + R() * 0.8));
        d.result = { subs, buyers, revenue: buyers * PJ[p].check, retention: .7 + R() * .2 };
      }
    }
  } else if (pm === 'cpm') d.cpmState = 'wait';
  return d;
}

function makeSale(p, date, slot) {
  const mand = PJ[p].mandatory.includes(slot);
  const format = R() < .85 ? '1/24' : '1/48';
  const status = pickStatus(date, slot, format);
  const pm = R() < .2 ? 'cpm' : 'fix';
  const d = { side: 'sell', project: p, date, slot, format, status, pm, buyer: pick(BUYERS), post: '', notes: '', warns: [] };
  if (pm === 'fix') d.price = p === 1 ? (mand ? between(5000, 7000, 250) : between(2500, 4000, 250)) : (mand ? between(6000, 9000, 500) : between(3500, 5000, 500));
  else d.rate = between(350, 500, 10);
  const st = startOf(date, slot);
  if (isPub(status)) {
    d.post = `https://t.me/${p === 1 ? 'satan_games' : 'crypto_insaid'}/${between(1200, 4800)}`;
    const views = between(9000, 15000, 10);
    d.factShift = between(0, 4);
    d.viewsSeen = views;
    if (pm === 'cpm') {
      if (status === 'live') { d.cpmState = 'wait'; d.viewsNow = Math.round(views * .7); }
      else if (R() < .07) { d.cpmState = 'failed'; d.views = Math.round(views * .8); d.warns.push({ code: 'cpmfail', sev: 'high' }); }
      else { d.cpmState = 'fixed'; d.views = views; d.fixedAt = new Date(+st + hoursOf(format) * 36e5 - 2 * 6e4); }
    }
  } else if (pm === 'cpm') d.cpmState = 'wait';
  return d;
}

function generate() {
  const deals = [];
  for (let day = DATA_FROM; day <= DATA_TO; day = addDays(day, 1)) {
    const date = iso(day);
    const ahead = dayDiff(day, TODAY);
    const fut = ahead > 14 ? .25 : ahead > 6 ? .55 : 1;
    for (const p of [1, 2, 3]) for (const s of SLOTS) {
      if (R() < BUY_PROB[p][s.k] * fut) {
        deals.push(makeBuy(p, date, s.k));
        if (R() < .05) deals.push(makeBuy(p, date, s.k));
      }
    }
    for (const p of [1, 3]) for (const s of SLOTS) {
      const mand = PJ[p].mandatory.includes(s.k);
      const prob = mand ? (ahead < 0 ? .88 : ahead <= 6 ? .72 : .3) : (ahead < 0 ? .25 : .12) * (p === 3 ? .6 : 1);
      if (R() < prob) deals.push(makeSale(p, date, s.k));
    }
  }

  // Примеры из брифа — чтобы проверить вёрстку на крайних значениях.
  const drop = (side, p, date, slot) => { for (let i = deals.length - 1; i >= 0; i--) { const x = deals[i]; if (x.side === side && x.project === p && x.date === date && x.slot === slot) deals.splice(i, 1); } };
  drop('buy', 1, '2026-10-06', 'n17');
  const cpmEx = makeBuy(1, '2026-10-06', 'n17');
  Object.assign(cpmEx, { format: '1/24', status: 'done', pm: 'cpm', rate: 450, views: 12480, cpmState: 'fixed', admin: 'tenshi', price: undefined, warns: [] });
  cpmEx.fixedAt = new Date(2026, 9, 7, 16, 58); // за 2 минуты до снятия в 17:00
  cpmEx.checks = { reach: { views: 12480, ago: 'перед снятием' }, time: { plan: '17:00', fact: '17:00', late: false }, top: { ok: true }, life: { ok: true, hours: 24 } };
  cpmEx.factShift = 0;
  cpmEx.result = { subs: 402, buyers: 11, revenue: 11 * 990, retention: .84 };
  deals.push(cpmEx);

  drop('buy', 3, '2026-10-14', 'evening');
  deals.push({ side: 'buy', project: 3, date: '2026-10-14', slot: 'evening', format: '1/48', status: 'agreed', pm: 'fix', price: 150000, admin: 'pro', creative: 'Разбор сделки', track: 'https://t.me/+Kx4Lm2Pq8VwZ', post: '', notes: 'Сетка из трёх каналов, 1,2 млн подписчиков суммарно. Креатив согласовать до 12.10.', warns: [], checks: null, result: null });

  drop('sell', 1, '2026-10-08', 'evening');
  deals.push({ side: 'sell', project: 1, date: '2026-10-08', slot: 'evening', format: '1/24', status: 'agreed', pm: 'cpm', rate: 450, cpmState: 'wait', buyer: '@ad_manager_77', post: '', notes: '', warns: [] });
  drop('sell', 1, '2026-10-08', 'morning');
  deals.push({ side: 'sell', project: 1, date: '2026-10-08', slot: 'morning', format: '1/24', status: 'live', pm: 'cpm', rate: 420, cpmState: 'wait', viewsNow: 9870, buyer: '@promo_hunter', post: 'https://t.me/satan_games/4417', notes: '', warns: [], factShift: 2 });
  // Завтра одно обязательное место ещё не продано — для предупреждения.
  drop('sell', 1, '2026-10-09', 'day');

  deals.sort((a, b) => a.date.localeCompare(b.date) || SLOT[a.slot].i - SLOT[b.slot].i || a.project - b.project);
  let nb = 1001, ns = 2001;
  for (const d of deals) {
    d.id = d.side === 'buy' ? `З-${nb++}` : `П-${ns++}`;
    if (!d.history) d.history = makeHistory(d);
  }
  return deals;
}

let DEALS = generate();

// ================= ЕДИНЫЕ ФОРМУЛЫ =================
function amountOf(d) {
  if (d.pm === 'fix') return d.price ?? null;
  if (d.cpmState === 'fixed' || d.cpmState === 'failed') return d.views != null ? Math.round(d.rate * d.views / 1000) : null;
  return null;
}
const viewsOf = d => d.views ?? d.viewsNow ?? d.checks?.reach?.views ?? d.viewsSeen ?? null;

function aggBuy(list) {
  const a = { count: 0, pubCount: 0, futCount: 0, spent: 0, planned: 0, plannedCpm: 0, pendingCpm: 0, estimated: 0,
    reach: 0, reachSpent: 0, resCount: 0, resSpent: 0, subs: 0, buyers: 0, revenue: 0, retW: 0, retSubs: 0 };
  for (const d of list) {
    if (d.status === 'cancel') continue;
    a.count++;
    const amt = amountOf(d);
    if (isPub(d.status)) {
      a.pubCount++;
      if (amt == null) a.pendingCpm++;
      else {
        a.spent += amt;
        if (d.cpmState === 'failed') a.estimated++;
        const v = viewsOf(d);
        if (v != null) { a.reach += v; a.reachSpent += amt; }
        if (d.result) {
          a.resCount++; a.resSpent += amt;
          a.subs += d.result.subs; a.buyers += d.result.buyers; a.revenue += d.result.revenue;
          if (d.result.retention != null) { a.retW += d.result.retention * d.result.subs; a.retSubs += d.result.subs; }
        }
      }
    } else {
      a.futCount++;
      if (amt == null) a.plannedCpm++; else a.planned += amt;
    }
  }
  a.cpm = a.reach ? a.reachSpent / a.reach * 1000 : null;
  a.cps = a.subs ? a.resSpent / a.subs : null;
  a.cpb = a.buyers ? a.resSpent / a.buyers : null;
  a.roi = a.resSpent ? (a.revenue - a.resSpent) / a.resSpent : null;
  a.retention = a.retSubs ? a.retW / a.retSubs : null;
  return a;
}

function aggSell(list) {
  const a = { count: 0, planCount: 0, earned: 0, earnedCount: 0, expected: 0, expectedCount: 0, expectedCpm: 0, waitCpm: 0, waitEst: 0, estimated: 0, views: 0, viewsEarned: 0 };
  for (const d of list) {
    if (d.status === 'cancel') continue;
    if (d.status === 'plan') { a.planCount++; continue; }
    a.count++;
    const amt = amountOf(d);
    if (isPub(d.status)) {
      if (amt == null) { a.waitCpm++; a.waitEst += d.rate * (d.viewsNow || 0) / 1000; }
      else {
        a.earned += amt; a.earnedCount++;
        if (d.cpmState === 'failed') a.estimated++;
        const v = viewsOf(d);
        if (v != null) { a.views += v; a.viewsEarned += amt; }
      }
    } else {
      a.expectedCount++;
      if (amt == null) a.expectedCpm++; else a.expected += amt;
    }
  }
  a.avg = a.earnedCount ? a.earned / a.earnedCount : null;
  a.factCpm = a.views ? a.viewsEarned / a.views * 1000 : null;
  return a;
}

// Закрыто ли обязательное место: продажа «Договорились», «Вышел» или «Завершён».
const sold = (p, date, slot) => state.demo !== 'empty' && DEALS.some(d => d.side === 'sell' && d.project === p && d.date === date && d.slot === slot && (d.status === 'agreed' || isPub(d.status)));
function mandatoryFill(channels, days) {
  const r = { total: 0, filled: 0, missPast: 0, missFuture: 0 };
  for (const p of channels) for (const day of days) for (const s of PJ[p].mandatory) {
    r.total++;
    const date = iso(day);
    if (sold(p, date, s)) r.filled++;
    else if (startOf(date, s) < NOW) r.missPast++;
    else r.missFuture++;
  }
  r.pct = r.total ? r.filled / r.total : null;
  return r;
}

function warnText(d, w) {
  const c = d.checks;
  switch (w.code) {
    case 'early': return `Пост удалён раньше срока — продержался ${dur(c.life.lived)}, <b>не хватило ${dur(c.life.short)}</b>`;
    case 'top': return `Не простоял час в топе — <b>не хватило ${w.short ?? c.top.short}${NB}мин</b>`;
    case 'late': return `Вышел в <b>${c.time.fact}</b> вместо ${c.time.plan}`;
    case 'noclicks': return 'Пост вышел, а заходов по ссылке нет';
    case 'cpmfail': return 'CPM: не удалось зафиксировать просмотры — сумма посчитана по последнему замеру';
    default: return '';
  }
}

// ================= СОСТОЯНИЕ =================
const state = {
  mode: 'buy', period: 'week', anchor: TODAY,
  cFrom: new Date(2026, 8, 21), cTo: new Date(2026, 9, 11),
  view: 'list', scope: [], sellCh: null,
  levels: { buy: ['project', 'week', 'slot'], sell: ['project', 'week', 'slot'] },
  expanded: null, sumSort: { col: null, dir: -1 },
  mx: { rows: 'project', buy: 'count', sell: 'count' },
  warnsOpen: false, demo: 'data', narrow: false, gridGroup: 'project',
};

function range() {
  let from, to;
  if (state.period === 'week') { from = mondayOf(state.anchor); to = addDays(from, 6); }
  else if (state.period === 'month') { from = new Date(state.anchor.getFullYear(), state.anchor.getMonth(), 1); to = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + 1, 0); }
  else { from = state.cFrom; to = state.cTo < state.cFrom ? state.cFrom : state.cTo; }
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return { from, to, days };
}
function prevRange(r) {
  if (state.period === 'month') { const f = new Date(r.from.getFullYear(), r.from.getMonth() - 1, 1); const t = new Date(r.from.getFullYear(), r.from.getMonth(), 0); return { from: f, to: t }; }
  const n = r.days.length; return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
}
function rangeLabel(r) {
  if (state.period === 'month') return `${MON_NOM[r.from.getMonth()]} ${r.from.getFullYear()}`;
  return `${dm(r.from)} – ${dm(r.to)}.${r.to.getFullYear()}`;
}
const prevLabel = () => (state.period === 'week' ? 'к прошлой неделе' : state.period === 'month' ? 'к прошлому месяцу' : 'к предыдущему периоду такой же длины');

const scopeIds = () => (state.scope.length ? state.scope : PROJECTS.map(p => p.id));
const channelIds = () => scopeIds().filter(id => PJ[id].channel);
const sideIds = () => (state.mode === 'buy' ? scopeIds() : channelIds());
function dealsIn(from, to, ids = sideIds()) {
  if (state.demo === 'empty') return [];
  const f = iso(from), t = iso(to);
  return DEALS.filter(d => d.side === state.mode && ids.includes(d.project) && d.date >= f && d.date <= t);
}
const agg = list => (state.mode === 'buy' ? aggBuy(list) : aggSell(list));

// ================= РАЗМЕТКА: МЕЛОЧИ =================
const $ = s => document.querySelector(s);
const ava = (p, cls = '') => `<span class="pava ${cls}" style="--h:${PJ[p].h}" aria-hidden="true">${esc(PJ[p].mono)}</span>`;
// «Кот (@kot_tgg)»: имя главное, username — в скобках и потише
const admHTML = id => (ADMINS[id] ? `<span class="adm"><b>${esc(ADMINS[id].name)}</b> <span class="u">(@${esc(ADMINS[id].user)})</span></span>` : '<span class="dash-v">—</span>');
const stChip = s => `<span class="st st-${s}">${ST[s].l}</span>`;
const mkOf = d => (isPub(d.status) ? 'pub' : d.status === 'agreed' ? 'agreed' : 'plan');
const ICON = {
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  bad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></svg>',
  err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 8v5M12 16.5h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>',
};
const priceHTML = d => {
  const amt = amountOf(d);
  if (d.pm === 'fix') return `<div class="price-main">${rub(d.price)}</div>`;
  if (amt == null) return `<div class="price-main price-q">CPM ${int(d.rate)}${NB}₽</div><div class="price-sub">сумма после фиксации</div>`;
  if (d.cpmState === 'failed') return `<div class="price-main price-q">≈${NB}${rub(amt)}</div><div class="price-sub">CPM ${int(d.rate)} · оценка</div>`;
  return `<div class="price-main">${rub(amt)}</div><div class="price-sub">CPM ${int(d.rate)}</div>`;
};
const roiCls = v => (v == null ? 'dash-v' : v >= 0 ? 'r-good' : 'r-bad');
const cpsCls = v => (v == null ? 'dash-v' : v <= 17 ? 'r-good' : v <= 25 ? 'r-mid' : 'r-bad');
function warnIcons(d) {
  if (!d.warns.length) return '';
  return d.warns.map(w => {
    const t = warnText(d, w).replace(/<[^>]+>/g, '');
    return `<span class="wic ${w.sev}" role="img" aria-label="${esc(t)}" title="${esc(t)}">${ICON.warn}</span>`;
  }).join('');
}
function emptyHTML(title, text, withBtn = true) {
  return `<div class="card"><div class="empty"><div class="e-ic">${ICON.empty}</div><h2>${title}</h2><p>${text}</p>${withBtn ? `<button class="btn btn-primary" type="button" data-act="new">${ICON.plus}${state.mode === 'buy' ? 'Новый закуп' : 'Новая продажа'}</button>` : ''}</div></div>`;
}

// ================= ШАПКА, ИТОГИ, ПРЕДУПРЕЖДЕНИЯ =================
function renderHeader(r) {
  const ids = scopeIds();
  $('#projSelLbl').textContent = !state.scope.length ? 'Все проекты' : ids.length === 1 ? PJ[ids[0]].name : `${ids.length} ${plural(ids.length, 'проект', 'проекта', 'проектов')}`;
  $('#projSelAva').innerHTML = ids.map(id => ava(id, 'sm')).join('');
  $('#tbSub').textContent = `${state.mode === 'buy' ? 'Закуп рекламы в чужих каналах' : 'Продажа мест в моих каналах'} · ${rangeLabel(r)}`;
  $('#rangeLbl').textContent = rangeLabel(r);
  $('#customRange').hidden = state.period !== 'custom';
  $('#cFrom').value = iso(state.cFrom); $('#cTo').value = iso(state.cTo);
  $('#newBtnLbl').textContent = state.mode === 'buy' ? 'Новый закуп' : 'Новая продажа';
  for (const [id, v] of [['#modeSeg', state.mode], ['#periodSeg', state.period], ['#viewSeg', state.view]]) {
    document.querySelectorAll(`${id} button`).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  }
}

const delta = (a, b, label, inverse = false) => {
  if (a == null || b == null || b === 0) return '';
  const v = (a - b) / Math.abs(b);
  if (Math.abs(v) < .005) return `<span class="delta flat" title="${label}">0%</span>`;
  const good = inverse ? v < 0 : v > 0;
  return `<span class="delta ${good ? 'up' : 'dn'}" title="${label}">${pct(v)}</span>`;
};
const deltaPp = (a, b, label) => {
  if (a == null || b == null) return '';
  const v = Math.round((a - b) * 100);
  return `<span class="delta ${v > 0 ? 'up' : v < 0 ? 'dn' : 'flat'}" title="${label}">${signed(v, `${Math.abs(v)} п.п.`)}</span>`;
};
const kpi = (lbl, val, sub, extra = '', cls = '', bar = '') => `<article class="card kpi"><div class="kpi-top"><span class="kpi-lbl">${lbl}</span>${extra}</div><div class="kpi-val ${cls}">${val}</div>${bar}<div class="kpi-sub">${sub}</div></article>`;

function renderKpis(r, list) {
  const el = $('#kpis');
  const pr = prevRange(r);
  const prevList = dealsIn(pr.from, pr.to);
  const lbl = prevLabel();
  if (state.mode === 'buy') {
    const a = aggBuy(list), b = aggBuy(prevList);
    const occ = occupancy(r.days, list);
    el.innerHTML =
      kpi('Потрачено', rub(a.spent), `«Вышел» и «Завершён» · ${a.pubCount} ${plural(a.pubCount, 'закуп', 'закупа', 'закупов')}${a.pendingCpm ? ` · ещё ${a.pendingCpm} по CPM ждут фиксации` : ''}`, delta(a.spent, b.spent, lbl)) +
      kpi('Запланировано', rub(a.planned), `«В плане» и «Договорились» · ${a.futCount}${a.plannedCpm ? ` · из них ${a.plannedCpm} по CPM, сумма будет после выхода` : ''}`) +
      kpi('Выручка с закупа', rub(a.revenue), `${int(a.buyers)} ${plural(a.buyers, 'покупка', 'покупки', 'покупок')} · ${int(a.subs)} ${plural(a.subs, 'подписчик', 'подписчика', 'подписчиков')}`, delta(a.revenue, b.revenue, lbl)) +
      kpi('ROI', pct(a.roi), a.resCount ? `по ${a.resCount} ${plural(a.resCount, 'закупу', 'закупам', 'закупам')} с накопленным результатом` : 'результата ещё нет', deltaPp(a.roi, b.roi, lbl), a.roi == null ? '' : a.roi >= 0 ? 'good' : 'bad') +
      kpi('Заполнено мест', `${occ.used} <small>из ${occ.total}</small>`, `частей дня за ${r.days.length} ${plural(r.days.length, 'день', 'дня', 'дней')} · по выбранным проектам`, '', '',
        `<div class="kpi-bar" role="img" aria-label="Занято ${occ.used} из ${occ.total}"><i style="width:${occ.total ? occ.used / occ.total * 100 : 0}%;--c:var(--accent)"></i></div>`);
  } else {
    const a = aggSell(list), b = aggSell(prevList);
    const chs = channelIds();
    const mf = mandatoryFill(chs, r.days);
    el.innerHTML =
      kpi('Заработано', rub(a.earned), `«Вышел» и «Завершён» · ${a.earnedCount} ${plural(a.earnedCount, 'продажа', 'продажи', 'продаж')}`, delta(a.earned, b.earned, lbl)) +
      kpi('Ожидается', rub(a.expected), `«Договорились», пост ещё не вышел · ${a.expectedCount}${a.expectedCpm ? ` · из них ${a.expectedCpm} по CPM без суммы` : ''}`) +
      kpi('Ожидает фиксации CPM', a.waitCpm ? `≈${NB}${rub(a.waitEst)}` : '—', a.waitCpm ? `${a.waitCpm} ${plural(a.waitCpm, 'продажа', 'продажи', 'продаж')} по CPM: сумма станет точной при снятии поста` : 'по вышедшим постам всё зафиксировано') +
      kpi('Средний чек', rub(a.avg), a.earnedCount ? `заработано ÷ ${a.earnedCount} ${plural(a.earnedCount, 'продажу', 'продажи', 'продаж')}` : 'нет вышедших продаж', delta(a.avg, b.avg, lbl)) +
      kpi('Заполнено обязательных', mf.total ? `${mf.filled} <small>из ${mf.total}</small>` : '—',
        !mf.total ? 'у выбранных каналов нет обязательных мест' : mf.missPast || mf.missFuture ? `${mf.missPast ? `<span class="r-bad">${mf.missPast} недопродано</span>` : ''}${mf.missPast && mf.missFuture ? ' · ' : ''}${mf.missFuture ? `${mf.missFuture} ещё можно продать` : ''}` : 'все обязательные места проданы',
        '', '', mf.total ? `<div class="kpi-bar" role="img" aria-label="Продано ${mf.filled} из ${mf.total}"><i style="width:${mf.filled / mf.total * 100}%;--c:var(--green)"></i><i style="width:${mf.missPast / mf.total * 100}%;--c:var(--red)"></i><i style="width:${mf.missFuture / mf.total * 100}%;--c:rgba(255,180,84,.45)"></i></div>` : '');
  }
}

function occupancy(days, list) {
  const used = new Set(list.filter(d => d.status !== 'cancel').map(d => `${d.date}|${d.slot}`));
  return { used: used.size, total: days.length * SLOTS.length };
}

function collectWarns(list) {
  const out = [];
  for (const d of list) if (d.status !== 'cancel') for (const w of d.warns) out.push({ sev: w.sev, html: warnText(d, w), d });
  if (state.mode === 'sell' && state.demo !== 'empty') {
    const tm = addDays(TODAY, 1), date = iso(tm);
    for (const p of channelIds()) for (const s of PJ[p].mandatory) {
      if (!sold(p, date, s)) out.push({ sev: 'mid', html: `Завтра, ${dm(tm)}, не продано обязательное место — <b>${SLOT[s].l}</b>`, tomorrow: { p, date, slot: s } });
    }
  }
  return out.sort((a, b) => (a.sev === b.sev ? 0 : a.sev === 'high' ? -1 : 1) || (b.d?.date || '').localeCompare(a.d?.date || ''));
}

function renderWarns(list) {
  const ws = collectWarns(list);
  const el = $('#warns');
  if (!ws.length) { el.innerHTML = ''; return; }
  const high = ws.filter(w => w.sev === 'high').length;
  const shown = state.warnsOpen ? ws : ws.slice(0, 3);
  el.innerHTML = `<div class="wbox">
    <div class="wbox-h"><span class="wic ${high ? 'high' : 'mid'}">${ICON.warn}</span>${ws.length} ${plural(ws.length, 'предупреждение', 'предупреждения', 'предупреждений')}<span class="cnt">${high ? `${high} ${plural(high, 'высокое', 'высоких', 'высоких')}` : 'все средние'}</span>
      ${ws.length > 3 ? `<button class="btn tiny" type="button" data-act="warns" aria-expanded="${state.warnsOpen}">${state.warnsOpen ? 'Свернуть' : `Показать все ${ws.length}`}</button>` : ''}</div>
    <ul class="wlist">${shown.map(w => {
      const meta = w.d ? `${dm(parseIso(w.d.date))} · ${SLOT[w.d.slot].l} · ${esc(PJ[w.d.project].mono)}${w.d.side === 'buy' ? ` · ${esc(admLabel(w.d.admin))}` : ` · ${esc(w.d.buyer)}`}` : `${esc(PJ[w.tomorrow.p].mono)} · продать`;
      const act = w.d ? `data-act="open" data-id="${w.d.id}"` : `data-act="new" data-date="${w.tomorrow.date}" data-slot="${w.tomorrow.slot}" data-proj="${w.tomorrow.p}"`;
      return `<li><button class="witem" type="button" ${act}><span class="wtag ${w.sev}">${w.sev === 'high' ? 'высокая' : 'средняя'}</span><span class="wtext">${w.html}</span><span class="wmeta">${meta}</span></button></li>`;
    }).join('')}</ul></div>`;
}

// ================= ВИД: СПИСОК =================
function renderList(list) {
  const buy = state.mode === 'buy';
  const rows = [...list].sort((a, b) => a.date.localeCompare(b.date) || SLOT[a.slot].i - SLOT[b.slot].i);
  const a = agg(list);
  const head = buy
    ? ['Дата выхода', 'Место', 'Формат', 'Проект', 'У кого купил', 'Цена', 'Статус', 'Подп.', '₽ за подп.', 'ROI', '']
    : ['Дата выхода', 'Место', 'Формат', 'Мой канал', 'Покупатель', 'Цена', 'Статус', 'Просмотры', ''];
  const numCols = buy ? new Set([5, 7, 8, 9]) : new Set([5, 7]);
  const body = rows.map(d => {
    const day = parseIso(d.date);
    const mand = !buy && PJ[d.project].mandatory.includes(d.slot);
    const one = buy ? aggBuy([d]) : aggSell([d]);
    const why = isPub(d.status) ? 'результат ещё копится' : d.status === 'cancel' ? 'отменён' : 'пост ещё не вышел';
    const m = (label, v, cls = '') => `<td class="num c-m ${cls} ${v === '—' ? 'empty-m' : ''}" data-label="${label}"${v === '—' ? ` title="${why}"` : ''}>${v === '—' ? `<span class="dash-v">—</span>` : v}</td>`;
    const metrics = buy
      ? m('Подп.', one.resCount ? int(one.subs) : '—') + m('₽ за подп.', rub1(one.cps), cpsCls(one.cps)) + m('ROI', pct(one.roi), roiCls(one.roi))
      : m('Просмотры', isPub(d.status) && viewsOf(d) != null ? int(viewsOf(d)) : '—');
    return `<tr class="${d.status === 'cancel' ? 'is-cancel' : ''}" data-act="open" data-id="${d.id}">
      <th scope="row" class="c-date"><button class="row-btn" type="button" data-act="open" data-id="${d.id}" aria-label="Открыть ${buy ? 'закуп' : 'продажу'} ${d.id}"><b>${dm(day)}</b><span>${DOW[day.getDay()]}</span></button></th>
      <td class="c-slot"><span class="chip slot">${SLOT[d.slot].l}${mand ? ' <span class="req" title="обязательное место">*</span>' : ''}</span><span class="chip fmt fmt-m">${d.format}</span></td>
      <td class="c-fmt"><span class="chip fmt">${d.format}</span></td>
      <td class="c-proj"><span class="c-prj">${ava(d.project)}<span class="nm">${esc(PJ[d.project].name)}</span></span></td>
      <td class="c-venue">${buy ? admHTML(d.admin) : esc(d.buyer)}</td>
      <td class="num c-price">${priceHTML(d)}</td>
      <td class="c-st">${stChip(d.status)}</td>
      ${metrics}
      <td class="c-warn"><span class="wcell">${warnIcons(d)}</span></td>
    </tr>`;
  }).join('');
  const foot = buy
    ? `<tr><th scope="row" colspan="5">Итого · ${a.count} ${plural(a.count, 'закуп', 'закупа', 'закупов')}</th><td class="num"><div class="price-main">${rub(a.spent)}</div><div class="price-sub">потрачено</div></td><td></td><td class="num">${a.resCount ? int(a.subs) : '—'}</td><td class="num ${cpsCls(a.cps)}">${rub1(a.cps)}</td><td class="num ${roiCls(a.roi)}">${pct(a.roi)}</td><td></td></tr>`
    : `<tr><th scope="row" colspan="5">Итого · ${a.count} ${plural(a.count, 'продажа', 'продажи', 'продаж')}</th><td class="num"><div class="price-main">${rub(a.earned)}</div><div class="price-sub">заработано</div></td><td></td><td class="num">${a.views ? int(a.views) : '—'}</td><td></td></tr>`;
  return `<article class="card hero">
    <div class="card-h"><span class="card-idx">01 / ${buy ? 'закупы' : 'продажи'}</span>
      <div><h2 class="card-t">${buy ? 'Список закупов' : 'Список продаж'}</h2><div class="card-s">${rows.length} ${plural(rows.length, 'сделка', 'сделки', 'сделок')} за период · отменённые приглушены · клик по строке — карточка</div></div></div>
    <div class="tbl-wrap"><table class="tbl list">
      <caption class="sr-only">${buy ? 'Закупы' : 'Продажи'} за период</caption>
      <thead><tr>${head.map((h, i) => `<th scope="col" class="${numCols.has(i) ? 'num' : ''}">${h ? h : '<span class="sr-only">Предупреждения</span>'}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div>
    ${!buy ? '<div class="hint-row"><span><span class="req r-mid mono">*</span> — обязательное место канала</span></div>' : ''}
  </article>`;
}

// ================= ВИД: СЕТКА =================
function renderGrid(r, list) {
  const useWeek = state.period === 'week' || (state.period === 'custom' && r.days.length <= 7);
  const buy = state.mode === 'buy';
  let ch = null, chPick = '';
  if (!buy) {
    const chs = channelIds();
    if (!chs.includes(state.sellCh)) state.sellCh = chs[0];
    ch = state.sellCh;
    if (chs.length > 1) chPick = `<div class="chan-pick" role="group" aria-label="Канал">${chs.map(id => `<button type="button" data-act="chan" data-id="${id}" aria-pressed="${id === ch}">${ava(id, 'sm')}${esc(PJ[id].name)}</button>`).join('')}</div>`;
    list = list.filter(d => d.project === ch);
  }
  return useWeek ? renderWeek(r, list, ch, chPick) : renderMonth(r, list, ch, chPick);
}

function cellDeals(list, date, slot) { return list.filter(d => d.date === date && d.slot === slot && d.status !== 'cancel'); }

// Тело недельной сетки: строки дней и счётчик «Занято / Продано» по местам.
// opts.proj — проект полосы (новый закуп из пустой клетки сразу на него),
// opts.hideAva — в полосе проекта аватарка в плашке лишняя.
function weekBody(r, list, mandatory, ch, opts = {}) {
  const buy = state.mode === 'buy';
  const footCnt = SLOTS.map(() => 0), footMiss = SLOTS.map(() => 0);
  const projAttr = ch ? ` data-proj="${ch}"` : opts.proj ? ` data-proj="${opts.proj}"` : '';
  const rows = r.days.map(day => {
    const date = iso(day), today = dayDiff(day, TODAY) === 0, wk = day.getDay() === 0 || day.getDay() === 6;
    const cells = SLOTS.map((s, si) => {
      const ds = cellDeals(list, date, s.k);
      const isMand = mandatory.includes(s.k);
      const filled = buy ? ds.length > 0 : ds.some(d => d.status !== 'plan');
      if (buy ? ds.length : filled) footCnt[si]++;
      let inner;
      if (ds.length) {
        inner = ds.slice(0, 2).map(d => {
          const nm = buy ? admHTML(d.admin) : esc(d.buyer);
          const lbl = `${SLOT[d.slot].l}, ${dm(day)}: ${buy ? `${PJ[d.project].name}, ${admLabel(d.admin)}` : d.buyer}, ${ST[d.status].l}${d.warns.length ? ', есть предупреждение' : ''}`;
          return `<button class="gdeal ${d.status === 'plan' ? 'plan' : ''} ${d.warns.length ? 'warn' : ''}" type="button" data-act="open" data-id="${d.id}" aria-label="${esc(lbl)}">${buy && !opts.hideAva ? ava(d.project, 'sm') : ''}<span class="nm">${nm}</span><span class="mk ${mkOf(d)}"></span></button>`;
        }).join('') + (ds.length > 2 ? `<button class="gmore" type="button" data-act="cell" data-date="${date}" data-slot="${s.k}">+ ещё ${ds.length - 2}</button>` : '');
        if (!buy && isMand && !filled) inner += `<span class="sr-only">обязательное место ещё не продано</span>`;
      } else if (isMand) {
        const past = startOf(date, s.k) < NOW;
        if (past) { footMiss[si]++; inner = `<div class="gmiss" role="img" aria-label="Недопродажа: обязательное место прошло пустым">не продано</div>`; }
        else inner = `<button class="gopen" type="button" data-act="new" data-date="${date}" data-slot="${s.k}" data-proj="${ch}" aria-label="Продать обязательное место: ${s.l}, ${dm(day)}">свободно · продать</button>`;
      } else {
        inner = `<button class="gadd" type="button" data-act="new" data-date="${date}" data-slot="${s.k}"${projAttr} aria-label="Добавить${opts.proj ? ` для ${esc(PJ[opts.proj].name)}` : ''}: ${s.l}, ${dm(day)}">＋<span class="gadd-t"> добавить</span></button>`;
      }
      return `<td><div class="gcell">${inner}</div></td>`;
    }).join('');
    return `<tr class="${today ? 'today' : ''} ${wk ? 'wknd' : ''}"><th scope="row"><b>${DOW[day.getDay()]}${today ? ' · сегодня' : ''}</b><span>${dm(day)}</span></th>${cells}</tr>`;
  }).join('');
  const n = r.days.length;
  const foot = SLOTS.map((s, si) => {
    const isMand = mandatory.includes(s.k);
    const cls = !buy && isMand ? (footCnt[si] === n ? 'full' : footMiss[si] ? 'low' : '') : '';
    return `<td class="${cls}">${footCnt[si]}/${n}</td>`;
  }).join('');
  return { rows, foot };
}

// По каждому своему проекту: что уже вышло, что впереди, сколько это стоит.
// Те же aggBuy и те же правила «занятости», что в итогах периода.
function projSummary(r, list) {
  const total = r.days.length * SLOTS.length;
  const items = scopeIds().map(p => {
    const ds = list.filter(d => d.project === p);
    const a = aggBuy(ds);
    const live = ds.filter(d => d.status !== 'cancel');
    const agreed = live.filter(d => d.status === 'agreed').length, plan = live.filter(d => d.status === 'plan').length;
    const cells = { pub: 0, agreed: 0, plan: 0 };
    for (const day of r.days) for (const s of SLOTS) { const st = dayState(ds, iso(day), s.k, null); if (st in cells) cells[st]++; }
    const used = cells.pub + cells.agreed + cells.plan;
    const w = v => `${total ? v / total * 100 : 0}%`;
    return `<li><button class="psum-it" type="button" data-act="only-proj" data-id="${p}" aria-label="Показать только ${esc(PJ[p].name)}">
      <span class="psum-top">${ava(p)}<span class="nm">${esc(PJ[p].name)}</span><span class="psum-occ mono">${used}/${total}</span></span>
      <span class="psum-nums">
        <span><b>${a.pubCount}</b>вышло · ${rub(a.spent)}</span>
        <span><b>${a.futCount}</b>впереди${a.planned ? ` · ${rub(a.planned)}` : ''}${a.plannedCpm ? `${a.planned ? ' +' : ' ·'} ${a.plannedCpm} по CPM` : ''}</span>
      </span>
      <span class="psum-bar" aria-hidden="true"><i style="width:${w(cells.pub)};--c:var(--green)"></i><i style="width:${w(cells.agreed)};--c:var(--accent)"></i><i style="width:${w(cells.plan)};--c:rgba(138,148,166,.55)"></i></span>
      <span class="psum-foot">${a.futCount ? `впереди: ${agreed} договорились · ${plan} в плане` : 'впереди ничего не запланировано'}</span>
    </button></li>`;
  }).join('');
  return `<ul class="psum" aria-label="По проектам">${items}</ul>`;
}

function renderWeek(r, list, ch, chPick) {
  const buy = state.mode === 'buy';
  const mandatory = ch ? PJ[ch].mandatory : [];
  const ids = scopeIds();
  const lanes = buy && state.gridGroup === 'project' && ids.length > 1;
  const head = SLOTS.map(s => `<th scope="col">${s.l}${mandatory.includes(s.k) ? '<span class="req">обязательное</span>' : ''}</th>`).join('');
  let bodies;
  if (lanes) {
    bodies = ids.map(p => {
      const ds = list.filter(d => d.project === p);
      const a = aggBuy(ds);
      const b = weekBody(r, ds, [], null, { proj: p, hideAva: true });
      return `<tbody class="lane"><tr class="lane-h"><th scope="rowgroup" colspan="${SLOTS.length + 1}"><span class="lane-in">${ava(p)}<b>${esc(PJ[p].name)}</b><span class="lane-s">вышло ${a.pubCount} · впереди ${a.futCount}</span></span></th></tr>
        ${b.rows}<tr class="lane-foot"><th scope="row">Занято</th>${b.foot}</tr></tbody>`;
    }).join('');
  } else {
    const b = weekBody(r, list, mandatory, ch);
    bodies = `<tbody>${b.rows}</tbody><tfoot><tr><th scope="row">${buy ? 'Занято' : 'Продано'}</th>${b.foot}</tr></tfoot>`;
  }
  const legend = buy
    ? `<span class="legend"><span class="mk agreed"></span>договорились</span><span class="legend"><span class="mk pub"></span>вышел / завершён</span><span class="legend"><span class="mk plan"></span>в плане</span><span class="legend" style="color:var(--red)">красная рамка — есть предупреждение</span><span>пустая клетка — «＋ добавить» с этим днём и местом${lanes ? ' сразу для этого проекта' : ''}</span>`
    : `<span class="legend"><span class="mk agreed"></span>договорились</span><span class="legend"><span class="mk pub"></span>вышел / завершён</span><span class="legend"><span class="mk plan"></span>в плане</span><span class="legend"><span class="mk miss"></span>недопродажа — обязательное место прошло пустым</span><span class="legend"><span class="mk open"></span>обязательное, ещё можно продать</span>`;
  const title = buy ? 'Что занято и что свободно' : `Продажи · ${esc(PJ[ch].name)}`;
  const groupSeg = buy && ids.length > 1
    ? `<div class="seg sm" role="group" aria-label="Группировка сетки" data-seg="gridGroup"><button type="button" data-v="project" aria-pressed="${state.gridGroup === 'project'}">По проектам</button><button type="button" data-v="all" aria-pressed="${state.gridGroup !== 'project'}">Все вместе</button></div>`
    : '';
  return `<article class="card hero">
    <div class="card-h"><span class="card-idx">01 / сетка</span>
      <div><h2 class="card-t">${title}</h2><div class="card-s">Неделя ${rangeLabel(r)} · ${buy ? (state.scope.length ? ids.map(id => PJ[id].mono).join(', ') : 'все проекты') : 'клик по клетке — продажа'}</div></div>
      <div class="right">${chPick}${groupSeg}</div></div>
    ${buy ? projSummary(r, list) : ''}
    <div class="tbl-wrap"><table class="tbl grid-tbl ${lanes ? 'lanes' : ''}">
      <caption class="sr-only">Сетка мест на неделю</caption>
      <thead><tr><th scope="col">День</th>${head}</tr></thead>
      ${bodies}
    </table><div class="scroll-hint" aria-hidden="true"></div></div>
    <div class="hint-row">${legend}</div></article>`;
}

function dayState(list, date, slot, ch) {
  const ds = cellDeals(list, date, slot);
  if (ds.some(d => isPub(d.status))) return 'pub';
  if (ds.some(d => d.status === 'agreed')) return 'agreed';
  if (ds.length) return ch && PJ[ch].mandatory.includes(slot) && startOf(date, slot) < NOW ? 'miss' : 'plan';
  if (ch && PJ[ch].mandatory.includes(slot)) return startOf(date, slot) < NOW ? 'miss' : 'open';
  return 'free';
}
const DOT_LBL = { pub: 'вышел', agreed: 'договорились', plan: 'в плане', free: 'свободно', miss: 'не продано', open: 'обязательное свободно' };

function renderMonth(r, list, ch, chPick) {
  const buy = state.mode === 'buy';
  const months = [];
  for (let m = new Date(r.from.getFullYear(), r.from.getMonth(), 1); m <= r.to; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) months.push(m);
  const f = iso(r.from), t = iso(r.to);
  const html = months.map(m => {
    const first = new Date(m.getFullYear(), m.getMonth(), 1), last = new Date(m.getFullYear(), m.getMonth() + 1, 0);
    let cells = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((x, i) => `<div class="cal-dow ${i > 4 ? 'wk' : ''}" aria-hidden="true">${x}</div>`).join('');
    for (let i = 0; i < (first.getDay() + 6) % 7; i++) cells += '<div class="cal-day blank" aria-hidden="true"></div>';
    for (let day = first; day <= last; day = addDays(day, 1)) {
      const date = iso(day), inR = date >= f && date <= t;
      const sts = SLOTS.map(s => dayState(list, date, s.k, ch));
      const busy = sts.filter(x => x === 'pub' || x === 'agreed' || x === 'plan').length;
      const miss = sts.filter(x => x === 'miss').length;
      const lbl = `${day.getDate()} ${MON_GEN[day.getMonth()]}, ${DOW_FULL[day.getDay()]}: ${buy ? `занято ${busy} из 7` : `продано ${busy} из 7${miss ? `, недопродано ${miss}` : ''}`}`;
      cells += `<button class="cal-day ${dayDiff(day, TODAY) === 0 ? 'today' : ''} ${inR ? '' : 'out'} ${miss ? 'has-miss' : ''}" type="button" data-act="day" data-date="${date}" aria-label="${lbl}">
        <span class="dn">${day.getDate()}<small>${dayDiff(day, TODAY) === 0 ? 'сегодня' : ''}</small></span>
        <span class="dots" aria-hidden="true">${sts.map((x, i) => `<span class="mk ${x}" title="${SLOTS[i].l}: ${DOT_LBL[x]}"></span>`).join('')}</span></button>`;
    }
    return `<section class="cal-month" aria-label="${MON_NOM[m.getMonth()]} ${m.getFullYear()}">${months.length > 1 ? `<h3 class="cal-mt">${MON_NOM[m.getMonth()]} ${m.getFullYear()}</h3>` : ''}<div class="cal-grid">${cells}</div></section>`;
  }).join('');
  let sum;
  if (buy) { const o = occupancy(r.days, list); sum = `Занято <b>${o.used}</b> из ${o.total} мест`; }
  else { const mf = mandatoryFill([ch], r.days); sum = `${esc(PJ[ch].mono)}: обязательных продано <b>${mf.filled}</b> из ${mf.total}${mf.missPast ? ` · <span class="r-bad">${mf.missPast} недопродано</span>` : ''}`; }
  const legend = `<span class="legend"><span class="mk pub"></span>вышел</span><span class="legend"><span class="mk agreed"></span>договорились</span><span class="legend"><span class="mk plan"></span>в плане</span><span class="legend"><span class="mk free"></span>свободно</span>${buy ? '' : '<span class="legend"><span class="mk miss"></span>недопродано</span><span class="legend"><span class="mk open"></span>обязательное свободно</span>'}<span>Метки в каждом дне — по порядку: ${SLOTS.map(s => s.s).join(' · ')}</span>`;
  return `<article class="card hero">
    <div class="card-h"><span class="card-idx">01 / календарь</span>
      <div><h2 class="card-t">${buy ? 'Закуплено по дням' : `Продажи · ${esc(PJ[ch].name)}`}</h2><div class="card-s">${rangeLabel(r)} · клик по дню — сделки дня</div></div>
      <div class="right"><span class="cal-sum">${sum}</span>${chPick}</div></div>
    ${buy ? projSummary(r, list) : ''}<div class="cal">${html}</div><div class="hint-row">${legend}</div></article>`;
}

// ================= ВИД: СВОДКА =================
const DIMS = {
  project: { l: 'Проект', sl: 'Мой канал', key: d => d.project, label: k => PJ[k].name, order: k => k },
  slot: { l: 'Место', key: d => d.slot, label: k => SLOT[k].l, order: k => SLOT[k].i },
  week: { l: 'Неделя', key: d => iso(mondayOf(parseIso(d.date))), label: k => weekLabel(k), order: k => k },
  day: { l: 'День', key: d => d.date, label: k => { const x = parseIso(k); return `${DOW[x.getDay()]}, ${dm(x)}`; }, order: k => k },
  format: { l: 'Формат', key: d => d.format, label: k => k, order: k => k },
  admin: { l: 'Админ', buyOnly: true, key: d => d.admin, label: k => admLabel(k), order: k => ADMINS[k]?.name || k },
  creative: { l: 'Креатив', buyOnly: true, key: d => d.creative || 'без креатива', label: k => k, order: k => k },
  buyer: { l: 'Покупатель', sellOnly: true, key: d => d.buyer, label: k => k, order: k => k },
};
const dimsForMode = () => Object.keys(DIMS).filter(k => !(state.mode === 'buy' ? DIMS[k].sellOnly : DIMS[k].buyOnly));
const dimLabel = k => (state.mode === 'sell' && DIMS[k].sl ? DIMS[k].sl : DIMS[k].l);
const SUM_COLS = {
  buy: [
    { k: 'count', l: 'Закупов', f: v => int(v) },
    { k: 'spent', l: 'Потрачено', f: rub, need: 'pub' },
    { k: 'subs', l: 'Подп.', f: v => int(v), need: 'res' },
    { k: 'cps', l: '₽ за подп.', f: rub1, cls: cpsCls },
    { k: 'buyers', l: 'Покупок', f: v => int(v), need: 'res' },
    { k: 'revenue', l: 'Выручка', f: rub, need: 'res' },
    { k: 'roi', l: 'ROI', f: pct, cls: roiCls },
  ],
  sell: [
    { k: 'count', l: 'Продано', f: v => int(v) },
    { k: 'earned', l: 'Заработано', f: rub, need: 'earned' },
    { k: 'avg', l: 'Ср. чек', f: rub },
    { k: 'views', l: 'Просмотры', f: v => (v ? int(v) : '—') },
    { k: 'factCpm', l: 'CPM факт.', f: rub1 },
  ],
};
function cellVal(c, a) {
  if (c.need === 'pub' && !a.pubCount) return { s: '—', v: null };
  if (c.need === 'res' && !a.resCount) return { s: '—', v: null };
  if (c.need === 'earned' && !a.earnedCount) return { s: '—', v: null };
  const v = a[c.k];
  return { s: v == null ? '—' : c.f(v), v };
}
function buildTree(list, levels, depth = 0, path = '') {
  const dim = DIMS[levels[depth]];
  const groups = new Map();
  for (const d of list) { const k = dim.key(d); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); }
  let nodes = [...groups].map(([k, ds]) => {
    const p = `${path}/${levels[depth]}:${k}`;
    return { k, key: p, label: dim.label(k), dim: levels[depth], deals: ds, a: agg(ds), children: depth + 1 < levels.length ? buildTree(ds, levels, depth + 1, p) : null };
  });
  const sc = state.sumSort;
  if (sc.col) nodes.sort((x, y) => { const a = x.a[sc.col], b = y.a[sc.col]; if (a == null) return 1; if (b == null) return -1; return (a - b) * sc.dir; });
  else nodes.sort((x, y) => { const a = dim.order(x.k), b = dim.order(y.k); return a < b ? -1 : a > b ? 1 : 0; });
  return nodes;
}

function renderSummary(r, list) {
  const levels = state.levels[state.mode];
  const live = list.filter(d => d.status !== 'cancel' && (state.mode === 'buy' || d.status !== 'plan'));
  const tree = buildTree(live, levels);
  if (!state.expanded) state.expanded = new Set(tree.map(n => n.key));
  const cols = SUM_COLS[state.mode];
  const total = agg(list);
  const remaining = dimsForMode().filter(k => !levels.includes(k));
  const chips = levels.map((k, i) => `${i ? '<span class="lvl-arrow" aria-hidden="true">→</span>' : ''}<span class="lvl"><span class="n">${i + 1}</span>${dimLabel(k)}
      <button type="button" data-act="lvl-left" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Поднять «${dimLabel(k)}» на уровень выше">${ICON.left}</button>
      <button type="button" data-act="lvl-right" data-i="${i}" ${i === levels.length - 1 ? 'disabled' : ''} aria-label="Опустить «${dimLabel(k)}» на уровень ниже">${ICON.right}</button>
      <button type="button" data-act="lvl-del" data-i="${i}" ${levels.length === 1 ? 'disabled' : ''} aria-label="Убрать уровень «${dimLabel(k)}»">${ICON.x}</button></span>`).join('');
  const add = levels.length < 3 && remaining.length
    ? `<button class="btn tiny add-btn" type="button" popovertarget="addPop">${ICON.plus}измерение</button>
       <div id="addPop" class="pop add-pop" popover>${remaining.map(k => `<button type="button" data-act="lvl-add" data-dim="${k}">${dimLabel(k)}</button>`).join('')}</div>`
    : '<span class="card-s">максимум три уровня</span>';
  const head = `<div class="card-h"><span class="card-idx">01 / сводка</span>
      <div><h2 class="card-t">Сводка с вложенностью</h2><div class="card-s">${rangeLabel(r)} · промежуточные итоги на каждом уровне · сортировка по колонке — внутри уровня</div></div></div>
    <div class="levels" role="group" aria-label="Уровни группировки"><span class="lbl">Уровни</span>${chips}${add}</div>`;
  if (!tree.length) return `<article class="card hero">${head}${emptyHTML('За период нет сделок', 'Сводке нечего группировать. Смените период или добавьте сделку.').replace('<div class="card">', '<div>')}</article>`;

  if (state.narrow) {
    const ms = a => cols.slice(0, state.mode === 'buy' ? 4 : 3).map(c => `<span>${c.l} <b>${cellVal(c, a).s}</b></span>`).join('') + (state.mode === 'buy' ? `<span>ROI <b class="${roiCls(a.roi)}">${pct(a.roi)}</b></span>` : '');
    const rec = nodes => nodes.map(n => n.children
      ? `<details data-key="${esc(n.key)}" ${state.expanded.has(n.key) ? 'open' : ''}><summary><span class="nm">${esc(n.label)}</span><span class="ms">${ms(n.a)}</span></summary>${rec(n.children)}</details>`
      : `<div class="leaf"><span class="nm">${esc(n.label)}</span><span class="ms">${ms(n.a)}</span></div>`).join('');
    return `<article class="card hero">${head}<div class="sum-m">${rec(tree)}<div class="tot">Итого · ${ms(total)}</div></div></article>`;
  }

  const rows = [];
  const walk = (nodes, lv) => {
    for (const n of nodes) {
      const open = state.expanded.has(n.key);
      rows.push(`<tr class="lv${lv}"><th scope="row"><div class="grp" style="--lv:${lv}">
        ${n.children ? `<button class="tog" type="button" data-act="tog" data-key="${esc(n.key)}" aria-expanded="${open}" aria-label="${open ? 'Свернуть' : 'Развернуть'}: ${esc(n.label)}">${ICON.chev}</button>` : '<span class="tog-sp"></span>'}
        ${n.dim === 'project' ? ava(n.k, 'sm') : ''}<span class="grp-nm">${esc(n.label)}</span></div></th>
        ${cols.map(c => { const v = cellVal(c, n.a); return `<td class="num ${c.cls ? c.cls(v.v) : ''}">${v.s === '—' ? '<span class="dash-v">—</span>' : v.s}</td>`; }).join('')}</tr>`);
      if (n.children && open) walk(n.children, lv + 1);
    }
  };
  walk(tree, 0);
  const sc = state.sumSort;
  return `<article class="card hero">${head}
    <div class="tbl-wrap"><table class="tbl sum-tbl">
      <caption class="sr-only">Сводка: ${levels.map(dimLabel).join(' → ')}</caption>
      <thead><tr><th scope="col">${levels.map(dimLabel).join(' → ')}</th>${cols.map(c => `<th scope="col" class="num" aria-sort="${sc.col === c.k ? (sc.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button class="th-sort" type="button" data-act="sort" data-col="${c.k}">${c.l}</button></th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
      <tfoot><tr><th scope="row">Итого</th>${cols.map(c => { const v = cellVal(c, total); return `<td class="num ${c.cls ? c.cls(v.v) : ''}">${v.s}</td>`; }).join('')}</tr></tfoot>
    </table></div>
    <div class="hint-row"><span>«Итого» здесь и итоги периода наверху считаются одной функцией — цифры совпадают.</span>${state.mode === 'buy' ? '<span>Подписчики, ₽ за подп. и ROI — по закупам с накопленным результатом.</span>' : '<span>Без «В плане»: такие места ещё не проданы.</span>'}</div>
  </article>`;
}

// ================= ВИД: МАТРИЦА =================
const MX_METRICS = {
  buy: [
    { k: 'count', l: 'Закупов', f: v => int(v), scale: 'mono', get: a => a.count },
    { k: 'spent', l: 'Потрачено', f: rub, scale: 'mono', get: a => (a.pubCount ? a.spent : null) },
    { k: 'cps', l: '₽ за подписчика', f: rub1, scale: 'cheap', get: a => a.cps },
    { k: 'roi', l: 'ROI', f: pct, scale: 'div', get: a => a.roi },
  ],
  sell: [
    { k: 'count', l: 'Продано мест', f: v => int(v), scale: 'mono', get: a => a.count },
    { k: 'earned', l: 'Выручка', f: rub, scale: 'mono', get: a => (a.earnedCount ? a.earned : null) },
    { k: 'fill', l: 'Заполнено обязательных', f: v => `${Math.round(v * 100)}%`, scale: 'fill', get: null },
  ],
};
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;
const GREEN = [61, 220, 151], AMBER = [255, 180, 84], RED = [255, 107, 122], ACCENT = [87, 182, 255];
const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
const tri = t => (t < .5 ? mix(GREEN, AMBER, t * 2) : mix(AMBER, RED, (t - .5) * 2));

function renderMatrix(r, list) {
  const buy = state.mode === 'buy';
  const metric = MX_METRICS[state.mode].find(m => m.k === state.mx[state.mode]) || MX_METRICS[state.mode][0];
  if (state.mx.rows === 'admin' && !buy) state.mx.rows = 'project';
  const rowsDim = state.mx.rows;
  let rowKeys;
  if (rowsDim === 'project') rowKeys = sideIds();
  else if (rowsDim === 'admin') rowKeys = [...new Set(list.filter(d => d.status !== 'cancel').map(d => d.admin))].sort((a, b) => ADMINS[a].name.localeCompare(ADMINS[b].name));
  else if (rowsDim === 'week') rowKeys = [...new Set(r.days.map(d => iso(mondayOf(d))))];
  else rowKeys = r.days.map(iso);
  const inRow = (d, k) => (rowsDim === 'admin' ? d.admin === k : rowsDim === 'project' ? d.project === k : rowsDim === 'week' ? iso(mondayOf(parseIso(d.date))) === k : d.date === k);
  const rowDays = k => (rowsDim === 'project' || rowsDim === 'admin' ? r.days : rowsDim === 'week' ? r.days.filter(d => iso(mondayOf(d)) === k) : [parseIso(k)]);
  const rowChannels = k => (rowsDim === 'project' ? [k] : channelIds());
  const live = list.filter(d => d.status !== 'cancel' && (buy || d.status !== 'plan'));

  // значение клетки: null — «не закупали / не продавали», 'na' — к клетке не применимо
  const value = (ds, days, chs, slot) => {
    if (metric.k === 'fill') {
      const relevant = chs.filter(p => slot ? PJ[p].mandatory.includes(slot) : PJ[p].mandatory.length);
      if (!relevant.length) return 'na';
      let tot = 0, fil = 0;
      for (const p of relevant) for (const day of days) for (const s of (slot ? [slot] : PJ[p].mandatory)) { tot++; if (sold(p, iso(day), s)) fil++; }
      return tot ? fil / tot : 'na';
    }
    if (!ds.length) return null;
    return metric.get(agg(ds));
  };
  const grid = rowKeys.map(k => {
    const rd = live.filter(d => inRow(d, k));
    return { k, cells: SLOTS.map(s => value(rd.filter(d => d.slot === s.k), rowDays(k), rowChannels(k), s.k)), tot: value(rd, rowDays(k), rowChannels(k), null) };
  });
  const colTot = SLOTS.map(s => value(live.filter(d => d.slot === s.k), r.days, channelIds(), s.k));
  const all = value(live, r.days, channelIds(), null);

  const nums = grid.flatMap(g => g.cells).filter(v => typeof v === 'number');
  const max = Math.max(0, ...nums), min = Math.min(...nums, Infinity);
  const negMax = Math.max(0, ...nums.filter(v => v < 0).map(v => -v)), posMax = Math.max(0, ...nums.filter(v => v > 0));
  const bg = v => {
    if (typeof v !== 'number') return '';
    if (metric.scale === 'mono') return rgba(ACCENT, .05 + .4 * (max ? v / max : 0));
    if (metric.scale === 'cheap') return rgba(tri(max > min ? (v - min) / (max - min) : 0), .24);
    if (metric.scale === 'fill') return rgba(tri(1 - v), .24);
    if (v === 0) return 'rgba(255,255,255,.05)';
    return v < 0 ? rgba(RED, .08 + .32 * (negMax ? -v / negMax : 0)) : rgba(GREEN, .08 + .32 * (posMax ? v / posMax : 0));
  };
  const cell = (v, tot = false) => {
    if (v === null) return `<td><span class="v empty" title="${buy ? 'не закупали' : 'не продавали'}">·</span></td>`;
    if (v === 'na') return `<td><span class="v na" title="не обязательное место">не обяз.</span></td>`;
    const s = metric.f(v);
    return `<td class="${tot ? 'tot' : ''}"><span class="v" ${tot ? '' : `style="--bg-c:${bg(v)}"`}>${s}</span></td>`;
  };
  const rowHead = k => (rowsDim === 'admin' ? admHTML(k) : rowsDim === 'project' ? `<span class="c-prj">${ava(k, 'sm')}<span class="nm">${esc(PJ[k].name)}</span></span>` : rowsDim === 'week' ? weekLabel(k) : (() => { const x = parseIso(k); return `${DOW[x.getDay()]}, ${dm(x)}`; })());
  const legends = {
    mono: `<span class="mx-legend"><span class="bar" style="background:linear-gradient(90deg,${rgba(ACCENT, .05)},${rgba(ACCENT, .45)})"></span>интенсивность = объём; «лучше» или «хуже» здесь нет</span>`,
    cheap: `<span class="mx-legend"><span class="bar" style="background:linear-gradient(90deg,${rgba(GREEN, .5)},${rgba(AMBER, .5)},${rgba(RED, .5)})"></span>дешевле — зеленее · от ${rub1(isFinite(min) ? min : null)} до ${rub1(max || null)}</span>`,
    div: `<span class="mx-legend"><span class="bar" style="background:linear-gradient(90deg,${rgba(RED, .45)},rgba(255,255,255,.06),${rgba(GREEN, .45)})"></span>минус — красный, плюс — зелёный, вокруг нуля</span>`,
    fill: `<span class="mx-legend"><span class="bar" style="background:linear-gradient(90deg,${rgba(RED, .5)},${rgba(AMBER, .5)},${rgba(GREEN, .5)})"></span>больше продано — зеленее</span>`,
  };
  const rowsOpts = [['project', buy ? 'Проекты' : 'Каналы'], ...(buy ? [['admin', 'Админы']] : []), ['week', 'Недели'], ['day', 'Дни']];
  return `<article class="card hero">
    <div class="card-h"><span class="card-idx">01 / матрица</span>
      <div><h2 class="card-t">${rowsOpts.find(o => o[0] === rowsDim)[1]} × места · ${metric.l}</h2><div class="card-s">${rangeLabel(r)} · «·» — ${buy ? 'не закупали' : 'не продавали'}, «—» — результата ещё нет</div></div>
      <div class="right">
        <div class="seg sm" role="group" aria-label="Строки" data-seg="mxRows">${rowsOpts.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${v === rowsDim}">${l}</button>`).join('')}</div>
        <div class="seg sm" role="group" aria-label="Метрика в клетках" data-seg="mxMetric">${MX_METRICS[state.mode].map(m => `<button type="button" data-v="${m.k}" aria-pressed="${m.k === metric.k}">${m.l}</button>`).join('')}</div>
      </div></div>
    <div class="tbl-wrap"><table class="tbl mx-tbl">
      <caption class="sr-only">Матрица: ${metric.l}</caption>
      <thead><tr><th scope="col">${rowsOpts.find(o => o[0] === rowsDim)[1]}</th>${SLOTS.map(s => `<th scope="col">${s.l}</th>`).join('')}<th scope="col">Итого</th></tr></thead>
      <tbody>${grid.map(g => `<tr><th scope="row">${rowHead(g.k)}</th>${g.cells.map(v => cell(v)).join('')}${cell(g.tot, true)}</tr>`).join('')}</tbody>
      <tfoot><tr><th scope="row">Итого</th>${colTot.map(v => cell(v, true)).join('')}${cell(all, true)}</tr></tfoot>
    </table><div class="scroll-hint" aria-hidden="true"></div></div>
    <div class="hint-row">${legends[metric.scale]}<span>Итоги строк и столбцов пересчитаны по всем их сделкам, а не сложены из клеток.</span></div></article>`;
}

// ================= ОТРИСОВКА =================
function render() {
  const r = range();
  CUR = r;
  renderHeader(r);
  const view = $('#view'), kp = $('#kpis');
  if (state.demo === 'loading') {
    kp.innerHTML = Array.from({ length: 5 }, () => '<div class="skel skel-kpi"></div>').join('');
    $('#warns').innerHTML = '';
    view.innerHTML = `<div class="card" aria-busy="true"><div class="card-h"><div class="skel" style="width:220px;height:18px"></div></div><div class="skel-rows">${'<div class="skel"></div>'.repeat(7)}</div></div>`;
    return;
  }
  if (state.demo === 'error') {
    kp.innerHTML = ''; $('#warns').innerHTML = '';
    view.innerHTML = `<div class="card"><div class="empty err" role="alert"><div class="e-ic">${ICON.err}</div><h2>Не удалось загрузить сделки</h2><p>Сервер аналитики не ответил за 10 секунд. Данные в базе целы — это ошибка связи.</p><button class="btn" type="button" data-act="retry">Повторить</button></div></div>`;
    return;
  }
  const list = dealsIn(r.from, r.to);
  renderKpis(r, list);
  renderWarns(list);
  if (state.mode === 'sell' && !channelIds().length) {
    view.innerHTML = emptyHTML('У выбранных проектов нет каналов', 'Продавать рекламу можно только в канале, а VPN — бот без канала. Выберите в шапке проект с каналом.', false);
    return;
  }
  if (!list.length && state.view !== 'grid') {
    view.innerHTML = emptyHTML(state.mode === 'buy' ? 'За этот период закупов нет' : 'За этот период продаж нет', state.demo === 'empty' ? 'Так раздел выглядит, пока в нём нет ни одной сделки. Первая появится после «Новый закуп» — или откройте сетку и нажмите на нужную клетку.' : 'Смените период стрелками или добавьте сделку — она сразу появится во всех видах.');
    return;
  }
  view.innerHTML = state.view === 'list' ? renderList(list)
    : state.view === 'grid' ? renderGrid(r, list)
    : state.view === 'summary' ? renderSummary(r, list)
    : renderMatrix(r, list);
}

// ================= ВЫБОР ПРОЕКТОВ =================
function renderProjPop() {
  const ids = scopeIds();
  const all = !state.scope.length;
  $('#projList').innerHTML = `<button class="pj-it" type="button" data-pj="all" aria-pressed="${all}"><svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg><span class="nm">Все проекты</span></button><div class="pop-sep"></div>` +
    PROJECTS.map(p => {
      const off = state.mode === 'sell' && !p.channel;
      return `<button class="pj-it" type="button" data-pj="${p.id}" aria-pressed="${!all && ids.includes(p.id)}" ${off ? 'disabled' : ''}><svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>${ava(p.id)}<span class="nm">${esc(p.name)}</span><span class="ptype">${off ? 'нет канала' : p.kind}</span></button>`;
    }).join('');
}
$('#projList').addEventListener('click', e => {
  const b = e.target.closest('[data-pj]'); if (!b) return;
  if (b.dataset.pj === 'all') state.scope = [];
  else {
    const id = Number(b.dataset.pj);
    const s = new Set(state.scope.length ? state.scope : []);
    s.has(id) ? s.delete(id) : s.add(id);
    state.scope = s.size === PROJECTS.length ? [] : [...s];
  }
  state.expanded = null;
  renderProjPop(); render();
});
$('#projPop').addEventListener('toggle', e => { if (e.newState === 'open') { renderProjPop(); placeFallback($('#projPop'), $('#projSelBtn'), 'end'); } });

// Без якорного позиционирования — ставим всплывающее окно под кнопкой сами.
function placeFallback(pop, btn, align) {
  if (CSS.supports('anchor-name: --a') || !btn) return;
  const b = btn.getBoundingClientRect();
  pop.style.position = 'fixed'; pop.style.margin = '0'; pop.style.inset = 'auto';
  pop.style.top = `${Math.min(b.bottom + 8, innerHeight - pop.offsetHeight - 8)}px`;
  const left = align === 'end' ? b.right - pop.offsetWidth : b.left;
  pop.style.left = `${Math.max(8, Math.min(left, innerWidth - pop.offsetWidth - 8))}px`;
}

// ================= КАРТОЧКА СДЕЛКИ =================
let editing = null;
function openDeal(id, prefill = {}) {
  const src = id ? DEALS.find(d => d.id === id) : null;
  const buy = (src ? src.side : state.mode) === 'buy';
  const ids = buy ? scopeIds() : channelIds();
  const d = src ? structuredClone(src) : {
    side: buy ? 'buy' : 'sell', project: Number(prefill.proj) || ids[0] || 1, date: prefill.date || iso(addDays(TODAY, 1)), slot: prefill.slot || 'evening',
    format: '1/24', status: 'plan', pm: 'fix', price: null, rate: null, admin: null, buyer: '', creative: '', track: '', post: '', notes: '', warns: [], history: [], result: null, checks: null,
  };
  editing = { src, d };
  const isNew = !src;
  const one = buy ? aggBuy([d]) : aggSell([d]);
  const pub = isPub(d.status);
  const what = buy ? 'закуп' : 'продажа';
  const projOpts = (buy ? PROJECTS : PROJECTS.filter(p => p.channel)).map(p => `<option value="${p.id}" ${p.id === d.project ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const slotPick = SLOTS.map(s => `<label><input type="radio" name="slot" value="${s.k}" ${s.k === d.slot ? 'checked' : ''} required>${s.l}${!buy && PJ[d.project].mandatory.includes(s.k) ? '<span class="req">*</span>' : ''}</label>`).join('');
  const views = viewsOf(d);

  // Блок фиксации CPM
  let cpm = '';
  {
    const st = startOf(d.date, d.slot), end = new Date(+st + hoursOf(d.format) * 36e5);
    const amt = amountOf(d);
    let box;
    if (d.cpmState === 'fixed') box = `<div class="cpmbox fixed"><span class="ic">${ICON.ok}</span><div><b>Просмотры зафиксированы</b><p><span class="mono">${int(d.views)}</span> просмотров · <span class="mono">${dtLbl(d.fixedAt)}</span> · итог <span class="mono">${rub(amt)}</span> &nbsp;<a href="#" data-act="proof">Подтверждение ↗</a></p></div></div>`;
    else if (d.cpmState === 'failed') box = `<div class="cpmbox failed"><span class="ic">${ICON.bad}</span><div><b>Не удалось зафиксировать просмотры — пост снят раньше</b><p>Последнее известное значение: <span class="mono">${int(d.views)}</span> просмотров. По нему сумма ≈ <span class="mono">${rub(amt)}</span> — это оценка, её стоит сверить с ${buy ? 'продавцом' : 'покупателем'}.</p></div></div>`;
    else box = `<div class="cpmbox wait"><span class="ic">${ICON.clock}</span><div><b>Ждёт снятия поста</b><p>Просмотры зафиксируются перед снятием — <span class="mono">${dm(end)} в ${hmOf(end)}</span>${d.viewsNow ? `. Сейчас <span class="mono">${int(d.viewsNow)}</span> просмотров, замер 5 мин назад` : ''}. Пост перешлётся в канал подтверждений вместе с цифрами.</p></div></div>`;
    cpm = `<div class="m-sec" id="cpmSec" ${d.pm === 'cpm' ? '' : 'hidden'}><div class="m-sec-h"><span class="card-idx">02 / фиксация CPM</span><h3>Просмотры для расчёта</h3></div>${box}</div>`;
  }

  // Результат
  const stat = (l, v) => `<div class="mstat"><b class="${v === '—' ? 'dash-v' : ''}">${v}</b><span>${l}</span></div>`;
  const amtNow = amountOf(d);
  const result = buy
    ? `<div class="mstats">${stat('Потрачено', pub && amtNow != null ? rub(amtNow) : '—')}${stat('Охват', pub && views != null ? int(views) : '—')}${stat('CPM', rub1(one.cpm))}${stat('Подписчиков', one.resCount ? int(one.subs) : '—')}${stat('₽ за подписчика', rub1(one.cps))}${stat('Удержание', one.retention != null ? `${Math.round(one.retention * 100)}%` : '—')}${stat('Покупок', one.resCount ? int(one.buyers) : '—')}${stat('₽ за покупателя', rub1(one.cpb))}${stat('Выручка', one.resCount ? rub(one.revenue) : '—')}${stat('ROI', pct(one.roi))}</div>`
    : `<div class="mstats" style="grid-template-columns:repeat(3,minmax(0,1fr))">${stat('Сумма', pub && amtNow != null ? rub(amtNow) : '—')}${stat('Просмотры', pub && views != null ? int(views) : '—')}${stat('Фактический CPM', rub1(one.factCpm))}</div>`;
  const resNote = !pub ? 'Пост ещё не вышел — вместо цифр прочерки, а не нули.' : buy && !one.resCount ? 'Пост вышел, результат ещё копится: подписчики и покупки появятся в течение суток.' : buy ? 'Подписчики и покупки — люди, пришедшие по ссылке для отслеживания этого закупа.' : '';

  // Проверки — только когда пост вышел
  let checks = '';
  if (pub && d.checks) {
    const c = d.checks, li = (cls, ic, l, v) => `<li class="${cls}"><span class="ci">${ic}</span><span class="cl">${l}</span><span class="cv">${v}</span></li>`;
    checks = `<div class="m-sec"><div class="m-sec-h"><span class="card-idx">${buy ? '04' : '03'} / проверки</span><h3>Автоматические проверки</h3></div><ul class="checks">
      ${li('ok', ICON.ok, 'Охват', `<span class="mono">${int(c.reach.views)}</span> просмотров, замер ${c.reach.ago}`)}
      ${c.time.late ? li('mid', ICON.warn, 'Время выхода', `вышел в <b class="mono">${c.time.fact}</b> вместо ${c.time.plan}`) : li('ok', ICON.ok, 'Время выхода', `вышел в <span class="mono">${c.time.fact}</span> — вовремя`)}
      ${c.top.wait ? li('wait', ICON.clock, 'Час в топе', 'идёт первый час') : c.top.ok ? li('ok', ICON.ok, 'Час в топе', 'продержался час') : li('bad', ICON.bad, 'Час в топе', `следующий пост через ${60 - c.top.short}${NB}мин — <b>не хватило ${c.top.short}${NB}мин</b>`)}
      ${c.life.wait ? li('wait', ICON.clock, 'Срок в ленте', `идёт: ${dur(c.life.elapsed)} из ${c.life.hours}${NB}ч`) : c.life.ok ? li('ok', ICON.ok, 'Срок в ленте', `${c.life.hours}${NB}ч выдержаны`) : li('bad', ICON.bad, 'Срок в ленте', `удалён через ${dur(c.life.lived)} — <b>не хватило ${dur(c.life.short)}</b>`)}
    </ul></div>`;
  }
  const hist = d.history?.length ? `<div class="m-sec"><div class="m-sec-h"><span class="card-idx">история</span><h3>История статусов</h3></div><ol class="tl">${d.history.map(h => `<li style="--c:${ST[h.st].c}"><span>${ST[h.st].l}</span><time datetime="${h.at.toISOString()}">${dmy(h.at)}, ${hmOf(h.at)}</time></li>`).join('')}</ol></div>` : '';

  $('#dealForm').innerHTML = `
    <div class="m-head"><div>
      <div class="m-eyebrow">${isNew ? `новый ${buy ? 'закуп' : 'продажа'}`.replace('новый продажа', 'новая продажа') : `${what} · ${d.id} · ${dmy(parseIso(d.date))}`}</div>
      <h2 id="dealTitle">${isNew ? (buy ? 'Новый закуп' : 'Новая продажа') : esc(buy ? admLabel(d.admin) : d.buyer)}</h2>
      ${isNew ? '' : `<div class="m-chips">${stChip(d.status)}<span class="chip slot">${SLOT[d.slot].l}</span><span class="chip fmt">${d.format}</span><span class="chip neutral">${ava(d.project, 'sm')}${esc(PJ[d.project].name)}</span>${warnIcons(d)}</div>`}
    </div><button class="x-btn" type="button" data-close aria-label="Закрыть">${ICON.x}</button></div>
    <div class="m-body">
      ${d.warns.length ? `<div class="m-sec"><div class="wbox"><ul class="wlist" style="border:0">${d.warns.map(w => `<li><div class="witem"><span class="wtag ${w.sev}">${w.sev === 'high' ? 'высокая' : 'средняя'}</span><span class="wtext">${warnText(d, w)}</span></div></li>`).join('')}</ul></div></div>` : ''}
      <div class="m-sec"><div class="m-sec-h"><span class="card-idx">01 / сделка</span><h3>${buy ? 'Поля закупа' : 'Поля продажи'}</h3></div>
      <div class="fgrid">
        <div class="fld"><label for="fProj">${buy ? 'Проект — куда ведём' : 'Мой канал'}</label><select class="inp" id="fProj" name="project" required>${projOpts}</select></div>
        ${buy
          ? `<div class="fld adm-fld"><label for="fWho" id="fWhoLbl">У кого купил — админ</label>
              <div class="cbx">
                <input class="inp" id="fWho" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="admList" aria-describedby="admHint" autocomplete="off" spellcheck="false" placeholder="Имя или @username" value="${esc(d.admin ? admLabel(d.admin) : '')}">
                <input type="hidden" name="admin" value="${d.admin || ''}">
                <ul class="cbx-list" id="admList" role="listbox" aria-labelledby="fWhoLbl" hidden></ul>
              </div>
              <div class="adm-sub" id="admNew" hidden>
                <div class="frow"><div><label class="sr-only" for="fNewName">Имя нового админа</label><input class="inp" id="fNewName" placeholder="Имя"></div>
                <div><label class="sr-only" for="fNewUser">Username нового админа</label><input class="inp mono" id="fNewUser" placeholder="username" pattern="@?[A-Za-z0-9_]{4,32}" autocapitalize="off" spellcheck="false"></div></div>
              </div>
              <div class="adm-sub" id="admRename" hidden>
                <div class="frow"><div><label class="sr-only" for="fRenUser">Новый username</label><input class="inp mono" id="fRenUser" placeholder="новый username" pattern="@?[A-Za-z0-9_]{4,32}" autocapitalize="off" spellcheck="false"></div>
                <div class="frow" style="flex:none"><button class="btn tiny" type="button" data-act="ren-ok">Сменить</button><button class="btn tiny" type="button" data-act="ren-cancel">Отмена</button></div></div>
                <div class="hint">Поменяется сразу во всех закупах и кампаниях — они ссылаются на админа, а не на текст. Старый username останется в подсказках как прошлый. В рабочей версии смену заметит сессия аккаунта и обновит сама.</div>
              </div>
              <div class="hint" id="admHint"></div>
              <span class="sr-only" aria-live="polite" id="admLive"></span></div>`
          : `<div class="fld"><label for="fWho">Покупатель — контакт</label><input class="inp" id="fWho" name="who" required value="${esc(d.buyer)}" placeholder="@username" pattern="@[A-Za-z0-9_]{4,32}"><div class="hint">Telegram-контакт в виде @username</div></div>`}
        <div class="fld"><label for="fDate">Дата выхода — план</label><input class="inp mono" type="date" id="fDate" name="date" required value="${d.date}"></div>
        <div class="fld"><label for="fFact">Дата выхода — факт</label><input class="inp mono" id="fFact" readonly value="${pub && d.checks ? `${dm(parseIso(d.date))}, ${d.checks.time.fact}` : pub ? `${dm(parseIso(d.date))}, ${SLOT[d.slot].t}` : ''}" placeholder="заполнится, когда пост выйдет"><div class="hint">Проставляет бот постинга, вручную не меняется</div></div>
        <div class="fld wide"><span class="flbl" id="slotLbl">Место</span><div class="slot-pick" role="radiogroup" aria-labelledby="slotLbl">${slotPick}</div>${buy ? '' : '<div class="hint">* — обязательное место этого канала</div>'}</div>
        <div class="fld"><span class="flbl" id="fmtLbl">Формат</span><div class="slot-pick" role="radiogroup" aria-labelledby="fmtLbl">${['1/24', '1/48'].map(f => `<label><input type="radio" name="format" value="${f}" ${f === d.format ? 'checked' : ''}>${f}</label>`).join('')}</div><div class="hint">1/24 — час в топе, сутки в ленте; 1/48 — двое суток</div></div>
        <div class="fld"><label for="fSt">Статус</label><select class="inp" id="fSt" name="status">${ST_ORDER.map(s => `<option value="${s}" ${s === d.status ? 'selected' : ''}>${ST[s].l}</option>`).join('')}</select></div>
        <div class="fld wide"><span class="flbl" id="pmLbl">Цена</span>
          <div class="frow" style="align-items:flex-start">
            <div class="slot-pick" role="radiogroup" aria-labelledby="pmLbl" style="flex:none">${[['fix', 'Фикс'], ['cpm', 'CPM']].map(([v, l]) => `<label><input type="radio" name="pm" value="${v}" ${v === d.pm ? 'checked' : ''}>${l}</label>`).join('')}</div>
            <div id="pmFix" ${d.pm === 'fix' ? '' : 'hidden'}><label class="sr-only" for="fPrice">Сумма, ₽</label><input class="inp mono" type="number" id="fPrice" name="price" min="1" step="1" inputmode="numeric" placeholder="Сумма, ₽" value="${d.price ?? ''}" ${d.pm === 'fix' ? 'required' : ''}></div>
            <div id="pmCpm" ${d.pm === 'cpm' ? '' : 'hidden'}><label class="sr-only" for="fRate">Ставка за 1000 просмотров, ₽</label><input class="inp mono" type="number" id="fRate" name="rate" min="1" step="1" inputmode="numeric" placeholder="Ставка за 1000, ₽" value="${d.rate ?? ''}" ${d.pm === 'cpm' ? 'required' : ''}><div class="calc" id="cpmCalc"></div></div>
          </div></div>
        ${buy ? `<div class="fld"><label for="fCr">Креатив</label><input class="inp" id="fCr" name="creative" value="${esc(d.creative)}" placeholder="Какой пост ушёл"></div>
        <div class="fld"><label for="fTr">Ссылка для отслеживания</label><input class="inp mono" id="fTr" name="track" value="${esc(d.track)}" placeholder="t.me/+… или t.me/бот?start=…"></div>` : ''}
        <div class="fld ${buy ? '' : 'wide'}"><label for="fPost">Ссылка на ${buy ? 'рекламный ' : ''}пост</label><input class="inp mono" id="fPost" name="post" value="${esc(d.post)}" placeholder="появится, когда пост выйдет"></div>
        ${buy ? `<div class="fld"><label for="fReach">Охват</label><input class="inp mono" id="fReach" readonly value="${pub && views != null ? `${int(views)} просмотров` : ''}" placeholder="замеряется автоматически"></div>` : ''}
        <div class="fld wide"><label for="fNotes">Заметки</label><textarea class="inp" id="fNotes" name="notes" placeholder="Договорённости, контакты, что учесть">${esc(d.notes)}</textarea></div>
      </div></div>
      ${cpm}
      <div class="m-sec"><div class="m-sec-h"><span class="card-idx">${buy ? '03' : '02'} / результат</span><h3>Показатели</h3></div>${result}${resNote ? `<p class="mnote">${resNote}</p>` : ''}</div>
      ${checks}${hist}
    </div>
    <div class="m-foot">${isNew ? '' : `<button class="btn btn-ghost-danger" type="button" data-act="del">Удалить</button>`}<span class="sp"></span><button class="btn" type="button" data-close>Отмена</button><button class="btn btn-primary" type="submit">${isNew ? 'Добавить' : 'Сохранить'}</button></div>`;
  updateCalc();
  $('#dealDlg').showModal();
  if (buy) admHint();
}

function updateCalc() {
  const f = $('#dealForm'); if (!f || !editing) return;
  const pm = f.elements.pm.value;
  $('#pmFix').hidden = pm !== 'fix'; $('#pmCpm').hidden = pm !== 'cpm';
  $('#fPrice').required = pm === 'fix'; $('#fRate').required = pm === 'cpm';
  const sec = $('#cpmSec'); if (sec) sec.hidden = pm !== 'cpm';
  const rate = Number($('#fRate').value);
  const v = viewsOf(editing.d);
  const known = editing.d.cpmState === 'fixed' || editing.d.cpmState === 'failed' ? editing.d.views : editing.d.viewsNow;
  $('#cpmCalc').innerHTML = !rate ? '' : known
    ? `≈ <b>${rub(Math.round(rate * known / 1000))}</b> при ${int(known)} просмотров`
    : `сумма станет известна после фиксации${v ? '' : ' просмотров'}`;
}
$('#dealForm').addEventListener('input', e => { if (e.target.name === 'pm' || e.target.name === 'rate') updateCalc(); });
$('#dealForm').addEventListener('change', e => { if (e.target.name === 'pm') updateCalc(); });

// ================= АВТОПОДБОР АДМИНА =================
// Ищет по имени, по текущему и прошлым username; слово, набранное не в той
// раскладке («rjn» вместо «кот»), тоже находит. Это ARIA-комбобокс: стрелки
// двигают выбор, Enter выбирает, Escape закрывает список, не закрывая карточку.
const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU = 'йцукенгшщзхъфывапролджэячсмитьбюё';
const swapLayout = s => [...s].map(c => { let i = EN.indexOf(c); if (i >= 0) return RU[i]; i = RU.indexOf(c); return i >= 0 ? EN[i] : c; }).join('');
const hl = (text, i, len) => `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + len))}</mark>${esc(text.slice(i + len))}`;
const hueOf = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

function admStats(id) {
  const ds = DEALS.filter(d => d.side === 'buy' && d.admin === id && d.status !== 'cancel');
  const today = iso(TODAY);
  const past = ds.filter(d => d.date <= today);
  return { n: past.length, planned: ds.length - past.length, last: past.reduce((m, d) => (d.date > m ? d.date : m), ''), projects: [...new Set(ds.map(d => d.project))].sort() };
}
function admSearch(raw) {
  const q0 = raw.trim().toLowerCase().replace(/^@/, '');
  const ids = Object.keys(ADMINS);
  const withStats = id => ({ id, st: admStats(id) });
  if (!q0) return ids.map(withStats).sort((a, b) => b.st.last.localeCompare(a.st.last)).slice(0, 8);
  const qs = [...new Set([q0, swapLayout(q0)])];
  const out = [];
  for (const id of ids) {
    const a = ADMINS[id], name = a.name.toLowerCase(), user = a.user.toLowerCase();
    let best = null;
    const hit = (score, field, text, i, len) => { if (i >= 0 && (!best || score > best.score)) best = { score, field, i, len }; };
    for (const q of qs) {
      if (user === q) hit(100, 'user', user, 0, q.length);
      if (user.startsWith(q)) hit(80, 'user', user, 0, q.length);
      if (name.startsWith(q)) hit(75, 'name', name, 0, q.length);
      const ws = (' ' + name).indexOf(' ' + q); if (ws > 0) hit(65, 'name', name, ws, q.length);
      hit(50, 'user', user, user.indexOf(q), q.length);
      hit(45, 'name', name, name.indexOf(q), q.length);
      for (const o of a.old || []) { const ol = o.toLowerCase(); hit(ol === q ? 42 : 32, `old:${o}`, ol, ol.indexOf(q), q.length); }
    }
    if (best) out.push({ ...withStats(id), ...best });
  }
  return out.sort((x, y) => y.score - x.score || y.st.last.localeCompare(x.st.last)).slice(0, 8);
}

const cbx = { items: [], active: -1, liveTimer: 0 };
function admOpen(show) {
  const inp = $('#fWho'), list = $('#admList');
  if (!inp) return;
  list.hidden = !show;
  inp.setAttribute('aria-expanded', String(show));
  if (!show) inp.removeAttribute('aria-activedescendant');
}
function admRender() {
  const inp = $('#fWho'), list = $('#admList');
  const q = inp.value.trim();
  const found = admSearch(q);
  const exact = found.some(r => r.score === 100 || admLabel(r.id).toLowerCase() === q.toLowerCase());
  cbx.items = found.map(r => ({ kind: 'adm', ...r }));
  if (q && !exact) cbx.items.push({ kind: 'new', q });
  cbx.active = cbx.items.length ? 0 : -1;
  list.innerHTML = cbx.items.map((it, k) => {
    if (it.kind === 'new') return `<li role="option" id="admopt-${k}" class="cbx-opt new" data-k="${k}" aria-selected="false"><span class="cbx-plus" aria-hidden="true">＋</span><span class="cbx-main">Новый админ <b>«${esc(it.q)}»</b></span></li>`;
    const a = ADMINS[it.id];
    const nm = it.field === 'name' ? hl(a.name, it.i, it.len) : esc(a.name);
    const us = it.field === 'user' ? hl(a.user, it.i, it.len) : esc(a.user);
    const oldMatch = it.field?.startsWith('old:') ? it.field.slice(4) : null;
    const old = oldMatch ? `<span class="cbx-old">раньше @${hl(oldMatch, it.i, it.len)}</span>` : a.old?.length ? `<span class="cbx-old dim">раньше @${esc(a.old[0])}</span>` : '';
    const st = it.st;
    return `<li role="option" id="admopt-${k}" class="cbx-opt" data-k="${k}" aria-selected="false">
      <span class="cbx-ini" style="--h:${hueOf(a.user)}" aria-hidden="true">${esc(a.name.slice(0, 1).toUpperCase())}</span>
      <span class="cbx-main"><span class="cbx-nm">${nm}</span> <span class="cbx-u">@${us}</span>${old}</span>
      <span class="cbx-pj" aria-hidden="true">${st.projects.map(p => ava(p, 'sm')).join('')}</span>
      <span class="cbx-meta">${st.n ? `${st.n} ${plural(st.n, 'закуп', 'закупа', 'закупов')} · последний ${dm(parseIso(st.last))}` : 'закупов ещё не было'}${st.planned ? ` · ещё ${st.planned} впереди` : ''}</span></li>`;
  }).join('') || '<li class="cbx-empty" role="presentation">Пока ни одного админа</li>';
  admActivate(cbx.active);
  clearTimeout(cbx.liveTimer); // число вариантов — без спама на каждую букву
  cbx.liveTimer = setTimeout(() => { const n = cbx.items.filter(x => x.kind === 'adm').length; $('#admLive') && ($('#admLive').textContent = n ? `${n} ${plural(n, 'вариант', 'варианта', 'вариантов')}` : 'Совпадений нет — можно добавить нового'); }, 600);
}
function admActivate(k) {
  cbx.active = k;
  document.querySelectorAll('#admList .cbx-opt').forEach((li, i) => { const on = i === k; li.classList.toggle('act', on); li.setAttribute('aria-selected', String(on)); });
  const li = document.getElementById(`admopt-${k}`);
  if (li) { $('#fWho').setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); }
}
function admPick(k) {
  const it = cbx.items[k]; if (!it) return;
  const f = $('#dealForm');
  $('#admRename').hidden = true;
  if (it.kind === 'adm') {
    f.elements.admin.value = it.id;
    $('#fWho').value = admLabel(it.id);
    $('#admNew').hidden = true; newRequired(false);
  } else {
    f.elements.admin.value = '';
    const looksUser = /^@?[A-Za-z0-9_]+$/.test(it.q);
    $('#admNew').hidden = false; newRequired(true);
    $('#fNewName').value = looksUser ? '' : it.q;
    $('#fNewUser').value = looksUser ? it.q.replace(/^@/, '') : '';
    (looksUser ? $('#fNewName') : $('#fNewUser')).focus();
  }
  $('#fWho').setCustomValidity('');
  admOpen(false);
  admHint();
}
function newRequired(on) { $('#fNewName').required = on; $('#fNewUser').required = on; }
function admHint() {
  const id = $('#dealForm').elements.admin?.value;
  const h = $('#admHint'); if (!h) return;
  h.innerHTML = id && ADMINS[id]
    ? `<button class="adm-link" type="button" data-act="adv" data-adm="${id}">Все кампании ${esc(ADMINS[id].name)} ↗</button> · <button class="adm-link" type="button" data-act="ren">Сменил username</button>${ADMINS[id].old?.length ? ` · <span>раньше: ${ADMINS[id].old.map(o => `@${esc(o)}`).join(', ')}</span>` : ''}`
    : !$('#admNew').hidden ? 'Новый админ сразу появится в подсказках и во вкладке «Кампании»' : 'Начните вводить имя или @username — подскажу из знакомых';
}
// новый админ: такой username уже у кого-то есть — это он и есть
function adminFromForm(f) {
  if (f.elements.admin.value) return f.elements.admin.value;
  const name = $('#fNewName').value.trim(), user = $('#fNewUser').value.trim().replace(/^@/, '');
  const ex = Object.keys(ADMINS).find(id => ADMINS[id].user.toLowerCase() === user.toLowerCase());
  if (ex) return ex;
  const id = user.toLowerCase();
  ADMINS[id] = { name, user, old: [] };
  return id;
}
function admValidate(f) {
  const fw = $('#fWho'), nu = $('#fNewUser');
  if (!fw) return;
  fw.setCustomValidity(f.elements.admin.value || !$('#admNew').hidden ? '' : 'Выберите админа из подсказок или добавьте нового');
  nu.setCustomValidity('');
  if (!$('#admNew').hidden && nu.value) {
    const u = nu.value.trim().replace(/^@/, '').toLowerCase();
    const was = Object.keys(ADMINS).find(id => (ADMINS[id].old || []).some(o => o.toLowerCase() === u));
    if (was) nu.setCustomValidity(`Так раньше звали ${admLabel(was)}. Если это он — выберите его в подсказках; если username занял другой человек — поправьте вручную в его карточке`);
  }
}

$('#dealForm').addEventListener('focusin', e => { if (e.target.id === 'fWho') { admRender(); admOpen(true); } });
$('#dealForm').addEventListener('focusout', e => { if (e.target.id === 'fWho') setTimeout(() => { if (document.activeElement?.id !== 'fWho') admOpen(false); }, 0); });
$('#dealForm').addEventListener('input', e => {
  if (e.target.id !== 'fWho') return;
  const f = $('#dealForm');
  if (f.elements.admin.value && e.target.value !== admLabel(f.elements.admin.value)) f.elements.admin.value = '';
  $('#admNew').hidden = true; newRequired(false); $('#admRename').hidden = true;
  e.target.setCustomValidity('');
  admRender(); admOpen(true); admHint();
});
$('#dealForm').addEventListener('keydown', e => {
  if (e.target.id === 'fRenUser' && e.key === 'Enter') { e.preventDefault(); $('[data-act="ren-ok"]').click(); return; }
  if (e.target.id !== 'fWho') return;
  const open = !$('#admList').hidden, n = cbx.items.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open) { admRender(); admOpen(true); return; }
    if (n) admActivate((cbx.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
  } else if (e.key === 'Enter' && open && cbx.active >= 0) { e.preventDefault(); admPick(cbx.active); }
  else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); admOpen(false); }
  else if (e.key === 'Tab') admOpen(false);
});
// mousedown не уводит фокус из поля — иначе список закрылся бы до клика
$('#dealForm').addEventListener('mousedown', e => { if (e.target.closest('#admList')) e.preventDefault(); });
$('#dealForm').addEventListener('click', e => {
  const li = e.target.closest('#admList .cbx-opt');
  if (li) admPick(Number(li.dataset.k));
  else if (e.target.id === 'fWho' && $('#admList').hidden) { admRender(); admOpen(true); }
});

$('#dealForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.currentTarget;
  if (f.elements.admin) admValidate(f);
  if (!f.checkValidity()) { f.reportValidity(); return; }
  const { src, d } = editing;
  const buy = d.side === 'buy';
  const el = f.elements;
  const prevStatus = d.status;
  Object.assign(d, {
    project: Number(el.project.value), date: el.date.value, slot: el.slot.value, format: el.format.value, status: el.status.value,
    pm: el.pm.value, notes: el.notes.value.trim(), post: el.post.value.trim(),
  });
  if (d.pm === 'fix') { d.price = Number(el.price.value); delete d.rate; } else { d.rate = Number(el.rate.value); delete d.price; if (!d.cpmState) d.cpmState = 'wait'; }
  if (buy) { d.admin = adminFromForm(f); d.creative = el.creative.value.trim(); d.track = el.track.value.trim(); } else d.buyer = el.who.value.trim();
  if (d.status !== prevStatus || !src) d.history = [...(d.history || []), { st: d.status, at: new Date(NOW) }];
  if (src) Object.assign(src, d);
  else {
    // следующий после наибольшего: после удаления номера не повторяются
    const last = Math.max(buy ? 1000 : 2000, ...DEALS.filter(x => x.side === d.side).map(x => Number(x.id.slice(2))));
    d.id = `${buy ? 'З' : 'П'}-${last + 1}`;
    DEALS.push(d);
    DEALS.sort((a, b) => a.date.localeCompare(b.date) || SLOT[a.slot].i - SLOT[b.slot].i || a.project - b.project);
  }
  $('#dealDlg').close();
  render();
  toast(src ? `${buy ? 'Закуп' : 'Продажа'} ${d.id} сохранён${buy ? '' : 'а'} — цифры во всех видах пересчитаны` : `${buy ? 'Закуп' : 'Продажа'} ${d.id} добавлен${buy ? '' : 'а'}`);
});

function openDay(date, slot) {
  const day = parseIso(date);
  const ids = state.mode === 'buy' ? scopeIds() : [state.sellCh];
  const ds = DEALS.filter(d => d.side === state.mode && d.date === date && ids.includes(d.project) && (!slot || d.slot === slot) && state.demo !== 'empty')
    .sort((a, b) => SLOT[a.slot].i - SLOT[b.slot].i);
  const buy = state.mode === 'buy';
  $('#dayDlg').innerHTML = `<div class="m-head"><div><div class="m-eyebrow">${buy ? 'закупы' : 'продажи'} дня</div><h2 id="dayTitle">${DOW_FULL[day.getDay()].replace(/^./, c => c.toUpperCase())}, ${day.getDate()} ${MON_GEN[day.getMonth()]}${slot ? ` · ${SLOT[slot].l}` : ''}</h2></div>
    <button class="x-btn" type="button" data-close aria-label="Закрыть">${ICON.x}</button></div>
    ${ds.length ? `<ul class="daylist">${ds.map(d => `<li><button class="dl-it" type="button" data-act="open" data-id="${d.id}"><span class="when"><span class="chip slot">${SLOT[d.slot].l}</span></span><span class="who">${ava(d.project, 'sm')}<span>${buy ? admHTML(d.admin) : esc(`${d.buyer} · ${PJ[d.project].mono}`)}</span>${warnIcons(d)}</span><span class="rt">${priceHTML(d)}${stChip(d.status)}</span></button></li>`).join('')}</ul>` : `<p class="dl-empty">${buy ? 'В этот день закупов нет.' : 'В этот день продаж нет.'}</p>`}
    <div class="m-foot"><span class="sp"></span><button class="btn btn-primary" type="button" data-act="new" data-date="${date}" ${slot ? `data-slot="${slot}"` : ''} ${buy ? '' : `data-proj="${state.sellCh}"`}>${ICON.plus}Добавить на этот день</button></div>`;
  $('#dayDlg').showModal();
}

// ================= СОБЫТИЯ =================
document.addEventListener('click', async e => {
  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) { closeBtn.closest('dialog')?.close(); return; }
  const nav = e.target.closest('[data-nav]');
  if (nav) { $('#moreDlg').close(); toast(`В макете открыт только раздел «Реклама» — «${nav.dataset.nav}» живёт в дашборде как есть`, 'info'); return; }
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  if (act === 'open') {
    if (t.tagName === 'TR' && e.target.closest('button')) return; // клик по кнопке внутри строки обработан ею
    e.preventDefault();
    $('#dayDlg').close();
    openDeal(t.dataset.id);
  } else if (act === 'new') {
    $('#dayDlg').close();
    openDeal(null, { date: t.dataset.date, slot: t.dataset.slot, proj: t.dataset.proj });
  } else if (act === 'day') openDay(t.dataset.date);
  else if (act === 'cell') openDay(t.dataset.date, t.dataset.slot);
  else if (act === 'chan') { state.sellCh = Number(t.dataset.id); render(); }
  else if (act === 'only-proj') { state.scope = [Number(t.dataset.id)]; state.expanded = null; render(); toast(`Показан только ${PJ[t.dataset.id].name} — «Все проекты» в шапке вернёт остальные`, 'info'); }
  else if (act === 'warns') { state.warnsOpen = !state.warnsOpen; render(); }
  else if (act === 'tog') { const k = t.dataset.key; state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k); render(); restoreFocus(`[data-act="tog"][data-key="${CSS.escape(k)}"]`); }
  else if (act === 'sort') { const c = t.dataset.col; state.sumSort = state.sumSort.col === c ? (state.sumSort.dir === -1 ? { col: c, dir: 1 } : { col: null, dir: -1 }) : { col: c, dir: -1 }; render(); restoreFocus(`[data-act="sort"][data-col="${c}"]`); }
  else if (act.startsWith('lvl-')) {
    const lv = state.levels[state.mode], i = Number(t.dataset.i);
    if (act === 'lvl-left' && i > 0) [lv[i - 1], lv[i]] = [lv[i], lv[i - 1]];
    if (act === 'lvl-right' && i < lv.length - 1) [lv[i + 1], lv[i]] = [lv[i], lv[i + 1]];
    if (act === 'lvl-del' && lv.length > 1) lv.splice(i, 1);
    if (act === 'lvl-add' && lv.length < 3) lv.push(t.dataset.dim);
    state.expanded = null; render();
  } else if (act === 'del') {
    const { src } = editing;
    $('#confirmText').textContent = `${src.side === 'buy' ? 'Закуп' : 'Продажа'} ${src.id} от ${dm(parseIso(src.date))} исчезнет из всех видов и итогов. Отменить это будет нельзя — если сделка просто сорвалась, лучше поставить статус «Отменён».`;
    const dlg = $('#confirmDlg');
    dlg.returnValue = '';
    dlg.showModal();
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') return;
      DEALS = DEALS.filter(x => x !== src);
      $('#dealDlg').close(); render(); toast(`${src.id} удалён${src.side === 'buy' ? '' : 'а'}`);
    }, { once: true });
  } else if (act === 'adv') {
    e.preventDefault();
    toast(`Откроется вкладка «Кампании» → «Рекламодатели» с фильтром по ${admLabel(t.dataset.adm)}: все его кампании, ссылки, подписчики и выручка`, 'info');
  } else if (act === 'ren') {
    $('#admRename').hidden = false; $('#fRenUser').value = ''; $('#fRenUser').focus();
  } else if (act === 'ren-cancel') {
    $('#admRename').hidden = true; $('#fRenUser').setCustomValidity('');
  } else if (act === 'ren-ok') {
    const id = $('#dealForm').elements.admin.value, inp = $('#fRenUser');
    const u = inp.value.trim().replace(/^@/, '');
    const taken = Object.keys(ADMINS).find(x => x !== id && ADMINS[x].user.toLowerCase() === u.toLowerCase());
    inp.setCustomValidity(!/^[A-Za-z0-9_]{4,32}$/.test(u) ? 'Username: 4–32 латинские буквы, цифры или _' : taken ? `@${u} уже у ${admLabel(taken)}` : u.toLowerCase() === ADMINS[id].user.toLowerCase() ? 'Это и есть текущий username' : '');
    if (!inp.reportValidity()) return;
    const a = ADMINS[id], was = a.user;
    a.old = [was, ...(a.old || []).filter(o => o.toLowerCase() !== u.toLowerCase())];
    a.user = u;
    $('#fWho').value = admLabel(id);
    $('#admRename').hidden = true; admHint();
    render();
    toast(`${a.name} теперь @${u} — обновлено во всех закупах сразу; по @${was} он по-прежнему находится`);
  } else if (act === 'proof') { e.preventDefault(); toast('Откроется сообщение в канале подтверждений: пересланный пост и замер просмотров', 'info'); }
  else if (act === 'retry') { setDemo('loading'); setTimeout(() => setDemo('data'), 900); }
});
function restoreFocus(sel) { document.querySelector(sel)?.focus(); }

// summary на телефоне: раскрытие <details> запоминается
document.addEventListener('toggle', e => {
  const d = e.target; if (!(d instanceof HTMLDetailsElement) || !d.dataset.key || !state.expanded) return;
  d.open ? state.expanded.add(d.dataset.key) : state.expanded.delete(d.dataset.key);
}, true);

function bindSeg(sel, fn) {
  document.querySelector(sel).addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b && !b.disabled) fn(b.dataset.v); });
}
bindSeg('#modeSeg', v => { state.mode = v; state.expanded = null; state.sumSort = { col: null, dir: -1 }; render(); });
bindSeg('#periodSeg', v => { state.period = v; state.expanded = null; render(); });
bindSeg('#viewSeg', v => { state.view = v; render(); });
bindSeg('#demoSeg', v => setDemo(v));
bindSeg('#devSeg', v => {
  $('#stage').dataset.device = v;
  document.querySelectorAll('#devSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
});
$('#view').addEventListener('click', e => {
  const b = e.target.closest('[data-seg] button[data-v]'); if (!b) return;
  const seg = b.closest('[data-seg]').dataset.seg;
  if (seg === 'mxRows') state.mx.rows = b.dataset.v;
  if (seg === 'mxMetric') state.mx[state.mode] = b.dataset.v;
  if (seg === 'gridGroup') state.gridGroup = b.dataset.v;
  render();
});
$('#view').addEventListener('toggle', e => { if (e.target.id === 'addPop' && e.newState === 'open') placeFallback(e.target, document.querySelector('.add-btn'), 'start'); }, true);
function setDemo(v) {
  state.demo = v;
  document.querySelectorAll('#demoSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  render();
}
function shift(dir) {
  if (state.period === 'week') state.anchor = addDays(state.anchor, 7 * dir);
  else if (state.period === 'month') state.anchor = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + dir, 1);
  else { const n = dayDiff(state.cTo, state.cFrom) + 1; state.cFrom = addDays(state.cFrom, n * dir); state.cTo = addDays(state.cTo, n * dir); }
  state.expanded = null; render();
}
$('#prevBtn').addEventListener('click', () => shift(-1));
$('#nextBtn').addEventListener('click', () => shift(1));
$('#cFrom').addEventListener('change', e => { if (e.target.value) { state.cFrom = parseIso(e.target.value); render(); } });
$('#cTo').addEventListener('change', e => { if (e.target.value) { state.cTo = parseIso(e.target.value); render(); } });
$('#newBtn').addEventListener('click', () => openDeal(null));
$('#moreBtn').addEventListener('click', () => $('#moreDlg').showModal());
$('#refreshBtn').addEventListener('click', e => {
  const b = e.currentTarget; b.classList.remove('spin'); void b.offsetWidth; b.classList.add('spin');
  toast('Данные обновлены', 'info');
});

// Закрытие диалога кликом мимо: closedby="any", а где его нет (Safari) — вручную.
if (!('closedBy' in HTMLDialogElement.prototype)) {
  document.querySelectorAll('dialog[closedby="any"]').forEach(dlg => dlg.addEventListener('click', e => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (r.top <= e.clientY && e.clientY <= r.bottom && r.left <= e.clientX && e.clientX <= r.right) return;
    dlg.close();
  }));
}

function toast(text, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="t-ic">${kind === 'ok' ? ICON.ok : ICON.clock}</span><span>${esc(text)}</span>`;
  $('#toasts').append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 400); }, 3200);
}

// Узкий режим: раскладку меняют контейнерные запросы, но сводке на телефоне
// нужна другая разметка, а диалогам (они вне контейнера) — признак на <html>.
new ResizeObserver(([entry]) => {
  const narrow = entry.contentRect.width < 760;
  document.documentElement.toggleAttribute('data-narrow', narrow);
  if (narrow !== state.narrow) { state.narrow = narrow; render(); }
}).observe($('#frame'));

render();
})();
