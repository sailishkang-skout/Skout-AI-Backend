/**
 * Cross-feature regression: this branch's ICS/RSVP meeting-invite system was built alongside
 * (not instead of) develop's pre-existing Google Calendar OAuth invite system. Both write to
 * the same `meetings` row and were merged from independent branches — this suite verifies they
 * actually coexist correctly end-to-end rather than just type-checking together.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type Db } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("Meeting invite system interop (ICS vs. Google Calendar)", () => {
  let app: FastifyInstance;
  let db: Db;
  let closeDb: () => Promise<void>;

  beforeAll(async () => {
    const config = loadEnv();
    app = await buildApp({ ...config, CLERK_SECRET_KEY: undefined, AUTH_STUB: true, LOG_LEVEL: "fatal" });
    const created = createDb(config.DATABASE_URL!);
    db = created.db;
    closeDb = () => created.sql.end();
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
  });

  function asUser(email: string) {
    return { "x-stub-user-email": email, "content-type": "application/json" };
  }

  it("creating a meeting with invitees sets icsUid and persists meetingAttendees without touching googleEventId", async () => {
    const headers = asUser(`interop-${randomUUID()}@example.com`);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/meetings",
      headers,
      payload: {
        title: "Interop test meeting",
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        durationMinutes: 30,
        meetingType: "video",
        invitees: [{ email: "prospect@example.com", name: "Prospect" }],
      },
    });
    expect(create.statusCode).toBe(201);
    const meeting = create.json();

    // ICS side fired: icsUid generated, attendee row created.
    expect(meeting.icsUid).toBeTruthy();
    expect(meeting.icsSequence).toBe(0);
    // Google side untouched by meeting creation — schedule-google is a separate, explicit action.
    expect(meeting.googleEventId).toBeNull();

    const attendees = await db
      .select()
      .from(schema.meetingAttendees)
      .where(eq(schema.meetingAttendees.meetingId, meeting.id));
    expect(attendees).toHaveLength(1);
    expect(attendees[0]!.email).toBe("prospect@example.com");
    expect(attendees[0]!.rsvpStatus).toBe("needs-action");
  });

  it("sendIcsInvites: false suppresses the ICS side entirely, leaving the meeting ready for /schedule-google only", async () => {
    const headers = asUser(`interop-${randomUUID()}@example.com`);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/meetings",
      headers,
      payload: {
        title: "Google-only meeting",
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        durationMinutes: 30,
        meetingType: "video",
        invitees: [{ email: "prospect@example.com", name: "Prospect" }],
        sendIcsInvites: false,
      },
    });
    expect(create.statusCode).toBe(201);
    const meeting = create.json();

    expect(meeting.icsUid).toBeNull();
    // invitees is still stored on the row — /schedule-google reads it from there.
    expect(meeting.invitees).toEqual([{ email: "prospect@example.com", name: "Prospect" }]);

    const attendees = await db
      .select()
      .from(schema.meetingAttendees)
      .where(eq(schema.meetingAttendees.meetingId, meeting.id));
    expect(attendees).toHaveLength(0);
  });

  it("/schedule-google on a meeting with no connected Google Calendar fails cleanly (422), independent of ICS state", async () => {
    const headers = asUser(`interop-${randomUUID()}@example.com`);

    // Get a real userId to set as organizer — the auth-stub middleware provisions one per email.
    const whoami = await app.inject({ method: "GET", url: "/api/v1/companies", headers });
    const { workspaceId } = whoami.json();
    const [membership] = await db
      .select({ userId: schema.workspaceMembers.userId })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
      .limit(1);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/meetings",
      headers,
      payload: {
        title: "Needs google connection",
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        durationMinutes: 30,
        meetingType: "video",
        organizerId: membership!.userId,
        invitees: [{ email: "prospect@example.com" }],
      },
    });
    expect(create.statusCode).toBe(201);
    const meeting = create.json();
    // ICS already fired for this meeting (ICS side confirmed independent above).
    expect(meeting.icsUid).toBeTruthy();

    const scheduleGoogle = await app.inject({
      method: "POST",
      url: `/api/v1/meetings/${meeting.id}/schedule-google`,
      headers,
      payload: {},
    });
    expect(scheduleGoogle.statusCode).toBe(422);
    expect(scheduleGoogle.json().error).toBe("google_calendar_not_connected");

    // Confirm schedule-google's failure didn't corrupt the ICS state it inherited.
    const [row] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, meeting.id));
    expect(row!.icsUid).toBe(meeting.icsUid);
    expect(row!.icsSequence).toBe(0);
  });

  it("cancelling a meeting with ICS attendees increments icsSequence and soft-deletes it", async () => {
    const headers = asUser(`interop-${randomUUID()}@example.com`);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/meetings",
      headers,
      payload: {
        title: "To be cancelled",
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        durationMinutes: 30,
        meetingType: "video",
        invitees: [{ email: "prospect@example.com" }],
      },
    });
    const meeting = create.json();

    const del = await app.inject({ method: "DELETE", url: `/api/v1/meetings/${meeting.id}`, headers });
    expect(del.statusCode).toBe(204);

    const [row] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, meeting.id));
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.icsSequence).toBe(1);

    // Deleted meetings 404 on GET.
    const get = await app.inject({ method: "GET", url: `/api/v1/meetings/${meeting.id}`, headers });
    expect(get.statusCode).toBe(404);
  });
});
