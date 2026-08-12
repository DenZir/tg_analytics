import express from "express";
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
  getLinkByRef,
  getCampaignById,
} from "./services/campaigns.js";
import { logEvent } from "./services/events.js";
import {
  getMetrics,
  getRetentionStats,
  getPurchaseConversion,
  getAdvertiserStats,
  getPrivatkaStats,
} from "./services/metrics.js";
import { eq } from "drizzle-orm";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "dashboard/public")));

// API Authentication Middleware
app.use("/api", (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  const expectedSecret = process.env.API_SECRET;

  if (expectedSecret && apiKey !== expectedSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
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

// GET /api/links/resolve?ref=<payload>
app.get("/api/links/resolve", async (req, res) => {
  try {
    const { ref } = req.query;
    if (!ref) {
      return res.status(400).json({ error: "Missing ref query parameter" });
    }

    const link = await getLinkByRef(String(ref));
    if (!link) {
      return res.status(404).json({ error: "Link not found" });
    }

    const campaign = await getCampaignById(link.campaignId);
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const tags = Object.fromEntries(campaign.tags.map((t) => [t.tagKey, t.tagValue]));

    res.json({
      linkId: link.id,
      campaignId: campaign.id,
      advertiser: campaign.advertiser,
      telegramRef: link.telegramRef,
      tags,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Events & Webhook API ---

// POST /api/events
app.post("/api/events", async (req, res) => {
  try {
    const { linkId, tgUserId, eventType, amount } = req.body;
    if (!tgUserId || !eventType) {
      return res.status(400).json({ error: "Missing required fields (tgUserId, eventType)" });
    }

    const event = await logEvent({
      linkId: linkId ? Number(linkId) : undefined,
      tgUserId: String(tgUserId),
      eventType: String(eventType),
      amount: amount ? Number(amount) : 0,
    });

    res.status(201).json({ success: true, event });
  } catch (error: any) {
    if (error.message && error.message.includes("Cannot attribute event")) {
      return res.status(422).json({ error: error.message });
    }
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
        return {
          ...c,
          retention24h: ret.retention24h,
          retention48h: ret.retention48h,
          purchaseConversion,
        };
      })
    );

    const advertisers = await getAdvertiserStats();
    const privatka = await getPrivatkaStats();

    res.json({
      campaigns: extendedCampaigns,
      advertisers,
      privatka,
    });
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
