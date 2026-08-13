let revenueChart = null;
let currentApiKey = null;
let activeModalCampaignId = null;
let extendedData = null;
let currentTableMode = "links"; // 'links' | 'advertisers'

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

async function fetchMetrics() {
  try {
    const res = await fetch("/api/metrics/extended", {
      headers: getHeaders(),
    });

    if (res.status === 401) {
      alert("Unauthorized: Invalid API Key");
      currentApiKey = null;
      return;
    }

    extendedData = await res.json();
    updateDashboard(extendedData);
  } catch (error) {
    console.error("Failed to fetch metrics:", error);
  }
}

function updateDashboard(data) {
  const campaignsList = data.campaigns || [];

  const totalCampaigns = campaignsList.length;
  const totalSubs = campaignsList.reduce((acc, curr) => acc + (curr.totalSubs || 0), 0);
  const totalRevenue = campaignsList.reduce((acc, curr) => acc + (curr.totalRevenue || 0), 0);
  const totalCost = campaignsList.reduce((acc, curr) => acc + (curr.price || 0), 0);
  const avgCps = totalSubs > 0 ? (totalCost / totalSubs).toFixed(2) : "0.00";

  document.getElementById("kpi-campaigns").innerText = totalCampaigns;
  document.getElementById("kpi-subs").innerText = totalSubs;
  document.getElementById("kpi-revenue").innerText = `${totalRevenue.toLocaleString()} ₽`;
  document.getElementById("kpi-cps").innerText = `${avgCps} ₽`;

  // Render Table & Privatka section
  renderCampaignsTable();
  renderPrivatkaTable();

  // Update Chart using daily metrics fallback or campaign metrics
  const dates = [];
  const ctx = document.getElementById("revenueChart").getContext("2d");

  if (revenueChart) {
    revenueChart.destroy();
  }

  revenueChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: dates.length > 0 ? dates : ["System Active"],
      datasets: [{
        label: "Revenue (₽)",
        data: dates.length > 0 ? [0] : [totalRevenue],
        borderColor: "#38bdf8",
        backgroundColor: "rgba(56, 189, 248, 0.1)",
        borderWidth: 3,
        fill: true,
        tension: 0.4,
        pointBackgroundColor: "#38bdf8",
        pointHoverRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          grid: { color: "rgba(255, 255, 255, 0.05)" },
          ticks: { color: "#94a3b8" }
        },
        y: {
          grid: { color: "rgba(255, 255, 255, 0.05)" },
          ticks: { color: "#94a3b8" }
        }
      }
    }
  });
}

