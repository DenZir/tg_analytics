'use strict';
/*
 * Раздел «Реклама»: закупы в чужих каналах и продажи мест в своих.
 *
 * Главное правило: любая цифра на странице получается из одного набора сделок
 * через aggBuy / aggSell. Итоги периода, строка «Итого» списка и сводки, клетки
 * матрицы, показатели в карточке сделки — всё это одни и те же функции над
 * разными подмножествами, поэтому разойтись между собой они не могут.
 *
 * Определения:
 *  - «Потрачено» / «Заработано» — сделки со статусом «Вышел» или «Завершён»,
 *    у которых известна сумма. CPM, у которого просмотры ещё не зафиксированы,
 *    суммы не имеет и считается отдельно («ждут фиксации»).
 *  - «Запланировано» / «Ожидается» — «В плане» и «Договорились» (для продаж —
 *    только «Договорились») с фиксированной ценой; CPM без суммы считается штуками.
 *  - Подписчики, покупки, выручка, ₽ за подписчика, ROI — по вышедшим закупам с
 *    ссылкой для отслеживания: люди, пришедшие по ней (сервер, /api/ads/deals).
 *    ROI = (выручка − их стоимость) / их стоимость.
 *  - Отменённые не входят ни в одну сумму и ни в одно количество.
 *
 * Данные — /api/ads: грузятся целиком и перечитываются после каждого изменения.
 */
(() => {

// ================= КОНСТАНТЫ =================
// «Сейчас» обновляется при каждой отрисовке: прошло ли место, что будет завтра.
let NOW = new Date();
let TODAY = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
function tick() { NOW = new Date(); TODAY = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate()); }

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

// Проекты приходят с сервера; монограмма и оттенок — из названия и id.
let PROJECTS = [];
let PJ = {};

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
// Всё приходит с сервера: проекты, контакты и сделки целиком. Сделок немного —
// сотни в месяц, — поэтому они грузятся разом, все виды считаются в браузере из
// одного массива, а после любого изменения он перечитывается.
// Контакт — один человек, по какую бы сторону сделки он ни был: «админ» закупа
// и «покупатель» продажи — id из одного справочника.
let ADMINS = {};
let DEALS = [];
let canMint = false;
let checker = { enabled: false, reason: null };
const contactIds = () => Object.keys(ADMINS).map(Number);
const admLabel = id => { const a = ADMINS[id]; return a ? (a.user ? `${a.name} (@${a.user})` : a.name) : '—'; };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = '/'; throw new Error('Сессия истекла — войдите заново'); }
  let data = null;
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (!res.ok) { const err = new Error(data?.error || `Ошибка сервера (${res.status})`); err.status = res.status; err.data = data; throw err; }
  return data;
}

