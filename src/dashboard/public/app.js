'use strict';
/* ================= АУТЕНТИФИКАЦИЯ ================= */
let currentApiKey = null;

function getApiKey() {
  if (!currentApiKey) {
    currentApiKey = prompt("Enter API Secret (X-API-Key):");
  }
  return currentApiKey;
}

function getHeaders() {
  return {
    "Content-Type": "application/json",
    "X-API-Key": getApiKey(),
  };
}

// Generic fetch wrapper: attaches auth headers to every request and resets
// currentApiKey on a 401 so the *next* action re-prompts for the key.
async function apiFetch(url, opts = {}) {
  const headers = { ...getHeaders(), ...(opts.headers || {}) };
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    currentApiKey = null;
  }
  return res;
}

async function fetchJSON(url, opts) {
  const res = await apiFetch(url, opts);
  if (!res.ok) {
    let msg = res.statusText || `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch {
      /* body wasn't JSON — keep statusText */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

/* ================= УТИЛИТЫ ================= */
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const fmtN = n => Math.round(n || 0).toLocaleString('ru-RU');
const fmtM = n => fmtN(n) + ' ₽';
const fmt1 = n => (Math.round((n || 0) * 10) / 10).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtPct = n => fmt1(n) + '%';
const plural = (n, a, b, c) => { n = Math.abs(n) % 100; const d = n % 10; if (n > 10 && n < 20) return c; if (d > 1 && d < 5) return b; if (d === 1) return a; return c; };
const pad2 = n => String(n).padStart(2, '0');
const dShort = dateStr => { const [, m, d] = dateStr.split('-'); return d + '.' + m; };
const dFull  = dateStr => { const [y, m, d] = dateStr.split('-'); return `${d}.${m}.${y}`; };
const dStamp = ts => { const d = new Date(ts); return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const dDate  = ts => { const d = new Date(ts); return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`; };

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* иконки */
const ic = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const IC = {
  up:ic('<path d="M7 17 17 7M9 7h8v8"/>'), x:ic('<path d="M6 6l12 12M18 6 6 18"/>'),
  check:ic('<path d="m5 12.5 4.5 4.5L19 7"/>'), warn:ic('<path d="M12 8v5m0 3.5v.01M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'),
  copy:ic('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  rub:ic('<path d="M7 20h7M7 16h7M7 4h4.5a4 4 0 0 1 0 8H7V4zm0 0v16"/>'),
  users:ic('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.7-3.2 3.3-5 6.5-5s5.8 1.8 6.5 5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M17.8 15.3c2 .7 3.3 2.2 3.7 4.7"/>'),
  target:ic('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
  cps:ic('<path d="M4 19h16M6 16V9m4 7V5m4 11v-5m4 5V8"/>'),
  zap:ic('<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>'),
  clock:ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'),
  play:ic('<path d="m7 5 12 7-12 7V5z"/>'),
  out:ic('<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M14 8l4 4-4 4m4-4H9"/>'),
  card:ic('<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 10h19"/>'),
  rot:ic('<path d="M20 11a8 8 0 1 0-2.3 6.3M20 4v4h-4"/>'),
  xcirc:ic('<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>')
};
const EV = {
  join:{l:'Заход',c:'#57B6FF',i:IC.users}, leave:{l:'Выход',c:'#FF6B7A',i:IC.out},
  lead:{l:'Лид',c:'#9B8CFF',i:IC.zap}, trial_start:{l:'Триал',c:'#7CC6FF',i:IC.play},
  payment:{l:'Оплата',c:'#3DDC97',i:IC.card}, renewal:{l:'Продление',c:'#3DDC97',i:IC.rot},
  churn:{l:'Отписка',c:'#FF6B7A',i:IC.xcirc}, join_request:{l:'Заявка на вход',c:'#FFB454',i:IC.clock}
};
const LT = {invite:{l:'Инвайт',cls:'t-invite'}, invite_closed:{l:'Закрытый',cls:'t-closed'}};
const FUNNEL_ENTRY_TYPES = ['join', 'lead', 'trial_start'];

function eventMeta(type) { return EV[type] || { l: type, c: '#8A94A6', i: IC.zap }; }
const hueBox = c => `background:${c}1f;color:${c};border:1px solid ${c}33`;
const rCls = v => v >= 70 ? 'r-good' : v >= 55 ? 'r-mid' : 'r-bad';

/* ================= СПАРКЛАЙН / АНИМАЦИИ ================= */
function spark(vals, color = '#57B6FF') {
  if (!vals || !vals.length) vals = [0, 0];
  const w = 92, h = 26, mn = Math.min(...vals), mx = Math.max(...vals), r = (mx - mn) || 1;
  const pts = vals.map((v, i) => [i / (vals.length - 1 || 1) * w, h - 3 - ((v - mn) / r) * (h - 7)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d} L ${w} ${h} L 0 ${h} Z" fill="${color}" opacity=".12"/><path class="spark-l" pathLength="1" d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}
function countUp(el, val, fmt) {
  if (RM) { el.textContent = fmt(val); return; }
  const t0 = performance.now(), dur = 900;
  (function f(t) { const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3); el.textContent = fmt(val * e); if (p < 1) requestAnimationFrame(f); })(t0);
}
function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast t-' + type;
  t.innerHTML = `<span class="t-ic">${type === 'ok' ? IC.check : type === 'warn' ? IC.warn : IC.zap}</span><span>${escapeHtml(msg)}</span>`;
  $('#toastRoot').appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 3400);
}

/* ================= ХРАНИЛИЩЕ ДАННЫХ ================= */
const DATA = {
  metrics: null,        // { campaigns, daily }
  extended: null,       // { campaigns, advertisers }
  projects: [],
  projectsById: {},
  recentEvents: [],
  byCampaignDate: new Map(),  // `${campaignId}|${date}` -> {subs,revenue}
  byDate: new Map(),          // date -> {subs,revenue} summed across all campaigns
  byAdvertiserDate: new Map(), // `${advertiser}|${date}` -> {subs,revenue}
  dateList: [],          // sorted ascending distinct dates present in daily
  histories: null,       // Map<campaignId, history> once loaded
  historiesPromise: null,
  utmLinks: [],          // /api/utm/links — independent UTM tracking, not campaign links
  utmSources: [],        // /api/utm/sources rollup
};

function buildIndexes() {
  DATA.byCampaignDate = new Map();
  DATA.byDate = new Map();
  DATA.byAdvertiserDate = new Map();
  for (const row of DATA.metrics.daily) {
    DATA.byCampaignDate.set(row.campaignId + '|' + row.date, row);
    const agg = DATA.byDate.get(row.date) || { subs: 0, revenue: 0 };
    agg.subs += row.subs; agg.revenue += row.revenue;
    DATA.byDate.set(row.date, agg);
    const advKey = row.advertiser + '|' + row.date;
    const advAgg = DATA.byAdvertiserDate.get(advKey) || { subs: 0, revenue: 0 };
    advAgg.subs += row.subs; advAgg.revenue += row.revenue;
    DATA.byAdvertiserDate.set(advKey, advAgg);
  }
  DATA.dateList = Array.from(DATA.byDate.keys()).sort();
}

async function loadCore() {
  const [metrics, extended, projects, recentEvents] = await Promise.all([
    fetchJSON('/api/metrics'),
    fetchJSON('/api/metrics/extended'),
    fetchJSON('/api/projects'),
    fetchJSON('/api/events/recent?limit=8'),
  ]);
  DATA.metrics = metrics;
  DATA.extended = extended;
  DATA.projects = projects;
  DATA.projectsById = Object.fromEntries(projects.map(p => [p.id, p]));
  DATA.recentEvents = recentEvents;
  buildIndexes();
  $('#nb-camp').textContent = extended.campaigns.length;
  $('#nb-proj').textContent = projects.length;
}

function invalidateHistories() {
  DATA.histories = null;
  DATA.historiesPromise = null;
}

// Fetches /api/campaigns/:id/history for every known campaign exactly once
// and caches the Map; reused by the Кампании (links mode) and
// Проекты screens instead of re-fetching per screen.
function getCampaignHistories() {
  if (!DATA.historiesPromise) {
    const ids = (DATA.extended?.campaigns || []).map(c => c.id);
    DATA.historiesPromise = Promise.all(
      ids.map(id => fetchJSON(`/api/campaigns/${id}/history`).catch(err => {
        console.error(`[dashboard] Failed to load history for campaign ${id}:`, err);
        return null;
      }))
    ).then(list => {
      const map = new Map();
      for (const h of list) if (h && h.campaign) map.set(h.campaign.id, h);
      DATA.histories = map;
      return map;
    });
  }
  return DATA.historiesPromise;
}

async function getCampaignHistory(id) {
  if (DATA.histories && DATA.histories.has(id)) return DATA.histories.get(id);
  const h = await fetchJSON(`/api/campaigns/${id}/history`);
  if (!DATA.histories) DATA.histories = new Map();
  DATA.histories.set(id, h);
  return h;
}

async function afterMutation() {
  await loadCore();
  invalidateHistories();
}

function last21Dates() { return DATA.dateList.slice(-21); }
function seriesForCampaign(campaignId, dates) {
  return dates.map(d => DATA.byCampaignDate.get(campaignId + '|' + d) || { subs: 0, revenue: 0 });
}

/* ---- окно периода (7д/14д/30д/Все) ---- */
function windowDates(period) {
  if (period === 'all') return DATA.dateList.slice();
  return DATA.dateList.slice(-period);
}
function prevWindowDates(period) {
  if (period === 'all') return null;
  const all = DATA.dateList;
  const start = all.length - 2 * period;
  if (start < 0) return null; // not enough history for a full previous window
  return all.slice(start, all.length - period);
}
function sumDates(dates) {
  return dates.reduce((acc, d) => {
    const v = DATA.byDate.get(d) || { subs: 0, revenue: 0 };
    acc.subs += v.subs; acc.revenue += v.revenue;
    return acc;
  }, { subs: 0, revenue: 0 });
}
function countActiveCampaigns(dates) {
  const dateSet = new Set(dates);
  const ids = new Set();
  for (const row of DATA.metrics.daily) {
    if (dateSet.has(row.date) && (row.subs > 0 || row.revenue > 0)) ids.add(row.campaignId);
  }
  return ids.size;
}

/* ---- разбивка кампании по ссылкам из реальных событий ---- */
function computeLinkStats(links, events) {
  return (links || []).map(l => {
    const linkEvents = (events || []).filter(e => e.linkId === l.id);
    const entryEvents = linkEvents.filter(e => FUNNEL_ENTRY_TYPES.includes(e.eventType));
    const joins = entryEvents.length;
    const subs = new Set(entryEvents.map(e => e.tgUserId)).size;
    const revenue = linkEvents
      .filter(e => e.eventType === 'payment' || e.eventType === 'renewal')
      .reduce((s, e) => s + (e.amount || 0), 0);
    return { link: l, joins, subs, revenue };
  });
}
// Best-effort split of a campaign's (contractually per-campaign) price across
// its links, proportional to revenue share, falling back to joins share.
function allocatePrice(linkStats, price) {
  const totalRevenue = linkStats.reduce((s, x) => s + x.revenue, 0);
  const totalJoins = linkStats.reduce((s, x) => s + x.joins, 0);
  return linkStats.map(x => {
    let share;
    if (totalRevenue > 0) share = x.revenue / totalRevenue;
    else if (totalJoins > 0) share = x.joins / totalJoins;
    else share = linkStats.length ? 1 / linkStats.length : 0;
    return { ...x, priceAlloc: price * share };
  });
}

async function computeLinkRows() {
  const histories = await getCampaignHistories();
  const rows = [];
  for (const camp of DATA.extended.campaigns) {
    const hist = histories.get(camp.id);
    if (!hist) continue;
    const linkStats = allocatePrice(computeLinkStats(hist.links, hist.events), camp.price);
    for (const stat of linkStats) {
      rows.push({
        campaign: camp,
        link: stat.link,
        joins: stat.joins,
        subs: stat.subs,
        revenue: stat.revenue,
        cps: stat.subs ? stat.priceAlloc / stat.subs : null,
        r24: camp.retention24h,
        url: linkDisplayUrl(stat.link),
        createdAt: hist.campaign?.createdAt || null,
      });
    }
  }
  return rows;
}

/* ---- URL ссылки для отображения ---- */
function linkDisplayUrl(link) {
  if (!link) return null;
  // telegramRef is already the full https://t.me/+... invite URL — never prepend anything.
  return link.telegramRef;
}

/* ================= СОСТОЯНИЕ UI ================= */
const state = { screen: 'overview', period: 30, mode: 'links', q: '' };
let chart = null;

/* ================= ОБЗОР ================= */
function renderKPIs() {
  const period = state.period;
  const dates = windowDates(period);
  const cur = sumDates(dates);
  const prevDates = prevWindowDates(period);
  const prev = prevDates ? sumDates(prevDates) : null;
  const cps = cur.subs ? cur.revenue / cur.subs : 0;
  const prevCps = prev && prev.subs ? prev.revenue / prev.subs : 0;

  const totalCampaigns = DATA.extended.campaigns.length;
  const totalPrice = DATA.extended.campaigns.reduce((s, c) => s + (c.price || 0), 0);
  const activeInCur = countActiveCampaigns(dates);
  const activeInPrev = prevDates ? countActiveCampaigns(prevDates) : null;

  const dl = (curVal, prevVal, goodUp = true) => {
    if (prevVal === null || prevVal === undefined) return '<span class="delta flat">нет пред. периода</span>';
    if (!prevVal) return '<span class="delta flat">новый период</span>';
    const p = (curVal - prevVal) / prevVal * 100, up = p >= 0, good = goodUp ? up : !up;
    return `<span class="delta ${good ? 'up' : 'dn'}">${up ? '+' : '−'}${fmt1(Math.abs(p))}%</span>`;
  };

  const sparkDates = dates.length ? dates : DATA.dateList;
  const sparkSubs = sparkDates.map(d => (DATA.byDate.get(d) || { subs: 0 }).subs);
  const sparkRev = sparkDates.map(d => (DATA.byDate.get(d) || { revenue: 0 }).revenue);
  const sparkCps = sparkDates.map(d => { const v = DATA.byDate.get(d) || { subs: 0, revenue: 0 }; return v.subs ? v.revenue / v.subs : 0; });

  const cards = [
    { lbl: 'Всего кампаний', icon: IC.target, c: '#57B6FF', val: totalCampaigns, fmt: fmtN,
      delta: prevDates ? dl(activeInCur, activeInPrev) : '<span class="delta flat">за весь период</span>',
      sub: `закупки на ${fmtM(totalPrice)}`, sparkV: sparkSubs },
    { lbl: 'Подписчики', icon: IC.users, c: '#9B8CFF', val: cur.subs, fmt: fmtN,
      delta: dl(cur.subs, prev ? prev.subs : null),
      sub: prev ? `${fmtN(prev.subs)} за пред. период` : 'за выбранный период', sparkV: sparkSubs },
    { lbl: 'Выручка', icon: IC.rub, c: '#3DDC97', val: cur.revenue, fmt: fmtM,
      delta: dl(cur.revenue, prev ? prev.revenue : null),
      sub: prev ? `${fmtM(prev.revenue)} за пред. период` : 'за выбранный период', sparkV: sparkRev },
    { lbl: 'Средний CPS', icon: IC.cps, c: '#FFB454', val: cps, fmt: v => fmt1(v) + ' ₽',
      delta: dl(cps, prev ? prevCps : null, false),
      sub: `выручка / подписчики · ${period === 'all' ? 'весь период' : period + ' дн'}`, sparkV: sparkCps },
  ];
  $('#kpis').innerHTML = cards.map((k, i) => `
    <article class="card kpi rv" style="--i:${i}">
      <div class="kpi-top"><span class="kpi-ic" style="${hueBox(k.c)}">${k.icon}</span><span class="kpi-lbl">${k.lbl}</span>${k.delta}</div>
      <div class="kpi-val" id="kpiv-${i}">—</div>
      <div class="kpi-sub">${k.sub}</div>
      <div class="kpi-spark">${spark(k.sparkV, k.c)}</div>
    </article>`).join('');
  cards.forEach((k, i) => countUp($('#kpiv-' + i), k.val, k.fmt));
}

function renderTop5() {
  const top = [...DATA.extended.campaigns].sort((a, b) => b.totalRevenue - a.totalRevenue).slice(0, 5);
  if (!top.length) {
    $('#top5').innerHTML = '<div style="padding:16px 18px;font-size:12px;color:var(--dim)">Нет кампаний с выручкой</div>';
    return;
  }
  const mx = Math.max(...top.map(c => c.totalRevenue), 1);
  $('#top5').innerHTML = top.map((c, i) => {
    const proj = DATA.projectsById[c.projectId];
    return `<div class="t5-row" data-c="${c.id}" style="cursor:pointer">
      <span class="t5-rank">0${i + 1}</span>
      <div style="min-width:0"><div class="t5-name">#${c.id} · ${escapeHtml(c.advertiser)}</div><div class="t5-adv">${escapeHtml(proj?.name || '—')}</div></div>
      <span class="t5-val">${fmtM(c.totalRevenue)}</span>
      <div class="t5-bar" style="grid-column:1/-1"><i style="--w:${Math.round(c.totalRevenue / mx * 100)}%"></i></div>
    </div>`;
  }).join('');
  $$('#top5 .t5-row').forEach(r => r.addEventListener('click', () => openCampaign(+r.dataset.c)));
  requestAnimationFrame(() => $('#top5').closest('.card').classList.add('in'));
}

function renderQuality() {
  const camps = DATA.extended.campaigns;
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const r24vals = camps.map(c => c.retention24h).filter(v => v !== null && v !== undefined);
  const r48vals = camps.map(c => c.retention48h).filter(v => v !== null && v !== undefined);
  const convvals = camps.map(c => c.purchaseConversion?.conversionPct).filter(v => v !== null && v !== undefined);
  const r24 = avg(r24vals) ?? 0, r48 = avg(r48vals) ?? 0, conv = avg(convvals) ?? 0;
  $('#convVal').textContent = convvals.length ? fmtPct(conv) : '—';
  $('#retCol').innerHTML = [
    ['Retention 24ч', r24, '#57B6FF', r24vals.length],
    ['Retention 48ч', r48, '#9B8CFF', r48vals.length],
    ['Конверсия в покупку', conv, '#3DDC97', convvals.length],
  ].map(x => `
    <div class="ret-row"><div class="ret-lbl"><span>${x[0]}</span><b>${x[3] ? fmtPct(x[1]) : '—'}</b></div>
    <div class="ret-bar"><i style="--w:${Math.min(100, x[1])}%;background:${x[2]}"></i></div></div>`).join('');
  const card = $('#retCol').closest('.card');
  requestAnimationFrame(() => { card.classList.add('in'); $('#convFg').style.strokeDashoffset = 238 - (238 * Math.min(conv, 100) / 100); });
}

function renderFeed() {
  const all = DATA.recentEvents || [];
  if (!all.length) {
    $('#feed').innerHTML = '<div style="padding:16px 18px;font-size:12px;color:var(--dim)">Событий пока нет</div>';
    return;
  }
  $('#feed').innerHTML = all.map(e => {
    const ev = eventMeta(e.eventType);
    return `<div class="feed-it"><span class="f-ic" style="${hueBox(ev.c)}">${ev.i}</span>
    <div class="f-tx"><b>${ev.l}</b> · ${escapeHtml(e.advertiser)}<span>${escapeHtml(e.linkLabel || e.telegramRef || '')} · ID ${escapeHtml(e.tgUserId)}${e.amount ? ` · ${fmt1(e.amount)} ₽` : ''}</span></div>
    <span class="f-time">${dStamp(e.ts)}</span></div>`;
  }).join('');
}

/* график */
function windowArrays() {
  const dates = windowDates(state.period);
  return {
    labels: dates.map(dShort),
    subs: dates.map(d => (DATA.byDate.get(d) || { subs: 0 }).subs),
    rev: dates.map(d => (DATA.byDate.get(d) || { revenue: 0 }).revenue),
    cps: dates.map(d => { const v = DATA.byDate.get(d) || { subs: 0, revenue: 0 }; return +(v.subs ? (v.revenue / v.subs).toFixed(2) : 0); }),
  };
}
function ensureChart() {
  if (!window.Chart) { $('#chartFallback').hidden = false; return; }
  if (chart) return;
  const cv = $('#mainChart'), ctx = cv.getContext('2d');
  const gA = ctx.createLinearGradient(0, 0, 0, 300); gA.addColorStop(0, 'rgba(87,182,255,.4)'); gA.addColorStop(1, 'rgba(87,182,255,.02)');
  const gG = ctx.createLinearGradient(0, 0, 0, 300); gG.addColorStop(0, 'rgba(61,220,151,.22)'); gG.addColorStop(1, 'rgba(61,220,151,0)');
  const w = windowArrays();
  chart = new Chart(ctx, { data: { labels: w.labels, datasets: [
    { type: 'bar', label: 'Подписки', data: w.subs, backgroundColor: gA, borderRadius: 3, barPercentage: .55, categoryPercentage: .72, yAxisID: 'y', order: 3 },
    { type: 'line', label: 'Выручка', data: w.rev, borderColor: '#3DDC97', backgroundColor: gG, fill: true, tension: .35, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, yAxisID: 'y1', order: 1 },
    { type: 'line', label: 'CPS', data: w.cps, borderColor: '#9B8CFF', borderDash: [4, 4], borderWidth: 1.6, tension: .35, pointRadius: 0, yAxisID: 'y2', hidden: true, order: 2 },
  ] }, options: {
    responsive: true, maintainAspectRatio: false, animation: RM ? false : { duration: 700, easing: 'easeOutQuart' },
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: '#0F1520', borderColor: 'rgba(255,255,255,.12)', borderWidth: 1, padding: 12, cornerRadius: 10,
      titleColor: '#E8EDF4', bodyColor: '#9AA5B8', bodyFont: { family: 'JetBrains Mono', size: 11 }, usePointStyle: true, boxWidth: 7, boxHeight: 7,
      callbacks: { label: c => ` ${c.dataset.label}: ` + (c.dataset.label === 'Выручка' ? fmtM(c.parsed.y) : c.dataset.label === 'CPS' ? c.parsed.y + ' ₽' : fmtN(c.parsed.y)) } } },
    scales: {
      x: { grid: { display: false }, ticks: { maxTicksLimit: 9, font: { family: 'JetBrains Mono', size: 10 }, color: '#5A6478' } },
      y: { position: 'left', grid: { color: 'rgba(255,255,255,.05)' }, ticks: { font: { family: 'JetBrains Mono', size: 10 }, color: '#5A6478' } },
      y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { family: 'JetBrains Mono', size: 10 }, color: 'rgba(61,220,151,.55)', callback: v => fmtN(v) + ' ₽' } },
      y2: { display: false },
    },
  } });
}
function refreshChart() {
  if (!chart) return;
  const w = windowArrays();
  chart.data.labels = w.labels;
  chart.data.datasets[0].data = w.subs; chart.data.datasets[1].data = w.rev; chart.data.datasets[2].data = w.cps;
  chart.update();
}

