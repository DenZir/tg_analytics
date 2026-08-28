import { startServer } from "./server.js";
import "./jobs/dailyAggregate.js";
import "./jobs/backup.js";
import "./jobs/purgeTrash.js";
import { startChannelBot } from "./bots/channelBot.js";

startServer();
startChannelBot();
// privBot is no longer started: deep-link attribution into the privatka bot was removed.
// The file itself (./bots/privBot.js) is left in place in case this is needed again later.
