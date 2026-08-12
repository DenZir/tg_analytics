import { db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { updateProjectConfig } from "../services/campaigns.js";

async function main() {
  const rawArgs = process.argv.slice(2);

  let name = "";
  let type = "";
  let channelId: string | undefined = undefined;
  let botUsername: string | undefined = undefined;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if ((arg === "--name" || arg === "-n") && i + 1 < rawArgs.length) {
      name = rawArgs[++i];
    } else if ((arg === "--type" || arg === "-t") && i + 1 < rawArgs.length) {
      type = rawArgs[++i];
    } else if ((arg === "--channel-id" || arg === "-c") && i + 1 < rawArgs.length) {
      channelId = rawArgs[++i];
    } else if ((arg === "--bot-username" || arg === "-b") && i + 1 < rawArgs.length) {
      botUsername = rawArgs[++i];
    }
  }

  // Fallback positional argument parsing if flags were stripped by shell wrapper
  if (!name || !type) {
    const cleanArgs = rawArgs.filter((a) => !a.startsWith("-"));
    if (cleanArgs.length >= 2) {
      if (!name) name = cleanArgs[0];
      if (!type) type = cleanArgs[1];
    }
  }

  if (!name || !type) {
    console.error(
      "Usage: npm run seed -- --name <name> --type <type> [--channel-id <id>] [--bot-username <username>]"
    );
    process.exit(1);
  }

  const [project] = await db
    .insert(projects)
    .values({ name, type })
    .returning();

  let finalProject = project;
  if (channelId || botUsername) {
    finalProject = await updateProjectConfig(project.id, {
      telegramChatId: channelId,
      botUsername: botUsername,
    });
  }

  console.log("\n=== Project Created Successfully ===");
  console.log("ID:", finalProject.id);
  console.log("Name:", finalProject.name);
  console.log("Type:", finalProject.type);
  console.log("Telegram Chat ID:", finalProject.telegramChatId || "-");
  console.log("Bot Username:", finalProject.botUsername || "-");
}

main().catch((err) => {
  console.error("Project seeding failed:", err);
  process.exit(1);
});
