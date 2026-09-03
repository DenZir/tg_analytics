import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import { createHash, timingSafeEqual } from "node:crypto";
import { db, sqlite } from "./db/index.js";
import { links } from "./db/schema.js";
import {
  createCampaign,
  getAllProjects,
  createProject,
  updateProjectConfig,
  linkProjects,
  getCampaignTags,
  upsertCampaignTag,
  deleteCampaignTag,
  getCampaignFullHistory,
  getAttributionForUser,
  reassignLinkCampaign,
  getCampaignsPage,
  softDeleteCampaign,
  restoreCampaign,
  getTrashedCampaigns,
  purgeCampaignCascade,
} from "./services/campaigns.js";
import { logEvent, getRecentEvents } from "./services/events.js";
import { EVENT_TYPES } from "./db/eventTypes.js";
import {
  getMetrics,
  getRetentionStats,
  getPurchaseConversion,
  getAdvertiserStats,
  getAdvertisersPage,
  getCreativesPage,
  getPrivatkaFinance,
  getPromoStats,
} from "./services/metrics.js";
import {
  createUtmLink,
  listUtmLinksWithMetrics,
  getUtmLinkDetail,
  getUtmSourceRollup,
  recordUtmHit,
  recordUtmPurchase,
  buildDeepLink,
} from "./services/utm.js";
import { getCampaignGeoBreakdown } from "./services/geo.js";
import { eq } from "drizzle-orm";
import {
  redeemAndRotateToken,
  getSessionTgUserId,
  createLoginToken,
  verifyTelegramLogin,
  SESSION_TTL_MS,
} from "./services/dashboardAuth.js";
import { isAdmin } from "./config/admins.js";
import { channelBot } from "./bots/channelBot.js";
import { createFullExport } from "./jobs/backup.js";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());

