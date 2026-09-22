import { vi } from "vitest";

export type MockIskDbOptions = {
  sessionToken: string;
  userId: string;
  workspaceId: string;
  email?: string;
  role?: string;
  /** When false, invite_sessions lookup returns no row (unknown/expired token). */
  sessionValid?: boolean;
};

/** Drizzle-shaped mock for the auth plugin's three `isk_` session lookups. */
export function mockDbForIskSession(options: MockIskDbOptions) {
  const { sessionValid = true } = options;
  let selectCall = 0;

  return {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(async () => {
        selectCall += 1;
        if (selectCall === 1) {
          if (!sessionValid) return [];
          return [{ userId: options.userId }];
        }
        if (selectCall === 2) {
          return [{ email: options.email ?? "invite-user@test.com" }];
        }
        if (selectCall === 3) {
          return [{ workspaceId: options.workspaceId, role: options.role ?? "member" }];
        }
        return [];
      });
      return chain;
    }),
  };
}
