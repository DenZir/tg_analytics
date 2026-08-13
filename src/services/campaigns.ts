import { db } from "../db/index.js";
import { campaigns, campaignTags, links, projects, events, dailyStats } from "../db/schema.js";
import { eq, and, inArray, desc } from "drizzle-orm";

export interface CreateCampaignInput {
  projectId: number;
  advertiser: string;
  price: number;
  tags?: Array<{ tagKey: string; tagValue: string }> | Record<string, string>;
}

export async function getAllProjects() {
  return await db.select().from(projects);
}

export async function createProject(input: {
  name: string;
  type: string;
  telegramChatId?: string;
  botUsername?: string;
  linkedProjectId?: number;
}) {
  const [project] = await db
    .insert(projects)
    .values({
      name: input.name,
      type: input.type,
      telegramChatId: input.telegramChatId || null,
      botUsername: input.botUsername || null,
      linkedProjectId: input.linkedProjectId || null,
    })
    .returning();

  return project;
}

export async function updateProjectConfig(
  projectId: number,
  config: { telegramChatId?: string; botUsername?: string; linkedProjectId?: number | null }
) {
  const [updatedProject] = await db
    .update(projects)
    .set({
      ...(config.telegramChatId !== undefined && { telegramChatId: config.telegramChatId }),
      ...(config.botUsername !== undefined && { botUsername: config.botUsername }),
      ...(config.linkedProjectId !== undefined && { linkedProjectId: config.linkedProjectId }),
    })
    .where(eq(projects.id, projectId))
    .returning();

  return updatedProject;
}

export async function linkProjects(channelProjectId: number, privatkaProjectId: number) {
  const channelProj = await db.query.projects.findFirst({
    where: eq(projects.id, channelProjectId),
  });
  if (!channelProj) {
    throw new Error(`Project ${channelProjectId} not found`);
  }
  if (channelProj.type !== "channel") {
    throw new Error(`Project "${channelProj.name}" (ID: ${channelProjectId}) must be of type 'channel'`);
  }

  const privatkaProj = await db.query.projects.findFirst({
    where: eq(projects.id, privatkaProjectId),
  });
  if (!privatkaProj) {
    throw new Error(`Project ${privatkaProjectId} not found`);
  }
  if (privatkaProj.type !== "bot_subscription") {
    throw new Error(`Project "${privatkaProj.name}" (ID: ${privatkaProjectId}) must be of type 'bot_subscription'`);
  }

  return await updateProjectConfig(channelProjectId, { linkedProjectId: privatkaProjectId });
}

export async function deleteProjectCascade(projectId: number) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!project) return null;

  // 1. Find all campaigns for this project
  const projectCampaigns = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.projectId, projectId));

  const campaignIds = projectCampaigns.map((c) => c.id);

  let deletedEventsCount = 0;
  let deletedLinksCount = 0;
  let deletedTagsCount = 0;
  let deletedStatsCount = 0;

  if (campaignIds.length > 0) {
    // Find all links for these campaigns
    const campaignLinks = await db
      .select()
      .from(links)
      .where(inArray(links.campaignId, campaignIds));

    const linkIds = campaignLinks.map((l) => l.id);

    if (linkIds.length > 0) {
      const delEvs = await db.delete(events).where(inArray(events.linkId, linkIds)).returning();
      deletedEventsCount = delEvs.length;
    }

    const delLinks = await db.delete(links).where(inArray(links.campaignId, campaignIds)).returning();
    deletedLinksCount = delLinks.length;

    const delTags = await db.delete(campaignTags).where(inArray(campaignTags.campaignId, campaignIds)).returning();
    deletedTagsCount = delTags.length;

    const delStats = await db.delete(dailyStats).where(inArray(dailyStats.campaignId, campaignIds)).returning();
    deletedStatsCount = delStats.length;

    await db.delete(campaigns).where(inArray(campaigns.id, campaignIds));
  }

  // Clear references from channels linked to this privatka project
  await db
    .update(projects)
    .set({ linkedProjectId: null })
    .where(eq(projects.linkedProjectId, projectId));

  // Delete project itself
  const [deletedProject] = await db
    .delete(projects)
    .where(eq(projects.id, projectId))
    .returning();

  return {
    deletedProject,
    deletedCampaignsCount: campaignIds.length,
    deletedTagsCount,
    deletedLinksCount,
    deletedEventsCount,
    deletedStatsCount,
  };
}

