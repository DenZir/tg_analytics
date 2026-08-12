import { db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createCampaign, createDeepLinkForCampaign } from "../services/campaigns.js";
import { createInviteForCampaign } from "../bots/channelBot.js";

async function main() {
  const rawArgs = process.argv.slice(2);

  let advertiser = "";
  let price: number | null = null;
  let projectId: number | null = null;
  let channelId: string | undefined = undefined;
  let privBot: string | undefined = undefined;
  let payload: string | undefined = undefined;
  const tags: Record<string, string> = {};

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    if ((arg === "--advertiser" || arg === "-a") && i + 1 < rawArgs.length) {
      advertiser = rawArgs[++i];
    } else if ((arg === "--price" || arg === "-p") && i + 1 < rawArgs.length) {
      price = parseFloat(rawArgs[++i]);
    } else if ((arg === "--project-id" || arg === "-pr") && i + 1 < rawArgs.length) {
      projectId = parseInt(rawArgs[++i], 10);
    } else if ((arg === "--channel-id" || arg === "-c") && i + 1 < rawArgs.length) {
      channelId = rawArgs[++i];
    } else if (arg === "--priv-bot" && i + 1 < rawArgs.length) {
      privBot = rawArgs[++i];
    } else if (arg === "--payload" && i + 1 < rawArgs.length) {
      payload = rawArgs[++i];
    } else if (arg === "--tag" && i + 1 < rawArgs.length) {
      const tagVal = rawArgs[++i];
      const [k, ...v] = tagVal.split("=");
      if (k) {
        tags[k] = v.join("=");
      }
    }
  }

  // Fallback positional argument parsing if flags were stripped by shell wrapper
  if (!advertiser || price === null || isNaN(price)) {
    const cleanArgs = rawArgs.filter((a) => a !== "new-campaign" && !a.startsWith("-"));
    if (cleanArgs.length >= 2) {
      if (!advertiser) advertiser = cleanArgs[0];
      if (price === null || isNaN(price)) price = parseFloat(cleanArgs[1]);
    }
  }

  if (!advertiser || price === null || isNaN(price)) {
    console.error(
      "Usage: npm run cli -- --advertiser <name> --price <price> [--project-id <id>] [--channel-id <channelId>] [--priv-bot <botUsername>] [--payload <customPayload>] [--tag key=value ...]"
    );
    process.exit(1);
  }

  const targetProjectId = projectId ?? 1;

  // Validate existence of project before campaign creation
  const existingProject = await db.query.projects.findFirst({
    where: eq(projects.id, targetProjectId),
  });

  if (!existingProject) {
    console.error(
      `\n[ERROR] Проект с ID ${targetProjectId} не найден.`
    );
    console.error(
      `Сначала создай его: npm run seed -- --name "Название" --type "channel"`
    );
    process.exit(1);
  }

  const campaign = await createCampaign({
    projectId: targetProjectId,
    advertiser,
    price,
    tags,
  });

  console.log("\n=== Campaign Created Successfully ===");
  console.log("ID:", campaign.id);
  console.log("Project ID:", campaign.projectId);
  console.log("Advertiser:", campaign.advertiser);
  console.log("Price:", campaign.price);
  console.log("Tags:", campaign.tags);

  if (channelId) {
    console.log(`\nGenerating Telegram invite link for channel ${channelId}...`);
    try {
      const inviteResult = await createInviteForCampaign(channelId, campaign.id, advertiser);
      console.log("Generated Invite Link:", inviteResult.inviteLink);
    } catch (err: any) {
      console.error("Failed to create Telegram invite link:", err.message);
    }
  }

  if (privBot) {
    console.log(`\nGenerating Deep-Link for private bot ${privBot}...`);
    try {
      const deepLinkResult = await createDeepLinkForCampaign(campaign.id, privBot, payload);
      console.log("Generated Deep-Link:", deepLinkResult.deepLink);
    } catch (err: any) {
      console.error("Failed to create Deep-Link:", err.message);
    }
  }
}

main().catch((err) => {
  console.error("CLI execution error:", err);
  process.exit(1);
});