/* ================= КАМПАНИИ ================= */
function headLinks() { return `<tr><th>Ссылка</th><th>Рекламодатель</th><th>Тип</th><th class="num">Заходы</th><th class="num">Подписки</th><th class="num">Выручка</th><th class="num">CPS</th><th class="num">R24ч</th><th>Тренд</th></tr>`; }
function headAdv() { return `<tr><th>Рекламодатель</th><th class="num">Кампаний</th><th class="num">Закупки</th><th class="num">Подписки</th><th class="num">Выручка</th><th class="num">Ср. CPS</th><th class="num">ROI</th><th class="num">Ср. R24ч</th><th>Тренд</th></tr>`; }

function toggleEmpty(show) {
  const empty = $('#campEmpty');
  empty.classList.toggle('show', show);
  if (show) $('#campEmptyQ').textContent = '«' + state.q + '»';
  $('#campBody').style.display = show ? 'none' : '';
}

async function renderCampaigns() {
  const q = state.q.trim().toLowerCase();
  const head = $('#campHead'), body = $('#campBody');

  if (state.mode === 'links') {
    head.innerHTML = headLinks();
    $('#campCardSub').textContent = 'Каждая выданная рекламодателю ссылка и её вклад';
    body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--dim);padding:22px">Загрузка ссылок…</td></tr>`;

    const allRows = await computeLinkRows();
    if (state.mode !== 'links') return; // user switched mode while we were loading
    const trendDates = last21Dates();
    const rows = allRows.filter(r => !q
      || r.campaign.advertiser.toLowerCase().includes(q)
      || (r.link.label || '').toLowerCase().includes(q)
      || (r.link.telegramRef || '').toLowerCase().includes(q)
      || String(r.campaign.id).includes(q));

    $('#campCount').textContent = `${allRows.length} ссылок · ${DATA.extended.campaigns.length} кампаний`;
    state.campaignsView = { mode: 'links', rows };

    body.innerHTML = rows.map((r, i) => {
      const c = r.campaign, l = r.link;
      const trend = seriesForCampaign(c.id, trendDates).map(p => p.revenue);
      const ltMeta = LT[l.linkType] || { l: l.linkType, cls: 'neutral' };
      return `<tr data-c="${c.id}" style="--i:${i}">
        <td><div class="cell-main">${escapeHtml(l.label || 'без названия')}</div><div class="cell-sub">${r.url ? escapeHtml(r.url) : 'URL не определён'}</div></td>
        <td><div class="cell-main">${escapeHtml(c.advertiser)}</div><div class="cell-sub">#${c.id}${r.createdAt ? ' · ' + dDate(r.createdAt) : ''}</div></td>
        <td><span class="chip ${ltMeta.cls}">${escapeHtml(ltMeta.l)}</span></td>
        <td class="num">${fmtN(r.joins)}</td><td class="num">${fmtN(r.subs)}</td>
        <td class="num" style="color:var(--green)">${fmtM(r.revenue)}</td>
        <td class="num">${r.cps !== null ? fmt1(r.cps) + ' ₽' : '—'}</td>
        <td class="num ${r.r24 !== null && r.r24 !== undefined ? rCls(r.r24) : ''}">${r.r24 !== null && r.r24 !== undefined ? fmtPct(r.r24) : '—'}</td>
        <td class="trend">${spark(trend, '#57B6FF')}</td></tr>`;
    }).join('');
    toggleEmpty(rows.length === 0);
    body.querySelectorAll('tr[data-c]').forEach(tr => tr.addEventListener('click', () => openCampaign(+tr.dataset.c)));
  } else {
    head.innerHTML = headAdv();
    $('#campCardSub').textContent = 'Свёрнутые показатели по имени рекламодателя';
    const trendDates = last21Dates();
    const allRows = DATA.extended.advertisers.map(a => {
      const roi = a.totalPrice ? (a.totalRevenue / a.totalPrice * 100) : null;
      const trend = trendDates.map(d => (DATA.byAdvertiserDate.get(a.advertiser + '|' + d) || { revenue: 0 }).revenue);
      return { ...a, roi, trend };
    });
    const rows = allRows.filter(a => !q || a.advertiser.toLowerCase().includes(q)).sort((a, b) => b.totalRevenue - a.totalRevenue);
    $('#campCount').textContent = `${allRows.length} рекламодателей`;
    state.campaignsView = { mode: 'adv', rows };

    body.innerHTML = rows.map((a, i) => `<tr data-adv="${escapeHtml(a.advertiser)}" style="--i:${i}">
      <td><div class="cell-main">${escapeHtml(a.advertiser)}</div><div class="cell-sub">${a.campaignsCount} ${plural(a.campaignsCount, 'кампания', 'кампании', 'кампаний')}</div></td>
      <td class="num">${a.campaignsCount}</td><td class="num">${fmtM(a.totalPrice)}</td><td class="num">${fmtN(a.totalSubs)}</td>
      <td class="num" style="color:var(--green)">${fmtM(a.totalRevenue)}</td>
      <td class="num">${a.avgCps !== null && a.avgCps !== undefined ? fmt1(a.avgCps) + ' ₽' : '—'}</td>
      <td class="num ${a.roi === null ? '' : a.roi >= 100 ? 'r-good' : a.roi >= 70 ? 'r-mid' : 'r-bad'}">${a.roi === null ? '—' : fmtPct(a.roi)}</td>
      <td class="num ${a.avgRetention24h !== null && a.avgRetention24h !== undefined ? rCls(a.avgRetention24h) : ''}">${a.avgRetention24h !== null && a.avgRetention24h !== undefined ? fmtPct(a.avgRetention24h) : '—'}</td>
      <td class="trend">${spark(a.trend, '#3DDC97')}</td></tr>`).join('');
    toggleEmpty(rows.length === 0);
    body.querySelectorAll('tr[data-adv]').forEach(tr => tr.addEventListener('click', () => {
      const camp = DATA.extended.campaigns.find(c => c.advertiser === tr.dataset.adv);
      if (camp) openCampaign(camp.id);
    }));
  }
}