// GET /health — actively verifies sqlite is reachable and, if the channel bot
// is configured, that it can still reach the Telegram API. Intentionally NOT
// behind the /api auth middleware or the dashboard session check below, so
// Docker's healthcheck (and any external uptime monitor) can hit it directly.
app.get("/health", async (_req, res) => {
  const checks: Record<string, string> = {};
  let healthy = true;

  try {
    sqlite.prepare("SELECT 1").get();
    checks.db = "ok";
  } catch (error: any) {
    checks.db = `error: ${error.message}`;
    healthy = false;
  }

  if (channelBot) {
    try {
      await Promise.race([
        channelBot.telegram.getMe(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
      ]);
      checks.channelBot = "ok";
    } catch (error: any) {
      checks.channelBot = `error: ${error.message}`;
      healthy = false;
    }
  } else {
    checks.channelBot = "not_configured";
  }

  res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", checks });
});

const CHANNEL_BOT_USERNAME = process.env.CHANNEL_BOT_USERNAME || "";
// `?start=dash` makes the bot answer with a one-time login link immediately,
// so signing in never needs a Telegram session in the browser — which is what
// the login widget below requires, and why it otherwise asks for a phone
// number on a browser that has never signed into Telegram Web.
const BOT_DEEP_LINK = CHANNEL_BOT_USERNAME
  ? `https://t.me/${CHANNEL_BOT_USERNAME}?start=dash`
  : null;

// Telegram Login Widget: one-click sign-in straight from this page. Rendered
// only when both the bot username and a dashboard URL are configured. The
// username is matched against Telegram's own format before being interpolated
// so it can't break out of the HTML attribute, and the domain in
// DASHBOARD_URL must be the exact one registered with BotFather via
// /setdomain — Telegram silently refuses to render the widget otherwise.
const DASHBOARD_BASE_URL = (process.env.DASHBOARD_URL || "").replace(/\/+$/, "");
const TELEGRAM_LOGIN_WIDGET =
  /^[A-Za-z0-9_]{4,32}$/.test(CHANNEL_BOT_USERNAME) && DASHBOARD_BASE_URL
    ? `<script async src="https://telegram.org/js/telegram-widget.js?22"
        data-telegram-login="${CHANNEL_BOT_USERNAME}"
        data-size="large"
        data-userpic="false"
        data-auth-url="${DASHBOARD_BASE_URL}/auth/telegram"
        data-request-access="write"></script>`
    : "";

const LOGIN_REQUIRED_HTML = `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="utf-8"><title>TG Analytics — вход</title></head>
<body style="font-family: sans-serif; text-align: center; padding: 60px 20px;">
  <h2>Требуется авторизация</h2>
  <p>Войдите аккаунтом из списка администраторов.</p>
  ${
    BOT_DEEP_LINK
      ? `<p><a href="${BOT_DEEP_LINK}" style="display:inline-block;padding:12px 24px;background:#2AABEE;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Войти через бота</a></p>
  <p style="color:#888;font-size:13px">Откроется Telegram — нажмите «🌐 Войти в дашборд».</p>`
      : `<p>Чтобы открыть дашборд, зайдите в Telegram-бота и нажмите «🔐 Авторизация в дашборд» в главном меню.</p>`
  }
  ${
    TELEGRAM_LOGIN_WIDGET
      ? `<p style="color:#888;font-size:13px;margin-top:32px">Или через виджет Telegram — он попросит номер телефона, если в этом браузере нет сессии Telegram Web:</p>
  <p>${TELEGRAM_LOGIN_WIDGET}</p>`
      : ""
  }
</body>
</html>`;

async function hasValidDashSession(req: express.Request): Promise<boolean> {
  const sessionToken = req.cookies?.dash_session;
  if (!sessionToken) return false;
  const tgUserId = await getSessionTgUserId(sessionToken);
  return !!tgUserId;
}

// Resolves an identity string for the audit log. A dashboard session cookie
// gives us the actual admin's tg user id; a caller authenticated via the
// shared X-API-Key header has no individual identity, so it's logged under
// a fixed "api-key" sentinel instead.
async function getRequestAdminId(req: express.Request): Promise<string> {
  const sessionToken = req.cookies?.dash_session;
  if (sessionToken) {
    const tgUserId = await getSessionTgUserId(sessionToken);
    if (tgUserId) return tgUserId;
  }
  return "api-key";
}

// GET /auth/callback?token=... — redeems a one-time login token minted by
// the bot's "🔐 Авторизация в дашборд" button, sets a persistent session
// cookie, and rotates the token so the original link can't be replayed.
app.get("/auth/callback", async (req, res) => {
  const token = String(req.query.token || "");
  if (!token) return res.status(400).send("Missing token");

  const newToken = await redeemAndRotateToken(token);
  if (!newToken) {
    return res
      .status(401)
      .send(
        "Ссылка недействительна или устарела. Вернитесь в бота и запросите новую через «🔐 Авторизация в дашборд»."
      );
  }

  res.cookie("dash_session", newToken, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    // secure: true intentionally omitted for now — this runs behind a plain-HTTP-to-the-app
    // Cloudflare tunnel during development; revisit once served consistently over a stable HTTPS domain.
  });
  res.redirect("/");
});

// GET /auth/telegram — callback for the Telegram Login Widget on the login
// page. Everything in the query string comes from the user's browser, so the
// HMAC check inside verifyTelegramLogin is what makes it trustworthy; only
// after that does the Telegram id get matched against the admin allowlist.
app.get("/auth/telegram", async (req, res) => {
  const botToken = process.env.CHANNEL_BOT_TOKEN;
  if (!botToken) {
    return res.status(503).send("Вход через Telegram не настроен: не задан CHANNEL_BOT_TOKEN.");
  }

  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === "string") params[key] = value;
  }

  const result = verifyTelegramLogin(params, botToken);
  if (!result.ok) {
    console.warn(`[auth] Telegram login rejected: ${result.reason}`);
    return res
      .status(401)
      .send("Не удалось подтвердить вход через Telegram. Откройте дашборд заново и попробуйте ещё раз.");
  }

  if (!isAdmin(result.tgUserId)) {
    console.warn(`[auth] Telegram login denied for non-admin ${result.tgUserId}`);
    return res.status(403).send("Этот Telegram-аккаунт не в списке администраторов дашборда.");
  }

  const token = await createLoginToken(result.tgUserId);
  res.cookie("dash_session", token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    // secure: true intentionally omitted, matching /auth/callback above — this
    // runs behind a plain-HTTP-to-the-app tunnel during development.
  });
  console.log(`[auth] Telegram widget login for admin ${result.tgUserId}`);
  res.redirect("/");
});

