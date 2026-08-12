import { startServer } from "./server.js";
import "./jobs/dailyAggregate.js";
import { startChannelBot } from "./bots/channelBot.js";
import { startPrivBot } from "./bots/privBot.js";

startServer();
startChannelBot();
startPrivBot();
