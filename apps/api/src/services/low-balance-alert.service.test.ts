import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, postCreditTransaction, schema } from "@skout/db";
import { commit, reserve } from "./api-credits.service.js";
import { buildLowBalanceEmail, checkLowBalance, clearLowBalanceNotifier, setLowBalanceNotifier, type LowBalanceDeps } from "./low-balance-alert.service.js";

describe("low-balance email", () => {
  it("names the workspace, balance and threshold, and links to buying credits", () => {
    const m = buildLowBalanceEmail({ to: "o@x.test", workspaceName: "Acme <Ltd>", balance: 42, threshold: 100, appUrl: "https://www.skoutai.io/app" });
    expect(m.subject).toBe("Data Credits are running low in Acme <Ltd>");
    expect(m.html).toContain("Acme &lt;Ltd&gt;");
    expect(m.text).toContain("42 Data Credits left, below your alert level of 100");
    expect(m.text).toContain("https://www.skoutai.io/app/settings/developers");
  });
});

/** PAPI-036 against a real, migrated Postgres. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("low-balance alert (PAPI-036, CRED-8)", () => {
  const { db, sql } = createDb(url as string);
  let mails: { to: string; subject: string }[] = [];
  let hooks: { eventType: string; workspaceId: string; payload: Record<string, unknown> }[] = [];
  const deps: LowBalanceDeps = {
    sendMail: async (m) => void mails.push({ to: m.to, subject: m.subject }),
    dispatchWebhook: async (eventType, workspaceId, payload) => void hooks.push({ eventType, workspaceId, payload }),
    defaultThreshold: 100,
    appUrl: "https://www.skoutai.io/app",
  };
  const created: { ws: string; users: string[] }[] = [];

  async function setup(credits: number) {
    const ws = randomUUID();
    await db.insert(schema.workspaces).values({ id: ws, name: "PAPI-036 Co", slug: `papi036-${ws}` });
    const users: string[] = [];
    for (const role of ["owner", "owner", "admin"]) {
      const [u] = await db.insert(schema.users).values({ email: `papi036-${role}-${randomUUID().slice(0, 6)}@test.com` }).returning();
      await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId: u!.id, role });
      users.push(u!.id);
    }
    created.push({ ws, users });
    const [key] = await db
      .insert(schema.apiKeys)
      .values({ workspaceId: ws, name: "k", type: "live", prefix: randomBytes(6).toString("hex"), keyHmac: "h", expiresAt: new Date(Date.now() + 30 * 86_400_000) })
      .returning();
    await postCreditTransaction(db, { workspaceId: ws, amount: credits, kind: "purchase", action: "test" });
    return { ws, keyId: key!.id };
  }
  const spend = async (ws: string, keyId: string, n: number) => {
    const h = await reserve(db, { workspaceId: ws, apiKeyId: keyId, requestId: randomUUID(), max: n });
    return commit(db, h.holdId, n, "people.lookup");
  };
  const notify = (workspaceId: string, balance: number) => checkLowBalance(db, deps, workspaceId, balance).then(() => undefined);

  beforeAll(() => setLowBalanceNotifier(notify));
  beforeEach(() => {
    mails = [];
    hooks = [];
  });
  afterAll(async () => {
    clearLowBalanceNotifier(notify);
    for (const c of created) {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, c.ws));
      for (const u of c.users) await db.delete(schema.users).where(eq(schema.users.id, u));
    }
    await sql.end();
  });

  it("fires once when a charge takes the balance below the threshold, emailing every Owner and sending credits.low", async () => {
    const { ws, keyId } = await setup(110);
    await spend(ws, keyId, 5); // 105: still above 100
    expect(mails).toHaveLength(0);
    expect(hooks).toHaveLength(0);

    await spend(ws, keyId, 10); // 95: crosses
    expect(mails).toHaveLength(2); // both Owners, not the Admin
    expect(mails[0]!.subject).toContain("running low");
    expect(hooks).toEqual([{ eventType: "credits.low", workspaceId: ws, payload: expect.objectContaining({ balance: 95, threshold: 100 }) }]);

    await spend(ws, keyId, 10); // 85: already alerted today
    await spend(ws, keyId, 10);
    expect(mails).toHaveLength(2);
    expect(hooks).toHaveLength(1);
  });

  it("doesn't repeat within 24 hours, then alerts again if the balance is still low", async () => {
    const { ws } = await setup(50);
    const t0 = new Date();
    expect((await checkLowBalance(db, deps, ws, 50, t0)).alerted).toBe(true);
    expect((await checkLowBalance(db, deps, ws, 40, new Date(t0.getTime() + 23 * 3_600_000))).alerted).toBe(false);
    expect((await checkLowBalance(db, deps, ws, 30, new Date(t0.getTime() + 24 * 3_600_000 + 1000))).alerted).toBe(true);
    expect(hooks.filter((h) => h.workspaceId === ws)).toHaveLength(2);
  });

  it("uses the owner's own threshold when set, and sends one alert when charges race", async () => {
    const { ws, keyId } = await setup(500);
    await db.insert(schema.workspaceApiSettings).values({ workspaceId: ws, lowBalanceThreshold: 450 }).onConflictDoUpdate({
      target: schema.workspaceApiSettings.workspaceId,
      set: { lowBalanceThreshold: 450 },
    });
    await spend(ws, keyId, 40); // 460: above 450
    expect(hooks).toHaveLength(0);
    await Promise.all([spend(ws, keyId, 20), spend(ws, keyId, 20), spend(ws, keyId, 20)]);
    expect(hooks.filter((h) => h.workspaceId === ws)).toHaveLength(1);
    expect(hooks[0]!.payload).toMatchObject({ threshold: 450 });
  });

  it("never lets an alert failure undo or block the charge", async () => {
    const { ws, keyId } = await setup(101);
    const broken = async () => {
      throw new Error("mail down");
    };
    setLowBalanceNotifier(broken);
    try {
      await expect(spend(ws, keyId, 5)).resolves.toMatchObject({ charged: 5, balance: 96 });
    } finally {
      setLowBalanceNotifier(notify);
    }
  });
});
