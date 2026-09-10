import { describe, expect, it } from "vitest";
import { createLogger, initRootLogger } from "./logger.js";
import { runWithRequestContext } from "./context.js";

describe("createLogger", () => {
  it("includes module name in log bindings", () => {
    initRootLogger({ service: "test", level: "silent", environment: "test" });
    const log = createLogger("auth.service");
    expect(log.module).toBe("auth.service");
  });

  it("merges request context into log fields", () => {
    initRootLogger({ service: "test", level: "silent", environment: "test" });
    const log = createLogger("crm.service");
    runWithRequestContext({ requestId: "req-1", workspaceId: "ws-1" }, () => {
      const child = log.child({ action: "import" });
      expect(child.module).toBe("crm.service");
    });
  });
});
