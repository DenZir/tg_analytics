import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import { createCampaign, createLinkForCampaign, getCampaignById } from "./services/campaigns.js";
import { logEvent } from "./services/events.js";

async function runTest() {
  console.log("=== TG ANALYTICS TEST RUN ===");

  // 1. Create a parent Project
  const [project] = await db
    .insert(projects)
    .values({
      name: "Crypto Channel Alpha",
      type: "channel",
    })
    .returning();

  console.log("1. Created Project:", project);

  // 2. Create Campaign with tags
  const campaign = await createCampaign({
    projectId: project.id,
    advertiser: "Binance Promo",
    price: 150.5,
    tags: {
      geo: "CIS",
      source: "telegram_ads",
    },
  });

  console.log("2. Created Campaign:", campaign);

  // 3. Create Link for Campaign
  const link = await createLinkForCampaign(
    campaign.id,
    "https://t.me/+test_ref_123",
    "invite_link"
  );

  console.log("3. Created Link:", link);

  // 4. Log Event
  const event = await logEvent({
    linkId: link.id,
    tgUserId: "99887766",
    eventType: "subscription",
    amount: 0,
  });

  console.log("4. Logged Event:", event);

  // 5. Test Duplicate Event (should silently return null)
  if (event) {
    const duplicateEvent = await logEvent({
      linkId: link.id,
      tgUserId: "99887766",
      eventType: "subscription",
      amount: 0,
      ts: event.ts,
    });
    console.log("5. Duplicate Event Logged (should be null):", duplicateEvent);
  }

  // 6. Read back full campaign details
  const fetchedCampaign = await getCampaignById(campaign.id);
  console.log("6. Fetched Campaign from DB:", JSON.stringify(fetchedCampaign, null, 2));

  console.log("=== TEST SUCCESSFUL ===");
}

runTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
