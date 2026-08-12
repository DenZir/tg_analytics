import { db } from "../db/index.js";
import { campaigns, campaignTags, links, events, dailyStats, projects } from "../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { deleteProjectCascade } from "../services/campaigns.js";

async function main() {
  const args = process.argv.slice(2);
  const isTagTest = args.includes("--tag-test");
  const isAll = args.includes("--all");
  const isConfirm = args.includes("--confirm");

  // Parse --project-ids "1,2,3" or --project-ids 1,2,3
  let targetProjectIds: number[] = [];
  const projArgIdx = args.findIndex((arg) => arg.startsWith("--project-ids"));
  if (projArgIdx !== -1) {
    let rawValue = "";
    if (args[projArgIdx].includes("=")) {
      rawValue = args[projArgIdx].split("=")[1];
    } else if (args[projArgIdx + 1] && !args[projArgIdx + 1].startsWith("--")) {
      rawValue = args[projArgIdx + 1];
    }
    if (rawValue) {
      targetProjectIds = rawValue
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => !isNaN(n) && n > 0);
    }
  }

  // Fetch current database counts & projects
  const allCampaignsList = await db.select().from(campaigns);
  const allTagsList = await db.select().from(campaignTags);
  const allLinksList = await db.select().from(links);
  const allEventsList = await db.select().from(events);
  const allDailyStatsList = await db.select().from(dailyStats);
  const allProjectsList = await db.select().from(projects);

  const testTags = allTagsList.filter((t) => t.tagKey === "is_test" && t.tagValue === "true");
  const testCampaignIds = Array.from(new Set(testTags.map((t) => t.campaignId)));

  console.log("=== TG ANALYTICS DATA RESET UTILITY ===");
  console.log(`• Projects total count: ${allProjectsList.length}`);
  console.log(`• Campaigns total count: ${allCampaignsList.length} (test campaigns with is_test=true: ${testCampaignIds.length})`);
  console.log(`• Campaign Tags total count: ${allTagsList.length}`);
  console.log(`• Links total count: ${allLinksList.length}`);
  console.log(`• Events total count: ${allEventsList.length}`);
  console.log(`• Daily Stats total count: ${allDailyStatsList.length}`);
  console.log("---------------------------------------");

  console.log("📁 List of existing projects in DB:");
  if (allProjectsList.length === 0) {
    console.log("  (No projects found)");
  } else {
    allProjectsList.forEach((p) => {
      const extraInfo = p.type === "channel"
        ? `ChatID: ${p.telegramChatId || "-"}, LinkedPrivatkaID: ${p.linkedProjectId || "none"}`
        : `BotUsername: @${p.botUsername || "-"}`;
      console.log(`  • [ID: ${p.id}] "${p.name}" (type: ${p.type}) | ${extraInfo}`);
    });
  }
  console.log("---------------------------------------");

  // Handler for --project-ids
  if (targetProjectIds.length > 0) {
    console.log(`\n🎯 Target Project IDs specified: [ ${targetProjectIds.join(", ")} ]`);

    const validProjects = [];
    for (const pid of targetProjectIds) {
      const proj = allProjectsList.find((p) => p.id === pid);
      if (!proj) {
        console.log(`⚠️ Project ID ${pid} не найден, пропущен`);
      } else {
        validProjects.push(proj);
      }
    }

    if (validProjects.length === 0) {
      console.log("No valid existing projects to process.");
      process.exit(0);
    }

    if (!isConfirm) {
      console.log("\n[DRY-RUN MODE for --project-ids]");
      for (const p of validProjects) {
        const pCamps = allCampaignsList.filter((c) => c.projectId === p.id);
        const pCampIds = pCamps.map((c) => c.id);
        const pLinks = allLinksList.filter((l) => pCampIds.includes(l.campaignId));
        const pLinkIds = pLinks.map((l) => l.id);
        const pEvs = allEventsList.filter((e) => pLinkIds.includes(e.linkId));

        console.log(`  • Project ID ${p.id} "${p.name}" (${p.type}): ${pCamps.length} campaigns, ${pLinks.length} links, ${pEvs.length} events will be deleted.`);
      }
      console.log("\n⚠️ Добавь --confirm для реального выполнения!");
      process.exit(0);
    }

    console.log("\n🚀 Deleting targeted projects with --confirm...");
    for (const p of validProjects) {
      const res = await deleteProjectCascade(p.id);
      if (res) {
        console.log(`✅ Deleted Project ID ${p.id} "${p.name}" (cascade: ${res.deletedCampaignsCount} campaigns, ${res.deletedLinksCount} links, ${res.deletedEventsCount} events)`);
      }
    }
    process.exit(0);
  }

  if (!isTagTest && !isAll) {
    console.log("[DRY-RUN MODE] No action flags provided (--tag-test, --all, or --project-ids). No data was modified.");
    console.log("Usage:");
    console.log("  npx tsx src/cli/resetData.ts");
    console.log("  npx tsx src/cli/resetData.ts --project-ids \"1,2,3\" [--confirm]");
    console.log("  npx tsx src/cli/resetData.ts --tag-test --confirm");
    console.log("  npx tsx src/cli/resetData.ts --all --confirm");
    process.exit(0);
  }

  if ((isTagTest || isAll) && !isConfirm) {
    console.log("⚠️ Добавь --confirm для реального выполнения!");
    process.exit(0);
  }

  if (isTagTest && isConfirm) {
    console.log("\n🚀 Resetting ONLY test data (campaigns with tag is_test=true)...");

    if (testCampaignIds.length === 0) {
      console.log("No test campaigns with tag is_test=true found.");
      process.exit(0);
    }

    const testLinks = allLinksList.filter((l) => testCampaignIds.includes(l.campaignId));
    const testLinkIds = testLinks.map((l) => l.id);

    let deletedEventsCount = 0;
    if (testLinkIds.length > 0) {
      const deletedEvs = await db.delete(events).where(inArray(events.linkId, testLinkIds)).returning();
      deletedEventsCount = deletedEvs.length;
    }

    const deletedLinks = await db.delete(links).where(inArray(links.campaignId, testCampaignIds)).returning();
    const deletedTags = await db.delete(campaignTags).where(inArray(campaignTags.campaignId, testCampaignIds)).returning();
    const deletedStats = await db.delete(dailyStats).where(inArray(dailyStats.campaignId, testCampaignIds)).returning();
    const deletedCamps = await db.delete(campaigns).where(inArray(campaigns.id, testCampaignIds)).returning();

    console.log(`✅ Test data reset complete! Deleted:`);
    console.log(`  - ${deletedCamps.length} campaigns`);
    console.log(`  - ${deletedTags.length} campaign tags`);
    console.log(`  - ${deletedLinks.length} links`);
    console.log(`  - ${deletedEventsCount} events`);
    console.log(`  - ${deletedStats.length} daily stats`);
    process.exit(0);
  }

  if (isAll && isConfirm) {
    console.log("\n🚀 Resetting ALL campaign data (campaigns, tags, links, events, dailyStats)...");

    const delEvs = await db.delete(events).returning();
    const delLinks = await db.delete(links).returning();
    const delTags = await db.delete(campaignTags).returning();
    const delStats = await db.delete(dailyStats).returning();
    const delCamps = await db.delete(campaigns).returning();

    console.log(`✅ All campaign data reset complete! Deleted:`);
    console.log(`  - ${delCamps.length} campaigns`);
    console.log(`  - ${delTags.length} campaign tags`);
    console.log(`  - ${delLinks.length} links`);
    console.log(`  - ${delEvs.length} events`);
    console.log(`  - ${delStats.length} daily stats`);
    console.log(`ℹ️ Projects table was left untouched (${allProjectsList.length} projects preserved).`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Error during resetData execution:", err);
  process.exit(1);
});