export async function createCampaign(input: CreateCampaignInput) {
  const [insertedCampaign] = await db
    .insert(campaigns)
    .values({
      projectId: input.projectId,
      advertiser: input.advertiser,
      price: input.price,
    })
    .returning();

  let createdTags: Array<{ id: number; campaignId: number; tagKey: string; tagValue: string }> = [];

  if (input.tags) {
    let tagEntries: Array<{ tagKey: string; tagValue: string }> = [];

    if (Array.isArray(input.tags)) {
      tagEntries = input.tags;
    } else {
      tagEntries = Object.entries(input.tags).map(([tagKey, tagValue]) => ({
        tagKey,
        tagValue,
      }));
    }

    if (tagEntries.length > 0) {
      createdTags = await db
        .insert(campaignTags)
        .values(
          tagEntries.map((t) => ({
            campaignId: insertedCampaign.id,
            tagKey: t.tagKey,
            tagValue: t.tagValue,
          }))
        )
        .returning();
    }
  }

  return {
    ...insertedCampaign,
    tags: createdTags,
  };
}

export async function createLinkForCampaign(
  campaignId: number,
  telegramRef: string,
  linkType: string
) {
  const [insertedLink] = await db
    .insert(links)
    .values({
      campaignId,
      telegramRef,
      linkType,
    })
    .returning();

  return insertedLink;
}

export async function createDeepLinkForCampaign(
  campaignId: number,
  botUsername: string,
  payload?: string
) {
  const cleanUsername = botUsername.startsWith("@")
    ? botUsername.slice(1)
    : botUsername;

  const finalPayload =
    payload || `ad_${campaignId}_${Date.now().toString(36)}`;

  const savedLink = await createLinkForCampaign(
    campaignId,
    finalPayload,
    "deeplink"
  );

  const deepLink = `https://t.me/${cleanUsername}?start=${finalPayload}`;

  return { deepLink, savedLink, payload: finalPayload };
}

export async function createCampaignWithLinks(
  projectId: number,
  advertiser: string,
  price: number,
  tags?: Array<{ tagKey: string; tagValue: string }> | Record<string, string>,
  includePrivatka: boolean = false,
  isClosedLink: boolean = false,
  createInviteFn?: (channelId: string | number, campaignId: number, name?: string, isClosed?: boolean) => Promise<{ inviteLink: string; savedLink: any }>
) {
  const campaign = await createCampaign({
    projectId,
    advertiser,
    price,
    tags,
  });

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  let channelLink: { inviteLink: string; savedLink: any } | null = null;
  let privatkaLink: { deepLink: string; savedLink: any; payload: string } | null = null;

  // 1. Channel invite link
  if (project?.type === "channel" && project.telegramChatId && createInviteFn) {
    const creativeValue = Array.isArray(tags)
      ? tags.find((t) => t.tagKey === "creative")?.tagValue
      : tags?.creative;
    const inviteLinkName = creativeValue ? `${advertiser} — ${creativeValue}` : advertiser;

    channelLink = await createInviteFn(project.telegramChatId, campaign.id, inviteLinkName, isClosedLink);
  }

  // 2. Privatka deep-link (if includePrivatka is true)
  if (includePrivatka) {
    let targetBotUsername: string | null = null;

    if (project?.type === "channel" && project.linkedProjectId) {
      const linkedProj = await db.query.projects.findFirst({
        where: eq(projects.id, project.linkedProjectId),
      });
      if (linkedProj?.botUsername) {
        targetBotUsername = linkedProj.botUsername;
      }
    } else if (project?.type === "bot_subscription" && project.botUsername) {
      targetBotUsername = project.botUsername;
    }

    if (targetBotUsername) {
      privatkaLink = await createDeepLinkForCampaign(campaign.id, targetBotUsername);
    }
  }

  return {
    campaign,
    channelLink,
    privatkaLink,
  };
}