function renderCampaignsTable() {
  if (!extendedData) return;

  const thead = document.getElementById("campaigns-table-head");
  const tbody = document.getElementById("campaigns-table-body");
  tbody.innerHTML = "";

  if (currentTableMode === "links") {
    document.getElementById("table-hint").style.display = "inline";
    thead.innerHTML = `
      <tr>
        <th>Админ</th>
        <th>Пост/Креатив</th>
        <th>Цена</th>
        <th>Заход</th>
        <th>Retention 24ч/48ч</th>
        <th>Конверсия в покупку %</th>
        <th>LTV / Выручка</th>
        <th>CPS</th>
      </tr>
    `;

    const campaignsList = extendedData.campaigns || [];
    if (campaignsList.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No campaigns found.</td></tr>`;
      return;
    }

    campaignsList.forEach((camp) => {
      const tr = document.createElement("tr");
      tr.className = "clickable-row";

      const safeAdv = escapeHtml(camp.advertiser);
      const cpsText = camp.cps !== null && camp.cps !== undefined ? `${Number(camp.cps).toFixed(2)} ₽` : "-";
      const tagHtml = camp.creative && camp.creative !== "-" 
        ? `<span class="tag-badge">${escapeHtml(camp.creative)}</span>` 
        : `<span style="color: var(--text-muted);">-</span>`;

      const ret24 = camp.retention24h !== null && camp.retention24h !== undefined ? `${camp.retention24h}%` : "-";
      const ret48 = camp.retention48h !== null && camp.retention48h !== undefined ? `${camp.retention48h}%` : "-";
      const retentionText = (ret24 === "-" && ret48 === "-") ? "-" : `${ret24} / ${ret48}`;

      const purConvPct = camp.purchaseConversion?.conversionPct !== null && camp.purchaseConversion?.conversionPct !== undefined
        ? `${camp.purchaseConversion.conversionPct}%`
        : "-";

      tr.innerHTML = `
        <td style="font-weight: 600;">${safeAdv}</td>
        <td>${tagHtml}</td>
        <td>${camp.price} ₽</td>
        <td style="color: var(--success); font-weight: 500;">+${camp.totalSubs}</td>
        <td style="font-weight: 500; color: var(--accent-blue);">${retentionText}</td>
        <td style="font-weight: 500; color: var(--accent-purple);">${purConvPct}</td>
        <td style="font-weight: 600;">${camp.totalRevenue} ₽</td>
        <td>${cpsText}</td>
      `;

      tr.addEventListener("click", () => {
        openCampaignModal(camp.id, camp.advertiser);
      });

      tbody.appendChild(tr);
    });
  } else {
    document.getElementById("table-hint").style.display = "none";
    thead.innerHTML = `
      <tr>
        <th>Админ</th>
        <th>Кол-во кампаний</th>
        <th>Сумма цен</th>
        <th>Заход</th>
        <th>Конверсия %</th>
        <th>Ср. CPS</th>
      </tr>
    `;

    const advertisersList = extendedData.advertisers || [];
    if (advertisersList.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No advertisers data found.</td></tr>`;
      return;
    }

    advertisersList.forEach((adv) => {
      const tr = document.createElement("tr");

      const safeAdv = escapeHtml(adv.advertiser);
      const avgCpsText = adv.avgCps !== null && adv.avgCps !== undefined ? `${Number(adv.avgCps).toFixed(2)} ₽` : "-";
      const retText = adv.avgRetention24h !== null && adv.avgRetention24h !== undefined ? `${adv.avgRetention24h}%` : "-";

      tr.innerHTML = `
        <td style="font-weight: 600;">${safeAdv}</td>
        <td style="font-weight: 500;">${adv.campaignsCount}</td>
        <td>${adv.totalPrice} ₽</td>
        <td style="color: var(--success); font-weight: 500;">+${adv.totalSubs}</td>
        <td style="font-weight: 500; color: var(--accent-blue);">${retText}</td>
        <td>${avgCpsText}</td>
      `;

      tbody.appendChild(tr);
    });
  }
}

function renderPrivatkaTable() {
  if (!extendedData) return;

  const tbody = document.getElementById("privatka-table-body");
  tbody.innerHTML = "";

  const privatkaList = extendedData.privatka || [];
  if (privatkaList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No privatka deep-links logged.</td></tr>`;
    return;
  }

  privatkaList.forEach((priv) => {
    const tr = document.createElement("tr");

    const safeAdv = escapeHtml(priv.advertiser);
    const rawRef = String(priv.telegramRef || "");
    const truncatedRef = rawRef.length > 30 ? rawRef.slice(0, 30) + "..." : rawRef;
    const safeRefDisplay = escapeHtml(truncatedRef);

    const fullUrl = rawRef.startsWith("http")
      ? rawRef
      : `https://t.me/pupazalupaabot?start=${encodeURIComponent(rawRef)}`;

    const refHtml = `<a href="${escapeHtml(fullUrl)}" target="_blank" style="color: var(--accent-blue); text-decoration: none;"><code>${safeRefDisplay}</code></a>`;

    const convText = priv.conversionPct !== null && priv.conversionPct !== undefined ? `${priv.conversionPct}%` : "-";
    const avgCheckText = priv.avgCheckPerLead !== null && priv.avgCheckPerLead !== undefined ? `${priv.avgCheckPerLead} ₽` : "-";

    tr.innerHTML = `
      <td style="font-weight: 600;">${safeAdv}</td>
      <td>${refHtml}</td>
      <td style="font-weight: 500;">${priv.leadsCount}</td>
      <td style="color: var(--success); font-weight: 500;">${priv.purchasedCount}</td>
      <td style="font-weight: 500; color: var(--accent-purple);">${convText}</td>
      <td style="font-weight: 600;">${avgCheckText}</td>
    `;

    tbody.appendChild(tr);
  });
}

// Mode Toggle Event Listeners
document.getElementById("tab-links").addEventListener("click", () => {
  currentTableMode = "links";
  document.getElementById("tab-links").classList.add("active");
  document.getElementById("tab-advertisers").classList.remove("active");
  renderCampaignsTable();
});

document.getElementById("tab-advertisers").addEventListener("click", () => {
  currentTableMode = "advertisers";
  document.getElementById("tab-advertisers").classList.add("active");
  document.getElementById("tab-links").classList.remove("active");
  renderCampaignsTable();
});