/* сегменты */
function segInit(seg, cb) {
  const thumb = seg.querySelector('.thumb');
  const place = b => { thumb.style.left = b.offsetLeft + 'px'; thumb.style.width = b.offsetWidth + 'px'; };
  seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    seg.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); place(b); cb(b);
  }));
  place(seg.querySelector('.on'));
  addEventListener('resize', () => place(seg.querySelector('.on')));
}
segInit($('#modeSeg'), b => { state.mode = b.dataset.m; renderCampaigns(); });
segInit($('#periodSeg'), b => { state.period = b.dataset.p === 'all' ? 'all' : +b.dataset.p; renderKPIs(); refreshChart(); });
$('#campSearch').addEventListener('input', e => { state.q = e.target.value; renderCampaigns(); });
$('#resetSearch').addEventListener('click', () => { state.q = ''; $('#campSearch').value = ''; renderCampaigns(); });
addEventListener('keydown', e => {
  if (e.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); $('#campSearch')?.focus(); }
  if (e.key === 'Escape') closeModal();
});

/* CSV */
function exportPrivatkasCsv() {
  const list = state.privatkasView;
  if (!list || !list.length) { toast('Нет данных для экспорта', 'warn'); return; }
  const rows = [];
  rows.push(['Приватка', 'Период', 'Доход', 'Средний чек', 'Платежи', 'Продления', 'Уникальные плательщики', 'ARPPU']);
  list.forEach(p => {
    [['Сегодня', p.today], ['7 дней', p.week], ['30 дней', p.month], ['Всё время', p.allTime]].forEach(([label, stats]) => {
      rows.push([p.projectName, label, stats.revenue, stats.avgCheck !== null ? stats.avgCheck.toFixed(2) : '', stats.paymentsCount, stats.renewalsCount, stats.uniquePayers, label === 'Всё время' ? (p.arppu !== null ? p.arppu.toFixed(2) : '') : '']);
    });
  });
  const blob = new Blob(['﻿' + rows.map(r => r.join(';')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'tg-analytics-privatkas.csv'; a.click();
  toast('CSV выгружен: ' + rows.length + ' строк', 'info');
}

$('#exportBtn').addEventListener('click', () => {
  if (state.screen === 'privatkas') { exportPrivatkasCsv(); return; }
  if (state.screen === 'utm') { exportUtmCsv(); return; }
  const view = state.campaignsView;
  if (!view || !view.rows.length) { toast('Нет данных для экспорта', 'warn'); return; }
  const rows = [];
  if (view.mode === 'links') {
    rows.push(['Ссылка', 'URL', 'Тип', 'Рекламодатель', 'Кампания', 'Заходы', 'Подписки', 'Выручка ₽', 'CPS ₽']);
    view.rows.forEach(r => rows.push([r.link.label || '', r.url || '', LT[r.link.linkType]?.l || r.link.linkType, r.campaign.advertiser, r.campaign.id, r.joins, r.subs, r.revenue, r.cps !== null ? r.cps.toFixed(2) : '']));
  } else {
    rows.push(['Рекламодатель', 'Кампаний', 'Закупки ₽', 'Подписки', 'Выручка ₽', 'Ср. CPS', 'ROI %']);
    view.rows.forEach(a => rows.push([a.advertiser, a.campaignsCount, a.totalPrice, a.totalSubs, a.totalRevenue, a.avgCps ?? '', a.roi !== null ? a.roi.toFixed(1) : '']));
  }
  const blob = new Blob(['﻿' + rows.map(r => r.join(';')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'tg-analytics-' + view.mode + '.csv'; a.click();
  toast('CSV выгружен: ' + rows.length + ' строк', 'info');
});

/* ================= МОДАЛКА КАМПАНИИ ================= */
async function openCampaign(campaignId) {
  const camp = DATA.extended.campaigns.find(c => c.id === campaignId);
  if (!camp) return;
  let hist;
  try {
    hist = await getCampaignHistory(campaignId);
  } catch (err) {
    toast(`Не удалось загрузить историю кампании: ${err.message}`, 'warn');
    return;
  }
  if (!hist) return;
  renderCampaignModal(camp, hist);
}

async function moveLink(linkId, targetCampaignId) {
  await fetchJSON(`/api/links/${linkId}/campaign`, { method: 'PATCH', body: JSON.stringify({ campaignId: targetCampaignId }) });
  await afterMutation();
}

function renderCampaignModal(camp, hist) {
  const links = hist.links || [];
  const events = hist.events || [];
  const tags = hist.tags || [];
  const linkStats = computeLinkStats(links, events);
  const totJoins = linkStats.reduce((s, x) => s + x.joins, 0);
  const totSubs = linkStats.reduce((s, x) => s + x.subs, 0);
  const totRevenue = linkStats.reduce((s, x) => s + x.revenue, 0);
  const proj = DATA.projectsById[camp.projectId];
  const createdAt = hist.campaign?.createdAt ? dDate(hist.campaign.createdAt) : '—';
  const otherCampaigns = DATA.extended.campaigns.filter(c => c.id !== camp.id).sort((a, b) => a.advertiser.localeCompare(b.advertiser));

  $('#modalRoot').innerHTML = `
  <div class="m-ov" id="mOv">
    <article class="modal" role="dialog" aria-modal="true">
      <header class="m-head">
        <div>
          <div class="m-eyebrow">Кампания #${camp.id} · создана ${createdAt}</div>
          <h2>${escapeHtml(camp.advertiser)}</h2>
          <div class="m-chips">
            <span class="chip ${proj?.type === 'channel' ? 't-proj' : 't-bot'}">${escapeHtml(proj?.name || '—')}</span>
            <span class="chip neutral mono">закупка ${fmtM(camp.price)}</span>
            <span class="chip neutral">${tags.length} ${plural(tags.length, 'тег', 'тега', 'тегов')}</span>
          </div>
        </div>
        <button class="x-btn" id="mClose">${IC.x}</button>
      </header>
      <div class="m-stats">
        <div class="m-stat"><b>${fmtN(totJoins)}</b><span>заходы</span></div>
        <div class="m-stat"><b>${fmtN(totSubs)}</b><span>подписки</span></div>
        <div class="m-stat"><b style="color:var(--green)">${fmtM(totRevenue)}</b><span>выручка</span></div>
        <div class="m-stat"><b>${totSubs ? fmt1(camp.price / totSubs) + ' ₽' : '—'}</b><span>CPS</span></div>
      </div>
      <div class="m-body">
        <section class="m-sec">
          <div class="m-sec-h"><span class="card-idx">01 / теги</span><h3>Разметка кампании</h3></div>
          <div class="tag-wrap" id="tagWrap">${tags.map(t => `<span class="tag">${escapeHtml(t.tagKey)}: <b>${escapeHtml(t.tagValue)}</b><button data-k="${escapeHtml(t.tagKey)}" title="Удалить тег">${IC.x}</button></span>`).join('') || '<span style="font-size:12px;color:var(--dim)">тегов нет</span>'}</div>
          <div class="tag-add">
            <input class="inp" id="tagKey" placeholder="ключ (напр. ниша)">
            <input class="inp" id="tagVal" placeholder="значение">
            <button class="btn tiny" id="tagAdd">${IC.check} Добавить</button>
          </div>
        </section>
        <section class="m-sec">
          <div class="m-sec-h"><span class="card-idx">02 / ссылки</span><h3>Выданные ссылки и перевес</h3></div>
          ${links.map(l => {
            const url = linkDisplayUrl(l);
            const stat = linkStats.find(x => x.link.id === l.id) || { joins: 0 };
            const ltMeta = LT[l.linkType] || { l: l.linkType, cls: 'neutral' };
            return `
          <div class="lk-row" data-l="${l.id}">
            <div class="lk-top">
              <span class="chip ${ltMeta.cls}">${escapeHtml(ltMeta.l)}</span>
              <span class="lk-txt"><b>${escapeHtml(l.label || 'без названия')}</b><span class="lk-url">${url ? escapeHtml(url) : 'URL не определён'}</span></span>
              <span class="chip neutral mono">${fmtN(stat.joins)} ${plural(stat.joins, 'заход', 'захода', 'заходов')}</span>
              ${url ? `<button class="btn tiny copy-btn" data-url="${escapeHtml(url)}">${IC.copy} Копировать</button>` : ''}
            </div>
            <div class="lk-move">
              <label>Перевесить на кампанию:</label>
              <select class="inp reassign">
                <option value="">— не выбрано —</option>
                ${otherCampaigns.map(x => `<option value="${x.id}">#${x.id} · ${escapeHtml(x.advertiser)}</option>`).join('')}
                <option value="__new">+ Создать новую кампанию…</option>
              </select>
              <button class="btn tiny btn-primary move-btn" hidden>${IC.check} Перевесить</button>
              <div class="newcamp" hidden>
                <input class="inp nc-adv" placeholder="Рекламодатель">
                <input class="inp price nc-price mono" placeholder="Цена, ₽">
                <button class="btn tiny btn-primary nc-go">Создать и перевесить</button>
              </div>
            </div>
          </div>`;
          }).join('') || '<div style="font-size:12px;color:var(--dim)">ссылок нет</div>'}
        </section>
        <section class="m-sec">
          <div class="m-sec-h"><span class="card-idx">03 / история</span><h3>События по ссылкам кампании</h3></div>
          <div class="tl">${events.length ? events.map(e => {
            const link = links.find(l => l.id === e.linkId);
            const ev = eventMeta(e.eventType);
            return `
            <div class="tl-it">
              <span class="tl-ic" style="--c:${ev.c}">${ev.i}</span>
              <div class="tl-tx"><b>${ev.l}</b><span>${escapeHtml(link?.label || 'без названия')} · ID ${escapeHtml(e.tgUserId)}</span></div>
              <div class="tl-meta">${e.amount ? `<span class="amt">+${fmt1(e.amount)} ₽</span>` : ''}${dStamp(e.ts)}</div>
            </div>`;
          }).join('') : '<div style="font-size:12px;color:var(--dim);padding:8px 0">событий нет</div>'}
          </div>
        </section>
      </div>
    </article>
  </div>`;

  const ov = $('#mOv');
  requestAnimationFrame(() => ov.classList.add('show'));
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });
  $('#mClose').addEventListener('click', closeModal);

  ov.querySelectorAll('#tagWrap button').forEach(b => b.addEventListener('click', async () => {
    const key = b.dataset.k;
    try {
      await fetchJSON(`/api/campaigns/${camp.id}/tags/${encodeURIComponent(key)}`, { method: 'DELETE' });
      toast(`Тег «${key}» удалён`, 'warn');
      await afterMutation();
      await renderCurrentScreen();
      await openCampaign(camp.id);
    } catch (err) { toast(`Не удалось удалить тег: ${err.message}`, 'warn'); }
  }));
  $('#tagAdd').addEventListener('click', async () => {
    const k = $('#tagKey').value.trim(), v = $('#tagVal').value.trim();
    if (!k || !v) { toast('Заполните ключ и значение тега', 'warn'); return; }
    try {
      await fetchJSON(`/api/campaigns/${camp.id}/tags/${encodeURIComponent(k)}`, { method: 'PUT', body: JSON.stringify({ tagValue: v }) });
      toast(`Тег «${k}: ${v}» добавлен`);
      await afterMutation();
      await renderCurrentScreen();
      await openCampaign(camp.id);
    } catch (err) { toast(`Не удалось добавить тег: ${err.message}`, 'warn'); }
  });

  ov.querySelectorAll('.copy-btn').forEach(b => b.addEventListener('click', () => {
    navigator.clipboard?.writeText(b.dataset.url).catch(() => {});
    toast('Ссылка скопирована в буфер', 'info');
  }));

  ov.querySelectorAll('.lk-row').forEach(row => {
    const linkId = +row.dataset.l;
    const sel = row.querySelector('.reassign'), mv = row.querySelector('.move-btn'), nc = row.querySelector('.newcamp');
    sel.addEventListener('change', () => {
      mv.hidden = !(sel.value && sel.value !== '__new');
      nc.hidden = sel.value !== '__new';
    });
    mv.addEventListener('click', async () => {
      const targetId = Number(sel.value);
      if (!targetId) return;
      try {
        await moveLink(linkId, targetId);
        const target = DATA.extended.campaigns.find(c => c.id === targetId);
        toast(`Ссылка перевешена на #${targetId}${target ? ' · ' + target.advertiser : ''}`);
        await renderCurrentScreen();
        await openCampaign(camp.id);
      } catch (err) { toast(`Не удалось перевесить ссылку: ${err.message}`, 'warn'); }
    });
    row.querySelector('.nc-go').addEventListener('click', async () => {
      const adv = row.querySelector('.nc-adv').value.trim();
      const price = Number(row.querySelector('.nc-price').value);
      if (!adv || !Number.isFinite(price)) { toast('Укажите рекламодателя и цену', 'warn'); return; }
      try {
        const newCamp = await fetchJSON('/api/campaigns', { method: 'POST', body: JSON.stringify({ projectId: camp.projectId, advertiser: adv, price }) });
        await moveLink(linkId, newCamp.id);
        toast(`Создана кампания #${newCamp.id} · ${adv}, ссылка перевешена`);
        await renderCurrentScreen();
        await openCampaign(newCamp.id);
      } catch (err) { toast(`Не удалось создать кампанию: ${err.message}`, 'warn'); }
    });
  });
}
function closeModal() {
  const ov = $('#mOv'); if (!ov) return;
  ov.classList.remove('show');
  setTimeout(() => { const root = $('#modalRoot'); if (root) root.innerHTML = ''; }, 220);
}

/* ================= ПРОЕКТЫ ================= */
function typeLabel(t) { return t === 'channel' ? 'Канал' : 'Бот-приватка'; }
function typeChipClass(t) { return t === 'channel' ? 't-proj' : 't-bot'; }
function identOf(p) { return p.type === 'channel' ? (p.telegramChatId || '—') : (p.botUsername || '—'); }

async function renderProjects() {
  const list = DATA.projects;
  $('#projSub').textContent = `${list.length} ${plural(list.length, 'проект', 'проекта', 'проектов')} · каналы и боты-приватки`;

  const campCountByProject = {};
  for (const c of DATA.extended.campaigns) campCountByProject[c.projectId] = (campCountByProject[c.projectId] || 0) + 1;

  function paint(linkCounts) {
    $('#projBody').innerHTML = list.map((p, i) => {
      const linked = p.linkedProjectId ? DATA.projectsById[p.linkedProjectId] : null;
      const linksCount = linkCounts ? (linkCounts[p.id] ?? 0) : '…';
      return `<tr style="--i:${i}">
        <td><div class="cell-main">${escapeHtml(p.name)}</div></td>
        <td><span class="chip ${typeChipClass(p.type)}">${typeLabel(p.type)}</span></td>
        <td class="mono" style="font-size:12px">${escapeHtml(identOf(p))}</td>
        <td style="font-size:12px;color:var(--muted)">${linked ? escapeHtml(linked.name) : '—'}</td>
        <td class="num">${campCountByProject[p.id] || 0}</td><td class="num">${linksCount}</td>
      </tr>`;
    }).join('');
  }
  paint(null);

  $('#f-link').innerHTML = '<option value="">— без связи —</option>' + list.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  try {
    const histories = await getCampaignHistories();
    const linkCounts = {};
    for (const c of DATA.extended.campaigns) {
      const hist = histories.get(c.id);
      linkCounts[c.projectId] = (linkCounts[c.projectId] || 0) + (hist?.links?.length || 0);
    }
    paint(linkCounts);
  } catch (err) {
    console.error('[dashboard] Failed to load link counts for projects:', err);
  }
}

$('#f-type').addEventListener('change', e => {
  $('#fldChat').hidden = e.target.value !== 'channel';
  $('#fldBot').hidden = e.target.value === 'channel';
});
$('#projForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#f-name').value.trim();
  const type = $('#f-type').value;
  const chatId = $('#f-chat').value.trim();
  const botUsername = $('#f-bot').value.trim();
  const linkTarget = $('#f-link').value;
  if (!name) { toast('Укажите название проекта', 'warn'); return; }
  if (type === 'channel' && !chatId) { toast('Укажите Chat ID канала', 'warn'); return; }
  if (type === 'bot_subscription' && !botUsername) { toast('Укажите username бота', 'warn'); return; }

  try {
    const body = { name, type };
    if (type === 'channel') body.telegramChatId = chatId; else body.botUsername = botUsername;
    const project = await fetchJSON('/api/projects', { method: 'POST', body: JSON.stringify(body) });

    let linkMsg = '';
    if (linkTarget) {
      try {
        await fetchJSON(`/api/projects/${project.id}/link-privatka`, { method: 'PATCH', body: JSON.stringify({ linkedProjectId: Number(linkTarget) }) });
        const lp = DATA.projectsById[Number(linkTarget)];
        linkMsg = lp ? ` и связан с «${lp.name}»` : '';
      } catch (err) {
        toast(`Проект создан, но связка не удалась: ${err.message}`, 'warn');
      }
    }

    e.target.reset();
    $('#fldChat').hidden = false; $('#fldBot').hidden = true;
    await loadCore();
    await renderProjects();
    toast(`Проект «${name}» добавлен${linkMsg}`);
  } catch (err) {
    toast(`Не удалось создать проект: ${err.message}`, 'warn');
  }
});

/* ================= UTM-МЕТКИ =================
   Independent tracking mechanic — separate from campaigns/links (channel-invite
   ad attribution). Do not conflate: a "UTM link" here has no relation to a
   campaign link row, it's tracked purely by utm_source/medium/campaign/content. */
function roiCls(v) { if (v === null || v === undefined) return ''; return v >= 100 ? 'r-good' : v >= 70 ? 'r-mid' : 'r-bad'; }
function convCell(pct) {
  if (pct === null || pct === undefined) return '<span style="color:var(--dim)">—</span>';
  return `<div class="convcell"><span class="mono" style="font-size:12px">${fmtPct(pct)}</span><div class="bar"><i style="width:${Math.min(100, pct)}%"></i></div></div>`;
}
function fmtHours(h) {
  if (h === null || h === undefined) return '—';
  if (h < 24) return fmt1(h) + 'ч';
  const days = Math.floor(h / 24), rem = Math.round(h % 24);
  return rem ? `${days}д ${rem}ч` : `${days}д`;
}

function renderUtmKpis(links) {
  const sum = key => links.reduce((s, l) => s + (l[key] || 0), 0);
  const starts = sum('starts'), uniqueStarts = sum('uniqueStarts'), purchases = sum('purchases'), revenue = sum('revenue');
  const uniquePurchasers = sum('uniquePurchasers');
  const conv = uniqueStarts ? uniquePurchasers / uniqueStarts * 100 : null;
  const cards = [
    { lbl: 'Заходы', icon: IC.users, c: '#57B6FF', val: fmtN(starts), sub: `уникальных: ${fmtN(uniqueStarts)}` },
    { lbl: 'Уникальные заходы', icon: IC.target, c: '#9B8CFF', val: fmtN(uniqueStarts), sub: `${links.length} ${plural(links.length, 'метка', 'метки', 'меток')}` },
    { lbl: 'Покупки', icon: IC.card, c: '#FFB454', val: fmtN(purchases), sub: `конверсия: ${conv !== null ? fmtPct(conv) : '—'}` },
    { lbl: 'Выручка', icon: IC.rub, c: '#3DDC97', val: fmtM(revenue), sub: `уник. плательщиков: ${fmtN(uniquePurchasers)}` },
  ];
  $('#utmKpis').innerHTML = cards.map((k, i) => `
    <article class="card kpi rv" style="--i:${i}">
      <div class="kpi-top"><span class="kpi-ic" style="${hueBox(k.c)}">${k.icon}</span><span class="kpi-lbl">${k.lbl}</span></div>
      <div class="kpi-val">${k.val}</div>
      <div class="kpi-sub">${k.sub}</div>
    </article>`).join('');
}

function renderUtmSources(sources) {
  if (!sources.length) {
    $('#utmSourcesBody').innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--dim);padding:22px">Источников пока нет</td></tr>`;
    return;
  }
  const sorted = [...sources].sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
  $('#utmSourcesBody').innerHTML = sorted.map((s, i) => `<tr style="--i:${i};cursor:default">
    <td><div class="cell-main">${escapeHtml(s.utmSource)}</div></td>
    <td class="num">${fmtN(s.linksCount)}</td>
    <td class="num">${fmtN(s.starts)}</td>
    <td class="num">${fmtN(s.uniqueStarts)}</td>
    <td class="num">${fmtN(s.purchases)}</td>
    <td>${convCell(s.conversionPct)}</td>
    <td class="num" style="color:var(--green)">${fmtM(s.revenue)}</td>
    <td class="num">${s.cac !== null && s.cac !== undefined ? fmt1(s.cac) + ' ₽' : '—'}</td>
    <td class="num ${roiCls(s.roi)}">${s.roi !== null && s.roi !== undefined ? fmtPct(s.roi) : '—'}</td>
    <td class="num">${s.renewalRatePct !== null && s.renewalRatePct !== undefined ? fmtPct(s.renewalRatePct) : '—'}</td>
  </tr>`).join('');
}

function renderUtmLinksTable(links) {
  $('#utmLinksSub').textContent = `${links.length} ${plural(links.length, 'ссылка', 'ссылки', 'ссылок')}`;
  const empty = $('#utmEmpty'), body = $('#utmLinksBody');
  if (!links.length) {
    empty.classList.add('show');
    body.style.display = 'none';
    body.innerHTML = '';
    return;
  }
  empty.classList.remove('show');
  body.style.display = '';
  const sorted = [...links].sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
  body.innerHTML = sorted.map((l, i) => `<tr data-id="${l.id}" style="--i:${i}">
    <td><div class="cell-main">${escapeHtml(l.label || l.slug)}</div><div class="cell-sub">${escapeHtml(l.utmSource)}/${escapeHtml(l.utmMedium)}/${escapeHtml(l.utmCampaign)}</div></td>
    <td class="num">${fmtN(l.starts)}</td>
    <td class="num">${fmtN(l.uniqueStarts)}</td>
    <td class="num">${fmtN(l.purchases)}</td>
    <td>${convCell(l.conversionPct)}</td>
    <td class="num" style="color:var(--green)">${fmtM(l.revenue)}</td>
    <td class="num">${l.cac !== null && l.cac !== undefined ? fmt1(l.cac) + ' ₽' : '—'}</td>
    <td class="num ${roiCls(l.roi)}">${l.roi !== null && l.roi !== undefined ? fmtPct(l.roi) : '—'}</td>
    <td class="num">${l.renewalRatePct !== null && l.renewalRatePct !== undefined ? fmtPct(l.renewalRatePct) : '—'}</td>
    <td class="mono" style="font-size:12px">${fmtHours(l.medianTimeToPurchaseHours)}</td>
  </tr>`).join('');
  $$('#utmLinksBody tr[data-id]').forEach(tr => tr.addEventListener('click', () => openUtmLink(+tr.dataset.id)));
}

async function renderUtm() {
  let links, sources;
  try {
    [links, sources] = await Promise.all([
      fetchJSON('/api/utm/links'),
      fetchJSON('/api/utm/sources'),
    ]);
  } catch (err) {
    toast(`Не удалось загрузить UTM-метки: ${err.message}`, 'warn');
    links = []; sources = [];
  }
  DATA.utmLinks = links;
  DATA.utmSources = sources;
  $('#nb-utm').textContent = links.length;
  renderUtmKpis(links);
  renderUtmSources(sources);
  renderUtmLinksTable(links);
}

function showUtmResult(value, kind) {
  const box = $('#utmResult');
  box.hidden = false;
  box.innerHTML = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
    <span>${kind === 'link' ? 'Диплинк создан:' : 'Slug создан:'}</span>
    <span class="mono" style="color:var(--accent)">${escapeHtml(value)}</span>
    <button class="btn tiny copy-btn" type="button" data-url="${escapeHtml(value)}">${IC.copy} Копировать</button>
  </div>`;
  box.querySelector('.copy-btn').addEventListener('click', () => {
    navigator.clipboard?.writeText(value).catch(() => {});
    toast('Скопировано в буфер', 'info');
  });
}

$('#utmForm').addEventListener('submit', async e => {
  e.preventDefault();
  const utmSource = $('#u-source').value.trim();
  const utmMedium = $('#u-medium').value.trim();
  const utmCampaign = $('#u-campaign').value.trim();
  const utmContent = $('#u-content').value.trim();
  const label = $('#u-label').value.trim();
  const spendRaw = $('#u-spend').value.trim();
  const slug = $('#u-slug').value.trim();
  let botUsername = $('#u-bot').value.trim();
  if (botUsername.startsWith('@')) botUsername = botUsername.slice(1);
  if (!utmSource || !utmMedium || !utmCampaign) { toast('Заполните источник, канал и кампанию', 'warn'); return; }

  const body = { utmSource, utmMedium, utmCampaign };
  if (utmContent) body.utmContent = utmContent;
  if (label) body.label = label;
  if (spendRaw) {
    const spend = Number(spendRaw);
    if (!Number.isFinite(spend) || spend < 0) { toast('Бюджет должен быть неотрицательным числом', 'warn'); return; }
    body.spend = spend;
  }
  if (slug) body.slug = slug;
  if (botUsername) body.botUsername = botUsername;

  try {
    const created = await fetchJSON('/api/utm/links', { method: 'POST', body: JSON.stringify(body) });
    e.target.reset();
    if (created.deepLink) showUtmResult(created.deepLink, 'link');
    else showUtmResult(created.slug, 'slug');
    toast(`UTM-ссылка «${created.slug}» создана`);
    await renderUtm();
  } catch (err) {
    toast(`Не удалось создать UTM-ссылку: ${err.message}`, 'warn');
  }
});

async function openUtmLink(id) {
  let detail;
  try {
    detail = await fetchJSON(`/api/utm/links/${id}`);
  } catch (err) {
    toast(`Не удалось загрузить UTM-ссылку: ${err.message}`, 'warn');
    return;
  }
  renderUtmModal(detail);
}

function renderUtmModal(l) {
  const deepLink = l.deepLink || null;
  const series = l.dailySeries || [];
  $('#modalRoot').innerHTML = `
  <div class="m-ov" id="mOv">
    <article class="modal" role="dialog" aria-modal="true">
      <header class="m-head">
        <div>
          <div class="m-eyebrow">UTM-ссылка · создана ${l.createdAt ? dDate(l.createdAt) : '—'}</div>
          <h2>${escapeHtml(l.label || l.slug)}</h2>
          <div class="m-chips">
            <span class="chip neutral mono">${escapeHtml(l.utmSource)}</span>
            <span class="chip neutral mono">${escapeHtml(l.utmMedium)}</span>
            <span class="chip neutral mono">${escapeHtml(l.utmCampaign)}</span>
            ${l.utmContent ? `<span class="chip neutral mono">${escapeHtml(l.utmContent)}</span>` : ''}
          </div>
        </div>
        <button class="x-btn" id="mClose">${IC.x}</button>
      </header>
      <div class="m-stats">
        <div class="m-stat"><b>${fmtN(l.starts)}</b><span>заходы</span></div>
        <div class="m-stat"><b>${fmtN(l.purchases)}</b><span>покупки</span></div>
        <div class="m-stat"><b style="color:var(--green)">${fmtM(l.revenue)}</b><span>выручка</span></div>
        <div class="m-stat"><b>${l.conversionPct !== null && l.conversionPct !== undefined ? fmtPct(l.conversionPct) : '—'}</b><span>конверсия</span></div>
      </div>
      <div class="m-body">
        <section class="m-sec">
          <div class="m-sec-h"><span class="card-idx">01 / метрики</span><h3>Дополнительные показатели</h3></div>
          <div style="display:flex;gap:22px;flex-wrap:wrap;font-size:12.5px;color:var(--muted)">
            <div>CAC: <b class="mono" style="color:var(--text)">${l.cac !== null && l.cac !== undefined ? fmt1(l.cac) + ' ₽' : '—'}</b></div>
            <div>ROI: <b class="mono ${roiCls(l.roi)}">${l.roi !== null && l.roi !== undefined ? fmtPct(l.roi) : '—'}</b></div>
            <div>Продления: <b class="mono" style="color:var(--text)">${l.renewalRatePct !== null && l.renewalRatePct !== undefined ? fmtPct(l.renewalRatePct) : '—'}</b> (${fmtM(l.renewalsRevenue || 0)})</div>
            <div>Медиана до покупки: <b class="mono" style="color:var(--text)">${fmtHours(l.medianTimeToPurchaseHours)}</b></div>
            <div>Бюджет: <b class="mono" style="color:var(--text)">${l.spend !== null && l.spend !== undefined ? fmtM(l.spend) : '—'}</b></div>
          </div>
        </section>
        <section class="m-sec">
          <div class="m-sec-h"><span class="card-idx">02 / динамика</span><h3>Заходы и выручка за 30 дней</h3></div>
          <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
            <div style="flex:1;min-width:200px">${spark(series.map(d => d.starts), '#57B6FF')}<div style="font-size:10.5px;color:var(--dim);margin-top:4px">Заходы</div></div>
            <div style="flex:1;min-width:200px">${spark(series.map(d => d.revenue), '#3DDC97')}<div style="font-size:10.5px;color:var(--dim);margin-top:4px">Выручка</div></div>
          </div>
        </section>
        <section class="m-sec">
          <div class="m-sec-h"><span class="card-idx">03 / диплинк</span><h3>Ссылка для трафика</h3></div>
          <div class="lk-row">
            <div class="lk-top">
              <span class="lk-txt"><b>${escapeHtml(l.slug)}</b>${deepLink ? `<span class="lk-url">${escapeHtml(deepLink)}</span>` : '<span class="lk-url">username бота не указан — используйте slug вручную</span>'}</span>
              <button class="btn tiny copy-btn" data-url="${escapeHtml(deepLink || l.slug)}">${IC.copy} Копировать</button>
            </div>
          </div>
        </section>
      </div>
    </article>
  </div>`;
  const ov = $('#mOv');
  requestAnimationFrame(() => ov.classList.add('show'));
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });
  $('#mClose').addEventListener('click', closeModal);
  ov.querySelectorAll('.copy-btn').forEach(b => b.addEventListener('click', () => {
    navigator.clipboard?.writeText(b.dataset.url).catch(() => {});
    toast('Скопировано в буфер', 'info');
  }));
}

function exportUtmCsv() {
  const list = DATA.utmLinks;
  if (!list || !list.length) { toast('Нет данных для экспорта', 'warn'); return; }
  const rows = [];
  rows.push(['Slug', 'Источник', 'Канал', 'Кампания', 'Контент', 'Название', 'Заходы', 'Уникальные', 'Покупки', 'Выручка ₽', 'Конверсия %', 'CAC', 'ROI %', 'Продления %', 'Медиана до покупки, ч']);
  list.forEach(l => rows.push([l.slug, l.utmSource, l.utmMedium, l.utmCampaign, l.utmContent || '', l.label || '', l.starts, l.uniqueStarts, l.purchases, l.revenue, l.conversionPct ?? '', l.cac ?? '', l.roi ?? '', l.renewalRatePct ?? '', l.medianTimeToPurchaseHours ?? '']));
  const blob = new Blob(['﻿' + rows.map(r => r.join(';')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'tg-analytics-utm.csv'; a.click();
  toast('CSV выгружен: ' + rows.length + ' строк', 'info');
}

/* ================= ПРИВАТКИ ================= */
function pfBlock(label, stats) {
  return `<div class="pf-block">
    <div class="pf-lbl">${label}</div>
    <div class="pf-val">${fmtM(stats.revenue)}</div>
    <div class="pf-sub">Ср. чек: ${stats.avgCheck !== null ? fmt1(stats.avgCheck) + ' ₽' : '—'} · Плательщики: ${fmtN(stats.uniquePayers)}</div>
    <div class="pf-break">Новые: ${fmtN(stats.paymentsCount)} (${fmtM(stats.paymentsRevenue)}) · Продления: ${fmtN(stats.renewalsCount)} (${fmtM(stats.renewalsRevenue)})</div>
  </div>`;
}

function renderPrivatkaCard(p, i) {
  return `<article class="card pf-card rv" style="--i:${i}">
    <div class="card-h"><span class="card-idx">${String(i + 1).padStart(2, '0')} / приватка</span><div><div class="card-t">${escapeHtml(p.projectName)}</div><div class="card-s">Финансы за 4 окна: сегодня, 7 дней, 30 дней, всё время</div></div></div>
    <div class="pf-body">
      <div class="pf-grid">
        ${pfBlock('Сегодня', p.today)}
        ${pfBlock('7 дней', p.week)}
        ${pfBlock('30 дней', p.month)}
        ${pfBlock('Всё время', p.allTime)}
      </div>
      <div class="pf-foot">
        <div class="pf-arppu"><b>${p.arppu !== null ? fmtM(p.arppu) : '—'}</b><span>ARPPU</span></div>
        <div class="pf-trend">${spark(p.dailySeries.map(d => d.revenue), '#3DDC97')}</div>
      </div>
    </div>
  </article>`;
}

function renderPrivatkaCompare(list) {
  if (list.length < 2) { $('#privatkaCompareWrap').innerHTML = ''; return; }
  const sorted = [...list].sort((a, b) => b.allTime.revenue - a.allTime.revenue);
  $('#privatkaCompareWrap').innerHTML = `
  <article class="card table-card rv" style="--i:${list.length}">
    <div class="card-h"><span class="card-idx">${String(list.length + 1).padStart(2, '0')} / сравнение</span><div><div class="card-t">Сравнение приваток</div><div class="card-s">по выручке за всё время</div></div></div>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr><th>Приватка</th><th class="num">Доход (всё время)</th><th class="num">Средний чек (всё время)</th><th class="num">ARPPU</th></tr></thead>
        <tbody>
          ${sorted.map(p => `<tr>
            <td><div class="cell-main">${escapeHtml(p.projectName)}</div></td>
            <td class="num" style="color:var(--green)">${fmtM(p.allTime.revenue)}</td>
            <td class="num">${p.allTime.avgCheck !== null ? fmt1(p.allTime.avgCheck) + ' ₽' : '—'}</td>
            <td class="num">${p.arppu !== null ? fmtM(p.arppu) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </article>`;
}

async function renderPrivatkas() {
  let list;
  try {
    list = await fetchJSON('/api/privatkas/finance');
  } catch (err) {
    toast(`Не удалось загрузить финансы приваток: ${err.message}`, 'warn');
    list = [];
  }
  state.privatkasView = list;

  if (!list.length) {
    $('#privatkaCards').innerHTML = '<div style="padding:16px 18px;font-size:12px;color:var(--dim)">Нет зарегистрированных приваток</div>';
    $('#privatkaCompareWrap').innerHTML = '';
    return;
  }

  $('#privatkaCards').innerHTML = list.map((p, i) => renderPrivatkaCard(p, i)).join('');
  renderPrivatkaCompare(list);
}

/* ================= НАВИГАЦИЯ / ЭКРАНЫ ================= */
const SCREENS = {
  overview: { t: 'Обзор', s: 'Сводка по закупкам, подпискам и выручке · данные из dailyStats и событий', c: { p: 1, s: 0, e: 0 } },
  campaigns: { t: 'Кампании', s: 'Эффективность закупок: режимы «по ссылкам» и «по рекламодателям»', c: { p: 0, s: 1, e: 1 } },
  utm: { t: 'UTM-метки', s: 'Независимый трекинг источников трафика: старты, покупки, CAC/ROI по utm-меткам', c: { p: 0, s: 0, e: 1 } },
  privatkas: { t: 'Приватки', s: 'Финансы подписочных ботов: доход, средний чек, ARPPU', c: { p: 0, s: 0, e: 1 } },
  projects: { t: 'Проекты', s: 'Реестр каналов и ботов-приваток, связывание проектов', c: { p: 0, s: 0, e: 0 } },
};

async function renderCurrentScreen() {
  if (state.screen === 'overview') { renderKPIs(); refreshChart(); renderTop5(); renderQuality(); renderFeed(); }
  else if (state.screen === 'campaigns') await renderCampaigns();
  else if (state.screen === 'utm') await renderUtm();
  else if (state.screen === 'privatkas') await renderPrivatkas();
  else if (state.screen === 'projects') await renderProjects();
}

async function go(scr) {
  state.screen = scr;
  $$('#nav .nav-it').forEach(b => b.classList.toggle('on', b.dataset.scr === scr));
  $$('.screen').forEach(s => s.classList.remove('active'));
  const el = $('#scr-' + scr); void el.offsetWidth; el.classList.add('active');
  const m = SCREENS[scr];
  $('#tb-title').textContent = m.t; $('#tb-sub').textContent = m.s;
  $('#periodSeg').hidden = !m.c.p; $('#searchWrap').hidden = !m.c.s; $('#exportBtn').hidden = !m.c.e;
  if (scr === 'overview') { renderKPIs(); ensureChart(); refreshChart(); renderTop5(); renderQuality(); renderFeed(); }
  if (scr === 'campaigns') await renderCampaigns();
  if (scr === 'utm') await renderUtm();
  if (scr === 'privatkas') await renderPrivatkas();
  if (scr === 'projects') await renderProjects();
}
$$('#nav .nav-it').forEach(b => b.addEventListener('click', () => go(b.dataset.scr)));
$('#refreshBtn').addEventListener('click', async () => {
  const b = $('#refreshBtn'); b.classList.add('spin'); setTimeout(() => b.classList.remove('spin'), 750);
  try {
    await afterMutation();
    const t = new Date(); $('#liveTime').textContent = pad2(t.getHours()) + ':' + pad2(t.getMinutes());
    await go(state.screen);
    toast('Данные синхронизированы с ботами', 'info');
  } catch (err) {
    toast(`Не удалось обновить данные: ${err.message}`, 'warn');
  }
});
$$('.ds-chip').forEach(b => b.addEventListener('click', () => {
  if (!chart) return;
  const i = +b.dataset.i, vis = chart.isDatasetVisible(i);
  chart.setDatasetVisibility(i, !vis); b.classList.toggle('on', !vis); chart.update();
}));

/* ================= ИНИЦИАЛИЗАЦИЯ ================= */
(async function init() {
  const wd = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  $('#tb-eyebrow').textContent = wd.charAt(0).toUpperCase() + wd.slice(1) + ' · tg-analytics';
  const t = new Date(); $('#liveTime').textContent = pad2(t.getHours()) + ':' + pad2(t.getMinutes());
  try {
    await loadCore();
    await go('overview');
  } catch (err) {
    console.error('[dashboard] Failed to load initial data:', err);
    toast('Не удалось загрузить данные. Обновите страницу.', 'warn');
  }
})();
