import { Telegraf, Markup, Scenes, session } from "telegraf";
import {
  createLinkForCampaign,
  getLinkByRef,
  createProject,
  getAllProjects,
  createCampaign,
  createCampaignWithLinks,
  updateProjectConfig,
  linkProjects,
  deleteProjectCascade,
  getDistinctTagValues,
  getProjectByChatId,
  getOrCreateUnassignedCampaign,
} from "../services/campaigns.js";
import { logEvent } from "../services/events.js";
import { getMetrics } from "../services/metrics.js";
import { EVENT_TYPES } from "../db/eventTypes.js";

const token = process.env.CHANNEL_BOT_TOKEN;

export const channelBot = token ? new Telegraf<any>(token) : null;

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function createInviteForCampaign(
  channelId: string | number,
  campaignId: number,
  name?: string,
  isClosed: boolean = false,
  label?: string
) {
  if (!channelBot) {
    throw new Error("CHANNEL_BOT_TOKEN is not configured in .env");
  }

  const invite = await channelBot.telegram.createChatInviteLink(channelId, {
    name,
    creates_join_request: isClosed,
  });

  const linkType = isClosed ? "invite_closed" : "invite";

  const savedLink = await createLinkForCampaign(
    campaignId,
    invite.invite_link,
    linkType,
    label
  );

  return { inviteLink: invite.invite_link, savedLink };
}

// --- User Interactive State for Form Card & Privatka Creation ---
interface UserState {
  awaitingField?: "advertiser" | "price" | "tags" | "creative" | "linkName" | "privatka_username" | "privatka_name";
  tempPrivatkaUsername?: string;
  tempCreativesList?: string[];
  // Draft Card State
  projectId?: number;
  advertiser?: string;
  price?: number;
  linkName?: string;
  isClosedLink?: boolean;
  tags?: Record<string, string>;
  cardMessageId?: number;
}

const userStates = new Map<number, UserState>();

function getMainMenuKeyboard() {
  const dashUrl = process.env.DASHBOARD_URL || "http://localhost:3000";
  const isValidPublicUrl = /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(dashUrl) && !dashUrl.includes("localhost") && !dashUrl.includes("127.0.0.1");

  const dashButton = isValidPublicUrl
    ? Markup.button.url("🌐 Открыть дашборд", dashUrl)
    : Markup.button.callback("🌐 Дашборд", "show_dash_url");

  return Markup.inlineKeyboard([
    [
      Markup.button.callback("➕ Создать ссылку", "menu_newlink"),
      Markup.button.callback("📢 Каналы", "menu_channels"),
    ],
    [
      Markup.button.callback("🔒 Приватки", "menu_privatkas"),
      Markup.button.callback("📊 Статистика", "menu_stats"),
    ],
    [
      Markup.button.callback("⚙️ Настройки", "menu_settings"),
      dashButton,
    ],
  ]);
}

async function sendMainMenu(ctx: any) {
  const text = "📱 <b>Главное меню TG Analytics</b>\n\nВыберите нужное действие:";
  const keyboard = getMainMenuKeyboard();
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...keyboard });
    } catch (_) {
      await ctx.reply(text, { parse_mode: "HTML", ...keyboard });
    }
  } else {
    await ctx.reply(text, { parse_mode: "HTML", ...keyboard });
  }
}

