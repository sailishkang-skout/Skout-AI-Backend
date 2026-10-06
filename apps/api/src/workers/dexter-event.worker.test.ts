import { describe, expect, it, vi } from "vitest";
import { handleDexterEvent } from "./dexter-event.worker.js";

const { deliverNotificationChannelsMock } = vi.hoisted(() => ({
  deliverNotificationChannelsMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/notifications.service.js", () => ({
  deliverNotificationChannels: deliverNotificationChannelsMock,
}));

const event = {
  event_id: "6f1c2a7e-8b1d-4c2e-9f3a-1a2b3c4d5e6f",
  event_type: "OpportunityQualified",
  schema_version: 1,
  tenant_id: "11111111-1111-4111-8111-111111111111",
  aggregate_type: "opportunity",
  aggregate_id: "deal-1",
  occurred_at: "2026-10-06T10:00:00.000Z",
  actor: { type: "user", id: "user-1" },
  correlation_id: "6f1c2a7e-8b1d-4c2e-9f3a-1a2b3c4d5e70",
  causation_id: null,
  payload: { opportunity_id: "deal-1", account_id: "company-1" },
} as const;

function makeDb(claimed: boolean, recipientIds: string[] = []) {
  const valuesCalls: unknown[] = [];
  let insertNumber = 0;
  const insert = vi.fn().mockImplementation(() => {
    insertNumber++;
    return {
      values: (values: unknown) => {
        valuesCalls.push(values);
        return {
          onConflictDoNothing: () => ({
            returning: async () => {
              if (insertNumber === 1) return claimed ? [{ eventId: event.event_id }] : [];
              return [{
                id: "notification-1",
                workspaceId: event.tenant_id,
                userId: recipientIds[0],
                type: "cops.OpportunityQualified",
                title: "CustomerOps: Opportunity Qualified",
                body: "A CustomerOps update is available for this record.",
                entityType: event.aggregate_type,
                entityId: event.aggregate_id,
                deliveredChannels: ["in_app"],
                readAt: null,
                createdAt: new Date("2026-10-06T10:00:00.000Z"),
              }];
            },
          }),
        };
      },
    };
  });
  const routeQuery = {
    from: () => routeQuery,
    where: () => routeQuery,
    limit: async () => [],
  };
  const recipientsQuery = {
    from: () => recipientsQuery,
    innerJoin: () => recipientsQuery,
    where: async () => recipientIds.map((userId) => ({ userId })),
  };
  type Tx = {
    insert: typeof insert;
    select: () => typeof routeQuery;
    selectDistinct: () => typeof recipientsQuery;
  };
  const tx: Tx = {
    insert,
    select: () => routeQuery,
    selectDistinct: () => recipientsQuery,
  };
  const transaction = vi.fn((callback: (tx: Tx) => unknown) => callback(tx));
  return {
    db: { transaction } as never,
    transaction,
    insert,
    valuesCalls,
  };
}

describe("handleDexterEvent COPS envelope handling", () => {
  it("atomically records the event and role-routed in-app notification", async () => {
    const mocks = makeDb(true, ["user-1"]);

    await handleDexterEvent(event, mocks.db);

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.insert).toHaveBeenCalledTimes(2);
    expect(mocks.valuesCalls[0]).toEqual({
      consumer: "skout-dexter-event",
      eventId: event.event_id,
    });
    expect(mocks.valuesCalls[1]).toMatchObject({
      workspaceId: event.tenant_id,
      userId: "user-1",
      sourceEventId: event.event_id,
      type: "cops.OpportunityQualified",
    });
  });

  it("ignores duplicate COPS deliveries", async () => {
    const mocks = makeDb(false);

    await expect(handleDexterEvent(event, mocks.db)).resolves.toBeUndefined();
    expect(mocks.insert).toHaveBeenCalledOnce();
  });

  it("retries outstanding provider delivery when a committed event is redelivered", async () => {
    deliverNotificationChannelsMock.mockClear();
    const pendingNotification = {
      id: "notification-1",
      workspaceId: event.tenant_id,
      userId: "user-1",
      type: "cops.OpportunityQualified",
      title: "CustomerOps: Opportunity Qualified",
      body: "A CustomerOps update is available for this record.",
      entityType: event.aggregate_type,
      entityId: event.aggregate_id,
      deliveredChannels: ["in_app"],
      readAt: null,
      createdAt: new Date("2026-10-06T10:00:00.000Z"),
    };
    const where = vi.fn().mockResolvedValue([pendingNotification]);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const db = {
      transaction: vi.fn(async () => ({ claimed: false, rows: [] })),
      select,
    } as never;
    const config = {} as never;

    await handleDexterEvent(event, db, config);

    expect(select).toHaveBeenCalledOnce();
    expect(deliverNotificationChannelsMock).toHaveBeenCalledWith(
      db,
      config,
      expect.objectContaining({ id: pendingNotification.id, deliveredChannels: ["in_app"] }),
      expect.objectContaining({ eventId: event.event_id }),
      { retryFailedDelivery: true }
    );
  });

  it("requires the existing database for idempotent COPS handling", async () => {
    await expect(handleDexterEvent(event, null)).rejects.toThrow(/DATABASE_URL/);
  });
});