// --- Task 4: Projects Management ---

async function fetchProjects() {
  try {
    const res = await fetch("/api/projects", {
      headers: getHeaders(),
    });
    if (!res.ok) return;

    const projects = await res.json();
    const tbody = document.getElementById("projects-table-body");
    tbody.innerHTML = "";

    if (projects.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No projects yet.</td></tr>`;
      return;
    }

    projects.forEach((p) => {
      const tr = document.createElement("tr");
      const safeName = escapeHtml(p.name);
      const safeType = escapeHtml(p.type);
      const safeChatId = escapeHtml(p.telegramChatId || "-");
      const safeUsername = escapeHtml(p.botUsername || "-");

      tr.innerHTML = `
        <td style="color: var(--text-muted);">${p.id}</td>
        <td style="font-weight: 600;">${safeName}</td>
        <td><span class="tag-badge">${safeType}</span></td>
        <td><code>${safeChatId}</code></td>
        <td><code>${safeUsername}</code></td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error("Failed to fetch projects:", err);
  }
}

document.getElementById("add-project-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("proj-name").value.trim();
  const type = document.getElementById("proj-type").value;
  const telegramChatId = document.getElementById("proj-chat-id").value.trim();
  const botUsername = document.getElementById("proj-bot-username").value.trim();

  if (!name || !type) return;

  try {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        name,
        type,
        telegramChatId: telegramChatId || undefined,
        botUsername: botUsername || undefined,
      }),
    });

    if (res.ok) {
      document.getElementById("add-project-form").reset();
      await fetchProjects();
    } else {
      const err = await res.json();
      alert(`Error creating project: ${escapeHtml(err.error)}`);
    }
  } catch (err) {
    console.error("Failed to add project:", err);
  }
});

// --- Modal Details & Tags ---

async function openCampaignModal(campaignId, advertiser) {
  activeModalCampaignId = campaignId;
  document.getElementById("modal-title").innerText = `Campaign Details — ${advertiser}`;
  document.getElementById("campaign-modal").classList.add("active");

  await loadCampaignTags(campaignId);
  await loadCampaignHistory(campaignId);
}

function closeModal() {
  document.getElementById("campaign-modal").classList.remove("active");
  activeModalCampaignId = null;
}

document.getElementById("modal-close-btn").addEventListener("click", closeModal);
document.getElementById("campaign-modal").addEventListener("click", (e) => {
  if (e.target.id === "campaign-modal") {
    closeModal();
  }
});

async function loadCampaignTags(campaignId) {
  const container = document.getElementById("modal-tags-list");
  container.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem;">Loading tags...</div>`;

  try {
    const res = await fetch(`/api/campaigns/${campaignId}/tags`, {
      headers: getHeaders(),
    });
    if (!res.ok) return;

    const tags = await res.json();
    container.innerHTML = "";

    if (tags.length === 0) {
      container.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem;">No tags set for this campaign.</div>`;
      return;
    }

    tags.forEach((t) => {
      const row = document.createElement("div");
      row.className = "tag-row";

      const safeKey = escapeHtml(t.tagKey);
      const safeVal = escapeHtml(t.tagValue);

      row.innerHTML = `
        <span class="tag-key-label">${safeKey}</span>
        <input type="text" value="${safeVal}" class="tag-val-input" style="flex: 1;">
        <button class="btn-sm btn-save">Save</button>
        <button class="btn-sm btn-danger btn-del">Delete</button>
      `;

      const valInput = row.querySelector(".tag-val-input");
      row.querySelector(".btn-save").addEventListener("click", async () => {
        const newVal = valInput.value.trim();
        await updateTag(campaignId, t.tagKey, newVal);
      });

      row.querySelector(".btn-del").addEventListener("click", async () => {
        await deleteTag(campaignId, t.tagKey);
      });

      container.appendChild(row);
    });
  } catch (err) {
    console.error("Failed to load tags:", err);
  }
}

async function updateTag(campaignId, tagKey, tagValue) {
  try {
    const res = await fetch(`/api/campaigns/${campaignId}/tags/${encodeURIComponent(tagKey)}`, {
      method: "PUT",
      headers: getHeaders(),
      body: JSON.stringify({ tagValue }),
    });

    if (res.ok) {
      await loadCampaignTags(campaignId);
      await fetchMetrics(); // Refresh main dashboard table
    }
  } catch (err) {
    console.error("Failed to update tag:", err);
  }
}

