import { randomUUID, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const SECRET = "test-rsvp-secret";

describe.skipIf(!hasDatabase)("POST /webhooks/meeting-rsvp", () => {
  let app: FastifyInstance;
  let db: Db;
  let closeDb: () => Promise<void>;

  beforeAll(async () => {
    const config = loadEnv({ MEETING_RSVP_WEBHOOK_SECRET: SECRET });
    app = await buildApp({ ...config, CLERK_SECRET_KEY: undefined, AUTH_STUB: true, LOG_LEVEL: "fatal" });
    const created = createDb(config.DATABASE_URL!);
    db = created.db;
    closeDb = () => created.sql.end();
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
  });

  it("rejects an unsigned request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/meeting-rsvp",
      payload: { meetingId: randomUUID(), attendeeEmail: "a@b.com", icsReplyContent: "" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a request signed with the wrong secret", async () => {
    const payload = { meetingId: randomUUID(), attendeeEmail: "a@b.com", icsReplyContent: "x" };
    const rawBody = JSON.stringify(payload);
    const signature = createHmac("sha256", "wrong-secret").update(rawBody).digest("hex");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/meeting-rsvp",
      headers: { "x-rsvp-signature": signature, "content-type": "application/json" },
      payload: rawBody,
    });
    expect(response.statusCode).toBe(400);
  });

  it("accepts a correctly signed ACCEPTED reply and updates the attendee", async () => {
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: "RSVP Test WS", slug: `rsvp-test-${randomUUID()}` })
      .returning();
    const [meeting] = await db
      .insert(schema.meetings)
      .values({
        workspaceId: workspace.id,
        title: "Test meeting",
        scheduledAt: new Date(),
        icsUid: `${randomUUID()}@meetings.skout.ai`,
      })
      .returning();
    await db.insert(schema.meetingAttendees).values({
      meetingId: meeting.id,
      email: "prospect@acme.com",
      rsvpStatus: "needs-action",
    });

    const icsReply = [
      "BEGIN:VCALENDAR",
      "METHOD:REPLY",
      "BEGIN:VEVENT",
      `UID:${meeting.icsUid}`,
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:prospect@acme.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const payload = { meetingId: meeting.id, attendeeEmail: "prospect@acme.com", icsReplyContent: icsReply };
    const rawBody = JSON.stringify(payload);
    const signature = createHmac("sha256", SECRET).update(rawBody).digest("hex");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/meeting-rsvp",
      headers: { "x-rsvp-signature": signature, "content-type": "application/json" },
      payload: rawBody,
    });
    expect(response.statusCode).toBe(200);

    const [attendee] = await db
      .select()
      .from(schema.meetingAttendees)
      .where(eq(schema.meetingAttendees.meetingId, meeting.id));
    expect(attendee.rsvpStatus).toBe("accepted");
    expect(attendee.respondedAt).not.toBeNull();
  });

  it("returns 404 when no matching attendee exists", async () => {
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: "RSVP 404 WS", slug: `rsvp-404-${randomUUID()}` })
      .returning();
    const [meeting] = await db
      .insert(schema.meetings)
      .values({
        workspaceId: workspace.id,
        title: "No attendees meeting",
        scheduledAt: new Date(),
        icsUid: `${randomUUID()}@meetings.skout.ai`,
      })
      .returning();

    const icsReply = [
      "BEGIN:VCALENDAR",
      "METHOD:REPLY",
      "BEGIN:VEVENT",
      `UID:${meeting.icsUid}`,
      "ATTENDEE;PARTSTAT=DECLINED:mailto:nobody@nowhere.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const payload = { meetingId: meeting.id, attendeeEmail: "nobody@nowhere.com", icsReplyContent: icsReply };
    const rawBody = JSON.stringify(payload);
    const signature = createHmac("sha256", SECRET).update(rawBody).digest("hex");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/meeting-rsvp",
      headers: { "x-rsvp-signature": signature, "content-type": "application/json" },
      payload: rawBody,
    });
    expect(response.statusCode).toBe(404);
  });
});
