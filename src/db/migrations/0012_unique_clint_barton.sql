-- Channel and bot become two halves of one project.
--
-- Until now a privatka was two rows: the channel people subscribed to, and the
-- bot that sold to them, joined by `linked_project_id`. That split one funnel
-- across two projects, and the money landed in the wrong half: a purchase took
-- its project from the buyer's last event, which was the channel join, so the
-- bot project — the one that actually earned it — reported zero.
--
-- Here every linked pair is folded into its channel's row. The channel's row is
-- the one kept because campaigns, invite links and the bulk of the events
-- already point at it; the bot row contributes its username and whatever it
-- owns, and is then removed.
--
-- Hand-written: drizzle-kit only knows that a column disappears, not that the
-- rows it linked have to be merged first.

-- 1. Which rows fold into which.
--
-- One channel per bot. Should two channels ever have pointed at the same bot,
-- the older channel receives it and the other simply loses the link; merging
-- one bot into two projects is not a thing that can be done.
CREATE TEMP TABLE `__merge` AS
SELECT
	MIN(c."id") AS "keep_id",
	b."id" AS "drop_id",
	b."bot_username" AS "bot_username"
FROM `projects` c
JOIN `projects` b ON b."id" = c."linked_project_id"
WHERE c."telegram_chat_id" IS NOT NULL
	AND b."id" <> c."id"
GROUP BY b."id";
--> statement-breakpoint

-- 2. Events. The unique key is (project, user, type, second), so a bot event
-- that already has an exact twin in the channel would collide on the move.
-- Such a twin is the same event recorded twice; the channel's copy stays.
DELETE FROM `events` WHERE "id" IN (
	SELECT e."id"
	FROM `events` e
	JOIN `__merge` m ON e."project_id" = m."drop_id"
	WHERE EXISTS (
		SELECT 1 FROM `events` k
		WHERE k."project_id" = m."keep_id"
			AND k."tg_user_id" = e."tg_user_id"
			AND k."event_type" = e."event_type"
			AND k."ts" = e."ts"
	)
);
--> statement-breakpoint
UPDATE `events`
SET "project_id" = (SELECT m."keep_id" FROM `__merge` m WHERE m."drop_id" = `events`."project_id")
WHERE "project_id" IN (SELECT "drop_id" FROM `__merge`);
--> statement-breakpoint

-- 3. Everything else the bot row owned.
UPDATE `campaigns`
SET "project_id" = (SELECT m."keep_id" FROM `__merge` m WHERE m."drop_id" = `campaigns`."project_id")
WHERE "project_id" IN (SELECT "drop_id" FROM `__merge`);
--> statement-breakpoint
UPDATE `utm_links`
SET "project_id" = (SELECT m."keep_id" FROM `__merge` m WHERE m."drop_id" = `utm_links`."project_id")
WHERE "project_id" IN (SELECT "drop_id" FROM `__merge`);
--> statement-breakpoint

-- 4. The kept row takes the bot's username. A channel that somehow already had
-- one keeps its own.
UPDATE `projects`
SET "bot_username" = COALESCE(
	"bot_username",
	(SELECT m."bot_username" FROM `__merge` m WHERE m."keep_id" = `projects`."id")
)
WHERE "id" IN (SELECT "keep_id" FROM `__merge`);
--> statement-breakpoint

-- 5. Nothing references the bot rows any more; they go.
DELETE FROM `projects` WHERE "id" IN (SELECT "drop_id" FROM `__merge`);
--> statement-breakpoint
DROP TABLE `__merge`;
--> statement-breakpoint

-- 6. Type follows composition from now on — for every project, not only the
-- merged ones. A bot row that was never linked to a channel is a bot without a
-- channel, whatever it was called before.
UPDATE `projects`
SET "type" = CASE
	WHEN "telegram_chat_id" IS NOT NULL AND "bot_username" IS NOT NULL THEN 'bot_subscription'
	WHEN "bot_username" IS NOT NULL THEN 'bot_direct'
	ELSE 'channel'
END;
--> statement-breakpoint

-- 7. The link itself has nothing left to describe.
ALTER TABLE `projects` DROP COLUMN `linked_project_id`;