// «🫦 SATAN GAMES 18+» → SG, «Крипто Инсайд: сигналы» → КИ: эмодзи и знаки не в счёт.
function monoOf(name) {
  const words = String(name).replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return words.length === 1 ? words[0].slice(0, 3).toUpperCase() : (words[0][0] + words[1][0]).toUpperCase();
}
const kindOf = p => (p.channel && p.bot ? 'канал + бот' : p.channel ? 'канал' : 'бот без канала');
function setProjects(list) {
  const seen = {};
  PROJECTS = list.map(p => {
    let mono = monoOf(p.name);
    if (seen[mono]) mono += ++seen[mono]; else seen[mono] = 1;
    return { id: p.id, name: p.name, mono, h: (p.id * 137 + 200) % 360, kind: kindOf(p), channel: p.channel, bot: p.bot, mandatory: p.mandatorySlots };
  });
  PJ = Object.fromEntries(PROJECTS.map(p => [p.id, p]));
}
function setContacts(list) {
  ADMINS = Object.fromEntries(list.map(c => [c.id, { name: c.name, user: c.username, old: c.oldUsernames || [], tg: c.tgUserId }]));
}
const toDate = v => (v ? new Date(v) : null);
const normDeal = d => ({
  ...d,
  fixedAt: toDate(d.fixedAt),
  publishedAt: toDate(d.publishedAt),
  history: (d.history || []).map(h => ({ st: h.st, at: new Date(h.at) })),
  removedAt: toDate(d.removedAt),
  // проверки поста считает сервер (jobs/adChecks.ts), здесь только показываем
  warns: d.warns || [],
  checks: d.checks || null,
});
async function loadAll() {
  const [boot, deals] = await Promise.all([api('GET', '/api/ads/bootstrap'), api('GET', '/api/ads/deals')]);
  setProjects(boot.projects);
  setContacts(boot.contacts);
  canMint = !!boot.canMintInvites;
  checker = boot.checker || checker;
  const cr = document.getElementById('checkerRow');
  if (cr) {
    cr.textContent = checker.enabled ? 'проверка постов: каждые 5 мин' : 'проверка постов выключена';
    cr.title = checker.enabled ? '' : (checker.reason || '');
  }
  DEALS = [...deals.buys, ...deals.sales].map(normDeal)
    .filter(d => PJ[d.project] && SLOT[d.slot])
    .sort((a, b) => a.date.localeCompare(b.date) || SLOT[a.slot].i - SLOT[b.slot].i || a.project - b.project);
  const t = new Date();
  const lt = document.getElementById('liveTime');
  if (lt) lt.textContent = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
}
const findDeal = id => (id ? DEALS.find(d => d.id === id) || DEALS.find(d => d.pkg === id) || null : null);

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
  const pk = new Set();
  const a = { count: 0, planCount: 0, earned: 0, earnedCount: 0, expected: 0, expectedCount: 0, expectedCpm: 0, waitCpm: 0, waitEst: 0, estimated: 0, views: 0, viewsEarned: 0 };
  for (const d of list) {
    if (d.status === 'cancel') continue;
    if (d.status === 'plan') { a.planCount++; continue; }
    a.count++;
    const amt = amountOf(d);
    if (isPub(d.status)) {
      if (amt == null) { a.waitCpm++; a.waitEst += d.rate * (d.viewsNow || 0) / 1000; }
      else {
        a.earned += amt; pk.add(d.pkg ?? d.id); a.earnedCount = pk.size;
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
const sold = (p, date, slot) => DEALS.some(d => d.side === 'sell' && d.project === p && d.date === date && d.slot === slot && (d.status === 'agreed' || isPub(d.status)));
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
  const x = w.data || {};
  switch (w.code) {
    case 'early': return `Пост удалён раньше срока — продержался ${dur(x.lived)}, <b>не хватило ${dur(x.short)}</b>`;
    case 'top': return `Не простоял час в топе — <b>не хватило ${x.short}${NB}мин</b>`;
    case 'late': return `Вышел в <b>${esc(x.fact)}</b> вместо ${esc(x.plan)}`;
    case 'noclicks': return 'Пост вышел больше 3 часов назад, а заходов по ссылке нет';
    case 'cpmfail': return 'CPM: пост снят до фиксации — сумма посчитана по последнему замеру';
    case 'notout': return `Пост не вышел — прошло ${dur(x.after)} после времени места`;
    case 'nolook': return `Не удаётся проверить пост: ${esc(x.reason)}`;
    case 'nopost': return d.side === 'buy'
      ? 'Место прошло, а ссылки на пост нет — вставьте её в карточку, иначе проверка пост не увидит'
      : 'posting не сообщил о посте — отметьте его в posting кнопкой «📣 Реклама»';
    default: return '';
  }
}
// «5 мин назад» — для замера просмотров
function agoLbl(isoAt) {
  const at = new Date(isoAt), m = Math.round((Date.now() - at) / 6e4);
  return m < 1 ? 'только что' : m < 60 ? `${m}${NB}мин назад` : dayDiff(at, new Date()) === 0 ? `в ${hmOf(at)}` : `${dm(at)} в ${hmOf(at)}`;
}

// ================= СОСТОЯНИЕ =================
const state = {
  mode: 'buy', period: 'week', anchor: TODAY,
  cFrom: addDays(TODAY, -20), cTo: TODAY,
  view: 'list', scope: [], sellCh: null,
  levels: { buy: ['project', 'week', 'slot'], sell: ['project', 'week', 'slot'] },
  expanded: null, sumSort: { col: null, dir: -1 },
  mx: { rows: 'project', buy: 'count', sell: 'count' },
  warnsOpen: false, status: 'loading', error: '', narrow: false, gridGroup: 'project',
  day: TODAY, calMonth: new Date(TODAY.getFullYear(), TODAY.getMonth(), 1),
};

function range() {
  let from, to;
  if (state.view === 'day') { from = to = state.day; }
  else if (state.period === 'week') { from = mondayOf(state.anchor); to = addDays(from, 6); }
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
  if (state.view === 'day') return `${DOW[r.from.getDay()]}, ${r.from.getDate()} ${MON_GEN[r.from.getMonth()]} ${r.from.getFullYear()}`;
  if (state.period === 'month') return `${MON_NOM[r.from.getMonth()]} ${r.from.getFullYear()}`;
  return `${dm(r.from)} – ${dm(r.to)}.${r.to.getFullYear()}`;
}
const prevLabel = () => (state.view === 'day' ? 'к предыдущему дню' : state.period === 'week' ? 'к прошлой неделе' : state.period === 'month' ? 'к прошлому месяцу' : 'к предыдущему периоду такой же длины');

const scopeIds = () => (state.scope.length ? state.scope : PROJECTS.map(p => p.id));
const channelIds = () => scopeIds().filter(id => PJ[id].channel);
const sideIds = () => (state.mode === 'buy' ? scopeIds() : channelIds());
function dealsIn(from, to, ids = sideIds()) {
  const f = iso(from), t = iso(to);
  return DEALS.filter(d => d.side === state.mode && ids.includes(d.project) && d.date >= f && d.date <= t);
}
const agg = list => (state.mode === 'buy' ? aggBuy(list) : aggSell(list));

// ================= РАЗМЕТКА: МЕЛОЧИ =================
const $ = s => document.querySelector(s);
const ava = (p, cls = '') => `<span class="pava ${cls}" style="--h:${PJ[p].h}" aria-hidden="true">${esc(PJ[p].mono)}</span>`;
// «Кот (@kot_tgg)»: имя главное, username — в скобках и потише
const admHTML = id => (ADMINS[id] ? `<span class="adm"><b>${esc(ADMINS[id].name)}</b>${ADMINS[id].user ? ` <span class="u">(@${esc(ADMINS[id].user)})</span>` : ''}</span>` : '<span class="dash-v">—</span>');
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
  $('#customRange').hidden = state.period !== 'custom' || state.view === 'day';
  $('#periodSeg').hidden = state.view === 'day';
  $('#prevBtn').setAttribute('aria-label', state.view === 'day' ? 'Предыдущий день' : 'Предыдущий период');
  $('#nextBtn').setAttribute('aria-label', state.view === 'day' ? 'Следующий день' : 'Следующий период');
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
  if (state.mode === 'sell') {
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
      const meta = w.d ? `${dm(parseIso(w.d.date))} · ${SLOT[w.d.slot].l} · ${esc(PJ[w.d.project].mono)}${` · ${esc(admLabel(contactOf(w.d)))}`}` : `${esc(PJ[w.tomorrow.p].mono)} · продать`;
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
      <td class="c-venue"><button class="adm-ops" type="button" data-act="ops" data-adm="${contactOf(d)}" aria-label="Все операции с ${esc(admLabel(contactOf(d)))}">${admHTML(contactOf(d))}</button>${buy ? '' : pkgBadge(d)}</td>
      <td class="num c-price">${priceHTML(d)}${!buy && pkgSize(d) > 1 ? `<div class="price-sub">доля · пакет ×${pkgSize(d)}${d.pm === 'fix' ? ` на ${rub(pkgOf(d).reduce((s, x) => s + (x.price || 0), 0))}` : ''}</div>` : ''}</td>
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
    // на телефоне неделя показывает все каналы сразу — ей нужен полный список
    if (useWeek && state.narrow) return renderWeekPhone(r, list, ch, chPick);
    list = list.filter(d => d.project === ch);
  }
  return useWeek ? renderWeek(r, list, ch, chPick) : renderMonth(r, list, ch, chPick);
}

function cellDeals(list, date, slot) { return list.filter(d => d.date === date && d.slot === slot && d.status !== 'cancel'); }

// Тело недельной сетки: строки дней и счётчик «Занято / Продано» по местам.
// opts.proj — проект полосы (новый закуп из пустой клетки сразу на него),
// opts.hideAva — в полосе проекта аватарка в плашке лишняя.
// Свободное место: в продажах так и пишем, в закупах — тихий «＋».
const freeLabel = () => (state.mode === 'sell'
  ? '<span class="gfree">свободно</span><span class="gadd-t">＋ продать</span>'
  : '<span class="gfree">＋</span><span class="gadd-t">＋ добавить</span>');
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
          const nm = admHTML(contactOf(d));
          const lbl = `${SLOT[d.slot].l}, ${dm(day)}: ${buy ? `${PJ[d.project].name}, ` : ''}${admLabel(contactOf(d))}, ${ST[d.status].l}${d.warns.length ? ', есть предупреждение' : ''}`;
          return `<button class="gdeal ${d.status === 'plan' ? 'plan' : ''} ${d.warns.length ? 'warn' : ''}" type="button" data-act="open" data-id="${d.id}" aria-label="${esc(lbl)}">${buy && !opts.hideAva ? ava(d.project, 'sm') : ''}<span class="nm">${nm}</span>${pkgBadge(d)}<span class="mk ${mkOf(d)}"></span></button>`;
        }).join('') + (ds.length > 2 ? `<button class="gmore" type="button" data-act="cell" data-date="${date}" data-slot="${s.k}">+ ещё ${ds.length - 2}</button>` : '');
        if (!buy && isMand && !filled) inner += `<span class="sr-only">обязательное место ещё не продано</span>`;
      } else if (isMand) {
        const past = startOf(date, s.k) < NOW;
        if (past) { footMiss[si]++; inner = `<div class="gmiss" role="img" aria-label="Недопродажа: обязательное место прошло пустым">не продано</div>`; }
        else inner = `<button class="gopen" type="button" data-act="new" data-date="${date}" data-slot="${s.k}" data-proj="${ch}" aria-label="Продать обязательное место: ${s.l}, ${dm(day)}">свободно · продать</button>`;
      } else {
        inner = `<button class="gadd" type="button" data-act="new" data-date="${date}" data-slot="${s.k}"${projAttr} aria-label="Добавить${opts.proj ? ` для ${esc(PJ[opts.proj].name)}` : ''}: ${s.l}, ${dm(day)}">${freeLabel()}</button>`;
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


// Неделя на телефоне: широкая сетка не помещается, поэтому — список дней.
// В дне строка на канал (в закупе — на проект) из 7 меток мест; нажатие на день
// открывает вид «День», где у каждого места полная плашка.
const SLOT_LETTER = { morning: 'У', day: 'Д', evening: 'В', night: 'Н', stories: 'С', n9: '9', n17: '17' };
function renderWeekPhone(r, list, ch, chPick) {
  const buy = state.mode === 'buy';
  const lines = buy ? (state.gridGroup === 'project' ? scopeIds().map(p => [p]) : [scopeIds()]) : channelIds().map(p => [p]);
  const days = r.days.map(day => {
    const date = iso(day), today = dayDiff(day, TODAY) === 0;
    const rows = lines.map(ps => {
      const ds = list.filter(d => ps.includes(d.project));
      const sts = SLOTS.map(s => dayState(ds, date, s.k, buy ? null : ps[0]));
      const used = sts.filter(x => x === 'pub' || x === 'agreed' || (buy && x === 'plan')).length;
      const who = `<span class="wl-who">${ps.length === 1 ? `${ava(ps[0], 'sm')}<span class="wl-nm">${esc(PJ[ps[0]].mono)}</span>` : '<span class="wl-nm">все</span>'}</span>`;
      return `<span class="wl">${who}<span class="wmarks">${sts.map((x, i) => `<span class="wm ${x}" title="${SLOTS[i].l}: ${DOT_LBL[x]}">${SLOT_LETTER[SLOTS[i].k]}</span>`).join('')}</span><span class="wl-n">${used}/7</span></span>`;
    }).join('');
    const lbl = `${DOW_FULL[day.getDay()]}, ${day.getDate()} ${MON_GEN[day.getMonth()]} — открыть день`;
    return `<li><button class="wday ${today ? 'today' : ''}" type="button" data-act="goto-day" data-date="${date}" aria-label="${lbl}">
      <span class="wd-h"><b>${DOW[day.getDay()]}, ${dm(day)}</b>${today ? '<span class="chip neutral today-chip">сегодня</span>' : ''}<span class="wd-go" aria-hidden="true">›</span></span>${rows}</button></li>`;
  }).join('');
  const seg = buy && scopeIds().length > 1
    ? `<div class="seg sm" role="group" aria-label="Группировка" data-seg="gridGroup"><button type="button" data-v="project" aria-pressed="${state.gridGroup === 'project'}">По проектам</button><button type="button" data-v="all" aria-pressed="${state.gridGroup !== 'project'}">Все вместе</button></div>` : '';
  return `<article class="card hero">
    <div class="card-h"><span class="card-idx">01 / сетка</span>
      <div><h2 class="card-t">${buy ? 'Что занято и что свободно' : 'Продажи по каналам'}</h2><div class="card-s">Неделя ${rangeLabel(r)} · нажмите на день — откроется он целиком</div></div>
      <div class="right">${seg}</div></div>
    ${buy ? projSummary(r, list) : ''}
    <ul class="wdays">${days}</ul>
    <div class="hint-row"><span class="legend"><span class="wm pub">У</span>вышел</span><span class="legend"><span class="wm agreed">У</span>договорились</span><span class="legend"><span class="wm plan">У</span>в плане</span><span class="legend"><span class="wm free">У</span>свободно</span>${buy ? '' : '<span class="legend"><span class="wm miss">У</span>не продано</span><span class="legend"><span class="wm open">У</span>обязательное свободно</span>'}<span>У Д В Н С — утро, день, вечер, ночь, сторис; 9 и 17 — нейтралы</span></div></article>`;
}

function renderWeek(r, list, ch, chPick) {
  if (state.narrow) return renderWeekPhone(r, list, ch, chPick);
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


// ================= ВИД: ДЕНЬ =================
// Слева календарь месяца с итогом по проектам в каждом дне, справа выбранный
// день: проекты × места. Всё за один день — и итоги наверху тоже.
function renderDay(r, list) {
  const buy = state.mode === 'buy';
  const ids = sideIds();
  const sel = iso(state.day), todayIso = iso(TODAY);
  const counted = d => d.status !== 'cancel' && (buy || d.status !== 'plan');

  // --- календарь ---
  const m0 = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth(), 1);
  const mEnd = new Date(m0.getFullYear(), m0.getMonth() + 1, 0);
  const monthDeals = dealsIn(m0, mEnd).filter(counted);
  let cells = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((x, i) => `<div class="cal-dow ${i > 4 ? 'wk' : ''}" aria-hidden="true">${x}</div>`).join('');
  for (let i = 0; i < (m0.getDay() + 6) % 7; i++) cells += '<div aria-hidden="true"></div>';
  for (let day = m0; day <= mEnd; day = addDays(day, 1)) {
    const date = iso(day);
    const per = ids.map(p => {
      const used = SLOTS.filter(s => monthDeals.some(d => d.project === p && d.date === date && d.slot === s.k)).length;
      const miss = !buy ? PJ[p].mandatory.filter(s => startOf(date, s) < NOW && !sold(p, date, s)).length : 0;
      return { p, used, miss };
    }).filter(x => x.used || x.miss);
    const lbl = `${day.getDate()} ${MON_GEN[day.getMonth()]}, ${DOW_FULL[day.getDay()]}${date === todayIso ? ', сегодня' : ''}: ${per.length ? per.map(x => `${PJ[x.p].mono} ${x.used} из 7${x.miss ? `, недопродано ${x.miss}` : ''}`).join('; ') : 'пусто'}`;
    cells += `<button class="dcal-day ${date === todayIso ? 'today' : ''} ${date === sel ? 'sel' : ''}" type="button" data-act="pick-day" data-date="${date}" tabindex="${date === sel ? 0 : -1}" aria-pressed="${date === sel}" ${date === todayIso ? 'aria-current="date"' : ''} aria-label="${lbl}">
      <span class="dn">${day.getDate()}</span>
      ${per.map(x => `<span class="pl ${x.miss ? 'miss' : ''}" style="--h:${PJ[x.p].h}" aria-hidden="true"><i></i><b>${esc(PJ[x.p].mono)} ${x.used}<span class="of">/7</span></b></span>`).join('')}
    </button>`;
  }
  const cal = `<div class="dcal">
    <div class="dcal-h">
      <button class="btn ic sm" type="button" data-act="cal-month" data-d="-1" aria-label="Предыдущий месяц">${ICON.left}</button>
      <h3 class="dcal-t">${MON_NOM[m0.getMonth()]} ${m0.getFullYear()}</h3>
      <button class="btn ic sm" type="button" data-act="cal-month" data-d="1" aria-label="Следующий месяц">${ICON.right}</button>
      ${sel !== todayIso ? '<button class="btn tiny" type="button" data-act="today">Сегодня</button>' : ''}
    </div>
    <div class="dcal-grid" role="group" aria-label="Выбор дня: стрелки — соседние дни, PageUp и PageDown — месяц">${cells}</div>
    <p class="dcal-note">${buy ? 'В дне — сколько из 7 мест занято у каждого проекта' : 'В дне — сколько из 7 мест продано в каждом канале; красное — недопродажа'}</p>
  </div>`;

  // --- выбранный день: проекты × места ---
  const dayList = list.filter(d => d.status !== 'cancel');
  const foot = SLOTS.map(() => 0);
  const cards = [];
  const rows = ids.map(p => {
    const mand = buy ? [] : PJ[p].mandatory;
    let used = 0;
    const inners = SLOTS.map((s, si) => {
      const ds = dayList.filter(d => d.project === p && d.slot === s.k);
      const filled = buy ? ds.length > 0 : ds.some(d => d.status !== 'plan');
      if (filled) { used++; foot[si]++; }
      let inner;
      if (ds.length) {
        inner = ds.map(d => {
          const who = admHTML(contactOf(d));
          const lbl = `${s.l}: ${PJ[p].name}, ${admLabel(contactOf(d))}, ${ST[d.status].l}`;
          return `<button class="dchip ${d.status === 'plan' ? 'plan' : ''} ${d.warns.length ? 'warn' : ''}" type="button" data-act="open" data-id="${d.id}" aria-label="${esc(lbl)}">
            <span class="nm">${who}${pkgBadge(d)}</span><span class="mk ${mkOf(d)}"></span>
            <span class="sub">${priceHTML(d).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}</span></button>`;
        }).join('');
      } else if (mand.includes(s.k)) {
        inner = startOf(sel, s.k) < NOW
          ? `<div class="gmiss" role="img" aria-label="Недопродажа: обязательное место прошло пустым">не продано</div>`
          : `<button class="gopen" type="button" data-act="new" data-date="${sel}" data-slot="${s.k}" data-proj="${p}" aria-label="Продать обязательное место: ${s.l}">свободно · продать</button>`;
      } else {
        inner = `<button class="gadd" type="button" data-act="new" data-date="${sel}" data-slot="${s.k}" data-proj="${p}" aria-label="Добавить для ${esc(PJ[p].name)}: ${s.l}">${freeLabel()}</button>`;
      }
      return inner;
    });
    cards.push({ p, used, inners, mand });
    const tds = inners.map(inner => `<td><div class="gcell">${inner}</div></td>`).join('');
    return `<tr><th scope="row"><span class="c-prj">${ava(p)}<span class="nm">${esc(PJ[p].name)}</span></span><span class="dp-occ">${used}/7 ${buy ? 'занято' : 'продано'}</span></th>${tds}</tr>`;
  }).join('');
  const head = SLOTS.map(s => `<th scope="col">${s.l}</th>`).join('');
  const d0 = state.day;
  const panel = `<div class="dayp">
    <div class="dayp-h"><h3>${DOW_FULL[d0.getDay()].replace(/^./, c => c.toUpperCase())}, ${d0.getDate()} ${MON_GEN[d0.getMonth()]}</h3>${sel === todayIso ? '<span class="chip neutral today-chip">сегодня</span>' : ''}
      <span class="dayp-s">${dayList.length} ${plural(dayList.length, 'сделка', 'сделки', 'сделок')} · ${state.narrow ? 'нажмите' : 'клик'} на свободное место — ${buy ? 'закуп' : 'продажа'} на этот день и место</span></div>
    ${state.narrow
      ? `<div class="dcards">${cards.map(c => `<div class="dcard"><h4 class="dcard-h">${ava(c.p)}<span class="nm">${esc(PJ[c.p].name)}</span><span class="dp-occ">${c.used}/7 ${buy ? 'занято' : 'продано'}</span></h4>
          <ul class="dslots">${SLOTS.map((s, i) => `<li><span class="dsl">${s.l}${c.mand.includes(s.k) ? '<span class="req" title="обязательное место">*</span>' : ''}</span><div class="dsv">${c.inners[i]}</div></li>`).join('')}</ul></div>`).join('')}</div>`
      : `<div class="tbl-wrap"><table class="tbl grid-tbl day-tbl">
      <caption class="sr-only">${buy ? 'Закупы' : 'Продажи'} за ${d0.getDate()} ${MON_GEN[d0.getMonth()]}: проекты по местам</caption>
      <thead><tr><th scope="col">${buy ? 'Проект' : 'Канал'}</th>${head}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th scope="row">${buy ? 'Занято' : 'Продано'}</th>${foot.map(n => `<td>${n}/${ids.length}</td>`).join('')}</tr></tfoot>
    </table><div class="scroll-hint" aria-hidden="true"></div></div>`}
  </div>`;
  return `<article class="card hero"><div class="card-h"><span class="card-idx">01 / день</span>
      <div><h2 class="card-t">${buy ? 'Закупы за день' : 'Продажи за день'}</h2><div class="card-s">Выберите день в календаре — справа только он</div></div></div>
    <div class="dayv">${cal}${panel}</div>
    <div class="hint-row"><span class="legend"><span class="mk agreed"></span>договорились</span><span class="legend"><span class="mk pub"></span>вышел / завершён</span><span class="legend"><span class="mk plan"></span>в плане</span>${buy ? '' : '<span class="legend"><span class="mk miss"></span>недопродано</span>'}</div></article>`;
}
function setDay(d) { state.day = d; state.calMonth = new Date(d.getFullYear(), d.getMonth(), 1); }

// ================= ВИД: СВОДКА =================
const DIMS = {
  project: { l: 'Проект', sl: 'Мой канал', key: d => d.project, label: k => PJ[k].name, order: k => k },
  slot: { l: 'Место', key: d => d.slot, label: k => SLOT[k].l, order: k => SLOT[k].i },
  week: { l: 'Неделя', key: d => iso(mondayOf(parseIso(d.date))), label: k => weekLabel(k), order: k => k },
  day: { l: 'День', key: d => d.date, label: k => { const x = parseIso(k); return `${DOW[x.getDay()]}, ${dm(x)}`; }, order: k => k },
  format: { l: 'Формат', key: d => d.format, label: k => k, order: k => k },
  admin: { l: 'Админ', buyOnly: true, key: d => d.admin, label: k => admLabel(k), order: k => ADMINS[k]?.name || k },
  creative: { l: 'Креатив', buyOnly: true, key: d => d.creative || 'без креатива', label: k => k, order: k => k },
  buyer: { l: 'Покупатель', sellOnly: true, key: d => d.buyer, label: k => admLabel(k), order: k => ADMINS[k]?.name || k },
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
  tick();
  const r = range();
  CUR = r;
  renderHeader(r);
  const view = $('#view'), kp = $('#kpis');
  if (state.status === 'loading') {
    kp.innerHTML = Array.from({ length: 5 }, () => '<div class="skel skel-kpi"></div>').join('');
    $('#warns').innerHTML = '';
    view.innerHTML = `<div class="card" aria-busy="true"><div class="card-h"><div class="skel" style="width:220px;height:18px"></div></div><div class="skel-rows">${'<div class="skel"></div>'.repeat(7)}</div></div>`;
    return;
  }
  if (state.status === 'error') {
    kp.innerHTML = ''; $('#warns').innerHTML = '';
    view.innerHTML = `<div class="card"><div class="empty err" role="alert"><div class="e-ic">${ICON.err}</div><h2>Не удалось загрузить сделки</h2><p>${esc(state.error || 'Сервер аналитики не ответил')}. Данные в базе целы — это ошибка связи.</p><button class="btn" type="button" data-act="retry">Повторить</button></div></div>`;
    return;
  }
  const list = dealsIn(r.from, r.to);
  renderKpis(r, list);
  renderWarns(list);
  if (!PROJECTS.length) {
    view.innerHTML = emptyHTML('Проектов пока нет', 'Сначала добавьте канал или бота во вкладке «Проекты» — закупы и продажи привязываются к ним.', false);
    return;
  }
  if (state.mode === 'sell' && !channelIds().length) {
    view.innerHTML = emptyHTML('У выбранных проектов нет каналов', 'Продавать рекламу можно только в канале, а у выбранных проектов только боты. Выберите в шапке проект с каналом.', false);
    return;
  }
  if (!list.length && state.view !== 'grid' && state.view !== 'day') {
    view.innerHTML = emptyHTML(state.mode === 'buy' ? 'За этот период закупов нет' : 'За этот период продаж нет', !DEALS.some(d => d.side === state.mode) ? `Сделок ещё нет. Первая появится после «${state.mode === 'buy' ? 'Новый закуп' : 'Новая продажа'}» — или откройте сетку и нажмите на нужную клетку.` : 'Смените период стрелками или добавьте сделку — она сразу появится во всех видах.');
    return;
  }
  view.innerHTML = state.view === 'list' ? renderList(list)
    : state.view === 'grid' ? renderGrid(r, list)
    : state.view === 'day' ? renderDay(r, list)
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
  const src = findDeal(id);
  if ((src ? src.side : state.mode) === 'sell') return openSale(id, prefill);
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
  if (!PROJECTS.length) { toast('Сначала добавьте проект во вкладке «Проекты»', 'info'); return; }
  const projOpts = (buy ? PROJECTS : PROJECTS.filter(p => p.channel)).map(p => `<option value="${p.id}" ${p.id === d.project ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const slotPick = SLOTS.map(s => `<label><input type="radio" name="slot" value="${s.k}" ${s.k === d.slot ? 'checked' : ''} required>${s.l}${!buy && PJ[d.project].mandatory.includes(s.k) ? '<span class="req">*</span>' : ''}</label>`).join('');
  const views = viewsOf(d);

  // Блок фиксации CPM
  let cpm = '';
  {
    const st = startOf(d.date, d.slot), end = new Date(+st + hoursOf(d.format) * 36e5);
    const amt = amountOf(d);
    let box;
    if (d.cpmState === 'fixed') box = `<div class="cpmbox fixed"><span class="ic">${ICON.ok}</span><div><b>Просмотры зафиксированы</b><p><span class="mono">${int(d.views)}</span> просмотров${d.fixedAt ? ` · <span class="mono">${dtLbl(d.fixedAt)}</span>` : ''} · итог <span class="mono">${rub(amt)}</span></p></div></div>`;
    else if (d.cpmState === 'failed') box = `<div class="cpmbox failed"><span class="ic">${ICON.bad}</span><div><b>Не удалось зафиксировать просмотры — пост снят раньше</b><p>Последнее известное значение: <span class="mono">${int(d.views)}</span> просмотров. По нему сумма ≈ <span class="mono">${rub(amt)}</span> — это оценка, её стоит сверить с ${buy ? 'продавцом' : 'покупателем'}.</p></div></div>`;
    else box = `<div class="cpmbox wait"><span class="ic">${ICON.clock}</span><div><b>Ждёт снятия поста</b><p>${checker.enabled && d.post
        ? `Просмотры зафиксируются сами за 10 минут до конца срока — <span class="mono">${dm(end)} в ${hmOf(end)}</span>${d.viewsNow ? `; сейчас <span class="mono">${int(d.viewsNow)}</span>` : ''}. Снимут раньше — сумма посчитается по последнему замеру. Можно вписать и вручную.`
        : `Просмотры фиксируются перед снятием — <span class="mono">${dm(end)} в ${hmOf(end)}</span>. ${checker.enabled ? 'Вставьте ссылку на пост — и они зафиксируются сами;' : 'Проверка постов выключена —'} пока впишите их ниже сами.`}</p></div></div>`;
    const viewsFld = `<div class="fgrid cpm-views"><div class="fld"><label for="fViews">Просмотры для расчёта</label><input class="inp mono" type="number" id="fViews" name="views" min="0" step="1" inputmode="numeric" value="${d.views ?? ''}" placeholder="при снятии поста"><div class="hint">${d.cpmState === 'fixed' ? 'Исправите — сумма пересчитается' : 'Впишете — сумма зафиксируется'}</div></div></div>`;
    cpm = `<div class="m-sec" id="cpmSec" ${d.pm === 'cpm' ? '' : 'hidden'}><div class="m-sec-h"><span class="card-idx">02 / фиксация CPM</span><h3>Просмотры для расчёта</h3></div>${box}${viewsFld}</div>`;
  }

  // Результат
  const stat = (l, v) => `<div class="mstat"><b class="${v === '—' ? 'dash-v' : ''}">${v}</b><span>${l}</span></div>`;
  const amtNow = amountOf(d);
  const result = buy
    ? `<div class="mstats">${stat('Потрачено', pub && amtNow != null ? rub(amtNow) : '—')}${stat('Охват', pub && views != null ? int(views) : '—')}${stat('CPM', rub1(one.cpm))}${stat('Подписчиков', one.resCount ? int(one.subs) : '—')}${stat('₽ за подписчика', rub1(one.cps))}${stat('Удержание', one.retention != null ? `${Math.round(one.retention * 100)}%` : '—')}${stat('Покупок', one.resCount ? int(one.buyers) : '—')}${stat('₽ за покупателя', rub1(one.cpb))}${stat('Выручка', one.resCount ? rub(one.revenue) : '—')}${stat('ROI', pct(one.roi))}</div>`
    : `<div class="mstats" style="grid-template-columns:repeat(3,minmax(0,1fr))">${stat('Сумма', pub && amtNow != null ? rub(amtNow) : '—')}${stat('Просмотры', pub && views != null ? int(views) : '—')}${stat('Фактический CPM', rub1(one.factCpm))}</div>`;
  const resNote = !pub ? 'Пост ещё не вышел — вместо цифр прочерки, а не нули.' : buy && !d.track ? 'У закупа нет ссылки для отслеживания — подписчиков и покупки не к чему привязать.' : buy && !one.resCount ? 'Пост вышел, результат ещё копится: подписчики и покупки появятся в течение суток.' : buy ? 'Подписчики и покупки — люди, пришедшие по ссылке для отслеживания этого закупа.' : '';

  // Проверки — только когда пост вышел
  let checks = '';
  if (pub && d.checks) {
    const c = d.checks, li = (cls, ic, l, v) => `<li class="${cls}"><span class="ci">${ic}</span><span class="cl">${l}</span><span class="cv">${v}</span></li>`;
    checks = `<div class="m-sec"><div class="m-sec-h"><span class="card-idx">${buy ? '04' : '03'} / проверки</span><h3>Автоматические проверки</h3></div><ul class="checks">
      ${c.reach ? li('ok', ICON.ok, 'Охват', `<span class="mono">${int(c.reach.views)}</span> просмотров, ${d.removedAt ? 'последний замер' : 'замер'} ${agoLbl(c.reach.at)}`) : ''}
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
        <div class="fld"><label for="fProj">${buy ? 'Проект — куда ведём' : 'Мой канал'}</label><select class="inp" id="fProj" name="project" required ${isNew ? '' : 'disabled'}>${projOpts}</select>${isNew ? '' : '<div class="hint">Не меняется: ссылка закупа уже выпущена для этого проекта</div>'}</div>
        ${contactField('У кого купил — админ', d.admin)}
        <div class="fld"><label for="fDate">Дата выхода — план</label><input class="inp mono" type="date" id="fDate" name="date" required value="${d.date}"></div>
        <div class="fld"><label for="fFact">Дата выхода — факт</label><input class="inp mono" id="fFact" readonly value="${factLabel(d)}" placeholder="заполнится, когда пост выйдет"><div class="hint">По отметке «Вышел»; точное время выхода будет ставить бот постинга</div></div>
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
        <div class="fld"><label for="fTr">Ссылка для отслеживания</label><input class="inp mono" id="fTr" name="track" value="${esc(d.track)}" placeholder="${isNew ? 'пусто — создам сам' : 't.me/+… или t.me/бот?start=…'}" autocapitalize="off" spellcheck="false"><div class="hint">${isNew ? 'Оставьте пустым — ссылка создастся сама; или вставьте готовую' : d.track ? '<button class="adm-link" type="button" data-act="copy-track">Скопировать</button> · другая ссылка — вставьте её сюда' : `Ссылки нет — вставьте готовую${canMint || !PJ[d.project].channel ? ' или <button class="adm-link" type="button" data-act="mint">создайте</button>' : ''}`}</div></div>` : ''}
        <div class="fld ${buy ? '' : 'wide'}"><label for="fPost">Ссылка на ${buy ? 'рекламный ' : ''}пост</label><input class="inp mono" id="fPost" name="post" value="${esc(d.post)}" placeholder="${d.post ? 'https://t.me/канал/123' : 'пусто, пока пост не вышел'}" autocapitalize="off" spellcheck="false">${buy ? `<div class="hint">${d.post
          ? (checker.enabled ? 'По ней проверка следит за постом: выход, просмотры, час в топе, срок' : 'Проверка постов выключена — ссылка пока только для справки')
          : `Место только забронировано — оставьте пустым. Когда пост выйдет, вставьте ссылку вида t.me/канал/123${checker.enabled ? ': проверка сама отметит выход, просмотры, час в топе и срок' : ''}`}</div>` : ''}</div>
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

// Факт выхода — момент отметки «Вышел». Отмеченное задним числом (уже после
// срока поста) о времени выхода ничего не говорит — тогда показываем план.
function factLabel(d) {
  if (!isPub(d.status)) return '';
  const st = startOf(d.date, d.slot), end = new Date(+st + hoursOf(d.format) * 36e5);
  if (d.publishedAt && d.publishedAt <= end) return `${dm(d.publishedAt)}, ${hmOf(d.publishedAt)}`;
  return `${dm(st)}, ${SLOT[d.slot].t} — по плану`;
}

function updateCalc() {
  const f = $('#dealForm'); if (!f || !editing || editing.kind === 'sale') return;
  const pm = f.elements.pm.value;
  $('#pmFix').hidden = pm !== 'fix'; $('#pmCpm').hidden = pm !== 'cpm';
  $('#fPrice').required = pm === 'fix'; $('#fRate').required = pm === 'cpm';
  const sec = $('#cpmSec'); if (sec) sec.hidden = pm !== 'cpm';
  const rate = Number($('#fRate').value);
  const v = viewsOf(editing.d);
  const known = Number($('#fViews')?.value) || (editing.d.cpmState === 'fixed' || editing.d.cpmState === 'failed' ? editing.d.views : editing.d.viewsNow);
  $('#cpmCalc').innerHTML = !rate ? '' : known
    ? `≈ <b>${rub(Math.round(rate * known / 1000))}</b> при ${int(known)} просмотров`
    : `сумма станет известна после фиксации${v ? '' : ' просмотров'}`;
}
$('#dealForm').addEventListener('input', e => { if (e.target.name === 'pm' || e.target.name === 'rate' || e.target.name === 'views') updateCalc(); });
$('#dealForm').addEventListener('change', e => { if (e.target.name === 'pm') updateCalc(); });


// ================= ПРОДАЖА: ПАКЕТ ПО КАНАЛАМ =================
// Одна продажа — один покупатель и одна сумма, но мест может быть несколько:
// по одному в каждом выбранном канале, в один день и на одно место. Хранится
// это как места-«доли» с общим d.pkg: тогда статистика по каналам, обязательные
// места и недопродажи считаются как раньше, а сумма пакета — это сумма долей.
const pkgOf = d => DEALS.filter(x => x.side === 'sell' && x.pkg === d.pkg);
const pkgSize = d => pkgOf(d).filter(x => x.status !== 'cancel').length;
const pkgBadge = d => { const n = d.side === 'sell' ? pkgSize(d) : 1; return n > 1 ? `<span class="pkgb" title="Пакет: ${n} ${plural(n, 'канал', 'канала', 'каналов')}">×${n}</span>` : ''; };
function evenSplit(total, chans) {
  const base = Math.floor(total / chans.length);
  return Object.fromEntries(chans.map((p, i) => [p, base + (i === 0 ? total - base * chans.length : 0)]));
}

function openSale(id, prefill = {}) {
  const src = findDeal(id);
  const parts = src ? pkgOf(src) : [];
  const base = src ? structuredClone(src) : {
    buyer: '', date: prefill.date || iso(addDays(TODAY, 1)), slot: prefill.slot || null, format: '1/24', status: 'plan', pm: 'fix', notes: '', history: [],
  };
  // без подсказки — первое место, свободное хотя бы в одном канале в этот день
  if (!base.slot) {
    const free = SLOTS.find(s => channelIds().some(p => !DEALS.some(x => x.side === 'sell' && x.project === p && x.date === base.date && x.slot === s.k && x.status !== 'cancel')));
    base.slot = free ? free.k : 'evening';
  }
  const chans = src ? parts.map(x => x.project) : [Number(prefill.proj) || state.sellCh || channelIds()[0]];
  const total = src && base.pm === 'fix' ? parts.reduce((s, x) => s + (x.price || 0), 0) : null;
  editing = { kind: 'sale', pkg: src?.pkg || null, parts, src };
  const isNew = !src;
  const pub = isPub(base.status);
  const warns = parts.flatMap(x => x.warns.map(w => ({ w, x })));

  // по каналам: доля, просмотры, фиксация CPM
  const rowsRes = parts.map(x => {
    const amt = amountOf(x), v = viewsOf(x);
    const fix = x.pm !== 'cpm' ? '' : x.cpmState === 'fixed' ? `<span class="r-good">зафиксировано ${dtLbl(x.fixedAt)}</span>`
      : x.cpmState === 'failed' ? '<span class="r-bad">не удалось — по последнему замеру</span>' : '<span class="dash-v">ждёт снятия поста</span>';
    return `<tr><th scope="row"><span class="c-prj">${ava(x.project, 'sm')}<span class="nm">${esc(PJ[x.project].name)}</span></span></th>
      <td class="num">${amt != null ? (x.cpmState === 'failed' ? '≈ ' : '') + rub(amt) : '<span class="dash-v">—</span>'}</td>
      <td class="num">${pub && v != null ? int(v) : '<span class="dash-v">—</span>'}</td>${base.pm === 'cpm' ? `<td>${fix}<label class="sr-only" for="v-${x.project}">Просмотры ${esc(PJ[x.project].name)}</label><input class="inp mono views-inp" type="number" min="0" step="1" inputmode="numeric" id="v-${x.project}" name="views-${x.project}" value="${x.views ?? ''}" placeholder="просмотры"></td>` : ''}</tr>`;
  }).join('');
  const sumAmt = parts.reduce((s, x) => s + (amountOf(x) ?? 0), 0), anyAmt = parts.some(x => amountOf(x) != null);
  const sumViews = parts.reduce((s, x) => s + (viewsOf(x) ?? 0), 0);
  const result = parts.length ? `<div class="tbl-wrap" style="padding:0"><table class="tbl sale-res"><thead><tr><th scope="col">Канал</th><th scope="col" class="num">Сумма</th><th scope="col" class="num">Просмотры</th>${base.pm === 'cpm' ? '<th scope="col">Фиксация CPM</th>' : ''}</tr></thead>
    <tbody>${rowsRes}</tbody><tfoot><tr><th scope="row">Итого${parts.length > 1 ? ` · ${parts.length} ${plural(parts.length, 'канал', 'канала', 'каналов')}` : ''}</th><td class="num">${anyAmt ? rub(sumAmt) : '—'}</td><td class="num">${pub && sumViews ? int(sumViews) : '—'}</td>${base.pm === 'cpm' ? '<td></td>' : ''}</tr></tfoot></table></div>` : '';

  $('#dealForm').innerHTML = `
    <div class="m-head"><div>
      <div class="m-eyebrow">${isNew ? 'новая продажа' : `продажа · ${base.pkg} · ${dmy(parseIso(base.date))}`}</div>
      <h2 id="dealTitle">${isNew ? 'Новая продажа' : esc(admLabel(base.buyer))}</h2>
      ${isNew ? '' : `<div class="m-chips">${stChip(base.status)}<span class="chip slot">${SLOT[base.slot].l}</span><span class="chip fmt">${base.format}</span>${parts.map(x => `<span class="chip neutral">${ava(x.project, 'sm')}${esc(PJ[x.project].mono)}</span>`).join('')}</div>`}
    </div><button class="x-btn" type="button" data-close aria-label="Закрыть">${ICON.x}</button></div>
    <div class="m-body">
      ${warns.length ? `<div class="m-sec"><div class="wbox"><ul class="wlist" style="border:0">${warns.map(({ w, x }) => `<li><div class="witem"><span class="wtag ${w.sev}">${w.sev === 'high' ? 'высокая' : 'средняя'}</span><span class="wtext">${esc(PJ[x.project].mono)}: ${warnText(x, w)}</span></div></li>`).join('')}</ul></div></div>` : ''}
      <div class="m-sec"><div class="m-sec-h"><span class="card-idx">01 / сделка</span><h3>Поля продажи</h3></div>
      <div class="fgrid">
        ${contactField('Покупатель — кто купил место', base.buyer)}
        <div class="fld"><label for="fDate">Дата выхода</label><input class="inp mono" type="date" id="fDate" name="date" required value="${base.date}"><div class="hint">Общая для всех каналов продажи</div></div>
        <div class="fld wide"><span class="flbl" id="slotLbl">Место — общее для всех каналов</span><div class="slot-pick" role="radiogroup" aria-labelledby="slotLbl">${SLOTS.map(s => `<label><input type="radio" name="slot" value="${s.k}" ${s.k === base.slot ? 'checked' : ''} required>${s.l}</label>`).join('')}</div></div>
        <fieldset class="fld wide chpick" id="chPick" data-init="${chans.join(',')}"></fieldset>
        <div class="fld"><span class="flbl" id="fmtLbl">Формат</span><div class="slot-pick" role="radiogroup" aria-labelledby="fmtLbl">${['1/24', '1/48'].map(f => `<label><input type="radio" name="format" value="${f}" ${f === base.format ? 'checked' : ''}>${f}</label>`).join('')}</div></div>
        <div class="fld"><label for="fSt">Статус</label><select class="inp" id="fSt" name="status">${ST_ORDER.map(s => `<option value="${s}" ${s === base.status ? 'selected' : ''}>${ST[s].l}</option>`).join('')}</select></div>
        <div class="fld wide"><span class="flbl" id="pmLbl">Цена</span>
          <div class="frow" style="align-items:flex-start">
            <div class="slot-pick" role="radiogroup" aria-labelledby="pmLbl" style="flex:none">${[['fix', 'Фикс'], ['cpm', 'CPM']].map(([v, l]) => `<label><input type="radio" name="pm" value="${v}" ${v === base.pm ? 'checked' : ''}>${l}</label>`).join('')}</div>
            <div id="sFix" ${base.pm === 'fix' ? '' : 'hidden'}><label class="sr-only" for="sTotal">Сумма за всю продажу, ₽</label><input class="inp mono" type="number" id="sTotal" name="total" min="1" step="1" inputmode="numeric" placeholder="Сумма за продажу, ₽" value="${total ?? ''}"><div id="splitBox"></div></div>
            <div id="sCpm" ${base.pm === 'cpm' ? '' : 'hidden'}><label class="sr-only" for="sRate">Ставка за 1000 просмотров, ₽</label><input class="inp mono" type="number" id="sRate" name="rate" min="1" step="1" inputmode="numeric" placeholder="Ставка за 1000, ₽" value="${base.rate ?? ''}"><div class="hint">Одна ставка на все каналы; просмотры фиксируются в каждом канале отдельно и складываются</div></div>
          </div></div>
        <div class="fld wide"><label for="fNotes">Заметки</label><textarea class="inp" id="fNotes" name="notes" placeholder="Договорённости, что учесть">${esc(base.notes)}</textarea></div>
      </div></div>
      ${result ? `<div class="m-sec"><div class="m-sec-h"><span class="card-idx">02 / по каналам</span><h3>Суммы и просмотры</h3></div>${result}${base.pm === 'cpm' ? '<p class="mnote">Просмотры по CPM пока вписываются вручную — при снятии поста; впишете — сумма канала зафиксируется.</p>' : pub ? '' : '<p class="mnote">Пост ещё не вышел — просмотры появятся после выхода.</p>'}</div>` : ''}
      ${base.history?.length ? `<div class="m-sec"><div class="m-sec-h"><span class="card-idx">история</span><h3>История статусов</h3></div><ol class="tl">${base.history.map(h => `<li style="--c:${ST[h.st].c}"><span>${ST[h.st].l}</span><time datetime="${h.at.toISOString()}">${dmy(h.at)}, ${hmOf(h.at)}</time></li>`).join('')}</ol></div>` : ''}
    </div>
    <div class="m-foot">${isNew ? '' : `<button class="btn btn-ghost-danger" type="button" data-act="del">Удалить</button>`}<span class="sp"></span><button class="btn" type="button" data-close>Отмена</button><button class="btn btn-primary" type="submit">${isNew ? 'Добавить' : 'Сохранить'}</button></div>`;
  renderChPick(chans);
  ensureChannel();
  renderSplit(total, src ? Object.fromEntries(parts.map(x => [x.project, x.price])) : null);
  $('#dealDlg').showModal();
  admHint();
}

// Каналы: занятое другим покупателем место в этот день выбрать нельзя.
function renderChPick(checked) {
  const box = $('#chPick'); if (!box) return;
  const f = $('#dealForm'), date = f.elements.date.value, slot = f.elements.slot.value;
  const own = new Set(editing.parts.map(x => x.id));
  box.innerHTML = `<legend class="flbl">В каких каналах</legend><div class="chopts">${PROJECTS.filter(p => p.channel).map(p => {
    const busy = DEALS.find(x => x.side === 'sell' && x.project === p.id && x.date === date && x.slot === slot && x.status !== 'cancel' && !own.has(x.id));
    const mand = p.mandatory.includes(slot);
    const on = checked.includes(p.id) && !busy;
    return `<label class="chopt ${busy ? 'busy' : ''}"><input type="checkbox" name="ch" value="${p.id}" ${on ? 'checked' : ''} ${busy ? 'disabled' : ''}>${ava(p.id)}<span class="nm">${esc(p.name)}</span>
      <span class="note">${busy ? `место занято: ${esc(admLabel(busy.buyer))}` : mand ? 'обязательное место' : ''}</span></label>`;
  }).join('')}</div><div class="hint">Отметьте несколько — это одна продажа пакетом: один покупатель, одна сумма, тот же день и место во всех каналах</div>`;
}
// если отмеченный канал оказался занят — отмечаем первый свободный, а не оставляем ни одного
function ensureChannel() {
  if (checkedChans().length) return;
  const free = document.querySelector('#chPick input[name="ch"]:not(:disabled)');
  if (free) free.checked = true;
}
const checkedChans = () => [...document.querySelectorAll('#chPick input[name="ch"]:checked')].map(i => Number(i.value));
// Дележ суммы по каналам: поровну, но можно поправить руками.
function renderSplit(total, shares) {
  const box = $('#splitBox'); if (!box) return;
  const chans = checkedChans();
  if (chans.length < 2 || !total) { box.innerHTML = ''; return; }
  const sh = shares && chans.every(p => p in shares) ? shares : evenSplit(total, chans);
  box.innerHTML = `<div class="split"><div class="split-h"><span>Дележ по каналам</span><button class="adm-link" type="button" data-act="split-even">Поровну</button></div>
    ${chans.map(p => `<label class="split-row">${ava(p, 'sm')}<span class="nm">${esc(PJ[p].mono)}</span><input class="inp mono" type="number" min="0" step="1" name="share-${p}" value="${sh[p]}" aria-label="Доля ${esc(PJ[p].name)}, ₽"></label>`).join('')}
    <div class="split-sum" id="splitSum"></div></div>`;
  updateSplitSum();
}
function updateSplitSum() {
  const el = $('#splitSum'); if (!el) return;
  const total = Number($('#sTotal').value) || 0;
  const sum = checkedChans().reduce((s, p) => s + (Number($('#dealForm').elements[`share-${p}`]?.value) || 0), 0);
  el.innerHTML = sum === total ? `<span class="r-good">распределено ${rub(sum)} из ${rub(total)}</span>` : `<span class="r-bad">распределено ${rub(sum)} из ${rub(total)} — ${sum > total ? 'лишние' : 'не хватает'} ${rub(Math.abs(total - sum))}</span>`;
}
function validateSale(f) {
  const chans = checkedChans();
  const first = f.querySelector('#chPick input[name="ch"]:not(:disabled)');
  first?.setCustomValidity(chans.length ? '' : 'Выберите хотя бы один канал');
  const pm = f.elements.pm.value;
  $('#sTotal').required = pm === 'fix'; $('#sRate').required = pm === 'cpm';
  $('#sTotal').setCustomValidity('');
  if (pm === 'fix' && chans.length > 1 && $('#splitBox').innerHTML) {
    const total = Number($('#sTotal').value) || 0;
    const sum = chans.reduce((s, p) => s + (Number(f.elements[`share-${p}`]?.value) || 0), 0);
    if (sum !== total) $('#sTotal').setCustomValidity(`Доли каналов (${rub(sum)}) не сходятся с суммой продажи`);
  }
}
async function saveSale(f) {
  const el = f.elements;
  const chans = checkedChans();
  const pm = el.pm.value, total = Number($('#sTotal').value) || 0;
  const shares = pm === 'fix' && chans.length > 1 && $('#splitBox').innerHTML ? Object.fromEntries(chans.map(p => [p, Number(el[`share-${p}`].value) || 0])) : null;
  const { src } = editing;
  const unlock = lockForm(f);
  try {
    const contactId = await adminFromForm(f);
    const places = chans.map(p => {
      const pl = { projectId: p };
      if (shares) pl.share = shares[p];
      const vi = el[`views-${p}`];
      if (pm === 'cpm' && vi) {
        const v = vi.value.trim();
        Object.assign(pl, v ? { views: Number(v), cpmState: 'fixed' } : { views: null, cpmState: 'wait' });
      }
      return pl;
    });
    const body = {
      contactId, date: el.date.value, slot: el.slot.value, format: el.format.value, status: el.status.value,
      priceMode: pm, total: pm === 'fix' ? total : null, cpmRate: pm === 'cpm' ? Number(el.rate.value) : null,
      notes: el.notes.value.trim(), places,
    };
    const res = src ? await api('PATCH', `/api/ads/sales/${src.dealId}`, body) : await api('POST', '/api/ads/sales', body);
    await reload();
    $('#dealDlg').close();
    toast(`${src ? 'Продажа сохранена' : 'Продажа добавлена'}: П-${res.sale.id} · ${chans.map(p => PJ[p].mono).join(' + ')}${chans.length > 1 && pm === 'fix' ? ` · ${rub(total)} за пакет` : ''}`);
  } catch (err) {
    showSaveError(err);
  } finally {
    unlock();
  }
}
// Пока запрос идёт, кнопка сохранения не нажимается второй раз.
function lockForm(f) {
  const btn = f.querySelector('button[type="submit"]');
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
  return () => { if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); } };
}
function showSaveError(err) {
  console.error('[ads] Save failed:', err);
  toast(err.message || 'Не удалось сохранить', 'warn');
}
$('#dealForm').addEventListener('change', e => {
  if (editing?.kind !== 'sale') return;
  if (e.target.name === 'date' || e.target.name === 'slot') { renderChPick(checkedChans()); ensureChannel(); renderSplit(Number($('#sTotal').value), null); }
  if (e.target.name === 'ch') renderSplit(Number($('#sTotal').value), null);
  if (e.target.name === 'pm') { $('#sFix').hidden = e.target.value !== 'fix'; $('#sCpm').hidden = e.target.value !== 'cpm'; }
});
$('#dealForm').addEventListener('input', e => {
  if (editing?.kind !== 'sale') return;
  if (e.target.id === 'sTotal') renderSplit(Number(e.target.value), null);
  else if (e.target.name?.startsWith('share-')) updateSplitSum();
});


// Поле «контакт» с автоподбором — одно и для админа в закупе, и для покупателя в
// продаже: это одни и те же люди, и их сделки в обе стороны сводятся вместе.
function contactField(label, value) {
  return `<div class="fld adm-fld"><label for="fWho" id="fWhoLbl">${label}</label>
    <div class="cbx">
      <input class="inp" id="fWho" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="admList" aria-describedby="admHint" autocomplete="off" spellcheck="false" placeholder="Имя или @username" value="${esc(value ? admLabel(value) : '')}">
      <input type="hidden" name="admin" value="${value || ''}">
      <ul class="cbx-list" id="admList" role="listbox" aria-labelledby="fWhoLbl" hidden></ul>
    </div>
    <div class="adm-sub" id="admNew" hidden>
      <div class="frow"><div><label class="sr-only" for="fNewName">Имя нового контакта</label><input class="inp" id="fNewName" placeholder="Имя"></div>
      <div><label class="sr-only" for="fNewUser">Username нового контакта</label><input class="inp mono" id="fNewUser" placeholder="username" pattern="@?[A-Za-z0-9_]{4,32}" autocapitalize="off" spellcheck="false"></div></div>
    </div>
    <div class="adm-sub" id="admRename" hidden>
      <div class="frow"><div><label class="sr-only" for="fRenUser">Новый username</label><input class="inp mono" id="fRenUser" placeholder="новый username" pattern="@?[A-Za-z0-9_]{4,32}" autocapitalize="off" spellcheck="false"></div>
      <div class="frow" style="flex:none"><button class="btn tiny" type="button" data-act="ren-ok">Сменить</button><button class="btn tiny" type="button" data-act="ren-cancel">Отмена</button></div></div>
      <div class="hint">Поменяется сразу во всех закупах, продажах и кампаниях — они ссылаются на контакт, а не на текст. Старый username останется в подсказках как прошлый. В рабочей версии смену заметит сессия аккаунта и обновит сама.</div>
    </div>
    <div class="hint" id="admHint"></div>
    <span class="sr-only" aria-live="polite" id="admLive"></span></div>`;
}

// ================= ВСЕ ОПЕРАЦИИ С КОНТАКТОМ =================
// Сделки в обе стороны: что я купил у него и что он купил у меня — для сверки и
// подсчёта, кто кому должен. Считаются «Договорились», «Вышел», «Завершён»;
// отметки об оплате в разделе нет, поэтому итог — сумма сделок, а не остаток долга.
let opsState = { id: null, period: 'all' };
// Обнуление («рассчитались») не трогает сделки: оно запоминает, какие операции
// вошли в расчёт, и дальше итог считает только остальные. В расчёт попадает то,
// что уже было в итоге; CPM без суммы и «В плане» дождутся следующего раза.
const SETTLE = {};
const settledIds = id => new Set((SETTLE[id] || []).flatMap(s => s.ids));
const isOpen = o => counts(o) && !o.settled;
// Подтверждение ловим на submit формы — он приходит сразу при нажатии кнопки,
// а событие close у диалога браузер может придержать (скрытая вкладка).
let confirmCb = null;
function confirmAsk(title, text, okLabel, onOk) {
  $('#confirmTitle').textContent = title; $('#confirmText').textContent = text; $('#confirmOk').textContent = okLabel;
  confirmCb = onOk;
  $('#confirmDlg').showModal();
}
$('#confirmDlg form').addEventListener('submit', e => {
  const cb = confirmCb; confirmCb = null;
  if (e.submitter?.value === 'ok' && cb) cb();
});
const contactOf = d => (d.side === 'buy' ? d.admin : d.buyer);
function opsList(id, period) {
  const inP = d => period === 'all' || d.date.startsWith(period);
  const mine = DEALS.filter(d => contactOf(d) === id && d.status !== 'cancel' && inP(d));
  const pk = new Map();
  for (const d of mine.filter(x => x.side === 'sell')) { if (!pk.has(d.pkg)) pk.set(d.pkg, []); pk.get(d.pkg).push(d); }
  const one = (ps, dir) => {
    const amts = ps.map(amountOf);
    return { dir, date: ps[0].date, slot: ps[0].slot, where: ps.map(x => x.project), amount: amts.some(v => v == null) ? null : amts.reduce((a, b) => a + b, 0),
      pm: ps[0].pm, rate: ps[0].rate, status: ps[0].status, id: ps[0].pkg ?? ps[0].id, est: ps.some(x => x.cpmState === 'failed') };
  };
  const closed = settledIds(id);
  return [...mine.filter(x => x.side === 'buy').map(d => one([d], 'in')), ...[...pk.values()].map(ps => one(ps, 'out'))]
    .map(o => ({ ...o, settled: closed.has(o.id) && o.amount != null }))
    .sort((x, y) => y.date.localeCompare(x.date) || SLOT[y.slot].i - SLOT[x.slot].i);
}
const counts = o => o.status === 'agreed' || isPub(o.status);
async function openOps(id) {
  id = Number(id);
  if (!ADMINS[id]) return;
  if ($('#dealDlg').open) $('#dealDlg').close();
  opsState = { id, period: 'all' };
  try { await loadSettlements(id); } catch (err) { toast(`Не удалось загрузить расчёты: ${err.message}`, 'warn'); }
  renderOps();
  if (!$('#opsDlg').open) $('#opsDlg').showModal();
}
// Обнуления хранит сервер; здесь — их копия для отрисовки.
async function loadSettlements(id) {
  const r = await api('GET', `/api/ads/contacts/${id}/ops`);
  SETTLE[id] = r.settlements.map(x => ({ sid: x.id, at: new Date(x.at), net: x.net, ids: x.ids }));
}
function opsTotals(ops) {
  const side = dir => {
    const xs = ops.filter(o => o.dir === dir && isOpen(o));
    return { n: xs.length, sum: xs.reduce((s, o) => s + (o.amount ?? 0), 0), pending: xs.filter(o => o.amount == null).length };
  };
  const i = side('in'), o = side('out');
  return { i, o, net: i.sum - o.sum };
}
function renderOps() {
  const { id, period } = opsState, a = ADMINS[id];
  const all = DEALS.filter(d => contactOf(d) === id && d.status !== 'cancel');
  const months = [...new Set(all.map(d => d.date.slice(0, 7)))].sort().reverse();
  const ops = opsList(id, period);
  const t = opsTotals(ops);
  const name = esc(a.name);
  const hist = SETTLE[id] || [], last = hist[hist.length - 1];
  const netLbl = v => (v > 0 ? `я должен ${rub(v)}` : v < 0 ? `мне должны ${rub(-v)}` : 'в ноль');
  const verdict = t.net > 0 ? `Я должен: <b class="mono">${rub(t.net)}</b>` : t.net < 0 ? `Мне должны: <b class="mono">${rub(-t.net)}</b>` : 'Взаимно в ноль';
  const pLbl = period === 'all' ? 'за всё время' : `за ${MON_NOM[Number(period.slice(5)) - 1].toLowerCase()} ${period.slice(0, 4)}`;
  // без склонения имён: «у Кот» звучит криво, а угадывать падеж нельзя
  const dirLbl = o => (o.dir === 'in' ? 'я купил' : 'купили у меня');
  const whereLbl = o => o.where.map(p => esc(PJ[p].mono)).join(' + ');
  const amtLbl = o => (o.amount == null ? `<span class="price-q">CPM ${int(o.rate)} ₽</span><span class="price-sub"> после фиксации</span>` : `${o.est ? '≈ ' : ''}${rub(o.amount)}`);
  const rowsHTML = state.narrow
    ? `<ul class="ops-m">${ops.map(o => `<li><button class="ops-it ${isOpen(o) ? '' : 'muted'}" type="button" data-act="open" data-id="${o.id}">
        <span class="ops-l1"><b class="mono">${dm(parseIso(o.date))}</b> · ${SLOT[o.slot].l} · ${whereLbl(o)}<span class="ops-amt mono">${amtLbl(o)}</span></span>
        <span class="ops-l2"><span class="op-dir ${o.dir}">${dirLbl(o)}</span><span>${o.settled ? '<span class="chip neutral">закрыто</span> ' : ''}${stChip(o.status)}</span></span></button></li>`).join('')}</ul>`
    : `<div class="tbl-wrap" style="padding:0;max-block-size:46vh"><table class="tbl list ops-tbl"><caption class="sr-only">Операции с ${name}</caption>
        <thead><tr><th scope="col">Дата</th><th scope="col">Кто кому</th><th scope="col">Где</th><th scope="col">Место</th><th scope="col" class="num">Сумма</th><th scope="col">Статус</th></tr></thead>
        <tbody>${ops.map(o => `<tr class="${isOpen(o) ? '' : 'is-plan'}" data-act="open" data-id="${o.id}">
          <th scope="row"><button class="row-btn mono" type="button" data-act="open" data-id="${o.id}">${dm(parseIso(o.date))}</button></th>
          <td><span class="op-dir ${o.dir}">${dirLbl(o)}</span></td><td>${whereLbl(o)}</td><td>${SLOT[o.slot].l}</td>
          <td class="num">${amtLbl(o)}</td><td>${stChip(o.status)}${o.settled ? ' <span class="chip neutral">закрыто</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`;
  $('#opsDlg').innerHTML = `
    <div class="m-head"><div><div class="m-eyebrow">все операции с контактом</div><h2 id="opsTitle">${esc(admLabel(id))}</h2>
      ${a.old?.length ? `<div class="m-chips"><span class="chip neutral">раньше ${a.old.map(o => `@${esc(o)}`).join(', ')}</span></div>` : ''}</div>
      <button class="x-btn" type="button" data-close aria-label="Закрыть">${ICON.x}</button></div>
    <div class="m-body">
      <div class="m-sec"><div class="seg sm ops-per" role="group" aria-label="Период">
        <button type="button" data-act="ops-period" data-v="all" aria-pressed="${period === 'all'}">Всё время</button>
        ${months.map(m => `<button type="button" data-act="ops-period" data-v="${m}" aria-pressed="${period === m}">${MON_NOM[Number(m.slice(5)) - 1]}</button>`).join('')}
      </div></div>
      <div class="ops-sum">
        <div class="ops-c in"><span class="ops-cl">Я купил</span><b class="mono">${rub(t.i.sum)}</b><span class="ops-cs">${t.i.n} ${plural(t.i.n, 'закуп', 'закупа', 'закупов')}${t.i.pending ? ` · ещё ${t.i.pending} по CPM без суммы` : ''}</span></div>
        <div class="ops-c out"><span class="ops-cl">Купили у меня</span><b class="mono">${rub(t.o.sum)}</b><span class="ops-cs">${t.o.n} ${plural(t.o.n, 'продажа', 'продажи', 'продаж')}${t.o.pending ? ` · ещё ${t.o.pending} по CPM без суммы` : ''}</span></div>
        <div class="ops-c net ${t.net > 0 ? 'owe' : t.net < 0 ? 'owed' : ''}"><span class="ops-cl">Итог ${pLbl}${last ? ' · после обнуления' : ''}</span><span class="ops-v">${verdict}</span><span class="ops-cs">${last ? `считается с обнуления ${dtLbl(last.at)}` : 'взаимозачёт: купленное минус проданное'}</span></div>
      </div>
      <p class="mnote">Считаются «Договорились», «Вышел» и «Завершён»; «В плане» показаны, но в итог не входят, отменённые скрыты. Рассчитались — нажмите «Обнулить»: итог станет 0, а сделки останутся в истории с пометкой «закрыто».</p>
      ${hist.length ? `<div class="m-sec"><div class="m-sec-h"><span class="card-idx">обнуления</span><h3>Расчёты</h3></div><ol class="settle">${[...hist].reverse().map((s, i) => `<li><time class="mono">${dmy(s.at)}, ${hmOf(s.at)}</time><span>было: ${netLbl(s.net)} · ${s.ids.length} ${plural(s.ids.length, 'операция', 'операции', 'операций')} закрыто</span>${i === 0 ? '<button class="adm-link" type="button" data-act="ops-undo">Отменить</button>' : ''}</li>`).join('')}</ol></div>` : ''}
      <div class="m-sec">${ops.length ? rowsHTML : `<p class="dl-empty" style="padding:6px 0">${pLbl[0].toUpperCase() + pLbl.slice(1)} операций нет.</p>`}</div>
    </div>
    <div class="m-foot"><button class="btn btn-ghost-danger" type="button" data-act="ops-reset" ${opsList(id, 'all').some(o => isOpen(o) && o.amount != null) ? '' : 'disabled'}>Обнулить</button><span class="sp"></span><button class="btn" type="button" data-act="ops-copy">Скопировать для сверки</button><button class="btn btn-primary" type="button" data-close>Готово</button></div>`;
}
function opsText() {
  const { id, period } = opsState, a = ADMINS[id];
  const ops = opsList(id, period).filter(isOpen), t = opsTotals(ops);
  const last = (SETTLE[id] || []).at(-1);
  const pLbl = period === 'all' ? 'всё время' : `${MON_NOM[Number(period.slice(5)) - 1]} ${period.slice(0, 4)}`;
  const lines = ops.map(o => `${dm(parseIso(o.date))} ${SLOT[o.slot].l} — ${o.dir === 'in' ? 'я купил' : 'купили у меня'}: ${o.where.map(p => PJ[p].mono).join(' + ')} — ${o.amount == null ? `CPM ${o.rate} ₽, сумма после фиксации` : `${o.est ? '≈ ' : ''}${rub(o.amount)}`} (${ST[o.status].l})`);
  const net = t.net > 0 ? `я должен ${rub(t.net)}` : t.net < 0 ? `мне должны ${rub(-t.net)}` : 'в ноль';
  return [`Сверка с ${admLabel(id)} · ${pLbl}${last ? ` · после расчёта ${dtLbl(last.at)}` : ''}`, ...lines, '', `Я купил: ${t.i.n} на ${rub(t.i.sum)}`, `Купили у меня: ${t.o.n} на ${rub(t.o.sum)}`, `Итог: ${net}`].join('\n');
}

// ================= АВТОПОДБОР АДМИНА =================
// Ищет по имени, по текущему и прошлым username; слово, набранное не в той
// раскладке («rjn» вместо «кот»), тоже находит. Это ARIA-комбобокс: стрелки
// двигают выбор, Enter выбирает, Escape закрывает список, не закрывая карточку.
const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU = 'йцукенгшщзхъфывапролджэячсмитьбюё';
const swapLayout = s => [...s].map(c => { let i = EN.indexOf(c); if (i >= 0) return RU[i]; i = RU.indexOf(c); return i >= 0 ? EN[i] : c; }).join('');
const hl = (text, i, len) => `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + len))}</mark>${esc(text.slice(i + len))}`;
const hueOf = s => [...String(s || '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

function admStats(id) {
  const ds = DEALS.filter(d => contactOf(d) === id && d.status !== 'cancel');
  const today = iso(TODAY);
  const past = ds.filter(d => d.date <= today);
  const buys = past.filter(d => d.side === 'buy').length, sells = new Set(past.filter(d => d.side === 'sell').map(d => d.pkg)).size;
  return { n: past.length, buys, sells, planned: ds.length - past.length, last: past.reduce((m, d) => (d.date > m ? d.date : m), ''), projects: [...new Set(ds.map(d => d.project))].sort() };
}
function admSearch(raw) {
  const q0 = raw.trim().toLowerCase().replace(/^@/, '');
  const ids = contactIds();
  const withStats = id => ({ id, st: admStats(id) });
  if (!q0) return ids.map(withStats).sort((a, b) => b.st.last.localeCompare(a.st.last)).slice(0, 8);
  const qs = [...new Set([q0, swapLayout(q0)])];
  const out = [];
  for (const id of ids) {
    const a = ADMINS[id], name = a.name.toLowerCase(), user = (a.user || '').toLowerCase();
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
    if (it.kind === 'new') return `<li role="option" id="admopt-${k}" class="cbx-opt new" data-k="${k}" aria-selected="false"><span class="cbx-plus" aria-hidden="true">＋</span><span class="cbx-main">Новый контакт <b>«${esc(it.q)}»</b></span></li>`;
    const a = ADMINS[it.id];
    const nm = it.field === 'name' ? hl(a.name, it.i, it.len) : esc(a.name);
    const us = it.field === 'user' ? hl(a.user, it.i, it.len) : esc(a.user);
    const oldMatch = it.field?.startsWith('old:') ? it.field.slice(4) : null;
    const old = oldMatch ? `<span class="cbx-old">раньше @${hl(oldMatch, it.i, it.len)}</span>` : a.old?.length ? `<span class="cbx-old dim">раньше @${esc(a.old[0])}</span>` : '';
    const st = it.st;
    return `<li role="option" id="admopt-${k}" class="cbx-opt" data-k="${k}" aria-selected="false">
      <span class="cbx-ini" style="--h:${hueOf(a.user || a.name)}" aria-hidden="true">${esc(a.name.slice(0, 1).toUpperCase())}</span>
      <span class="cbx-main"><span class="cbx-nm">${nm}</span>${a.user ? ` <span class="cbx-u">@${us}</span>` : ''}${old}</span>
      <span class="cbx-pj" aria-hidden="true">${st.projects.map(p => ava(p, 'sm')).join('')}</span>
      <span class="cbx-meta">${st.n ? [st.buys ? `${st.buys} ${plural(st.buys, 'закуп', 'закупа', 'закупов')}` : '', st.sells ? `${st.sells} ${plural(st.sells, 'продажа', 'продажи', 'продаж')}` : '', `последняя сделка ${dm(parseIso(st.last))}`].filter(Boolean).join(' · ') : 'сделок ещё не было'}${st.planned ? ` · ещё ${st.planned} впереди` : ''}</span></li>`;
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
  const id = Number($('#dealForm').elements.admin?.value) || null;
  const h = $('#admHint'); if (!h) return;
  h.innerHTML = id && ADMINS[id]
    ? `<button class="adm-link" type="button" data-act="ops" data-adm="${id}">Все операции с ${esc(ADMINS[id].name)}</button>${DEALS.some(d => d.side === 'buy' && d.admin === id) ? ` · <button class="adm-link" type="button" data-act="adv" data-adm="${id}">Кампании ↗</button>` : ''} · <button class="adm-link" type="button" data-act="ren">${ADMINS[id].user ? 'Сменил username' : 'Указать username'}</button>${ADMINS[id].old?.length ? ` · <span>раньше: ${ADMINS[id].old.map(o => `@${esc(o)}`).join(', ')}</span>` : ''}`
    : !$('#admNew').hidden ? 'Новый админ сразу появится в подсказках и во вкладке «Кампании»' : 'Начните вводить имя или @username — подскажу из знакомых';
}
// Новый контакт создаётся на сервере в момент сохранения сделки. Такой username
// уже у кого-то есть — это он и есть.
async function adminFromForm(f) {
  if (f.elements.admin.value) return Number(f.elements.admin.value);
  const name = $('#fNewName').value.trim(), user = $('#fNewUser').value.trim().replace(/^@/, '');
  const ex = contactIds().find(id => ADMINS[id].user && ADMINS[id].user.toLowerCase() === user.toLowerCase());
  if (ex) return ex;
  const res = await api('POST', '/api/ads/contacts', { name, username: user || null });
  const c = res.contact;
  ADMINS[c.id] = { name: c.name, user: c.username, old: [], tg: c.tgUserId };
  // повторное сохранение после ошибки не должно создать контакт второй раз
  f.elements.admin.value = c.id;
  $('#admNew').hidden = true; newRequired(false);
  $('#fWho').value = admLabel(c.id);
  if (res.notice) toast(res.notice, 'info');
  return c.id;
}
function admValidate(f) {
  const fw = $('#fWho'), nu = $('#fNewUser');
  if (!fw) return;
  fw.setCustomValidity(f.elements.admin.value || !$('#admNew').hidden ? '' : 'Выберите контакт из подсказок или добавьте нового');
  nu.setCustomValidity('');
  if (!$('#admNew').hidden && nu.value) {
    const u = nu.value.trim().replace(/^@/, '').toLowerCase();
    const was = contactIds().find(id => (ADMINS[id].old || []).some(o => o.toLowerCase() === u));
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
  if (editing.kind === 'sale') validateSale(f);
  if (!f.checkValidity()) { f.reportValidity(); return; }
  if (editing.kind === 'sale') { saveSale(f); return; }
  saveBuy(f);
});

async function saveBuy(f) {
  const { src, d } = editing;
  const el = f.elements;
  const unlock = lockForm(f);
  try {
    const contactId = await adminFromForm(f);
    const pm = el.pm.value;
    const body = {
      contactId, date: el.date.value, slot: el.slot.value, format: el.format.value, status: el.status.value,
      priceMode: pm, price: pm === 'fix' ? Number(el.price.value) : null, cpmRate: pm === 'cpm' ? Number(el.rate.value) : null,
      creative: el.creative.value.trim(), postUrl: el.post.value.trim(), notes: el.notes.value.trim(),
    };
    if (pm === 'cpm') {
      const v = el.views?.value.trim();
      if (v) Object.assign(body, { views: Number(v), cpmState: d.cpmState === 'failed' ? 'failed' : 'fixed' });
      else Object.assign(body, { views: null, cpmState: 'wait' });
    }
    const track = el.track.value.trim();
    let res, warning = null;
    if (!src) {
      body.projectId = Number(el.project.value);
      if (track) body.readyLink = track;
      res = await api('POST', '/api/ads/buys', body);
      warning = res.warning;
    } else {
      res = await api('PATCH', `/api/ads/buys/${src.dealId}`, body);
      if (track && track !== src.track) warning = (await api('POST', `/api/ads/buys/${src.dealId}/link`, { readyLink: track })).warning;
    }
    await reload();
    $('#dealDlg').close();
    toast(src ? `Закуп З-${res.buy.id} сохранён — цифры во всех видах пересчитаны` : `Закуп З-${res.buy.id} добавлен`);
    if (warning) toast(warning, 'warn');
  } catch (err) {
    // закуп мог сохраниться, а ссылка — нет: показываем то, что уже в базе
    if (src) reload().catch(() => {});
    showSaveError(err);
  } finally {
    unlock();
  }
}

function openDay(date, slot) {
  const day = parseIso(date);
  const ids = state.mode === 'buy' ? scopeIds() : [state.sellCh];
  const ds = DEALS.filter(d => d.side === state.mode && d.date === date && ids.includes(d.project) && (!slot || d.slot === slot))
    .sort((a, b) => SLOT[a.slot].i - SLOT[b.slot].i);
  const buy = state.mode === 'buy';
  $('#dayDlg').innerHTML = `<div class="m-head"><div><div class="m-eyebrow">${buy ? 'закупы' : 'продажи'} дня</div><h2 id="dayTitle">${DOW_FULL[day.getDay()].replace(/^./, c => c.toUpperCase())}, ${day.getDate()} ${MON_GEN[day.getMonth()]}${slot ? ` · ${SLOT[slot].l}` : ''}</h2></div>
    <button class="x-btn" type="button" data-close aria-label="Закрыть">${ICON.x}</button></div>
    ${ds.length ? `<ul class="daylist">${ds.map(d => `<li><button class="dl-it" type="button" data-act="open" data-id="${d.id}"><span class="when"><span class="chip slot">${SLOT[d.slot].l}</span></span><span class="who">${ava(d.project, 'sm')}<span>${admHTML(contactOf(d))}${buy ? '' : ` · ${esc(PJ[d.project].mono)}`}</span>${warnIcons(d)}</span><span class="rt">${priceHTML(d)}${stChip(d.status)}</span></button></li>`).join('')}</ul>` : `<p class="dl-empty">${buy ? 'В этот день закупов нет.' : 'В этот день продаж нет.'}</p>`}
    <div class="m-foot"><span class="sp"></span><button class="btn btn-primary" type="button" data-act="new" data-date="${date}" ${slot ? `data-slot="${slot}"` : ''} ${buy ? '' : `data-proj="${state.sellCh}"`}>${ICON.plus}Добавить на этот день</button></div>`;
  $('#dayDlg').showModal();
}

// ================= СОБЫТИЯ =================
document.addEventListener('click', async e => {
  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) { closeBtn.closest('dialog')?.close(); return; }
  const nav = e.target.closest('[data-nav]');
  if (nav) { location.href = `${dashPage()}?scr=${encodeURIComponent(nav.dataset.nav)}`; return; }
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  if (act === 'open') {
    if (t.tagName === 'TR' && e.target.closest('button')) return; // клик по кнопке внутри строки обработан ею
    e.preventDefault();
    $('#dayDlg').close(); $('#opsDlg').close(); if ($('#dealDlg').open) $('#dealDlg').close();
    openDeal(t.dataset.id);
  } else if (act === 'new') {
    $('#dayDlg').close();
    openDeal(null, { date: t.dataset.date, slot: t.dataset.slot, proj: t.dataset.proj });
  } else if (act === 'day') openDay(t.dataset.date);
  else if (act === 'cell') openDay(t.dataset.date, t.dataset.slot);
  else if (act === 'chan') { state.sellCh = Number(t.dataset.id); render(); }
  else if (act === 'goto-day') { state.view = 'day'; setDay(parseIso(t.dataset.date)); render(); $('#view').scrollIntoView({ block: 'start' }); }
  else if (act === 'pick-day') { setDay(parseIso(t.dataset.date)); render(); restoreFocus(`.dcal-day[data-date="${t.dataset.date}"]`); }
  else if (act === 'cal-month') { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + Number(t.dataset.d), 1); render(); }
  else if (act === 'today') { setDay(TODAY); render(); restoreFocus(`.dcal-day[data-date="${iso(TODAY)}"]`); }
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
    const gone = editing.kind === 'sale' ? editing.parts : [src];
    confirmAsk('Удалить сделку?',
      `${src.side === 'buy' ? 'Закуп' : 'Продажа'} ${src.pkg ?? src.id} от ${dm(parseIso(src.date))}${gone.length > 1 ? ` — во всех ${gone.length} каналах —` : ''} исчезнет из всех видов и итогов. Отменить это будет нельзя — если сделка просто сорвалась, лучше поставить статус «Отменён».${src.side === 'buy' && src.campaignId ? ' Кампания закупа со ссылкой уйдёт в корзину «Кампаний» — оттуда её можно восстановить.' : ''}`,
      'Удалить', async () => {
        try {
          await api('DELETE', src.side === 'buy' ? `/api/ads/buys/${src.dealId}` : `/api/ads/sales/${src.dealId}`);
          await reload();
          $('#dealDlg').close();
          toast(src.side === 'buy' ? `Закуп З-${src.dealId} удалён` : `Продажа П-${src.dealId} удалена`);
        } catch (err) { toast(err.message, 'warn'); }
      });
  } else if (act === 'ops') {
    e.preventDefault(); openOps(Number(t.dataset.adm));
  } else if (act === 'ops-period') {
    opsState.period = t.dataset.v; renderOps();
  } else if (act === 'ops-reset') {
    // в расчёт — только то, у чего есть сумма: CPM без фиксации дождётся следующего раза
    const id = opsState.id, open = opsList(id, 'all').filter(o => isOpen(o) && o.amount != null), tt = opsTotals(open);
    const was = tt.net > 0 ? `я должен ${rub(tt.net)}` : tt.net < 0 ? `мне должны ${rub(-tt.net)}` : 'в ноль';
    confirmAsk(`Обнулить расчёт: ${admLabel(id)}?`,
      `Сейчас итог за всё время: ${was} (${open.length} ${plural(open.length, 'операция', 'операции', 'операций')}).${opsState.period !== 'all' ? ' Обнуляется весь итог, а не только выбранный месяц.' : ''} После обнуления он станет 0. Сделки останутся в истории с пометкой «закрыто»; новые сделки, CPM без суммы и «В плане» войдут в следующий расчёт. Обнуление можно отменить.`,
      'Обнулить', async () => {
        try {
          // что именно закрыть, решает сервер — по тем же правилам, что итог выше
          const r = await api('POST', `/api/ads/contacts/${id}/settlements`);
          await loadSettlements(id);
          renderOps();
          const n = r.settlement.net;
          toast(`Обнулено — было: ${n > 0 ? `я должен ${rub(n)}` : n < 0 ? `мне должны ${rub(-n)}` : 'в ноль'}. Сделки остались в истории`);
        } catch (err) { toast(err.message, 'warn'); }
      });
  } else if (act === 'ops-undo') {
    const id = opsState.id, s = SETTLE[id]?.at(-1);
    if (!s) return;
    try {
      await api('DELETE', `/api/ads/settlements/${s.sid}`);
      await loadSettlements(id);
      renderOps();
      toast(`Обнуление от ${dtLbl(s.at)} отменено — эти операции снова в итоге`, 'info');
    } catch (err) { toast(err.message, 'warn'); }
  } else if (act === 'ops-copy') {
    navigator.clipboard.writeText(opsText()).then(() => toast('Сверка скопирована — можно вставить в чат с контактом'), () => toast('Не удалось скопировать: браузер не дал доступ к буферу', 'info'));
  } else if (act === 'split-even') {
    renderSplit(Number($('#sTotal').value), null);
  } else if (act === 'adv') {
    e.preventDefault();
    location.href = `${dashPage()}?scr=campaigns&contact=${encodeURIComponent(t.dataset.adm)}`;
  } else if (act === 'ren') {
    $('#admRename').hidden = false; $('#fRenUser').value = ''; $('#fRenUser').focus();
  } else if (act === 'ren-cancel') {
    $('#admRename').hidden = true; $('#fRenUser').setCustomValidity('');
  } else if (act === 'ren-ok') {
    const id = Number($('#dealForm').elements.admin.value), inp = $('#fRenUser');
    const u = inp.value.trim().replace(/^@/, '');
    const taken = contactIds().find(x => x !== id && ADMINS[x].user && ADMINS[x].user.toLowerCase() === u.toLowerCase());
    inp.setCustomValidity(!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(u) ? 'Username: 4–32 латинские буквы, цифры или _, начинается с буквы' : taken ? `@${u} уже у ${admLabel(taken)}` : u.toLowerCase() === (ADMINS[id].user || '').toLowerCase() ? 'Это и есть текущий username' : '');
    if (!inp.reportValidity()) return;
    const was = ADMINS[id].user;
    try {
      const r = await api('PATCH', `/api/ads/contacts/${id}`, { username: u });
      await reload();
      $('#fWho').value = admLabel(id);
      $('#admRename').hidden = true; admHint();
      toast(was ? `${r.contact.name} теперь @${u} — обновлено во всех сделках и кампаниях; по @${was} он по-прежнему находится` : `${r.contact.name}: username @${u} сохранён`);
      if (r.notice) toast(r.notice, 'info');
    } catch (err) { inp.setCustomValidity(err.message); inp.reportValidity(); }
  } else if (act === 'copy-track') {
    navigator.clipboard.writeText($('#fTr').value).then(() => toast('Ссылка скопирована — можно отправлять админу'), () => toast('Не удалось скопировать: браузер не дал доступ к буферу', 'info'));
  } else if (act === 'mint') {
    const src = editing?.src; if (!src) return;
    try {
      const r = await api('POST', `/api/ads/buys/${src.dealId}/link`, {});
      await reload();
      if (r.warning) toast(r.warning, 'warn');
      else { $('#dealDlg').close(); openDeal(src.id); toast('Ссылка создана'); }
    } catch (err) { toast(err.message, 'warn'); }
  } else if (act === 'retry') boot();
});
function restoreFocus(sel) { document.querySelector(sel)?.focus(); }

// Календарь дня с клавиатуры: стрелки — соседние дни и недели, PageUp/PageDown — месяц.
$('#view').addEventListener('keydown', e => {
  const b = e.target.closest('.dcal-day'); if (!b) return;
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
  let next = null;
  const cur = parseIso(b.dataset.date);
  if (step) next = addDays(cur, step);
  else if (e.key === 'PageUp' || e.key === 'PageDown') next = new Date(cur.getFullYear(), cur.getMonth() + (e.key === 'PageUp' ? -1 : 1), Math.min(cur.getDate(), 28));
  else if (e.key === 'Home') next = mondayOf(cur);
  else if (e.key === 'End') next = addDays(mondayOf(cur), 6);
  if (!next) return;
  e.preventDefault();
  setDay(next); render(); restoreFocus(`.dcal-day[data-date="${iso(next)}"]`);
});

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
bindSeg('#viewSeg', v => { if (v === 'day') setDay(TODAY); state.view = v; render(); });
$('#view').addEventListener('click', e => {
  const b = e.target.closest('[data-seg] button[data-v]'); if (!b) return;
  const seg = b.closest('[data-seg]').dataset.seg;
  if (seg === 'mxRows') state.mx.rows = b.dataset.v;
  if (seg === 'mxMetric') state.mx[state.mode] = b.dataset.v;
  if (seg === 'gridGroup') state.gridGroup = b.dataset.v;
  render();
});
$('#view').addEventListener('toggle', e => { if (e.target.id === 'addPop' && e.newState === 'open') placeFallback(e.target, document.querySelector('.add-btn'), 'start'); }, true);
function shift(dir) {
  if (state.view === 'day') setDay(addDays(state.day, dir));
  else if (state.period === 'week') state.anchor = addDays(state.anchor, 7 * dir);
  else if (state.period === 'month') state.anchor = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + dir, 1);
  else { const n = dayDiff(state.cTo, state.cFrom) + 1; state.cFrom = addDays(state.cFrom, n * dir); state.cTo = addDays(state.cTo, n * dir); }
  state.expanded = null; render();
}
$('#prevBtn').addEventListener('click', () => shift(-1));
$('#nextBtn').addEventListener('click', () => shift(1));
$('#cFrom').addEventListener('change', e => { if (e.target.value) { state.cFrom = parseIso(e.target.value); render(); } });
$('#cTo').addEventListener('change', e => { if (e.target.value) { state.cTo = parseIso(e.target.value); render(); } });
$('#newBtn').addEventListener('click', () => openDeal(null, state.view === 'day' ? { date: iso(state.day) } : {}));
$('#moreBtn').addEventListener('click', () => $('#moreDlg').showModal());
$('#refreshBtn').addEventListener('click', async e => {
  const b = e.currentTarget; b.classList.remove('spin'); void b.offsetWidth; b.classList.add('spin');
  try { await reload(); toast('Данные обновлены', 'info'); } catch (err) { toast(`Не удалось обновить: ${err.message}`, 'warn'); }
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
  el.innerHTML = `<span class="t-ic">${kind === 'ok' ? ICON.ok : kind === 'warn' ? ICON.warn : ICON.clock}</span><span>${esc(text)}</span>`;
  $('#toasts').append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 400); }, kind === 'warn' ? 6000 : 3200);
}

// Узкий режим: раскладку меняют контейнерные запросы, но сводке на телефоне
// нужна другая разметка, а диалогам (они вне контейнера) — признак на <html>.
new ResizeObserver(([entry]) => {
  const narrow = entry.contentRect.width < 760;
  document.documentElement.toggleAttribute('data-narrow', narrow);
  if (narrow !== state.narrow) { state.narrow = narrow; render(); if ($('#opsDlg').open) renderOps(); }
}).observe($('#frame'));

// Дашборд у мобильной версии свой: туда и ведут ссылки на остальные разделы.
const dashPage = () => (state.narrow ? '/mobile.html' : '/index.html');

async function reload() {
  await loadAll();
  render();
  if ($('#opsDlg').open) renderOps();
}
async function boot() {
  const wd = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  $('#tbEyebrow').textContent = `${wd} · tg-analytics`;
  state.status = 'loading'; render();
  try {
    await loadAll();
    state.status = 'ready';
    // ссылка из уведомления бота: ads.html?deal=З-12 открывает карточку сделки
    const want = new URLSearchParams(location.search).get('deal');
    if (want) {
      history.replaceState(null, '', location.pathname);
      const d = findDeal(want);
      if (d) {
        state.mode = d.side === 'buy' ? 'buy' : 'sell';
        setDay(parseIso(d.date)); state.anchor = parseIso(d.date);
        render(); openDeal(d.id);
      } else toast(`Сделка ${want} не найдена — возможно, её удалили`, 'warn');
    }
  } catch (err) {
    console.error('[ads] Failed to load:', err);
    state.status = 'error'; state.error = err.message;
  }
  render();
}
boot();
})();