export async function getLinkByRef(telegramRef: string) {
  const link = await db.query.links.findFirst({
    where: eq(links.telegramRef, telegramRef),
  });
  return link || null;
}

export async function getCampaignById(id: number) {
  const campaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, id),
  });
  if (!campaign) return null;

  const tags = await db
    .select()
    .from(campaignTags)
    .where(eq(campaignTags.campaignId, id));

  const campaignLinks = await db
    .select()
    .from(links)
    .where(eq(links.campaignId, id));

  return {
    ...campaign,
    tags,
    links: campaignLinks,
  };
}

export async function getAttributionForUser(tgUserId: string) {
  const lastTouch = await db
    .select({ linkId: events.linkId })
    .from(events)
    .where(eq(events.tgUserId, tgUserId))
    .orderBy(desc(events.ts), desc(events.id))
    .limit(1);

  if (lastTouch.length === 0 || !lastTouch[0].linkId) {
    return null;
  }

  const link = await db.query.links.findFirst({
    where: eq(links.id, lastTouch[0].linkId),
  });

  if (!link) {
    return null;
  }

  const campaign = await getCampaignById(link.campaignId);
  if (!campaign) {
    return null;
  }

  const tags: Record<string, string> = {};
  for (const t of campaign.tags) {
    tags[t.tagKey] = t.tagValue;
  }

  return {
    linkId: link.id,
    campaignId: campaign.id,
    advertiser: campaign.advertiser,
    telegramRef: link.telegramRef,
    tags,
  };
}

export async function getCampaignTags(campaignId: number) {
  return await db
    .select()
    .from(campaignTags)
    .where(eq(campaignTags.campaignId, campaignId));
}

export async function getDistinctTagValues(tagKey: string): Promise<string[]> {
  const rows = await db
    .select({ tagValue: campaignTags.tagValue })
    .from(campaignTags)
    .where(eq(campaignTags.tagKey, tagKey));

  const distinctValues = Array.from(new Set(rows.map((r) => r.tagValue))).filter(Boolean);
  return distinctValues;
}

export async function upsertCampaignTag(
  campaignId: number,
  tagKey: string,
  tagValue: string
) {
  const existing = await db.query.campaignTags.findFirst({
    where: and(
      eq(campaignTags.campaignId, campaignId),
      eq(campaignTags.tagKey, tagKey)
    ),
  });

  if (existing) {
    const [updated] = await db
      .update(campaignTags)
      .set({ tagValue })
      .where(
        and(
          eq(campaignTags.campaignId, campaignId),
          eq(campaignTags.tagKey, tagKey)
        )
      )
      .returning();
    return updated;
  } else {
    const [inserted] = await db
      .insert(campaignTags)
      .values({
        campaignId,
        tagKey,
        tagValue,
      })
      .returning();
    return inserted;
  }
}

export async function deleteCampaignTag(campaignId: number, tagKey: string) {
  await db
    .delete(campaignTags)
    .where(
      and(
        eq(campaignTags.campaignId, campaignId),
        eq(campaignTags.tagKey, tagKey)
      )
    );
  return { success: true };
}

export async function getCampaignFullHistory(campaignId: number) {
  const campaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, campaignId),
  });
  if (!campaign) return null;

  const tags = await getCampaignTags(campaignId);
  const campaignLinks = await db
    .select()
    .from(links)
    .where(eq(links.campaignId, campaignId));

  const linkIds = campaignLinks.map((l) => l.id);

  let campaignEvents: Array<any> = [];
  if (linkIds.length > 0) {
    campaignEvents = await db
      .select()
      .from(events)
      .where(inArray(events.linkId, linkIds))
      .orderBy(desc(events.ts));
  }

  return {
    campaign,
    tags,
    links: campaignLinks,
    events: campaignEvents,
  };
}
