import { db } from "../db/index.js";
import { campaigns, campaignTags, links, projects, events, dailyStats } from "../db/schema.js";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { aggregate } from "../jobs/dailyAggregate.js";
import { getRetentionStats } from "./metrics.js";
import { EVENT_TYPES, FUNNEL_ENTRY_TYPES } from "../db/eventTypes.js";

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
  linkType: string,
  label?: string
) {
  const [insertedLink] = await db
    .insert(links)
    .values({
      campaignId,
      telegramRef,
      linkType,
      label: label ?? null,
    })
    .returning();

  return insertedLink;
}

export async function createCampaignWithLinks(
  projectId: number,
  advertiser: string,
  price: number,
  linkName: string,
  tags?: Array<{ tagKey: string; tagValue: string }> | Record<string, string>,
  isClosedLink: boolean = false,
  createInviteFn?: (channelId: string | number, campaignId: number, name?: string, isClosed?: boolean, label?: string) => Promise<{ inviteLink: string; savedLink: any }>
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

  // 1. Channel invite link
  if (project?.type === "channel" && project.telegramChatId && createInviteFn) {
    const inviteName = `${advertiser} — ${linkName}`;
    channelLink = await createInviteFn(project.telegramChatId, campaign.id, inviteName, isClosedLink, linkName);
  }

  return {
    campaign,
    channelLink,
  };
}

export const UNASSIGNED_ADVERTISER = "Не размечено (авто)";

export async function getProjectByChatId(chatId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.telegramChatId, chatId),
  });
  return project || null;
}

export async function getOrCreateUnassignedCampaign(projectId: number) {
  const existing = await db.query.campaigns.findFirst({
    where: and(eq(campaigns.projectId, projectId), eq(campaigns.advertiser, UNASSIGNED_ADVERTISER)),
  });
  if (existing) return existing;

  const [created] = await db
    .insert(campaigns)
    .values({ projectId, advertiser: UNASSIGNED_ADVERTISER, price: 0 })
    .returning();

  return created;
}

export async function reassignLinkCampaign(linkId: number, campaignId: number) {
  const campaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, campaignId),
  });
  if (!campaign) {
    throw new Error(`Campaign ${campaignId} not found`);
  }

  const [updated] = await db
    .update(links)
    .set({ campaignId })
    .where(eq(links.id, linkId))
    .returning();

  if (!updated) {
    throw new Error(`Link ${linkId} not found`);
  }

  // dailyStats is a pre-aggregated cache keyed by campaignId — moving a link's
  // historical events to a new campaign needs an explicit recompute, since
  // aggregate() otherwise only runs when a brand new event is logged.
  await aggregate();

  return updated;
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
    label: link.label,
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

// Cascades a single campaign delete across its links/tags/stats/events —
// mirrors deleteProjectCascade above, just scoped to one campaign instead of
// every campaign under a project. There's no DB-level ON DELETE CASCADE (SQLite
// FK enforcement isn't even turned on here), so this has to be done by hand.
export async function deleteCampaignCascade(campaignId: number) {
  const campaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, campaignId),
  });
  if (!campaign) return null;

  const campaignLinks = await db.select().from(links).where(eq(links.campaignId, campaignId));
  const linkIds = campaignLinks.map((l) => l.id);

  let deletedEventsCount = 0;
  if (linkIds.length > 0) {
    const delEvs = await db.delete(events).where(inArray(events.linkId, linkIds)).returning();
    deletedEventsCount = delEvs.length;
  }

  const delLinks = await db.delete(links).where(eq(links.campaignId, campaignId)).returning();
  const delTags = await db.delete(campaignTags).where(eq(campaignTags.campaignId, campaignId)).returning();
  const delStats = await db.delete(dailyStats).where(eq(dailyStats.campaignId, campaignId)).returning();

  const [deletedCampaign] = await db.delete(campaigns).where(eq(campaigns.id, campaignId)).returning();

  return {
    deletedCampaign,
    deletedLinksCount: delLinks.length,
    deletedTagsCount: delTags.length,
    deletedStatsCount: delStats.length,
    deletedEventsCount,
  };
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

export interface CampaignsPageParams {
  page: number;
  pageSize: number;
  q?: string;
}

export interface CampaignsPageLinkRow {
  id: number;
  telegramRef: string;
  linkType: string;
  label: string | null;
  joins: number;
  subs: number;
  buyers: number;
  revenue: number;
  cps: number | null;
  pricePerSub: number | null;
}

export interface CampaignsPageRow {
  id: number;
  projectId: number;
  advertiser: string;
  price: number;
  creative: string | null;
  createdAt: Date;
  retention24h: number | null;
  retention48h: number | null;
  links: CampaignsPageLinkRow[];
}