async function deleteTag(campaignId, tagKey) {
  try {
    const res = await fetch(`/api/campaigns/${campaignId}/tags/${encodeURIComponent(tagKey)}`, {
      method: "DELETE",
      headers: getHeaders(),
    });

    if (res.ok) {
      await loadCampaignTags(campaignId);
      await fetchMetrics();
    }
  } catch (err) {
    console.error("Failed to delete tag:", err);
  }
}

document.getElementById("add-tag-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeModalCampaignId) return;

  const tagKey = document.getElementById("new-tag-key").value.trim();
  const tagValue = document.getElementById("new-tag-val").value.trim();

  if (!tagKey || !tagValue) return;

  await updateTag(activeModalCampaignId, tagKey, tagValue);
  document.getElementById("add-tag-form").reset();
});

async function loadCampaignHistory(campaignId) {
  const tbody = document.getElementById("modal-history-table-body");
  tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Loading history...</td></tr>`;

  try {
    const res = await fetch(`/api/campaigns/${campaignId}/history`, {
      headers: getHeaders(),
    });
    if (!res.ok) return;

    const data = await res.json();
    renderCampaignLinks(campaignId, data.links || []);

    const events = data.events || [];
    tbody.innerHTML = "";

    if (events.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No events logged yet.</td></tr>`;
      return;
    }

    events.forEach((e) => {
      const tr = document.createElement("tr");
      const dateStr = escapeHtml(new Date(e.ts).toLocaleString());
      const amountText = e.amount > 0 ? `${e.amount} ₽` : "-";
      const safeEventType = escapeHtml(e.eventType);
      const safeTgUserId = escapeHtml(e.tgUserId);
      const eventBadgeClass = e.eventType === "payment" ? "color: var(--success);" : "";

      tr.innerHTML = `
        <td style="color: var(--text-muted); font-size: 0.85rem;">${dateStr}</td>
        <td style="font-weight: 600; ${eventBadgeClass}">${safeEventType}</td>
        <td><code>${safeTgUserId}</code></td>
        <td style="font-weight: 600;">${amountText}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error("Failed to load history:", err);
  }
}

function renderCampaignLinks(campaignId, linksList) {
  const container = document.getElementById("modal-links-list");
  container.innerHTML = "";

  if (linksList.length === 0) {
    container.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem;">No links for this campaign yet.</div>`;
    return;
  }

  const allCampaigns = (extendedData?.campaigns || [])
    .slice()
    .sort((a, b) => a.advertiser.localeCompare(b.advertiser));

  linksList.forEach((l) => {
    const row = document.createElement("div");
    row.className = "tag-row";

    const safeRef = escapeHtml(l.telegramRef);
    const safeLabel = l.label ? escapeHtml(l.label) : "без названия";
    const safeType = escapeHtml(l.linkType);

    const optionsHtml = allCampaigns
      .filter((c) => c.id !== campaignId)
      .map((c) => `<option value="${c.id}">${escapeHtml(c.advertiser)} (#${c.id})</option>`)
      .join("");

    row.innerHTML = `
      <span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;">
        <strong>${safeLabel}</strong>
        <span style="color: var(--text-muted); font-size: 0.8rem;"> (${safeType})</span><br>
        <code style="font-size: 0.8rem;">${safeRef}</code>
      </span>
      <select class="move-link-select" style="max-width: 220px; flex-shrink: 0;">
        <option value="">Move to campaign…</option>
        ${optionsHtml}
      </select>
      <button class="btn-sm btn-move">Move</button>
    `;

    const select = row.querySelector(".move-link-select");
    row.querySelector(".btn-move").addEventListener("click", async () => {
      const targetCampaignId = Number(select.value);
      if (!targetCampaignId) return;
      await moveLink(l.id, targetCampaignId, campaignId);
    });

    container.appendChild(row);
  });
}

async function moveLink(linkId, targetCampaignId, currentCampaignId) {
  try {
    const res = await fetch(`/api/links/${linkId}/campaign`, {
      method: "PATCH",
      headers: getHeaders(),
      body: JSON.stringify({ campaignId: targetCampaignId }),
    });

    if (res.ok) {
      await loadCampaignHistory(currentCampaignId);
      await fetchMetrics();
    } else {
      const body = await res.json().catch(() => ({}));
      alert(`Failed to move link: ${body.error || res.statusText}`);
    }
  } catch (err) {
    console.error("Failed to move link:", err);
  }
}

// Initial page load
window.addEventListener("DOMContentLoaded", () => {
  fetchMetrics();
  fetchProjects();
});
