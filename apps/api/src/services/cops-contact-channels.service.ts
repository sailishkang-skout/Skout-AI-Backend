import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";

const { contactChannels } = schema;

export type ChannelWriteOutcome = "inserted" | "updated" | "kept_verified" | "kept_higher_confidence";

export interface ChannelWriteInput {
  workspaceId: string;
  contactId: string;
  channel: string;
  value: string;
  verified: boolean;
  confidence: number;
  source: string;
}

/**
 * Writes one contact channel value under the COPS verified-vs-inferred rule (Bible: never
 * overwrite a verified value with a lower-confidence one):
 *  - a new value is inserted;
 *  - an unverified write never replaces a verified row for the same value;
 *  - a write with lower confidence than the stored row, and not verified, is kept out;
 *  - otherwise the row is updated with the newer observation.
 * Keyed by (workspace, contact, channel, value), so the value itself is never silently replaced.
 */
export async function writeContactChannel(db: Db, input: ChannelWriteInput): Promise<ChannelWriteOutcome> {
  const [existing] = await db
    .select({ id: contactChannels.id, verified: contactChannels.verified, confidence: contactChannels.confidence })
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.workspaceId, input.workspaceId),
        eq(contactChannels.contactId, input.contactId),
        eq(contactChannels.channel, input.channel),
        eq(contactChannels.value, input.value)
      )
    )
    .limit(1);

  if (!existing) {
    await db.insert(contactChannels).values({
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      channel: input.channel,
      value: input.value,
      verified: input.verified,
      confidence: input.confidence.toFixed(2),
      source: input.source,
    });
    return "inserted";
  }

  if (existing.verified && !input.verified) return "kept_verified";
  if (!input.verified && input.confidence < Number(existing.confidence)) return "kept_higher_confidence";

  await db
    .update(contactChannels)
    .set({
      verified: input.verified,
      confidence: input.confidence.toFixed(2),
      source: input.source,
      observedAt: new Date(),
    })
    .where(eq(contactChannels.id, existing.id));
  return "updated";
}