// Serve the mobile build for phone browsers hitting the root URL, so there's
// no separate address to remember — /index.html and /mobile.html stay
// reachable directly (unaffected by this check) for anyone who wants to force
// one or the other.
const MOBILE_UA = /Android|iPhone|iPod|Windows Phone|BlackBerry|IEMobile|Opera Mini/i;
app.get("/", async (req, res, next) => {
  if (!(await hasValidDashSession(req))) {
    return res.status(401).send(LOGIN_REQUIRED_HTML);
  }
  if (MOBILE_UA.test(req.headers["user-agent"] || "")) {
    return res.sendFile(path.join(__dirname, "dashboard/public/mobile.html"));
  }
  next();
});

app.get(["/index.html", "/mobile.html"], async (req, res, next) => {
  if (!(await hasValidDashSession(req))) {
    return res.status(401).send(LOGIN_REQUIRED_HTML);
  }
  next();
});

app.use(express.static(path.join(__dirname, "dashboard/public")));

// API Authentication Middleware — accepts EITHER the shared X-API-Key header
// (used by server-to-server callers, e.g. the private/private-test bots) OR
// a valid dash_session cookie (used by the browser dashboard).
// Constant-time string comparison — hashing both sides to a fixed-length
// digest first avoids timingSafeEqual's own length-mismatch throw, and means
// comparison time never varies with how much of the input happens to match.
function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

app.use("/api", async (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  const expectedSecret = process.env.API_SECRET;
  if (expectedSecret && typeof apiKey === "string" && constantTimeEqual(apiKey, expectedSecret)) {
    return next();
  }

  if (await hasValidDashSession(req)) return next();

  return res.status(401).json({ error: "Unauthorized" });
});

// GET /api/export/full — downloads a complete, point-in-time sqlite snapshot
// (every table, exactly as the schema defines it) for admins who want the
// full raw dataset rather than the scoped CSV export on each dashboard tab.
// Reuses the same sqlite.backup() mechanism as the scheduled nightly backup
// (src/jobs/backup.ts), just to a one-off file that's deleted right after
// it's streamed to the client.
app.get("/api/export/full", async (_req, res) => {
  let tempPath: string | null = null;
  try {
    tempPath = await createFullExport();
    const filename = `tg-analytics-export-${new Date().toISOString().slice(0, 10)}.db`;
    res.download(tempPath, filename, (err) => {
      if (tempPath) fs.unlink(tempPath, () => {});
      if (err) console.error("[export] Failed to send full export:", err);
    });
  } catch (error: any) {
    if (tempPath) fs.unlink(tempPath, () => {});
    res.status(500).json({ error: error.message });
  }
});

// --- Projects API ---

