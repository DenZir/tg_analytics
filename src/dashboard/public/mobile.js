'use strict';
import {
  apiFetch, fetchJSON, RM, $, $$, fmtN, fmtM, fmt1, fmtPct, plural, pad2, dShort, dFull, dStamp, dDate,
  escapeHtml, geoChipRow, IC, EV, LT, FUNNEL_ENTRY_TYPES, eventMeta, hueBox, rCls, countUp, toast,
  DATA, buildIndexes, loadCore, invalidateHistories, getCampaignHistories, getCampaignHistory, afterMutation,
  last21Dates, seriesForCampaign, windowDates, prevWindowDates, sumDates, countActiveCampaigns, windowArrays,
  computeLinkStats, allocatePrice, computeLinkRows, linkDisplayUrl, state, CAMP_PAGE_SIZE,
  fetchCampaignsPage, renderPager, fetchAllCampaignRowsForExport, moveLink, segInit,
  daysUntilPurge, typeLabel, typeChipClass, identOf, roiCls, fmtHours,
} from './shared.js';

/* ================= СПАРКЛАЙН (мобильные размеры) ================= */
function spark(vals, color = '#57B6FF') {
  if (!vals || !vals.length) vals = [0, 0];
  const w = 220, h = 26, mn = Math.min(...vals), mx = Math.max(...vals), r = (mx - mn) || 1;
  const pts = vals.map((v, i) => [i / (vals.length - 1 || 1) * w, h - 3 - ((v - mn) / r) * (h - 7)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d} L ${w} ${h} L 0 ${h} Z" fill="${color}" opacity=".12"/><path class="spark-l" pathLength="1" d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}

/* ================= СОСТОЯНИЕ UI (мобильно-специфичное) ================= */
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
    if (prevVal === null || prevVal === undefined) return '<span class="delta flat">нет данных</span>';
    if (!prevVal) return '<span class="delta flat">новое</span>';
    const p = (curVal - prevVal) / prevVal * 100, up = p >= 0, good = goodUp ? up : !up;
    return `<span class="delta ${good ? 'up' : 'dn'}">${up ? '+' : '−'}${fmt1(Math.abs(p))}%</span>`;
  };

  const sparkDates = dates.length ? dates : DATA.dateList;
  const sparkSubs = sparkDates.map(d => (DATA.byDate.get(d) || { subs: 0 }).subs);
  const sparkRev = sparkDates.map(d => (DATA.byDate.get(d) || { revenue: 0 }).revenue);
  const sparkCps = sparkDates.map(d => { const v = DATA.byDate.get(d) || { subs: 0, revenue: 0 }; return v.subs ? v.revenue / v.subs : 0; });

  const cards = [
    { lbl: 'Кампаний', icon: IC.target, c: '#57B6FF', val: totalCampaigns, fmt: fmtN,
      delta: prevDates ? dl(activeInCur, activeInPrev) : '<span class="delta flat">весь период</span>',
      sub: `закупки на ${fmtM(totalPrice)}`, sparkV: sparkSubs },
    { lbl: 'Подписчики', icon: IC.users, c: '#9B8CFF', val: cur.subs, fmt: fmtN,
      delta: dl(cur.subs, prev ? prev.subs : null),
      sub: prev ? `${fmtN(prev.subs)} за пред. период` : 'за выбранный период', sparkV: sparkSubs },
    { lbl: 'Выручка', icon: IC.rub, c: '#3DDC97', val: cur.revenue, fmt: fmtM,
      delta: dl(cur.revenue, prev ? prev.revenue : null),
      sub: prev ? `${fmtM(prev.revenue)} за пред. период` : 'за выбранный период', sparkV: sparkRev },
    { lbl: 'Доход/подписчик', icon: IC.cps, c: '#FFB454', val: cps, fmt: v => fmt1(v) + ' ₽',
      delta: dl(cps, prev ? prevCps : null, false),
      sub: `выручка / подписчики · ${period === 'all' ? 'весь период' : period + ' дн'}`, sparkV: sparkCps },
  ];
  $('#kpis').innerHTML = cards.map((k, i) => `
    <article class="card kpi rv" style="--i:${i + 1}">
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
    $('#top5').innerHTML = '<div style="padding:16px 14px;font-size:12px;color:var(--dim)">Нет кампаний с выручкой</div>';
    return;
  }
  const mx = Math.max(...top.map(c => c.totalRevenue), 1);
  $('#top5').innerHTML = top.map((c, i) => {
    const proj = DATA.projectsById[c.projectId];
    return `<div class="t5-row" data-c="${c.id}">
      <span class="t5-rank">0${i + 1}</span>
      <div style="min-width:0"><div class="t5-name">#${c.id} · ${escapeHtml(c.advertiser)}</div><div class="t5-adv">${escapeHtml(proj?.name || '—')}</div></div>
      <span class="t5-val">${fmtM(c.totalRevenue)}</span>
      <div class="t5-bar"><i style="--w:${Math.round(c.totalRevenue / mx * 100)}%"></i></div>
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
    ['Конверсия', conv, '#3DDC97', convvals.length],
  ].map(x => `
    <div class="ret-row"><div class="ret-lbl"><span>${x[0]}</span><b>${x[3] ? fmtPct(x[1]) : '—'}</b></div>
    <div class="ret-bar"><i style="--w:${Math.min(100, x[1])}%;background:${x[2]}"></i></div></div>`).join('');
  const card = $('#retCol').closest('.card');
  requestAnimationFrame(() => { card.classList.add('in'); $('#convFg').style.strokeDashoffset = 226 - (226 * Math.min(conv, 100) / 100); });
}