// Paginated version of the "по ссылкам" campaigns table: fetches one page of
// campaigns (newest first) plus only the links/events/retention needed for
// those campaigns, instead of the N+1 pattern of computing extended metrics
// for every campaign in the project up front.
export async function getCampaignsPage(
  params: CampaignsPageParams
): Promise<{ rows: CampaignsPageRow[]; total: number }> {
  const { page, pageSize } = params;
  const q = params.q?.trim();
  const offset = (page - 1) * pageSize;

  let whereClause;
  if (q) {
    const needle = `%${q}%`;
    const matches = await db
      .selectDistinct({ id: campaigns.id })
      .from(campaigns)
      .leftJoin(links, eq(links.campaignId, campaigns.id))
      .where(
        sql`lower_unicode(${campaigns.advertiser}) LIKE lower_unicode(${needle})
          OR CAST(${campaigns.id} AS TEXT) LIKE ${needle}
          OR lower_unicode(coalesce(${links.label}, '')) LIKE lower_unicode(${needle})
          OR lower_unicode(coalesce(${links.telegramRef}, '')) LIKE lower_unicode(${needle})`
      );
    const matchingIds = matches.map((m) => m.id);
    if (matchingIds.length === 0) return { rows: [], total: 0 };
    whereClause = inArray(campaigns.id, matchingIds);
  }

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(campaigns)
    .where(whereClause);

  const pageCampaigns = await db
    .select()
    .from(campaigns)
    .where(whereClause)
    .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
    .limit(pageSize)
    .offset(offset);

  if (pageCampaigns.length === 0) return { rows: [], total: Number(total) || 0 };

  const campaignIds = pageCampaigns.map((c) => c.id);

  const [pageLinks, pageTags, retentions] = await Promise.all([
    db.select().from(links).where(inArray(links.campaignId, campaignIds)),
    db
      .select()
      .from(campaignTags)
      .where(and(inArray(campaignTags.campaignId, campaignIds), eq(campaignTags.tagKey, "creative"))),
    Promise.all(campaignIds.map((id) => getRetentionStats(id))),
  ]);

  const linkIds = pageLinks.map((l) => l.id);
  const pageEvents = linkIds.length
    ? await db.select().from(events).where(inArray(events.linkId, linkIds))
    : [];

  const retentionByCampaign = new Map(campaignIds.map((id, i) => [id, retentions[i]]));
  const creativeByCampaign = new Map(pageTags.map((t) => [t.campaignId, t.tagValue]));

  const linksByCampaign = new Map<number, typeof pageLinks>();
  for (const l of pageLinks) {
    const arr = linksByCampaign.get(l.campaignId) || [];
    arr.push(l);
    linksByCampaign.set(l.campaignId, arr);
  }
  const eventsByLink = new Map<number, typeof pageEvents>();
  for (const e of pageEvents) {
    const arr = eventsByLink.get(e.linkId) || [];
    arr.push(e);
    eventsByLink.set(e.linkId, arr);
  }

  const rows: CampaignsPageRow[] = pageCampaigns.map((camp) => {
    const campLinks = linksByCampaign.get(camp.id) || [];
    const linkStats = campLinks.map((l) => {
      const linkEvents = eventsByLink.get(l.id) || [];
      const entryEvents = linkEvents.filter((e) =>
        (FUNNEL_ENTRY_TYPES as readonly string[]).includes(e.eventType)
      );
      const joins = entryEvents.length;
      const subs = new Set(entryEvents.map((e) => e.tgUserId)).size;
      const buyers = new Set(
        linkEvents.filter((e) => e.eventType === EVENT_TYPES.PAYMENT).map((e) => e.tgUserId)
      ).size;
      const revenue = linkEvents
        .filter((e) => e.eventType === EVENT_TYPES.PAYMENT || e.eventType === EVENT_TYPES.RENEWAL)
        .reduce((s, e) => s + (e.amount || 0), 0);
      return { link: l, joins, subs, buyers, revenue };
    });

    // Same proportional price-split as the per-campaign history view: a
    // campaign's price is allocated across its own links by revenue share
    // (falling back to joins share), which is why links always stay grouped
    // with the rest of their campaign's links on the same page.
    const totalRevenue = linkStats.reduce((s, x) => s + x.revenue, 0);
    const totalJoins = linkStats.reduce((s, x) => s + x.joins, 0);

    const linkRows: CampaignsPageLinkRow[] = linkStats.map((x) => {
      let share: number;
      if (totalRevenue > 0) share = x.revenue / totalRevenue;
      else if (totalJoins > 0) share = x.joins / totalJoins;
      else share = linkStats.length ? 1 / linkStats.length : 0;
      const priceAlloc = camp.price * share;
      return {
        id: x.link.id,
        telegramRef: x.link.telegramRef,
        linkType: x.link.linkType,
        label: x.link.label,
        joins: x.joins,
        subs: x.subs,
        buyers: x.buyers,
        revenue: x.revenue,
        cps: x.buyers ? priceAlloc / x.buyers : null,
        pricePerSub: x.subs ? priceAlloc / x.subs : null,
      };
    });

    const ret = retentionByCampaign.get(camp.id) || { retention24h: null, retention48h: null };

    return {
      id: camp.id,
      projectId: camp.projectId,
      advertiser: camp.advertiser,
      price: camp.price,
      creative: creativeByCampaign.get(camp.id) || null,
      createdAt: camp.createdAt,
      retention24h: ret.retention24h,
      retention48h: ret.retention48h,
      links: linkRows,
    };
  });

  return { rows, total: Number(total) || 0 };
}
