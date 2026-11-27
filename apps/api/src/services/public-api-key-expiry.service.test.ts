import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { buildKeyExpiryEmail, dueMilestone, runKeyExpiryReminders, type KeyExpiryDeps } from "./public-api-key-expiry.service.js";

const DAY = 86_400_000;

describe("key expiry milestones (PAPI-022)", () => {
  const exp = new Date("2026-12-31T00:00:00Z");
  const at = (daysBefore: number) => new Date(exp.getTime() - daysBefore * DAY);
  it("picks the nearest unsent milestone", () => {
    expect(dueMilestone(exp, {}, at(20))).toBeNull();
    expect(dueMilestone(exp, {}, at(14))).toBe("d14");
    expect(dueMilestone(exp, { d14: "x" }, at(10))).toBeNull();
    expect(dueMilestone(exp, { d14: "x" }, at(3))).toBe("d3");
    expect(dueMilestone(exp, { d14: "x", d3: "x" }, at(1))).toBeNull();
    expect(dueMilestone(exp, { d14: "x", d3: "x" }, at(0))).toBe("expired");
    expect(dueMilestone(exp, { d14: "x", d3: "x", expired: "x" }, at(-5))).toBeNull();
  });

  it("builds an email with the masked key and a link, never the key", () => {
    const mail = buildKeyExpiryEmail({ to: "a@b.test", keyName: "Prod <server>", maskedKey: "sk_live_0123456789ab_••••", expiresAt: exp, daysLeft: 3, appUrl: "https://www.skoutai.io/app/" });
    expect(mail.subject).toBe('Your Skout API key "Prod <server>" expires in 3 days');
    expect(mail.html).toContain("Prod &lt;server&gt;");
    expect(mail.text).toContain("https://www.skoutai.io/app/settings/developers");
    expect(mail.text).toContain("sk_live_0123456789ab_••••");
  });
});

const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("key expiry reminders with a clock fixture (Postgres)", () => {
  const { db, sql } = createDb(url as string);
  const T0 = new Date("2027-03-01T08:00:00Z");
  let ws: string;
  const userIds: string[] = [];
  const emails = { creator: "", owner1: "", owner2: "", member: "" };
  let mails: { to: string; subject: string }[] = [];
  let hooks: { eventType: string; payload: Record<string, unknown> }[] = [];
  const deps: KeyExpiryDeps = {
    sendMail: async (m) => {
      mails.push({ to: m.to, subject: m.subject });
    },
    dispatchWebhook: async (eventType, _ws, payload) => {
      hooks.push({ eventType, payload });
    },
    appUrl: "https://www.skoutai.io/app",
  };
  const run = async (at: Date) => {
    mails = [];
    hooks = [];
    const r = await runKeyExpiryReminders(db, deps, at);
    return r.reminders.filter((x) => keyIds.includes(x.keyId));
  };
  const keyIds: string[] = [];
  const insertKey = async (createdAt: Date, days: number, over: Partial<typeof schema.apiKeys.$inferInsert> = {}) => {
    const [k] = await db
      .insert(schema.apiKeys)
      .values({
        workspaceId: ws,
        createdBy: userIds[0],
        name: "Prod server",
        type: "live",
        prefix: randomBytes(6).toString("hex"),
        keyHmac: "h",
        expiresAt: new Date(createdAt.getTime() + days * DAY),
        createdAt,
        ...over,
      })
      .returning();
    keyIds.push(k!.id);
    return k!;
  };

  beforeAll(async () => {
    ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-022", slug: `papi022-${ws}` });
    for (const [label, role] of [["creator", "admin"], ["owner1", "owner"], ["owner2", "owner"], ["member", "member"]] as const) {
      const email = `papi022-${label}-${ws.slice(0, 6)}@test.com`;
      const [u] = await db.insert(schema.users).values({ email }).returning();
      userIds.push(u!.id);
      emails[label] = email;
      await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId: u!.id, role });
    }
  });

  afterAll(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
    for (const id of userIds) await db.delete(schema.users).where(eq(schema.users.id, id));
    await sql.end();
  });

  it("sends each reminder exactly once and fires api_key.expired on the expiry day", async () => {
    const key = await insertKey(T0, 30);
    const day = (n: number, hours = 0) => new Date(T0.getTime() + n * DAY + hours * 3_600_000);

    expect(await run(day(10))).toEqual([]); // 20 days left
    expect(mails).toHaveLength(0);

    const d14 = await run(day(16)); // 14 days left
    expect(d14).toEqual([{ keyId: key.id, milestone: "d14", recipients: 3 }]);
    expect(mails.map((m) => m.to).sort()).toEqual([emails.creator, emails.owner1, emails.owner2].sort());
    expect(mails[0]!.subject).toContain("expires in 14 days");
    expect(hooks).toEqual([{ eventType: "api_key.expiring", payload: expect.objectContaining({ key_id: key.id, days_left: 14 }) }]);
    expect(JSON.stringify(hooks)).not.toContain("hmac");

    expect(await run(day(16, 6))).toEqual([]); // same day, later run
    expect(await run(day(20))).toEqual([]);
    expect(mails).toHaveLength(0);

    const d3 = await run(day(27, 1)); // 2 days 23 h left
    expect(d3.map((r) => r.milestone)).toEqual(["d3"]);
    expect(mails).toHaveLength(3);
    expect(mails[0]!.subject).toContain("expires in 3 days");
    expect(await run(day(28))).toEqual([]);

    expect(await run(day(29, 23))).toEqual([]); // 1 hour before expiry
    const expired = await run(day(30)); // the expiry moment
    expect(expired.map((r) => r.milestone)).toEqual(["expired"]);
    expect(mails).toHaveLength(0);
    expect(hooks).toEqual([{ eventType: "api_key.expired", payload: expect.objectContaining({ key_id: key.id, masked_key: expect.stringMatching(/••••$/) }) }]);
    expect(await run(day(30, 12))).toEqual([]);
    expect(await run(day(45))).toEqual([]);

    const audits = await db
      .select({ action: schema.auditLogs.action })
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.entityId, key.id), eq(schema.auditLogs.action, "api_key.expired")));
    expect(audits).toHaveLength(1);
  });

  it("sends only the 3-day reminder for a short-lived key, and skips revoked and rotated keys", async () => {
    const start = new Date("2027-06-01T08:00:00Z");
    const short = await insertKey(start, 2);
    await insertKey(start, 10, { revokedAt: start, revokeReason: "test" });
    const replacement = await insertKey(start, 90);
    await insertKey(start, 10, { replacedBy: replacement.id, graceUntil: new Date(start.getTime() + DAY) });
    const first = await run(new Date(start.getTime() + 3_600_000));
    expect(first).toEqual([{ keyId: short.id, milestone: "d3", recipients: 3 }]);
    const [row] = await db.select({ sent: schema.apiKeys.expiryRemindersSent }).from(schema.apiKeys).where(eq(schema.apiKeys.id, short.id));
    expect(Object.keys(row!.sent).sort()).toEqual(["d14", "d3"]);
  });

  it("never sends the same reminder twice when two runs race", async () => {
    const start = new Date("2027-09-01T08:00:00Z");
    const key = await insertKey(start, 20);
    const at = new Date(start.getTime() + 7 * DAY);
    mails = [];
    const [a, b] = await Promise.all([runKeyExpiryReminders(db, deps, at), runKeyExpiryReminders(db, deps, at)]);
    const both = [...a.reminders, ...b.reminders].filter((r) => r.keyId === key.id);
    expect(both).toHaveLength(1);
    expect(mails.filter((m) => m.subject.includes("Prod server"))).toHaveLength(3);
  });
});