function renderFeed() {
  const all = DATA.recentEvents || [];
  if (!all.length) {
    $('#feed').innerHTML = '<div style="padding:16px 14px;font-size:12px;color:var(--dim)">Событий пока нет</div>';
    return;
  }
  $('#feed').innerHTML = all.map(e => {
    const ev = eventMeta(e.eventType);
    return `<div class="feed-it"><span class="f-ic" style="${hueBox(ev.c)}">${ev.i}</span>
    <div class="f-tx"><b>${ev.l}</b> · ${escapeHtml(e.advertiser)}<span>${escapeHtml(e.linkLabel || e.telegramRef || '')} · ID ${escapeHtml(e.tgUserId)}${e.amount ? ` · ${fmt1(e.amount)} ₽` : ''}</span></div>
    <span class="f-time">${dStamp(e.ts)}</span></div>`;
  }).join('');
}

function ensureChart() {
  if (!window.Chart) { $('#chartFallback').hidden = false; return; }
  if (chart) return;
  const cv = $('#mainChart'), ctx = cv.getContext('2d');
  const gA = ctx.createLinearGradient(0, 0, 0, 230); gA.addColorStop(0, 'rgba(87,182,255,.4)'); gA.addColorStop(1, 'rgba(87,182,255,.02)');
  const gG = ctx.createLinearGradient(0, 0, 0, 230); gG.addColorStop(0, 'rgba(61,220,151,.22)'); gG.addColorStop(1, 'rgba(61,220,151,0)');
  const w = windowArrays();
  chart = new Chart(ctx, { data: { labels: w.labels, datasets: [
    { type: 'bar', label: 'Подписки', data: w.subs, backgroundColor: gA, borderRadius: 3, barPercentage: .55, categoryPercentage: .72, yAxisID: 'y', order: 3 },
    { type: 'line', label: 'Выручка', data: w.rev, borderColor: '#3DDC97', backgroundColor: gG, fill: true, tension: .35, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, yAxisID: 'y1', order: 1 },
    { type: 'line', label: 'Доход/подписчик', data: w.cps, borderColor: '#9B8CFF', borderDash: [4, 4], borderWidth: 1.6, tension: .35, pointRadius: 0, yAxisID: 'y2', hidden: true, order: 2 },
  ] }, options: {
    responsive: true, maintainAspectRatio: false, animation: RM ? false : { duration: 700, easing: 'easeOutQuart' },
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: '#0F1520', borderColor: 'rgba(255,255,255,.12)', borderWidth: 1, padding: 10, cornerRadius: 10,
      titleColor: '#E8EDF4', bodyColor: '#9AA5B8', bodyFont: { family: 'JetBrains Mono', size: 10.5 }, usePointStyle: true, boxWidth: 7, boxHeight: 7,
      callbacks: { label: c => ` ${c.dataset.label}: ` + (c.dataset.label === 'Выручка' ? fmtM(c.parsed.y) : c.dataset.label === 'Доход/подписчик' ? c.parsed.y + ' ₽' : fmtN(c.parsed.y)) } } },
    scales: {
      x: { grid: { display: false }, ticks: { maxTicksLimit: 6, font: { family: 'JetBrains Mono', size: 9.5 }, color: '#5A6478' } },
      y: { position: 'left', grid: { color: 'rgba(255,255,255,.05)' }, ticks: { maxTicksLimit: 5, font: { family: 'JetBrains Mono', size: 9.5 }, color: '#5A6478' } },
      y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { maxTicksLimit: 5, font: { family: 'JetBrains Mono', size: 9.5 }, color: 'rgba(61,220,151,.55)', callback: v => fmtN(v) + ' ₽' } },
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

/* ================= КАМПАНИИ (карточки) ================= */
function toggleEmpty(show) {
  const empty = $('#campEmpty');
  empty.classList.toggle('show', show);
  if (show) $('#campEmptyQ').textContent = '«' + state.q + '»';
  $('#campCards').style.display = show ? 'none' : '';
}


let campRenderToken = 0;

async function renderCampaigns() {
  const wrap = $('#campCards');
  wrap.innerHTML = `<div style="padding:20px 4px;color:var(--dim);font-size:12px;text-align:center">Загрузка…</div>`;
  const token = ++campRenderToken;

  if (state.mode === 'links') {
    let data;
    try {
      data = await fetchCampaignsPage('links', state.campPage);
    } catch (err) {
      if (token !== campRenderToken) return;
      wrap.innerHTML = `<div style="padding:20px 4px;color:var(--dim);font-size:12px;text-align:center">Не удалось загрузить кампании: ${escapeHtml(err.message)}</div>`;
      return;
    }
    if (token !== campRenderToken) return;

    state.campTotalPages = data.totalPages;
    const trendDates = last21Dates();
    const rows = [];
    for (const c of data.campaigns) {
      for (const l of c.links) {
        rows.push({
          campaign: c,
          link: l,
          subs: l.subs,
          revenue: l.revenue,
          cps: l.cps,
          pricePerSub: l.pricePerSub,
          r24: c.retention24h,
          r48: c.retention48h,
          url: l.telegramRef,
          createdAt: c.createdAt,
          creative: c.creative,
        });
      }
    }

    $('#campCount').textContent = `${rows.length} ссылок на странице · ${data.total} ${plural(data.total, 'кампания', 'кампании', 'кампаний')} всего`;
    state.campaignsView = { mode: 'links', rows };
    renderPager(data.total, data.page, data.totalPages);

    wrap.innerHTML = rows.map((r, i) => {
      const c = r.campaign, l = r.link;
      const trend = seriesForCampaign(c.id, trendDates).map(p => p.revenue);
      const ltMeta = LT[l.linkType] || { l: l.linkType, cls: 'neutral' };
      return `<article class="card crow" data-c="${c.id}" style="--i:${i}">
        <div class="crow-top"><span class="chip ${ltMeta.cls}">${escapeHtml(ltMeta.l)}</span><span class="crow-name">${escapeHtml(l.label || 'без названия')}</span><span class="crow-rev">${fmtM(r.revenue)}</span></div>
        <div class="crow-url">${r.url ? escapeHtml(r.url) : 'URL не определён'} · ${escapeHtml(c.advertiser)}</div>
        <hr class="crow-sep">
        <div class="m-grid">
          <div class="m-cell"><span>Подписки</span><b>${fmtN(r.subs)}</b></div>
          <div class="m-cell"><span>₽/подписчик</span><b>${r.pricePerSub !== null ? fmt1(r.pricePerSub) + ' ₽' : '—'}</b></div>
          <div class="m-cell"><span>₽/покупка</span><b>${r.cps !== null ? fmt1(r.cps) + ' ₽' : '—'}</b></div>
          <div class="m-cell"><span>R24ч</span><b class="${r.r24 !== null && r.r24 !== undefined ? rCls(r.r24) : ''}">${r.r24 !== null && r.r24 !== undefined ? fmtPct(r.r24) : '—'}</b></div>
          <div class="m-cell"><span>R48ч</span><b class="${r.r48 !== null && r.r48 !== undefined ? rCls(r.r48) : ''}">${r.r48 !== null && r.r48 !== undefined ? fmtPct(r.r48) : '—'}</b></div>
        </div>
        <div class="crow-spark">${spark(trend, '#57B6FF')}</div>
      </article>`;
    }).join('');
    toggleEmpty(rows.length === 0);
    wrap.querySelectorAll('.crow').forEach(el => el.addEventListener('click', () => openCampaign(+el.dataset.c)));
  } else {
    let data;
    try {
      data = await fetchCampaignsPage('advertisers', state.campPage);
    } catch (err) {
      if (token !== campRenderToken) return;
      wrap.innerHTML = `<div style="padding:20px 4px;color:var(--dim);font-size:12px;text-align:center">Не удалось загрузить рекламодателей: ${escapeHtml(err.message)}</div>`;
      return;
    }
    if (token !== campRenderToken) return;

    state.campTotalPages = data.totalPages;
    const trendDates = last21Dates();
    const rows = data.advertisers.map(a => {
      const roi = a.totalPrice ? (a.totalRevenue / a.totalPrice * 100) : null;
      const trend = trendDates.map(d => (DATA.byAdvertiserDate.get(a.advertiser + '|' + d) || { revenue: 0 }).revenue);
      return { ...a, roi, trend };
    });
    $('#campCount').textContent = `${data.total} ${plural(data.total, 'рекламодатель', 'рекламодателя', 'рекламодателей')}`;
    state.campaignsView = { mode: 'adv', rows };
    renderPager(data.total, data.page, data.totalPages);

    wrap.innerHTML = rows.map((a, i) => `<article class="card crow" data-adv="${escapeHtml(a.advertiser)}" style="--i:${i}">
      <div class="crow-top"><span class="crow-name">${escapeHtml(a.advertiser)}</span><span class="crow-rev">${fmtM(a.totalRevenue)}</span></div>
      <div class="crow-url">${a.campaignsCount} ${plural(a.campaignsCount, 'кампания', 'кампании', 'кампаний')} · ROI <span class="${a.roi === null ? '' : a.roi >= 100 ? 'r-good' : a.roi >= 70 ? 'r-mid' : 'r-bad'}">${a.roi === null ? '—' : fmtPct(a.roi)}</span></div>
      <hr class="crow-sep">
      <div class="m-grid">
        <div class="m-cell"><span>Закупки</span><b>${fmtM(a.totalPrice)}</b></div>
        <div class="m-cell"><span>Подписки</span><b>${fmtN(a.totalSubs)}</b></div>
        <div class="m-cell"><span>Ср. ₽/подписчик</span><b>${a.avgPricePerSub !== null && a.avgPricePerSub !== undefined ? fmt1(a.avgPricePerSub) + ' ₽' : '—'}</b></div>
        <div class="m-cell"><span>Ср. ₽/покупка</span><b>${a.avgCps !== null && a.avgCps !== undefined ? fmt1(a.avgCps) + ' ₽' : '—'}</b></div>
        <div class="m-cell"><span>LTV когорты</span><b>${a.avgCohortLtv !== null && a.avgCohortLtv !== undefined ? fmt1(a.avgCohortLtv) + ' ₽' : '—'}</b></div>
        <div class="m-cell"><span>Ср. R24ч</span><b class="${a.avgRetention24h !== null && a.avgRetention24h !== undefined ? rCls(a.avgRetention24h) : ''}">${a.avgRetention24h !== null && a.avgRetention24h !== undefined ? fmtPct(a.avgRetention24h) : '—'}</b></div>
        <div class="m-cell"><span>Ср. R48ч</span><b class="${a.avgRetention48h !== null && a.avgRetention48h !== undefined ? rCls(a.avgRetention48h) : ''}">${a.avgRetention48h !== null && a.avgRetention48h !== undefined ? fmtPct(a.avgRetention48h) : '—'}</b></div>
      </div>
      <div class="crow-spark">${spark(a.trend, '#3DDC97')}</div>
    </article>`).join('');
    toggleEmpty(rows.length === 0);
    wrap.querySelectorAll('.crow').forEach(el => el.addEventListener('click', () => {
      const camp = DATA.extended.campaigns.find(c => c.advertiser === el.dataset.adv);
      if (camp) openCampaign(camp.id);
    }));
  }
}

segInit($('#modeSeg'), b => { state.mode = b.dataset.m; state.campPage = 1; renderCampaigns(); });
$$('#periodChips .pchip').forEach(b => b.addEventListener('click', () => {
  $$('#periodChips .pchip').forEach(x => x.classList.remove('on')); b.classList.add('on');
  state.period = b.dataset.p === 'all' ? 'all' : +b.dataset.p; renderKPIs(); refreshChart();
}));
let campSearchDebounce = null;
$('#campSearch').addEventListener('input', e => {
  state.q = e.target.value;
  state.campPage = 1;
  clearTimeout(campSearchDebounce);
  campSearchDebounce = setTimeout(() => renderCampaigns(), 300);
});
$('#resetSearch').addEventListener('click', () => { state.q = ''; state.campPage = 1; $('#campSearch').value = ''; renderCampaigns(); });
$('#campPagerPrev')?.addEventListener('click', () => { if (state.campPage > 1) { state.campPage--; renderCampaigns(); } });
$('#campPagerNext')?.addEventListener('click', () => { if (state.campPage < state.campTotalPages) { state.campPage++; renderCampaigns(); } });

$('#trashBtn').addEventListener('click', openTrash);
$('#exportBtn').addEventListener('click', async () => {
  const view = state.campaignsView;
  if (!view) { toast('Нет данных для экспорта', 'warn'); return; }
  const apiMode = view.mode === 'links' ? 'links' : 'advertisers';
  const btn = $('#exportBtn');
  btn.disabled = true;
  try {
    const allRows = await fetchAllCampaignRowsForExport(apiMode);
    if (!allRows.length) { toast('Нет данных для экспорта', 'warn'); return; }
    const rows = [];
    if (view.mode === 'links') {
      rows.push(['Ссылка', 'URL', 'Тип', 'Рекламодатель', 'Кампания', 'Подписки', 'Выручка ₽', '₽/подписчик', '₽/покупка', 'R24ч %', 'R48ч %']);
      allRows.forEach(r => rows.push([r.link.label || '', r.url || '', LT[r.link.linkType]?.l || r.link.linkType, r.campaign.advertiser, r.campaign.id, r.subs, r.revenue, r.pricePerSub !== null ? r.pricePerSub.toFixed(2) : '', r.cps !== null ? r.cps.toFixed(2) : '', r.r24 ?? '', r.r48 ?? '']));
    } else {
      rows.push(['Рекламодатель', 'Кампаний', 'Закупки ₽', 'Подписки', 'Выручка ₽', 'Ср. ₽/подписчик', 'Ср. ₽/покупка', 'LTV когорты ₽', 'ROI %', 'Ср. R24ч %', 'Ср. R48ч %']);
      allRows.forEach(a => rows.push([a.advertiser, a.campaignsCount, a.totalPrice, a.totalSubs, a.totalRevenue, a.avgPricePerSub ?? '', a.avgCps ?? '', a.avgCohortLtv ?? '', a.roi !== null ? a.roi.toFixed(1) : '', a.avgRetention24h ?? '', a.avgRetention48h ?? '']));
    }
    const blob = new Blob(['﻿' + rows.map(r => r.join(';')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'tg-analytics-' + view.mode + '.csv'; a.click();
    toast('CSV выгружен: ' + rows.length + ' строк', 'info');
  } catch (err) {
    toast(`Не удалось выгрузить CSV: ${err.message}`, 'warn');
  } finally {
    btn.disabled = false;
  }
});

/* ================= BOTTOM SHEET: КАМПАНИЯ ================= */
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
  renderCampaignSheet(camp, hist);
}

function renderCampaignSheet(camp, hist) {
  const links = hist.links || [];
  const events = hist.events || [];
  const tags = hist.tags || [];
  const linkStats = computeLinkStats(links, events);
  const totSubs = linkStats.reduce((s, x) => s + x.subs, 0);
  const totBuyers = linkStats.reduce((s, x) => s + x.buyers, 0);
  const totRevenue = linkStats.reduce((s, x) => s + x.revenue, 0);
  const proj = DATA.projectsById[camp.projectId];
  const createdAt = hist.campaign?.createdAt ? dDate(hist.campaign.createdAt) : '—';
  const otherCampaigns = DATA.extended.campaigns.filter(c => c.id !== camp.id).sort((a, b) => a.advertiser.localeCompare(b.advertiser));

  $('#modalRoot').innerHTML = `
  <div class="m-ov" id="mOv">
    <article class="sheet" role="dialog" aria-modal="true">
      <div class="grab"></div>
      <header class="m-head">
        <div style="min-width:0">
          <div class="m-eyebrow">Кампания #${camp.id} · создана ${createdAt}</div>
          <h2>${escapeHtml(camp.advertiser)}</h2>
          <div class="m-chips">
            <span class="chip ${proj?.type === 'channel' ? 't-proj' : 't-bot'}">${escapeHtml(proj?.name || '—')}</span>
            <span class="chip neutral mono">закупка ${fmtM(camp.price)}</span>
            ${geoChipRow(camp.geo)}
          </div>
        </div>
        <button class="x-btn" id="mClose">${IC.x}</button>
      </header>
      <div class="m-stats">
        <div class="m-stat"><b>${fmtN(totSubs)}</b><span>подписки</span></div>
        <div class="m-stat"><b style="color:var(--green)">${fmtM(totRevenue)}</b><span>выручка</span></div>
        <div class="m-stat"><b>${totSubs ? fmt1(camp.price / totSubs) + ' ₽' : '—'}</b><span>₽/подписчик</span></div>
        <div class="m-stat"><b>${totBuyers ? fmt1(camp.price / totBuyers) + ' ₽' : '—'}</b><span>₽/покупка</span></div>
      </div>
      <div class="m-body">
        <section class="m-sec">
          <div class="m-sec-h"><span class="card-idx">01 / теги</span><h3>Разметка кампании</h3></div>
          <div class="tag-wrap" id="tagWrap">${tags.map(t => `<span class="tag">${escapeHtml(t.tagKey)}: <b>${escapeHtml(t.tagValue)}</b><button data-k="${escapeHtml(t.tagKey)}" title="Удалить тег">${IC.x}</button></span>`).join('') || '<span style="font-size:12px;color:var(--dim)">тегов нет</span>'}</div>
          <div class="tag-add">
            <input class="inp" id="tagKey" placeholder="ключ">
            <input class="inp" id="tagVal" placeholder="значение">
            <button class="btn tiny" id="tagAdd">${IC.check}</button>
          </div>
        </section>
        <section class="m-sec">
          <div class="m-sec-h"><span class="card-idx">02 / ссылки</span><h3>Ссылки и перевес</h3></div>
          ${links.map(l => {
            const url = linkDisplayUrl(l);
            const stat = linkStats.find(x => x.link.id === l.id) || { joins: 0 };
            const ltMeta = LT[l.linkType] || { l: l.linkType, cls: 'neutral' };
            return `
          <div class="lk-row" data-l="${l.id}">
            <div class="lk-top">
              <span class="chip ${ltMeta.cls}">${escapeHtml(ltMeta.l)}</span>
              <div class="lk-txt" style="min-width:0;flex:1"><b>${escapeHtml(l.label || 'без названия')}</b><span class="lk-url">${url ? escapeHtml(url) : 'URL не определён'}</span></div>
            </div>
            <div class="lk-actions">
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
                <input class="inp nc-price mono" placeholder="Цена, ₽">
                <button class="btn tiny btn-primary nc-go">Создать и перевесить</button>
              </div>
            </div>
          </div>`;
          }).join('') || '<div style="font-size:12px;color:var(--dim)">ссылок нет</div>'}
        </section>
        <section class="m-sec">
          <div class="m-sec-h"><span class="card-idx">03 / история</span><h3>События</h3></div>
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
  document.body.style.overflow = 'hidden';
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
  document.body.style.overflow = '';
  setTimeout(() => { const root = $('#modalRoot'); if (root) root.innerHTML = ''; }, 280);
}

/* ================= КОРЗИНА ================= */
async function openTrash() {
  let rows;
  try {
    rows = await fetchJSON('/api/campaigns/trash');
  } catch (err) {
    toast(`Не удалось загрузить корзину: ${err.message}`, 'warn');
    return;
  }
  renderTrashSheet(rows);
}

function renderTrashSheet(rows) {
  $('#modalRoot').innerHTML = `
  <div class="m-ov" id="mOv">
    <article class="sheet" role="dialog" aria-modal="true">
      <div class="grab"></div>
      <header class="m-head">
        <div style="min-width:0">
          <div class="m-eyebrow">${rows.length} ${plural(rows.length, 'кампания', 'кампании', 'кампаний')}</div>
          <h2>🗑 Корзина</h2>
        </div>
        <button class="x-btn" id="mClose">${IC.x}</button>
      </header>
      <div class="m-body">
        <section class="m-sec">
          ${rows.length ? rows.map(c => `
            <div class="lk-row" data-c="${c.id}">
              <div class="lk-top">
                <div class="lk-txt" style="min-width:0;flex:1"><b>${escapeHtml(c.advertiser)}</b><span class="lk-url">#${c.id} · удалена ${dDate(c.deletedAt)} · автоудаление через ${daysUntilPurge(c.deletedAt)} ${plural(daysUntilPurge(c.deletedAt), 'день', 'дня', 'дней')}</span></div>
              </div>
              <div class="lk-actions">
                <button class="btn tiny btn-primary trash-restore" data-id="${c.id}">${IC.check} Восстановить</button>
                <button class="btn tiny btn-danger trash-purge" data-id="${c.id}">${IC.x} Удалить навсегда</button>
              </div>
            </div>`).join('') : '<div style="font-size:12px;color:var(--dim)">Корзина пуста</div>'}
        </section>
      </div>
    </article>
  </div>`;

  const ov = $('#mOv');
  requestAnimationFrame(() => ov.classList.add('show'));
  document.body.style.overflow = 'hidden';
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });
  $('#mClose').addEventListener('click', closeModal);

  ov.querySelectorAll('.trash-restore').forEach(b => b.addEventListener('click', async () => {
    try {
      await fetchJSON(`/api/campaigns/${b.dataset.id}/restore`, { method: 'POST' });
      toast('Кампания восстановлена из корзины');
      await afterMutation();
      await renderCurrentScreen();
      await openTrash();
    } catch (err) {
      toast(`Не удалось восстановить кампанию: ${err.message}`, 'warn');
    }
  }));

  ov.querySelectorAll('.trash-purge').forEach(b => b.addEventListener('click', async () => {
    const ok = window.confirm('Удалить навсегда?\n\nКампания и все её ссылки, теги и события будут удалены безвозвратно. Это нельзя отменить.');
    if (!ok) return;
    try {
      await fetchJSON(`/api/campaigns/${b.dataset.id}/purge`, { method: 'DELETE' });
      toast('Кампания удалена навсегда', 'warn');
      await openTrash();
    } catch (err) {
      toast(`Не удалось удалить кампанию: ${err.message}`, 'warn');
    }
  }));
}

addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

/* ================= UTM-МЕТКИ ================= */
function renderUtmKpis(links) {
  const sum = key => links.reduce((s, l) => s + (l[key] || 0), 0);
  const starts = sum('starts'), uniqueStarts = sum('uniqueStarts'), purchases = sum('purchases'), revenue = sum('revenue');
  const uniquePurchasers = sum('uniquePurchasers');
  const conv = uniqueStarts ? uniquePurchasers / uniqueStarts * 100 : null;
  const cards = [
    { lbl: 'Заходы', icon: IC.users, c: '#57B6FF', val: fmtN(starts), sub: `уникальных: ${fmtN(uniqueStarts)}` },
    { lbl: 'Меток', icon: IC.target, c: '#9B8CFF', val: fmtN(links.length), sub: `уник. заходы: ${fmtN(uniqueStarts)}` },
    { lbl: 'Покупки', icon: IC.card, c: '#FFB454', val: fmtN(purchases), sub: `конверсия: ${conv !== null ? fmtPct(conv) : '—'}` },
    { lbl: 'Выручка', icon: IC.rub, c: '#3DDC97', val: fmtM(revenue), sub: `плательщиков: ${fmtN(uniquePurchasers)}` },
  ];
  $('#utmKpis').innerHTML = cards.map((k, i) => `
    <article class="card kpi rv" style="--i:${i + 1}">
      <div class="kpi-top"><span class="kpi-ic" style="${hueBox(k.c)}">${k.icon}</span><span class="kpi-lbl">${k.lbl}</span></div>
      <div class="kpi-val">${k.val}</div>
      <div class="kpi-sub">${k.sub}</div>
    </article>`).join('');
}

function renderUtmSources(sources) {
  const wrap = $('#utmSourceCards');
  if (!sources.length) {
    wrap.innerHTML = '<div style="padding:16px 4px;font-size:12px;color:var(--dim)">Источников пока нет</div>';
    return;
  }
  const sorted = [...sources].sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
  wrap.innerHTML = sorted.map((s, i) => `<article class="card crow" style="--i:${i};cursor:default">
    <div class="crow-top"><span class="crow-name">${escapeHtml(s.utmSource)}</span><span class="crow-rev">${fmtM(s.revenue)}</span></div>
    <div class="crow-url">${s.linksCount} ${plural(s.linksCount, 'метка', 'метки', 'меток')} · ROI <span class="${roiCls(s.roi)}">${s.roi !== null && s.roi !== undefined ? fmtPct(s.roi) : '—'}</span></div>
    <hr class="crow-sep">
    <div class="m-grid">
      <div class="m-cell"><span>Заходы</span><b>${fmtN(s.starts)}</b></div>
      <div class="m-cell"><span>Уникальные</span><b>${fmtN(s.uniqueStarts)}</b></div>
      <div class="m-cell"><span>Покупки</span><b>${fmtN(s.purchases)}</b></div>
      <div class="m-cell"><span>CAC</span><b>${s.cac !== null && s.cac !== undefined ? fmt1(s.cac) + ' ₽' : '—'}</b></div>
      <div class="m-cell"><span>LTV когорты</span><b>${s.avgCohortLtv !== null && s.avgCohortLtv !== undefined ? fmt1(s.avgCohortLtv) + ' ₽' : '—'}</b></div>
    </div>
    <div class="convcell"><div class="bar"><i style="width:${Math.min(s.conversionPct || 0, 100)}%"></i></div><b>${s.conversionPct !== null && s.conversionPct !== undefined ? fmtPct(s.conversionPct) : '—'}</b></div>
  </article>`).join('');
}

function renderUtmLinksCards(links) {
  $('#utmLinksCount').textContent = `${links.length} ${plural(links.length, 'ссылка', 'ссылки', 'ссылок')}`;
  const empty = $('#utmEmpty'), wrap = $('#utmLinksCards');
  if (!links.length) {
    empty.classList.add('show');
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  empty.classList.remove('show');
  wrap.style.display = '';
  const sorted = [...links].sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
  wrap.innerHTML = sorted.map((l, i) => `<article class="card crow" data-id="${l.id}" style="--i:${i}">
    <div class="crow-top"><span class="crow-name">${escapeHtml(l.label || l.slug)}</span><span class="crow-rev">${fmtM(l.revenue)}</span></div>
    <div class="crow-url">${escapeHtml(l.utmSource)}/${escapeHtml(l.utmMedium)}/${escapeHtml(l.utmCampaign)}</div>
    <hr class="crow-sep">
    <div class="m-grid">
      <div class="m-cell"><span>Заходы</span><b>${fmtN(l.starts)}</b></div>
      <div class="m-cell"><span>Покупки</span><b>${fmtN(l.purchases)}</b></div>
      <div class="m-cell"><span>CAC</span><b>${l.cac !== null && l.cac !== undefined ? fmt1(l.cac) + ' ₽' : '—'}</b></div>
      <div class="m-cell"><span>ROI</span><b class="${roiCls(l.roi)}">${l.roi !== null && l.roi !== undefined ? fmtPct(l.roi) : '—'}</b></div>
    </div>
    <div class="convcell"><div class="bar"><i style="width:${Math.min(l.conversionPct || 0, 100)}%"></i></div><b>${l.conversionPct !== null && l.conversionPct !== undefined ? fmtPct(l.conversionPct) : '—'}</b></div>
  </article>`).join('');
  $$('#utmLinksCards .crow').forEach(el => el.addEventListener('click', () => openUtmLink(+el.dataset.id)));
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
  renderUtmLinksCards(links);
  populateUtmBotSelect();
}

function populateUtmBotSelect() {
  const sel = $('#u-bot-select');
  if (!sel) return;
  const bots = (DATA.projects || []).filter(p => p.type === 'bot_subscription' && p.botUsername);
  const prevValue = sel.value;

  const opts = [`<option value="">${bots.length ? '— без диплинка —' : '— нет зарегистрированных ботов —'}</option>`];
  opts.push(...bots.map(p => `<option value="${escapeHtml(p.botUsername)}">${escapeHtml(p.name)} (@${escapeHtml(p.botUsername)})</option>`));
  opts.push('<option value="__custom">Другой (ввести вручную)…</option>');
  sel.innerHTML = opts.join('');

  if (prevValue && [...sel.options].some(o => o.value === prevValue)) {
    sel.value = prevValue;
  } else if (bots.length === 1) {
    sel.value = bots[0].botUsername;
  } else {
    sel.value = '';
  }
  $('#u-bot-custom-wrap').hidden = sel.value !== '__custom';
}
$('#u-bot-select').addEventListener('change', () => {
  $('#u-bot-custom-wrap').hidden = $('#u-bot-select').value !== '__custom';
});

function showUtmResult(value, kind) {
  const box = $('#utmResult');
  box.hidden = false;
  box.innerHTML = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
    <span>${kind === 'link' ? 'Диплинк создан:' : 'Slug создан:'}</span>
    <span class="mono" style="color:var(--accent);word-break:break-all">${escapeHtml(value)}</span>
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
  const botSel = $('#u-bot-select').value;
  let botUsername = botSel === '__custom' ? $('#u-bot').value.trim() : botSel;
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
    if (created.deepLink) {
      showUtmResult(created.deepLink, 'link');
      toast(`UTM-ссылка «${created.slug}» создана`);
    } else {
      showUtmResult(created.slug, 'slug');
      toast(`UTM-ссылка «${created.slug}» создана БЕЗ диплинка — бот не выбран`, 'warn');
    }
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
  renderUtmSheet(detail);
}

function renderUtmSheet(l) {
  const deepLink = l.deepLink || null;
  const series = l.dailySeries || [];
  $('#modalRoot').innerHTML = `
  <div class="m-ov" id="mOv">
    <article class="sheet" role="dialog" aria-modal="true">
      <div class="grab"></div>
      <header class="m-head">
        <div style="min-width:0">
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
          <div style="display:flex;flex-direction:column;gap:8px;font-size:12.5px;color:var(--muted)">
            <div>CAC: <b class="mono" style="color:var(--text)">${l.cac !== null && l.cac !== undefined ? fmt1(l.cac) + ' ₽' : '—'}</b></div>
            <div>ROI: <b class="mono ${roiCls(l.roi)}">${l.roi !== null && l.roi !== undefined ? fmtPct(l.roi) : '—'}</b></div>
            <div>Продления: <b class="mono" style="color:var(--text)">${l.renewalRatePct !== null && l.renewalRatePct !== undefined ? fmtPct(l.renewalRatePct) : '—'}</b> (${fmtM(l.renewalsRevenue || 0)})</div>
            <div>Медиана до покупки: <b class="mono" style="color:var(--text)">${fmtHours(l.medianTimeToPurchaseHours)}</b></div>
            <div>Бюджет: <b class="mono" style="color:var(--text)">${l.spend !== null && l.spend !== undefined ? fmtM(l.spend) : '—'}</b></div>
          </div>
        </section>
        <section class="m-sec">
          <div class="m-sec-h"><span class="card-idx">02 / динамика</span><h3>Заходы и выручка за 30 дней</h3></div>
          <div style="display:flex;flex-direction:column;gap:14px">
            <div>${spark(series.map(d => d.starts), '#57B6FF')}<div style="font-size:10.5px;color:var(--dim);margin-top:4px">Заходы</div></div>
            <div>${spark(series.map(d => d.revenue), '#3DDC97')}<div style="font-size:10.5px;color:var(--dim);margin-top:4px">Выручка</div></div>
          </div>
        </section>
        <section class="m-sec">
          <div class="m-sec-h"><span class="card-idx">03 / диплинк</span><h3>Ссылка для трафика</h3></div>
          <div class="lk-row">
            <div class="lk-top">
              <div class="lk-txt" style="min-width:0;flex:1"><b>${escapeHtml(l.slug)}</b><span class="lk-url">${deepLink ? escapeHtml(deepLink) : 'username бота не указан — используйте slug вручную'}</span></div>
            </div>
            <div class="lk-actions">
              <button class="btn tiny copy-btn" data-url="${escapeHtml(deepLink || l.slug)}">${IC.copy} Копировать</button>
            </div>
          </div>
        </section>
      </div>
    </article>
  </div>`;
  const ov = $('#mOv');
  requestAnimationFrame(() => ov.classList.add('show'));
  document.body.style.overflow = 'hidden';
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });
  $('#mClose').addEventListener('click', closeModal);
  ov.querySelectorAll('.copy-btn').forEach(b => b.addEventListener('click', () => {
    navigator.clipboard?.writeText(b.dataset.url).catch(() => {});
    toast('Скопировано в буфер', 'info');
  }));
}

/* ================= ПРИВАТКИ (реальные финансы) ================= */
function pfBlock(label, stats) {
  return `<div class="pf-block">
    <div class="pf-lbl">${label}</div>
    <div class="pf-val">${fmtM(stats.revenue)}</div>
    <div class="pf-sub">Чек: ${stats.avgCheck !== null ? fmt1(stats.avgCheck) + ' ₽' : '—'} · Плательщики: ${fmtN(stats.uniquePayers)}</div>
    <div class="pf-break">Новые: ${fmtN(stats.paymentsCount)} (${fmtM(stats.paymentsRevenue)})<br>Продления: ${fmtN(stats.renewalsCount)} (${fmtM(stats.renewalsRevenue)})</div>
  </div>`;
}
function renderPrivatkaCard(p, i) {
  return `<article class="card pf-card rv" style="--i:${i}">
    <div class="card-h"><span class="card-idx">${String(i + 1).padStart(2, '0')} / приватка</span><div><div class="card-t">${escapeHtml(p.projectName)}</div><div class="card-s">Сегодня · 7д · 30д · всё время</div></div></div>
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
  const wrap = $('#pvCompareWrap');
  if (list.length < 2) { wrap.innerHTML = ''; return; }
  const sorted = [...list].sort((a, b) => b.allTime.revenue - a.allTime.revenue);
  wrap.innerHTML = `<article class="card rv" style="--i:${list.length}">
    <div class="card-h"><span class="card-idx">${String(list.length + 1).padStart(2, '0')} / сравнение</span><div><div class="card-t">Сравнение приваток</div><div class="card-s">по выручке за всё время</div></div></div>
    <div style="padding:4px 14px 14px">
      ${sorted.map(p => `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px dashed var(--line)">
        <span style="font-size:12.5px;font-weight:600;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.projectName)}</span>
        <span class="mono" style="font-size:12px;color:var(--green)">${fmtM(p.allTime.revenue)}</span>
      </div>`).join('')}
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
    $('#pvCards').innerHTML = '<div style="padding:16px 4px;font-size:12px;color:var(--dim)">Нет зарегистрированных приваток</div>';
    $('#pvCompareWrap').innerHTML = '';
    return;
  }

  $('#pvCards').innerHTML = list.map((p, i) => renderPrivatkaCard(p, i)).join('');
  renderPrivatkaCompare(list);
}

/* ================= ПРОЕКТЫ ================= */
async function renderProjects() {
  const list = DATA.projects;
  $('#projSub').textContent = `${list.length} ${plural(list.length, 'проект', 'проекта', 'проектов')}`;

  const campCountByProject = {};
  for (const c of DATA.extended.campaigns) campCountByProject[c.projectId] = (campCountByProject[c.projectId] || 0) + 1;

  function paint(linkCounts) {
    $('#projCards').innerHTML = list.map((p, i) => {
      const linked = p.linkedProjectId ? DATA.projectsById[p.linkedProjectId] : null;
      const linksCount = linkCounts ? (linkCounts[p.id] ?? 0) : '…';
      return `<article class="card prow" style="--i:${i}">
        <div class="prow-top"><b>${escapeHtml(p.name)}</b><span class="chip ${typeChipClass(p.type)}">${typeLabel(p.type)}</span></div>
        <div class="prow-id">${escapeHtml(identOf(p))}</div>
        <div class="prow-meta">
          <span>Связь: <b>${linked ? escapeHtml(linked.name) : '—'}</b></span>
          <span>Кампаний: <b>${campCountByProject[p.id] || 0}</b></span>
          <span>Ссылок: <b>${linksCount}</b></span>
        </div>
      </article>`;
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
    console.error('[mobile] Failed to load link counts for projects:', err);
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

/* ================= НАВИГАЦИЯ ================= */
async function renderCurrentScreen() {
  if (state.screen === 'overview') { renderKPIs(); refreshChart(); renderTop5(); renderQuality(); renderFeed(); }
  else if (state.screen === 'campaigns') await renderCampaigns();
  else if (state.screen === 'utm') await renderUtm();
  else if (state.screen === 'privatkas') await renderPrivatkas();
  else if (state.screen === 'projects') await renderProjects();
}

const rendered = {};
async function go(scr) {
  state.screen = scr;
  $$('#tabbar .tab').forEach(b => b.classList.toggle('on', b.dataset.scr === scr));
  $$('.screen').forEach(s => s.classList.remove('active'));
  const el = $('#scr-' + scr); void el.offsetWidth; el.classList.add('active');
  scrollTo({ top: 0, behavior: 'auto' });
  if (scr === 'overview') { renderKPIs(); ensureChart(); refreshChart(); if (!rendered.ov) { renderTop5(); renderQuality(); renderFeed(); rendered.ov = 1; } }
  if (scr === 'campaigns') await renderCampaigns();
  if (scr === 'utm') await renderUtm();
  if (scr === 'privatkas') await renderPrivatkas();
  if (scr === 'projects') await renderProjects();
}
$$('#tabbar .tab').forEach(b => b.addEventListener('click', () => go(b.dataset.scr)));
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
  const wd = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  $('#tb-eyebrow').textContent = wd.charAt(0).toUpperCase() + wd.slice(1) + ' · tg-analytics';
  const t = new Date(); $('#liveTime').textContent = pad2(t.getHours()) + ':' + pad2(t.getMinutes());
  try {
    await loadCore();
    await go('overview');
  } catch (err) {
    console.error('[mobile] Failed to load initial data:', err);
    toast('Не удалось загрузить данные. Обновите страницу.', 'warn');
  }
})();
