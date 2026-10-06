import { describe, expect, it, vi } from "vitest";
import { requireCopsPermission } from "./cops-platform.service.js";

function fakeReply() {
  const reply = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(body: unknown) {
      reply.body = body;
      return reply;
    },
  };
  return reply;
}

const request = (over: Record<string, unknown> = {}) =>
  ({ headers: {}, workspaceId: "ws_1", userId: "u_1", ...over }) as never;

describe("requireCopsPermission", () => {
  it("lets a caller through when the permission key is granted", async () => {
    const getPerms = vi.fn().mockResolvedValue(["commercial:approve"]);
    const handler = requireCopsPermission("commercial", "approve", getPerms);
    const reply = fakeReply();
    await handler(request(), reply as never);
    expect(getPerms).toHaveBeenCalledWith("ws_1", "u_1");
    expect(reply.statusCode).toBe(200);
  });

  it("denies with the COPS envelope and the required permission", async () => {
    const handler = requireCopsPermission("commercial", "read", async () => ["crm:read"]);
    const reply = fakeReply();
    await handler(request(), reply as never);
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toMatchObject({
      code: "FORBIDDEN",
      details: { required_permission: "commercial:read" },
      retryable: false,
    });
  });

  it("returns 401 when workspace or user context is missing", async () => {
    const handler = requireCopsPermission("crm", "read", async () => []);
    const reply = fakeReply();
    await handler(request({ workspaceId: undefined }), reply as never);
    expect(reply.statusCode).toBe(401);
  });
});
