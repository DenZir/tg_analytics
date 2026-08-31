'use strict';
/* ================================================================
 * Shared data/logic layer for the desktop (app.js) and mobile
 * (mobile.js) dashboards. Anything that renders markup stays in its
 * own file on purpose (tables vs cards, modal vs bottom sheet) — this
 * module holds only what should never differ between the two:
 * networking, the DATA store, pure computations, and formatting.
 * ================================================================ */

/* ================= АУТЕНТИФИКАЦИЯ ================= */
// Auth is now a same-origin session cookie (dash_session), set via the
// Telegram bot's "🔐 Авторизация в дашборд" login link — no client-side
// secret to manage. The browser attaches the cookie automatically.

// Generic fetch wrapper: bounces to the login page if the session is
// missing/expired (server responds 401).
export async function apiFetch(url, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    window.location.href = "/";
  }
  return res;
}

export async function fetchJSON(url, opts) {
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
export const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const $  = s => document.querySelector(s);
export const $$ = s => [...document.querySelectorAll(s)];
export const fmtN = n => Math.round(n || 0).toLocaleString('ru-RU');
export const fmtM = n => fmtN(n) + ' ₽';
export const fmt1 = n => (Math.round((n || 0) * 10) / 10).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const fmtPct = n => fmt1(n) + '%';
export const plural = (n, a, b, c) => { n = Math.abs(n) % 100; const d = n % 10; if (n > 10 && n < 20) return c; if (d > 1 && d < 5) return b; if (d === 1) return a; return c; };
export const pad2 = n => String(n).padStart(2, '0');
export const dShort = dateStr => { const [, m, d] = dateStr.split('-'); return d + '.' + m; };
export const dFull  = dateStr => { const [y, m, d] = dateStr.split('-'); return `${d}.${m}.${y}`; };
export const dStamp = ts => { const d = new Date(ts); return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
export const dDate  = ts => { const d = new Date(ts); return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`; };

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Approximate geo breakdown chip, built from camp.geo (top buckets by pct,
// e.g. [{flag:'🇷🇺',pct:62}, ...] -> "🇷🇺 62% · 🇺🇦 20% · 🌐 18%"). Omitted
// entirely when there's no geo data yet.
export function geoChipRow(geo) {
  if (!geo || !geo.length) return '';
  const top = [...geo].sort((a, b) => b.pct - a.pct).slice(0, 4);
  const text = top.map(g => `${g.flag} ${g.pct}%`).join(' · ');
  return `<span class="chip neutral mono">${escapeHtml(text)}</span>`;
}

/* иконки */
const ic = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
export const IC = {
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
export const EV = {
  join:{l:'Заход',c:'#57B6FF',i:IC.users}, leave:{l:'Выход',c:'#FF6B7A',i:IC.out},
  lead:{l:'Лид',c:'#9B8CFF',i:IC.zap}, trial_start:{l:'Триал',c:'#7CC6FF',i:IC.play},
  payment:{l:'Оплата',c:'#3DDC97',i:IC.card}, renewal:{l:'Продление',c:'#3DDC97',i:IC.rot},
  churn:{l:'Отписка',c:'#FF6B7A',i:IC.xcirc}, join_request:{l:'Заявка на вход',c:'#FFB454',i:IC.clock}
};
export const LT = {invite:{l:'Инвайт',cls:'t-invite'}, invite_closed:{l:'Закрытый',cls:'t-closed'}};
export const FUNNEL_ENTRY_TYPES = ['join', 'lead', 'trial_start'];

export function eventMeta(type) { return EV[type] || { l: type, c: '#8A94A6', i: IC.zap }; }
export const hueBox = c => `background:${c}1f;color:${c};border:1px solid ${c}33`;
export const rCls = v => v >= 70 ? 'r-good' : v >= 55 ? 'r-mid' : 'r-bad';

/* ================= АНИМАЦИИ ================= */
export function countUp(el, val, fmt) {
  if (RM) { el.textContent = fmt(val); return; }
  const t0 = performance.now(), dur = 900;
  (function f(t) { const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3); el.textContent = fmt(val * e); if (p < 1) requestAnimationFrame(f); })(t0);
}
export function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast t-' + type;
  t.innerHTML = `<span class="t-ic">${type === 'ok' ? IC.check : type === 'warn' ? IC.warn : IC.zap}</span><span>${escapeHtml(msg)}</span>`;
  $('#toastRoot').appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 3400);
}

/* ================= ХРАНИЛИЩЕ ДАННЫХ ================= */
export const DATA = {
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

export function buildIndexes() {
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

export async function loadCore() {
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

export function invalidateHistories() {
  DATA.histories = null;
  DATA.historiesPromise = null;
}

// Fetches /api/campaigns/:id/history for every known campaign exactly once
// and caches the Map; reused by the Кампании (links mode) and
// Проекты screens instead of re-fetching per screen.
export function getCampaignHistories() {
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

export async function getCampaignHistory(id) {
  if (DATA.histories && DATA.histories.has(id)) return DATA.histories.get(id);
  const h = await fetchJSON(`/api/campaigns/${id}/history`);
  if (!DATA.histories) DATA.histories = new Map();
  DATA.histories.set(id, h);
  return h;
}

export async function afterMutation() {
  await loadCore();
  invalidateHistories();
}

export function last21Dates() { return DATA.dateList.slice(-21); }
export function seriesForCampaign(campaignId, dates) {
  return dates.map(d => DATA.byCampaignDate.get(campaignId + '|' + d) || { subs: 0, revenue: 0 });
}

/* ---- окно периода (7д/14д/30д/Все) ---- */
export function windowDates(period) {
  if (period === 'all') return DATA.dateList.slice();
  return DATA.dateList.slice(-period);
}
export function prevWindowDates(period) {
  if (period === 'all') return null;
  const all = DATA.dateList;
  const start = all.length - 2 * period;
  if (start < 0) return null; // not enough history for a full previous window
  return all.slice(start, all.length - period);
}
export function sumDates(dates) {
  return dates.reduce((acc, d) => {
    const v = DATA.byDate.get(d) || { subs: 0, revenue: 0 };
    acc.subs += v.subs; acc.revenue += v.revenue;
    return acc;
  }, { subs: 0, revenue: 0 });
}
export function countActiveCampaigns(dates) {
  const dateSet = new Set(dates);
  const ids = new Set();
  for (const row of DATA.metrics.daily) {
    if (dateSet.has(row.date) && (row.subs > 0 || row.revenue > 0)) ids.add(row.campaignId);
  }
  return ids.size;
}

export function windowArrays() {
  const dates = windowDates(state.period);
  return {
    labels: dates.map(dShort),
    subs: dates.map(d => (DATA.byDate.get(d) || { subs: 0 }).subs),
    rev: dates.map(d => (DATA.byDate.get(d) || { revenue: 0 }).revenue),
    cps: dates.map(d => { const v = DATA.byDate.get(d) || { subs: 0, revenue: 0 }; return +(v.subs ? (v.revenue / v.subs).toFixed(2) : 0); }),
  };
}

/* ---- разбивка кампании по ссылкам из реальных событий ---- */
export function computeLinkStats(links, events) {
  return (links || []).map(l => {
    const linkEvents = (events || []).filter(e => e.linkId === l.id);
    const entryEvents = linkEvents.filter(e => FUNNEL_ENTRY_TYPES.includes(e.eventType));
    const joins = entryEvents.length;
    const subs = new Set(entryEvents.map(e => e.tgUserId)).size;
    const buyers = new Set(linkEvents.filter(e => e.eventType === 'payment').map(e => e.tgUserId)).size;
    const revenue = linkEvents
      .filter(e => e.eventType === 'payment' || e.eventType === 'renewal')
      .reduce((s, e) => s + (e.amount || 0), 0);
    return { link: l, joins, subs, buyers, revenue };
  });
}
// Best-effort split of a campaign's (contractually per-campaign) price across
// its links, proportional to revenue share, falling back to joins share.
export function allocatePrice(linkStats, price) {
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

export async function computeLinkRows() {
  const histories = await getCampaignHistories();
  const rows = [];
  for (const camp of DATA.extended.campaigns) {
    const hist = histories.get(camp.id);
    if (!hist) continue;
    const linkStats = allocatePrice(computeLinkStats(hist.links, hist.events), camp.price);
    const creative = hist.tags?.find(t => t.tagKey === 'creative')?.tagValue || null;
    for (const stat of linkStats) {
      rows.push({
        campaign: camp,
        link: stat.link,
        joins: stat.joins,
        subs: stat.subs,
        buyers: stat.buyers,
        revenue: stat.revenue,
        cps: stat.buyers ? stat.priceAlloc / stat.buyers : null,
        pricePerSub: stat.subs ? stat.priceAlloc / stat.subs : null,
        r24: camp.retention24h,
        r48: camp.retention48h,
        url: linkDisplayUrl(stat.link),
        createdAt: hist.campaign?.createdAt || null,
        creative,
      });
    }
  }
  return rows;
}

/* ---- URL ссылки для отображения ---- */
export function linkDisplayUrl(link) {
  if (!link) return null;
  // telegramRef is already the full https://t.me/+... invite URL — never prepend anything.
  return link.telegramRef;
}

/* ================= СОСТОЯНИЕ UI (кампании/пагинация) ================= */
export const state = { screen: 'overview', period: 30, mode: 'links', q: '', campPage: 1, campTotalPages: 1 };
export const CAMP_PAGE_SIZE = 25;

// Fetches one page of the campaigns tab from the server — the DB query
// itself is paginated (LIMIT/OFFSET), and retention/conversion/link stats
// are computed only for that page's campaigns, so loading stays fast no
// matter how many campaigns the project has accumulated.
export async function fetchCampaignsPage(mode, page) {
  const params = new URLSearchParams({ mode, page: String(page), pageSize: String(CAMP_PAGE_SIZE) });
  if (state.q.trim()) params.set('q', state.q.trim());
  return fetchJSON(`/api/campaigns/page?${params}`);
}

export function renderPager(total, page, totalPages) {
  const pager = $('#campPager');
  if (!pager) return;
  if (total === 0) { pager.hidden = true; return; }
  pager.hidden = false;
  $('#campPagerInfo').textContent = `Стр. ${page} из ${totalPages}`;
  $('#campPagerPrev').disabled = page <= 1;
  $('#campPagerNext').disabled = page >= totalPages;
}

export async function fetchAllCampaignRowsForExport(mode) {
  const EXPORT_PAGE_SIZE = 100;
  const out = [];
  let page = 1, totalPages = 1;
  do {
    const params = new URLSearchParams({ mode, page: String(page), pageSize: String(EXPORT_PAGE_SIZE) });
    if (state.q.trim()) params.set('q', state.q.trim());
    const data = await fetchJSON(`/api/campaigns/page?${params}`);
    totalPages = data.totalPages;
    if (mode === 'links') {
      for (const c of data.campaigns) {
        for (const l of c.links) {
          out.push({ campaign: c, link: l, subs: l.subs, revenue: l.revenue, cps: l.cps, pricePerSub: l.pricePerSub, avgCohortLtv: l.avgCohortLtv, r24: c.retention24h, r48: c.retention48h, url: l.telegramRef, creative: c.creative });
        }
      }
    } else {
      for (const a of data.advertisers) {
        out.push({ ...a, roi: a.totalPrice ? (a.totalRevenue / a.totalPrice * 100) : null });
      }
    }
    page++;
  } while (page <= totalPages);
  return out;
}

export async function moveLink(linkId, targetCampaignId) {
  await fetchJSON(`/api/links/${linkId}/campaign`, { method: 'PATCH', body: JSON.stringify({ campaignId: targetCampaignId }) });
  await afterMutation();
}

/* ---- сегменты (переключатели-табы со скользящим "thumb") ---- */
export function segInit(seg, cb) {
  const thumb = seg.querySelector('.thumb');
  const place = b => { thumb.style.left = b.offsetLeft + 'px'; thumb.style.width = b.offsetWidth + 'px'; };
  seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    seg.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); place(b); cb(b);
  }));
  place(seg.querySelector('.on'));
  addEventListener('resize', () => place(seg.querySelector('.on')));
}

/* ================= КОРЗИНА ================= */
export function daysUntilPurge(deletedAt) {
  const purgeAt = new Date(deletedAt).getTime() + 30 * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((purgeAt - Date.now()) / (24 * 60 * 60 * 1000)));
}

/* ================= ПРОЕКТЫ ================= */
export function typeLabel(t) { return t === 'channel' ? 'Канал' : 'Бот-подписка'; }
export function typeChipClass(t) { return t === 'channel' ? 't-proj' : 't-bot'; }
export function identOf(p) { return p.type === 'channel' ? (p.telegramChatId || '—') : (p.botUsername || '—'); }

/* ================= UTM ================= */
export function roiCls(v) { if (v === null || v === undefined) return ''; return v >= 100 ? 'r-good' : v >= 70 ? 'r-mid' : 'r-bad'; }
export function fmtHours(h) {
  if (h === null || h === undefined) return '—';
  if (h < 24) return fmt1(h) + 'ч';
  const days = Math.floor(h / 24), rem = Math.round(h % 24);
  return rem ? `${days}д ${rem}ч` : `${days}д`;
}

/* ================= CSV ================= */
// Excel in a ru-RU locale parses dot-decimals like "6.03" as dates ("6 марта"),
// silently corrupting exported metrics. The field delimiter in our CSVs is ';',
// so a comma decimal separator is unambiguous and Excel reads it as a number.
// Pass `digits` to keep an existing toFixed() shape; omit it to leave the
// number's natural precision. Empty/невалидные values stay empty cells.
export function csvNum(value, digits = null) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return (digits === null ? String(n) : n.toFixed(digits)).replace('.', ',');
}
