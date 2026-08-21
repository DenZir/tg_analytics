import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "./db/index.js";
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
} from "./services/campaigns.js";
import { logEvent, getRecentEvents } from "./services/events.js";
import {
  getMetrics,
  getRetentionStats,
  getPurchaseConversion,
  getAdvertiserStats,
  getPrivatkaFinance,
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
import { redeemAndRotateToken, getSessionTgUserId } from "./services/dashboardAuth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());

const CHANNEL_BOT_USERNAME = process.env.CHANNEL_BOT_USERNAME || "";
const BOT_DEEP_LINK = CHANNEL_BOT_USERNAME ? `https://t.me/${CHANNEL_BOT_USERNAME}` : null;

const LOGIN_REQUIRED_HTML = `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="utf-8"><title>TG Analytics — вход</title></head>
<body style="font-family: sans-serif; text-align: center; padding: 60px 20px;">
  <h2>Требуется авторизация</h2>
  <p>Чтобы открыть дашборд, зайдите в Telegram-бота и нажмите «🔐 Авторизация в дашборд» в главном меню.</p>
  ${
    BOT_DEEP_LINK
      ? `<p><a href="${BOT_DEEP_LINK}" style="display:inline-block;padding:12px 24px;background:#2AABEE;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Открыть бота</a></p>`
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
    maxAge: 5 * 60 * 60 * 1000, // 5 hours, matches dashboardAuth's SESSION_TTL_MS
    // secure: true intentionally omitted for now — this runs behind a plain-HTTP-to-the-app
    // Cloudflare tunnel during development; revisit once served consistently over a stable HTTPS domain.
  });
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
app.use("/api", async (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  const expectedSecret = process.env.API_SECRET;
  if (expectedSecret && apiKey === expectedSecret) return next();

  if (await hasValidDashSession(req)) return next();

  return res.status(401).json({ error: "Unauthorized" });
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
    const { linkId, tgUserId, eventType, amount, languageCode } = req.body;
    if (!tgUserId || !eventType) {
      return res.status(400).json({ error: "Missing required fields (tgUserId, eventType)" });
    }

    const event = await logEvent({
      linkId: linkId ? Number(linkId) : undefined,
      tgUserId: String(tgUserId),
      eventType: String(eventType),
      amount: amount ? Number(amount) : 0,
      languageCode: languageCode ? String(languageCode) : undefined,
    });

    res.status(201).json({ success: true, event });
  } catch (error: any) {
    if (error.message && error.message.includes("Cannot attribute event")) {
      return res.status(422).json({ error: error.message });
    }
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