async function renderDraftCard(ctx: any, userId: number, editMode = true) {
  const state = userStates.get(userId) || { isClosedLink: false };
  userStates.set(userId, state);

  const projectsList = await getAllProjects();
  const selectedProject = projectsList.find((p) => p.id === state.projectId);

  const channelName = selectedProject ? escapeHtml(selectedProject.name) : "не выбран";
  const advertiserText = state.advertiser ? escapeHtml(state.advertiser) : "не указан";
  const linkNameText = state.linkName ? escapeHtml(state.linkName) : "не указано";
  const priceText = state.price !== undefined ? `${state.price} ₽` : "не указана";
  const closedStatus = state.isClosedLink ? "Закрытая (заявка) 🔒" : "Прямая 🔓";

  const tagsText = state.tags && Object.keys(state.tags).length > 0
    ? Object.entries(state.tags).map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(v)}`).join(", ")
    : "нет";

  const creativeText = state.tags?.creative ? escapeHtml(state.tags.creative) : "не указан";

  let noticeText = "";
  if (state.awaitingField === "advertiser") {
    noticeText = "\n\n💬 <i>Отправьте имя продавца / рекламодателя ответным текстом...</i>";
  } else if (state.awaitingField === "price") {
    noticeText = "\n\n💬 <i>Отправьте цену закупки числом (например: 500)...</i>";
  } else if (state.awaitingField === "tags") {
    noticeText = "\n\n💬 <i>Отправьте теги в формате key=value,key2=value2...</i>";
  } else if (state.awaitingField === "creative") {
    noticeText = "\n\n💬 <i>Отправьте название поста/креатива ответным текстом...</i>";
  } else if (state.awaitingField === "linkName") {
    noticeText = "\n\n💬 <i>Отправьте короткое название ссылки для быстрого распознавания (например: \"ВК-паблик Х, пост от 12.08\")...</i>";
  }

  const cardText =
    `📝 <b>Карточка создания рекламной ссылки</b>\n\n` +
    `📢 <b>Канал</b>: ${channelName}\n` +
    `👤 <b>Продавец</b>: ${advertiserText}\n` +
    `🔤 <b>Название ссылки</b>: ${linkNameText}\n` +
    `💰 <b>Цена</b>: ${priceText}\n` +
    `🚪 <b>Ссылка</b>: ${closedStatus}\n` +
    `🏷️ <b>Теги</b>: ${tagsText}` +
    noticeText;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("📢 Канал", "card_select_channel"),
      Markup.button.callback("👤 Продавец", "card_input_adv"),
    ],
    [
      Markup.button.callback("🔤 Название ссылки", "card_input_linkname"),
    ],
    [
      Markup.button.callback("💰 Цена", "card_input_price"),
      Markup.button.callback(`🎬 Пост/Креатив: ${creativeText}`, "card_select_creative"),
    ],
    [
      Markup.button.callback("🏷️ Теги", "card_input_tags"),
    ],
    [
      Markup.button.callback(`🚪 Ссылка: ${state.isClosedLink ? "Закрытая" : "Прямая"}`, "card_toggle_closed"),
    ],
    [
      Markup.button.callback("❌ Отмена", "card_cancel"),
      Markup.button.callback("🚀 Создать", "card_create"),
    ],
  ]);

  if (editMode && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(cardText, { parse_mode: "HTML", ...keyboard });
    } catch (_) {
      const sent = await ctx.reply(cardText, { parse_mode: "HTML", ...keyboard });
      state.cardMessageId = sent.message_id;
    }
  } else if (state.cardMessageId && ctx.telegram && ctx.chat) {
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        state.cardMessageId,
        undefined,
        cardText,
        { parse_mode: "HTML", ...keyboard }
      );
    } catch (_) {
      const sent = await ctx.reply(cardText, { parse_mode: "HTML", ...keyboard });
      state.cardMessageId = sent.message_id;
    }
  } else {
    const sent = await ctx.reply(cardText, { parse_mode: "HTML", ...keyboard });
    state.cardMessageId = sent.message_id;
  }
}

async function renderChannelsMenu(ctx: any) {
  const projectsList = await getAllProjects();
  const channels = projectsList.filter((p) => p.type === "channel");

  if (channels.length === 0) {
    const text = "📢 <b>Зарегистрированные каналы:</b>\n\nНет зарегистрированных каналов.";
    const backKb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ В главное меню", "menu_main")]]);
    if (ctx.callbackQuery) {
      return ctx.editMessageText(text, { parse_mode: "HTML", ...backKb });
    }
    return ctx.reply(text, { parse_mode: "HTML", ...backKb });
  }

  const buttons = channels.map((c) => [
    Markup.button.callback(`📢 ${c.name}`, `chan_card_${c.id}`),
  ]);
  buttons.push([Markup.button.callback("⬅️ В главное меню", "menu_main")]);

  const msg = "📢 <b>Выберите канал для просмотра и настройки:</b>";
  if (ctx.callbackQuery) {
    return ctx.editMessageText(msg, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(buttons),
    });
  }
  return ctx.reply(msg, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(buttons),
  });
}

async function renderPrivatkasMenu(ctx: any) {
  const projectsList = await getAllProjects();
  const privatkas = projectsList.filter((p) => p.type === "bot_subscription");

  let msg = "🔒 <b>Выберите приватку для просмотра и настройки:</b>\n\n";
  const buttons: any[] = [];

  if (privatkas.length === 0) {
    msg = "🔒 <b>Зарегистрированные приватки (боты подписок):</b>\n\nНет зарегистрированных ботов приватки.";
  } else {
    privatkas.forEach((p) => {
      const safeName = escapeHtml(p.name);
      const usernameText = p.botUsername ? `@${escapeHtml(p.botUsername)}` : "без username";
      buttons.push([Markup.button.callback(`🔒 ${safeName} (${usernameText})`, `priv_card_${p.id}`)]);
    });
  }

  buttons.push([Markup.button.callback("➕ Добавить приватку", "priv_add_new")]);
  buttons.push([Markup.button.callback("⬅️ В главное меню", "menu_main")]);

  const keyboard = Markup.inlineKeyboard(buttons);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(msg, { parse_mode: "HTML", ...keyboard });
    } catch (_) {
      await ctx.reply(msg, { parse_mode: "HTML", ...keyboard });
    }
  } else {
    await ctx.reply(msg, { parse_mode: "HTML", ...keyboard });
  }
}

async function renderPrivatkaCard(ctx: any, privatkaId: number) {
  const projectsList = await getAllProjects();
  const privatka = projectsList.find((p) => p.id === privatkaId);

  if (!privatka) {
    return ctx.answerCbQuery("⚠️ Приватка не найдена");
  }

  const safeName = escapeHtml(privatka.name);
  const usernameText = privatka.botUsername ? `@${escapeHtml(privatka.botUsername)}` : "не указан";

  const linkedChannels = projectsList.filter((p) => p.type === "channel" && p.linkedProjectId === privatkaId);
  const linkedChannelsText = linkedChannels.length > 0
    ? linkedChannels.map((c) => `• <b>${escapeHtml(c.name)}</b> (ID: <code>${c.id}</code>)`).join("\n")
    : "нет привязанных каналов";

  const cardText =
    `🔒 <b>Карточка приватки:</b> ${safeName}\n\n` +
    `🆔 <b>Project ID:</b> <code>${privatka.id}</code>\n` +
    `🤖 <b>Bot Username:</b> <code>${usernameText}</code>\n\n` +
    `📢 <b>Привязана к каналам:</b>\n${linkedChannelsText}`;

  const buttons = [
    [Markup.button.callback("🗑️ Удалить приватку", `priv_del_confirm_${privatka.id}`)],
    [Markup.button.callback("⬅️ К списку приваток", "menu_privatkas")],
  ];

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(cardText, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
    } catch (_) {
      await ctx.reply(cardText, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
    }
  } else {
    await ctx.reply(cardText, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
  }
}

async function renderChannelCard(ctx: any, channelId: number) {
  const projectsList = await getAllProjects();
  const channel = projectsList.find((p) => p.id === channelId);

  if (!channel) {
    return ctx.answerCbQuery("⚠️ Канал не найден");
  }

  const safeName = escapeHtml(channel.name);
  const chatIdText = channel.telegramChatId ? `<code>${escapeHtml(channel.telegramChatId)}</code>` : "не указан";

  let privatkaStatusText = "не привязана 🔴";
  let linkedProj: any = null;

  if (channel.linkedProjectId) {
    linkedProj = projectsList.find((p) => p.id === channel.linkedProjectId);
    if (linkedProj) {
      const safePrivName = escapeHtml(linkedProj.name);
      const privUsernameText = linkedProj.botUsername ? `@${escapeHtml(linkedProj.botUsername)}` : "без username";
      privatkaStatusText = `<b>${safePrivName}</b> (${privUsernameText}) 🟢`;
    }
  }

  const cardText =
    `📢 <b>Карточка канала:</b> ${safeName}\n\n` +
    `🆔 <b>Project ID:</b> <code>${channel.id}</code>\n` +
    `📡 <b>Telegram Chat ID:</b> ${chatIdText}\n\n` +
    `🔒 <b>Приватка:</b> ${privatkaStatusText}`;

  const buttons: any[] = [];
  if (channel.linkedProjectId) {
    buttons.push([Markup.button.callback("❌ Отвязать приватку", `chan_unlink_${channel.id}`)]);
  } else {
    buttons.push([Markup.button.callback("🔗 Привязать приватку", `chan_link_menu_${channel.id}`)]);
  }
  buttons.push([Markup.button.callback("🗑️ Удалить канал", `chan_del_confirm_${channel.id}`)]);
  buttons.push([Markup.button.callback("⬅️ К списку каналов", "menu_channels")]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(cardText, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
    } catch (_) {
      await ctx.reply(cardText, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
    }
  } else {
    await ctx.reply(cardText, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
  }
}

if (channelBot) {
  // Middleware: restrict private chat access to ADMIN_CHAT_ID
  channelBot.use(async (ctx: any, next: any) => {
    if (ctx.chat?.type === "private" && ctx.from) {
      const adminId = process.env.ADMIN_CHAT_ID;
      if (adminId && String(ctx.from.id) !== String(adminId)) {
        await ctx.reply("Not authorized");
        return;
      }
    }
    return next();
  });

  // Text message listener for interactive inputs
  channelBot.on("text", async (ctx: any, next: any) => {
    const userId = ctx.from?.id;
    if (!userId) return next();

    const state = userStates.get(userId);

    if (state && state.awaitingField) {
      const text = ctx.message.text.trim();

      // Form Card Fields
      if (state.awaitingField === "advertiser") {
        state.advertiser = text;
        delete state.awaitingField;
        try { await ctx.deleteMessage(); } catch (_) {}
        await renderDraftCard(ctx, userId, false);
        return;
      } else if (state.awaitingField === "price") {
        const priceVal = parseFloat(text.replace(",", "."));
        if (isNaN(priceVal) || priceVal < 0) {
          await ctx.reply("⚠️ Пожалуйста, введите корректное число для цены закупки (например: 500):");
          return;
        }
        state.price = priceVal;
        delete state.awaitingField;
        try { await ctx.deleteMessage(); } catch (_) {}
        await renderDraftCard(ctx, userId, false);
        return;
      } else if (state.awaitingField === "creative") {
        if (!state.tags) state.tags = {};
        state.tags.creative = text;
        delete state.awaitingField;
        try { await ctx.deleteMessage(); } catch (_) {}
        await renderDraftCard(ctx, userId, false);
        return;
      } else if (state.awaitingField === "linkName") {
        state.linkName = text;
        delete state.awaitingField;
        try { await ctx.deleteMessage(); } catch (_) {}
        await renderDraftCard(ctx, userId, false);
        return;
      } else if (state.awaitingField === "tags") {
        const parsedTags: Record<string, string> = {};
        const pairs = text.split(",");
        for (const pair of pairs) {
          const [k, ...v] = pair.split("=");
          if (k && k.trim()) {
            parsedTags[k.trim()] = v.join("=").trim() || "true";
          }
        }
        state.tags = { ...(state.tags || {}), ...parsedTags };
        delete state.awaitingField;
        try { await ctx.deleteMessage(); } catch (_) {}
        await renderDraftCard(ctx, userId, false);
        return;
      }

      // Privatka Creation Fields
      else if (state.awaitingField === "privatka_username") {
        const cleanUsername = text.replace(/^@/, "").trim();
        if (!cleanUsername) {
          await ctx.reply("⚠️ Пожалуйста, введите корректный username бота приватки (например: my_priv_bot):");
          return;
        }
        state.tempPrivatkaUsername = cleanUsername;
        state.awaitingField = "privatka_name";
        userStates.set(userId, state);
        await ctx.reply(
          `Username: <code>@${escapeHtml(cleanUsername)}</code> принят.\n\n` +
          `Отправьте название для приватки (или отправьте <code>-</code> чтобы использовать username как название):`,
          { parse_mode: "HTML" }
        );
        return;
      } else if (state.awaitingField === "privatka_name") {
        const username = state.tempPrivatkaUsername || "privat_bot";
        const finalName = text === "-" ? username : text;

        try {
          const project = await createProject({
            name: finalName,
            type: "bot_subscription",
            botUsername: username,
          });

          delete state.awaitingField;
          delete state.tempPrivatkaUsername;
          userStates.set(userId, state);

          await ctx.reply(
            `🎉 Приватный бот <b>${escapeHtml(finalName)}</b> (@${escapeHtml(username)}) успешно зарегистрирован! (ID: <code>${project.id}</code>)`,
            { parse_mode: "HTML" }
          );

          await renderPrivatkasMenu(ctx);
        } catch (err: any) {
          await ctx.reply(`Ошибка создания проекта приватки: ${escapeHtml(err.message)}`);
        }
        return;
      }
    }

    return next();
  });

  // Command /menu & /newlink
  channelBot.command(["menu", "newlink"], async (ctx: any) => {
    const adminId = process.env.ADMIN_CHAT_ID;
    if (adminId && String(ctx.from?.id) !== String(adminId)) {
      return ctx.reply("Not authorized");
    }
    return sendMainMenu(ctx);
  });

  // Command /stats
  channelBot.command("stats", async (ctx: any) => {
    const adminId = process.env.ADMIN_CHAT_ID;
    if (adminId && String(ctx.from?.id) !== String(adminId)) {
      return ctx.reply("Not authorized");
    }

    try {
      const metrics = await getMetrics();
      const sortedCampaigns = metrics.campaigns
        .slice()
        .sort((a, b) => (b.totalRevenue || 0) - (a.totalRevenue || 0))
        .slice(0, 5);

      if (sortedCampaigns.length === 0) {
        return ctx.reply("📊 Нет данных по кампаниям.");
      }

      let replyText = "📊 <b>Топ-5 кампаний по доходу</b>:\n\n";
      sortedCampaigns.forEach((c, idx) => {
        const cpsText = c.cps !== null && c.cps !== undefined ? `${Number(c.cps).toFixed(2)} ₽` : "-";
        const safeAdv = escapeHtml(c.advertiser);
        replyText += `${idx + 1}. <b>${safeAdv}</b> — CPS: ${cpsText}, подписчиков: ${c.totalSubs}, доход: ${c.totalRevenue} ₽\n`;
      });

      await ctx.reply(replyText, { parse_mode: "HTML" });
    } catch (err: any) {
      await ctx.reply(`Ошибка получения статистики: ${escapeHtml(err.message)}`, {
        parse_mode: "HTML",
      });
    }
  });

  // Callback query dispatcher
  channelBot.on("callback_query", async (ctx: any) => {
    try {
      if (!("data" in ctx.callbackQuery)) return;
      const data: string = ctx.callbackQuery.data;
      const userId = ctx.from?.id;
      if (!userId) return;

      // --- Main Menu Actions ---
      if (data === "show_dash_url") {
        const dashUrl = process.env.DASHBOARD_URL || "http://localhost:3000";
        await ctx.answerCbQuery(`Дашборд: ${dashUrl}`, { show_alert: true });
        return;
      }

      if (data === "menu_newlink") {
        await ctx.answerCbQuery();
        userStates.set(userId, { isClosedLink: false });
        return renderDraftCard(ctx, userId);
      }

      if (data === "menu_channels") {
        await ctx.answerCbQuery();
        return renderChannelsMenu(ctx);
      }

      if (data === "menu_privatkas") {
        await ctx.answerCbQuery();
        return renderPrivatkasMenu(ctx);
      }

      if (data === "priv_add_new") {
        await ctx.answerCbQuery();
        const state = userStates.get(userId) || {};
        state.awaitingField = "privatka_username";
        userStates.set(userId, state);
        return ctx.reply("Отправьте username бота приватки (например: <code>my_priv_bot</code>):", { parse_mode: "HTML" });
      }

      if (data === "menu_stats") {
        await ctx.answerCbQuery();
        const metrics = await getMetrics();
        const sortedCampaigns = metrics.campaigns
          .slice()
          .sort((a, b) => (b.totalRevenue || 0) - (a.totalRevenue || 0))
          .slice(0, 5);

        let replyText = "📊 <b>Топ-5 кампаний по доходу</b>:\n\n";
        if (sortedCampaigns.length === 0) {
          replyText += "Нет данных.";
        } else {
          sortedCampaigns.forEach((c, idx) => {
            const cpsText = c.cps !== null && c.cps !== undefined ? `${Number(c.cps).toFixed(2)} ₽` : "-";
            const safeAdv = escapeHtml(c.advertiser);
            replyText += `${idx + 1}. <b>${safeAdv}</b> — CPS: ${cpsText}, subs: ${c.totalSubs}, revenue: ${c.totalRevenue} ₽\n`;
          });
        }
        const backKb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ В главное меню", "menu_main")]]);
        return ctx.editMessageText(replyText, { parse_mode: "HTML", ...backKb });
      }

      if (data === "menu_settings") {
        await ctx.answerCbQuery();
        const adminId = process.env.ADMIN_CHAT_ID || "не задан";
        const msg =
          `⚙️ <b>Настройки системы:</b>\n\n` +
          `• <b>Admin Chat ID</b>: <code>${adminId}</code>\n` +
          `• <b>API Secret</b>: <code>${process.env.API_SECRET || "не задан"}</code>\n` +
          `• <b>Channel Bot Token</b>: <code>задан</code>\n` +
          `• <b>Privat Bot Token</b>: <code>${process.env.PRIV_BOT_TOKEN ? "задан" : "не задан"}</code>`;
        const backKb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ В главное меню", "menu_main")]]);
        return ctx.editMessageText(msg, { parse_mode: "HTML", ...backKb });
      }

      if (data === "menu_main" || data === "card_cancel") {
        await ctx.answerCbQuery();
        userStates.delete(userId);
        return sendMainMenu(ctx);
      }

      // --- Privatka Card Actions ---
      if (data.startsWith("priv_card_")) {
        await ctx.answerCbQuery();
        const privId = Number(data.split("_")[2]);
        return renderPrivatkaCard(ctx, privId);
      }

      if (data.startsWith("priv_del_confirm_")) {
        await ctx.answerCbQuery();
        const privId = Number(data.split("_")[3]);
        const projectsList = await getAllProjects();
        const privatka = projectsList.find((p) => p.id === privId);

        if (!privatka) return ctx.answerCbQuery("⚠️ Приватка не найдена");

        const text = `⚠️ <b>Вы уверены, что хотите удалить бот приватки ${escapeHtml(privatka.name)}?</b>\n\nВсе привязанные каналы будут автоматически отвязаны.`;
        const buttons = Markup.inlineKeyboard([
          [Markup.button.callback("💥 Да, удалить", `priv_del_do_${privId}`)],
          [Markup.button.callback("❌ Отмена", `priv_card_${privId}`)],
        ]);
        return ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
      }

      if (data.startsWith("priv_del_do_")) {
        const privId = Number(data.split("_")[3]);
        await deleteProjectCascade(privId);
        await ctx.answerCbQuery("Бот приватки успешно удалён!");
        return renderPrivatkasMenu(ctx);
      }

      // --- Channel Details, Linking & Deletion Callback Actions ---
      if (data.startsWith("chan_card_")) {
        await ctx.answerCbQuery();
        const chanId = Number(data.split("_")[2]);
        return renderChannelCard(ctx, chanId);
      }

      if (data.startsWith("chan_del_confirm_")) {
        await ctx.answerCbQuery();
        const chanId = Number(data.split("_")[3]);
        const projectsList = await getAllProjects();
        const channel = projectsList.find((p) => p.id === chanId);

        if (!channel) return ctx.answerCbQuery("⚠️ Канал не найден");

        const text = `⚠️ <b>Вы уверены, что хотите удалить канал ${escapeHtml(channel.name)}?</b>\n\nВсе связанные кампании, инвайт-ссылки и события будут каскадно удалены.`;
        const buttons = Markup.inlineKeyboard([
          [Markup.button.callback("💥 Да, удалить", `chan_del_do_${chanId}`)],
          [Markup.button.callback("❌ Отмена", `chan_card_${chanId}`)],
        ]);
        return ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
      }

      if (data.startsWith("chan_del_do_")) {
        const chanId = Number(data.split("_")[3]);
        await deleteProjectCascade(chanId);
        await ctx.answerCbQuery("Канал успешно удалён!");
        return renderChannelsMenu(ctx);
      }

      if (data.startsWith("chan_link_menu_")) {
        await ctx.answerCbQuery();
        const chanId = Number(data.split("_")[3]);
        const projectsList = await getAllProjects();
        const privatkas = projectsList.filter((p) => p.type === "bot_subscription");

        if (privatkas.length === 0) {
          return ctx.answerCbQuery("⚠️ Нет приваток. Сначала добавьте приватку в меню '🔒 Приватки'");
        }

        const buttons = privatkas.map((p) => [
          Markup.button.callback(`🔒 ${p.name} (@${p.botUsername || "бот"})`, `do_link_chan_${chanId}_${p.id}`),
        ]);
        buttons.push([Markup.button.callback("⬅️ Назад в карточку канала", `chan_card_${chanId}`)]);

        return ctx.editMessageText("🔒 <b>Выберите бота приватки для привязки:</b>", {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard(buttons),
        });
      }

      if (data.startsWith("do_link_chan_")) {
        const parts = data.split("_");
        const chanId = Number(parts[3]);
        const privatkaId = Number(parts[4]);

        await linkProjects(chanId, privatkaId);
        await ctx.answerCbQuery("Приватка успешно привязана! 🟢");
        return renderChannelCard(ctx, chanId);
      }

      if (data.startsWith("chan_unlink_")) {
        const chanId = Number(data.split("_")[2]);
        await updateProjectConfig(chanId, { linkedProjectId: null });
        await ctx.answerCbQuery("Приватка отвязана 🔴");
        return renderChannelCard(ctx, chanId);
      }

      // --- Draft Card Actions ---
      if (data === "card_select_channel") {
        await ctx.answerCbQuery();
        const projectsList = await getAllProjects();
        const channels = projectsList.filter((p) => p.type === "channel");

        if (channels.length === 0) {
          return ctx.answerCbQuery("⚠️ Нет каналов. Создайте через seedProject или Дашборд!");
        }

        const buttons = channels.map((c) => [
          Markup.button.callback(`📢 ${c.name}`, `set_chan_${c.id}`),
        ]);
        buttons.push([Markup.button.callback("⬅️ Назад в карточку", "card_back_to_card")]);

        return ctx.editMessageText("📢 <b>Выберите канал:</b>", {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard(buttons),
        });
      }

      if (data.startsWith("set_chan_")) {
        await ctx.answerCbQuery();
        const chanId = Number(data.split("_")[2]);
        const state = userStates.get(userId) || { isClosedLink: false };
        state.projectId = chanId;
        userStates.set(userId, state);
        return renderDraftCard(ctx, userId);
      }

      if (data === "card_back_to_card") {
        await ctx.answerCbQuery();
        return renderDraftCard(ctx, userId);
      }

      if (data === "card_input_adv") {
        await ctx.answerCbQuery();
        const state = userStates.get(userId) || { isClosedLink: false };
        state.awaitingField = "advertiser";
        userStates.set(userId, state);
        return renderDraftCard(ctx, userId);
      }

      if (data === "card_input_linkname") {
        await ctx.answerCbQuery();
        const state = userStates.get(userId) || { isClosedLink: false };
        state.awaitingField = "linkName";
        userStates.set(userId, state);
        return renderDraftCard(ctx, userId);
      }

      if (data === "card_input_price") {
        await ctx.answerCbQuery();
        const state = userStates.get(userId) || { isClosedLink: false };
        state.awaitingField = "price";
        userStates.set(userId, state);
        return renderDraftCard(ctx, userId);
      }

      if (data === "card_input_tags") {
        await ctx.answerCbQuery();
        const state = userStates.get(userId) || { isClosedLink: false };
        state.awaitingField = "tags";
        userStates.set(userId, state);
        return renderDraftCard(ctx, userId);
      }

      if (data === "card_select_creative") {
        await ctx.answerCbQuery();
        const state = userStates.get(userId) || { isClosedLink: false };
        userStates.set(userId, state);

        const existingCreatives = await getDistinctTagValues("creative");

        if (existingCreatives.length === 0) {
          state.awaitingField = "creative";
          userStates.set(userId, state);
          return renderDraftCard(ctx, userId);
        }

        state.tempCreativesList = existingCreatives;
        userStates.set(userId, state);

        const buttons = existingCreatives.map((val, idx) => [
          Markup.button.callback(`🎬 ${val}`, `set_cr_${idx}`),
        ]);
        buttons.push([Markup.button.callback("➕ Новый креатив", "card_input_new_creative")]);
        buttons.push([Markup.button.callback("⬅️ Назад в карточку", "card_back_to_card")]);

        return ctx.editMessageText("🎬 <b>Выберите существующий пост/креатив или создайте новый:</b>", {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard(buttons),
        });
      }

      if (data.startsWith("set_cr_")) {
        await ctx.answerCbQuery();
        const idx = Number(data.split("_")[2]);
        const state = userStates.get(userId) || { isClosedLink: false };
        const val = state.tempCreativesList?.[idx];

        if (val) {
          if (!state.tags) state.tags = {};
          state.tags.creative = val;
        }
        delete state.awaitingField;
        userStates.set(userId, state);
        return renderDraftCard(ctx, userId);
      }

      if (data === "card_input_new_creative") {
        await ctx.answerCbQuery();
        const state = userStates.get(userId) || { isClosedLink: false };
        state.awaitingField = "creative";
        userStates.set(userId, state);
        return renderDraftCard(ctx, userId);
      }

      if (data === "card_toggle_closed") {
        const state = userStates.get(userId) || { isClosedLink: false };
        state.isClosedLink = !state.isClosedLink;
        userStates.set(userId, state);
        await ctx.answerCbQuery(state.isClosedLink ? "Закрытая ссылка (заявка) 🔒" : "Прямая ссылка 🔓");
        return renderDraftCard(ctx, userId);
      }

      if (data === "card_create") {
        const state = userStates.get(userId);

        if (!state?.projectId) {
          return ctx.answerCbQuery("⚠️ Сначала выберите канал!");
        }
        if (!state.advertiser) {
          return ctx.answerCbQuery("⚠️ Укажите имя продавца / рекламодателя!");
        }
        if (!state.linkName) {
          return ctx.answerCbQuery("⚠️ Укажите название ссылки для распознавания!");
        }
        if (state.price === undefined) {
          return ctx.answerCbQuery("⚠️ Укажите цену закупки!");
        }

        await ctx.answerCbQuery("Создаём ссылки...");

        try {
          const creationResult = await createCampaignWithLinks(
            state.projectId,
            state.advertiser,
            state.price,
            state.linkName,
            state.tags || {},
            state.isClosedLink || false,
            createInviteForCampaign
          );

          let linksResultText = "";

          if (creationResult.channelLink) {
            const linkTypeLabel = state.isClosedLink ? "Инвайт-ссылка с заявкой 🔒" : "Инвайт-ссылка 🔓";
            linksResultText += `📢 <b>${linkTypeLabel} канала</b>:\n${creationResult.channelLink.inviteLink}\n\n`;
          } else {
            linksResultText += `⚠️ У канала не указан telegramChatId (добавьте через seedProject).\n\n`;
          }

          const safeAdv = escapeHtml(state.advertiser);
          const tagsText = state.tags && Object.keys(state.tags).length > 0
            ? Object.entries(state.tags).map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(v)}`).join(", ")
            : "нет";

          const finalMessage =
            `🎉 <b>Кампания создана успешно!</b>\n\n` +
            `📌 <b>Рекламодатель</b>: ${safeAdv}\n` +
            `💰 <b>Цена</b>: ${state.price} ₽\n` +
            `🏷️ <b>Теги</b>: ${tagsText}\n\n` +
            `${linksResultText}`;

          await ctx.reply(finalMessage, { parse_mode: "HTML" });
          userStates.delete(userId);
        } catch (err: any) {
          await ctx.reply(`Ошибка создания кампании: ${escapeHtml(err.message)}`, {
            parse_mode: "HTML",
          });
        }
        return;
      }

      // Channel detection registration button callback
      if (data.startsWith("reg_chan:")) {
        const parts = data.split(":");
        const chatId = parts[1];
        const title = parts.slice(2).join(":");

        const project = await createProject({
          name: title,
          type: "channel",
          telegramChatId: chatId,
        });

        const safeTitle = escapeHtml(title);
        await ctx.answerCbQuery("Канал успешно зарегистрирован!");
        await ctx.reply(
          `Канал <b>${safeTitle}</b> зарегистрирован, project_id: <code>${project.id}</code>`,
          { parse_mode: "HTML" }
        );
        console.log(`[channelBot] Registered project ${project.id} for channel ${title} (${chatId})`);
      }
    } catch (error) {
      console.error("[channelBot] Error processing callback query:", error);
    }
  });

  // Listener for channel member join/leave events
  channelBot.on("chat_member", async (ctx: any) => {
    try {
      const update = ctx.chatMember;
      const tgUserId = String(update.new_chat_member.user.id);
      const oldStatus = update.old_chat_member.status;
      const newStatus = update.new_chat_member.status;

      const wasIn = ["member", "administrator", "creator", "restricted"].includes(oldStatus);
      const isIn = ["member", "administrator", "creator", "restricted"].includes(newStatus);

      if (!wasIn && isIn) {
        // Fresh join — Telegram only populates invite_link for joins, never for leaves.
        const inviteUrl = update.invite_link?.invite_link;
        if (!inviteUrl) return;

        let link = await getLinkByRef(inviteUrl);

        if (!link) {
          // Link wasn't created through our bot (e.g. made manually by another admin,
          // or predates tracking) — auto-register it under a per-project "unassigned"
          // bucket so it still gets attributed, rather than dropping the join silently.
          const project = await getProjectByChatId(String(update.chat.id));
          if (!project) return; // channel isn't registered at all, nothing to attach to

          const unassignedCampaign = await getOrCreateUnassignedCampaign(project.id);
          const label = update.invite_link?.name || null;
          link = await createLinkForCampaign(unassignedCampaign.id, inviteUrl, "invite", label);
          console.log(
            `[channelBot] Auto-registered unknown invite link ${inviteUrl} under unassigned campaign ${unassignedCampaign.id}`
          );
        }

        await logEvent({
          linkId: link.id,
          tgUserId,
          eventType: EVENT_TYPES.JOIN,
          languageCode: update.new_chat_member.user.language_code,
        });
        console.log(`[channelBot] Logged join event for user ${tgUserId}`);
      } else if (wasIn && !isIn) {
        // Leave/kick — no invite_link is ever present here, so attribute via last-touch instead.
        await logEvent({
          tgUserId,
          eventType: EVENT_TYPES.LEAVE,
          languageCode: update.new_chat_member.user.language_code,
        });
        console.log(`[channelBot] Logged leave event for user ${tgUserId}`);
      }
    } catch (error) {
      console.error("[channelBot] Error processing chat_member update:", error);
    }
  });

  // Listener for channel join requests (logs event, join requests remain pending for manual approval)
  channelBot.on("chat_join_request", async (ctx: any) => {
    try {
      const inviteUrl = ctx.chatJoinRequest?.invite_link?.invite_link;
      if (!inviteUrl) return;

      const link = await getLinkByRef(inviteUrl);
      if (link) {
        await logEvent({
          linkId: link.id,
          tgUserId: String(ctx.chatJoinRequest.from.id),
          eventType: EVENT_TYPES.JOIN_REQUEST,
          languageCode: ctx.chatJoinRequest.from.language_code,
        });
        console.log(`[channelBot] Logged join_request for user ${ctx.chatJoinRequest.from.id}`);
      }
    } catch (error) {
      console.error("[channelBot] Error handling chat_join_request:", error);
    }
  });

  // Listener when bot status changes in channel (my_chat_member)
  channelBot.on("my_chat_member", async (ctx: any) => {
    try {
      const newStatus = ctx.myChatMember.new_chat_member.status;
      const chat = ctx.myChatMember.chat;
      const adminId = process.env.ADMIN_CHAT_ID;

      if (newStatus === "administrator" && chat.type !== "private" && adminId) {
        const title = "title" in chat ? chat.title : "Un-named Channel";
        const safeTitle = escapeHtml(title);
        const callbackData = `reg_chan:${chat.id}:${title.slice(0, 30)}`;

        await channelBot.telegram.sendMessage(
          adminId,
          `Обнаружен новый канал <b>${safeTitle}</b> (id: <code>${chat.id}</code>). Зарегистрировать для отслеживания?`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              Markup.button.callback("➕ Зарегистрировать", callbackData),
            ]),
          }
        );
        console.log(`[channelBot] Sent channel detection alert for ${title} (${chat.id}) to admin ${adminId}`);
      }
    } catch (error) {
      console.error("[channelBot] Error handling my_chat_member update:", error);
    }
  });
}

export async function startChannelBot() {
  if (!channelBot) {
    console.log("[channelBot] Skipped start: CHANNEL_BOT_TOKEN is empty in .env");
    return;
  }
  try {
    await channelBot.launch({
      allowedUpdates: ["chat_member", "my_chat_member", "chat_join_request", "callback_query", "message"],
    });
    console.log("[channelBot] Bot started successfully.");
  } catch (error) {
    console.error("[channelBot] Launch error:", error);
  }
}