// GET /api/projects
app.get("/api/projects", async (_req, res) => {
  try {
    const projectsList = await getAllProjects();
    res.json(projectsList);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/projects
app.post("/api/projects", async (req, res) => {
  try {
    const { name, type, telegramChatId, botUsername } = req.body;
    if (!name || !type) {
      return res.status(400).json({ error: "Missing required fields (name, type)" });
    }

    const project = await createProject({
      name: String(name),
      type: String(type),
      telegramChatId: telegramChatId ? String(telegramChatId) : undefined,
      botUsername: botUsername ? String(botUsername) : undefined,
    });

    res.status(201).json(project);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/projects/:id
app.patch("/api/projects/:id", async (req, res) => {
  try {
    const projectId = Number(req.params.id);
    const { telegramChatId, botUsername } = req.body;

    const updated = await updateProjectConfig(projectId, {
      telegramChatId: telegramChatId !== undefined ? String(telegramChatId) : undefined,
      botUsername: botUsername !== undefined ? String(botUsername) : undefined,
    });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/projects/:id/link-privatka
app.patch("/api/projects/:id/link-privatka", async (req, res) => {
  try {
    const channelProjectId = Number(req.params.id);
    const { linkedProjectId } = req.body;

    if (!linkedProjectId) {
      return res.status(400).json({ error: "Missing linkedProjectId in request body" });
    }

    const updatedProject = await linkProjects(channelProjectId, Number(linkedProjectId));
    res.json(updatedProject);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// --- Campaigns & Tags API ---

// POST /api/campaigns
app.post("/api/campaigns", async (req, res) => {
  try {
    const { projectId, advertiser, price, tags } = req.body;
    if (!projectId || !advertiser || price === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const campaign = await createCampaign({
      projectId: Number(projectId),
      advertiser: String(advertiser),
      price: Number(price),
      tags,
    });

    res.status(201).json(campaign);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/campaigns/:id/tags
app.get("/api/campaigns/:id/tags", async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    const tagsList = await getCampaignTags(campaignId);
    res.json(tagsList);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/campaigns/:id/tags/:tagKey
app.put("/api/campaigns/:id/tags/:tagKey", async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    const tagKey = String(req.params.tagKey);
    const { tagValue } = req.body;

    if (tagValue === undefined) {
      return res.status(400).json({ error: "Missing tagValue in request body" });
    }

    const updatedTag = await upsertCampaignTag(campaignId, tagKey, String(tagValue));
    res.json(updatedTag);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/campaigns/:id/tags/:tagKey
app.delete("/api/campaigns/:id/tags/:tagKey", async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    const tagKey = String(req.params.tagKey);

    const result = await deleteCampaignTag(campaignId, tagKey);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/campaigns/:id/history
app.get("/api/campaigns/:id/history", async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    const history = await getCampaignFullHistory(campaignId);
    if (!history) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    res.json(history);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/campaigns/:id — moves the campaign to the trash (soft delete).
// Restorable via POST /api/campaigns/:id/restore until it's purged (either
// manually via DELETE /api/campaigns/:id/purge, or automatically after
// TRASH_RETENTION_DAYS by src/jobs/purgeTrash.ts).
app.delete("/api/campaigns/:id", async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    const adminId = await getRequestAdminId(req);
    const result = await softDeleteCampaign(campaignId, adminId);
    if (!result) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/campaigns/trash — lists campaigns currently in the trash
app.get("/api/campaigns/trash", async (_req, res) => {
  try {
    const rows = await getTrashedCampaigns();
    res.json(rows);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/campaigns/:id/restore — restores a campaign out of the trash
app.post("/api/campaigns/:id/restore", async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    const adminId = await getRequestAdminId(req);
    const result = await restoreCampaign(campaignId, adminId);
    if (!result) {
      return res.status(404).json({ error: "Campaign not found or not in the trash" });
    }
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/campaigns/:id/purge — permanently deletes a campaign that is
// already in the trash, before its automatic expiry
app.delete("/api/campaigns/:id/purge", async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    const adminId = await getRequestAdminId(req);
    const result = await purgeCampaignCascade(campaignId, adminId);
    if (!result) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// PATCH /api/links/:id/campaign
app.patch("/api/links/:id/campaign", async (req, res) => {
  try {
    const linkId = Number(req.params.id);
    const { campaignId } = req.body;
    if (!campaignId) {
      return res.status(400).json({ error: "Missing campaignId in request body" });
    }

    const updated = await reassignLinkCampaign(linkId, Number(campaignId));
    res.json(updated);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/attribution?tgUserId=<id>
app.get("/api/attribution", async (req, res) => {
  try {
    const { tgUserId } = req.query;
    if (!tgUserId) {
      return res.status(400).json({ error: "Missing tgUserId query parameter" });
    }

    const result = await getAttributionForUser(String(tgUserId));
    if (!result) {
      return res.status(404).json({ error: "No attribution found for this tgUserId" });
    }

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Events & Webhook API ---

// POST /api/events
app.post("/api/events", async (req, res) => {
  try {
    const { linkId, tgUserId, eventType, amount, languageCode, promoCode, discountAmount } =
      req.body;
    if (!tgUserId || !eventType) {
      return res.status(400).json({ error: "Missing required fields (tgUserId, eventType)" });
    }
    const validEventTypes = Object.values(EVENT_TYPES) as string[];
    if (!validEventTypes.includes(String(eventType))) {
      return res.status(400).json({
        error: `Invalid eventType "${eventType}". Must be one of: ${validEventTypes.join(", ")}`,
      });
    }

    // The promo code is free text coming from a bot, so it is trimmed and
    // length-capped before it can ever reach a dashboard cell.
    const normalizedPromo =
      typeof promoCode === "string" && promoCode.trim() !== ""
        ? promoCode.trim().slice(0, 64)
        : undefined;

    const parsedDiscount = discountAmount === undefined ? 0 : Number(discountAmount);
    if (!Number.isFinite(parsedDiscount) || parsedDiscount < 0) {
      return res.status(400).json({ error: "discountAmount must be a non-negative number" });
    }

    const event = await logEvent({
      linkId: linkId ? Number(linkId) : undefined,
      tgUserId: String(tgUserId),
      eventType: String(eventType),
      amount: amount ? Number(amount) : 0,
      languageCode: languageCode ? String(languageCode) : undefined,
      promoCode: normalizedPromo,
      discountAmount: parsedDiscount,
    });

    res.status(201).json({ success: true, event });
  } catch (error: any) {
    if (error.message && error.message.includes("Cannot attribute event")) {
      return res.status(422).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

// GET /api/promo — per-code promo performance for the dashboard.
app.get("/api/promo", async (_req, res) => {
  try {
    res.json(await getPromoStats());
  } catch (error: any) {
    console.error("[api] Failed to load promo stats:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/events/recent?limit=<n>
app.get("/api/events/recent", async (req, res) => {
  try {
    const { limit } = req.query;
    const parsedLimit = limit !== undefined ? Number(limit) : undefined;
    const recentEvents = await getRecentEvents(
      parsedLimit !== undefined && !Number.isNaN(parsedLimit) ? parsedLimit : undefined
    );
    res.json(recentEvents);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/payments/webhook
app.post("/api/payments/webhook", async (req, res) => {
  try {
    let { campaignId, linkId, tgUserId, amount } = req.body;

    if (!tgUserId || amount === undefined) {
      return res.status(400).json({ error: "Missing required fields (tgUserId, amount)" });
    }

    if (!linkId && campaignId) {
      const link = await db.query.links.findFirst({
        where: eq(links.campaignId, Number(campaignId)),
      });
      if (link) {
        linkId = link.id;
      }
    }

    if (!linkId) {
      return res.status(400).json({ error: "Could not find a valid linkId for payment" });
    }

    const event = await logEvent({
      linkId: Number(linkId),
      tgUserId: String(tgUserId),
      eventType: "payment",
      amount: Number(amount),
    });

    res.status(200).json({ success: true, event });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/metrics
app.get("/api/metrics", async (_req, res) => {
  try {
    const metrics = await getMetrics();
    res.json(metrics);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/metrics/extended
app.get("/api/metrics/extended", async (_req, res) => {
  try {
    const baseMetrics = await getMetrics();

    const extendedCampaigns = await Promise.all(
      baseMetrics.campaigns.map(async (c) => {
        const ret = await getRetentionStats(c.id);
        const purchaseConversion = await getPurchaseConversion(c.id);
        const geo = await getCampaignGeoBreakdown(c.id);
        return {
          ...c,
          retention24h: ret.retention24h,
          retention48h: ret.retention48h,
          purchaseConversion,
          geo,
        };
      })
    );

    const advertisers = await getAdvertiserStats();

    res.json({
      campaigns: extendedCampaigns,
      advertisers,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/campaigns/page?mode=links|advertisers|creatives&page=&pageSize=&q=
// Paginated data source for the "Кампании" dashboard tab — computes
// retention/conversion/link stats only for the requested page's campaigns
// instead of every campaign in the project (see /api/metrics/extended).
app.get("/api/campaigns/page", async (req, res) => {
  try {
    const rawMode = req.query.mode;
    const mode =
      rawMode === "advertisers" ? "advertisers" : rawMode === "creatives" ? "creatives" : "links";
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const q = typeof req.query.q === "string" ? req.query.q : undefined;

    if (mode === "advertisers") {
      const { rows, total } = await getAdvertisersPage({ page, pageSize, q });
      res.json({ mode, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), advertisers: rows });
    } else if (mode === "creatives") {
      const { rows, total } = await getCreativesPage({ page, pageSize, q });
      res.json({ mode, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), creatives: rows });
    } else {
      const { rows, total } = await getCampaignsPage({ page, pageSize, q });
      res.json({ mode, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), campaigns: rows });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/privatkas/finance
app.get("/api/privatkas/finance", async (_req, res) => {
  try {
    const finance = await getPrivatkaFinance();
    res.json(finance);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- UTM Links API ---

// POST /api/utm/links
app.post("/api/utm/links", async (req, res) => {
  try {
    const { utmSource, utmMedium, utmCampaign, utmContent, label, spend, slug, botUsername } =
      req.body;

    if (!utmSource || !utmMedium || !utmCampaign) {
      return res
        .status(400)
        .json({ error: "Missing required fields (utmSource, utmMedium, utmCampaign)" });
    }

    const link = await createUtmLink({
      utmSource: String(utmSource),
      utmMedium: String(utmMedium),
      utmCampaign: String(utmCampaign),
      utmContent: utmContent !== undefined ? String(utmContent) : undefined,
      label: label !== undefined ? String(label) : undefined,
      spend: spend !== undefined ? Number(spend) : undefined,
      slug: slug !== undefined ? String(slug) : undefined,
      botUsername: botUsername ? String(botUsername) : undefined,
    });

    res.status(201).json({ ...link, deepLink: buildDeepLink(link) });
  } catch (error: any) {
    if (
      error.message &&
      (error.message.includes("already taken") || error.message.includes("Invalid slug"))
    ) {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

// GET /api/utm/links
app.get("/api/utm/links", async (_req, res) => {
  try {
    const linksList = await listUtmLinksWithMetrics();
    res.json(linksList);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/utm/links/:id
app.get("/api/utm/links/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const detail = await getUtmLinkDetail(id);
    if (!detail) {
      return res.status(404).json({ error: "UTM link not found" });
    }
    res.json(detail);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/utm/sources
app.get("/api/utm/sources", async (_req, res) => {
  try {
    const rollup = await getUtmSourceRollup();
    res.json(rollup);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/utm/hit
app.post("/api/utm/hit", async (req, res) => {
  try {
    const { slug, tgUserId, languageCode } = req.body;
    if (!slug || !tgUserId) {
      return res.status(400).json({ error: "Missing required fields (slug, tgUserId)" });
    }

    const result = await recordUtmHit(
      String(slug),
      String(tgUserId),
      languageCode ? String(languageCode) : undefined
    );
    if (!result.found) {
      return res.status(404).json({ error: "Unknown UTM slug" });
    }

    res.status(201).json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/utm/purchase
app.post("/api/utm/purchase", async (req, res) => {
  try {
    const { tgUserId, amount, eventType } = req.body;
    if (!tgUserId || amount === undefined) {
      return res.status(400).json({ error: "Missing required fields (tgUserId, amount)" });
    }
    if (eventType !== "payment" && eventType !== "renewal") {
      return res.status(400).json({ error: "eventType must be 'payment' or 'renewal'" });
    }

    const result = await recordUtmPurchase(String(tgUserId), Number(amount), eventType);
    res.status(200).json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export function startServer() {
  return app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

export { app };
