import { describe, expect, it } from "vitest";
import { createTaskActionNodeHandler } from "./action-create-task.node.js";
import { createTicketActionNodeHandler } from "./action-create-ticket.node.js";
import { updateFieldsActionNodeHandler } from "./action-update-fields.node.js";
import type { NodeExecutionContext } from "./types.js";

/**
 * COPS-10: the builder needs a successful simulation before it can publish, and a simulation has
 * no account. Found in the live browser run: a workflow with "create task" could never publish.
 */
function ctx(type: string, config: Record<string, unknown>, isSimulation: boolean): NodeExecutionContext {
  return { db: {} as never, config: {} as never, workspaceId: "ws-1", runId: "run-1", isSimulation, node: { id: "a", type: type as never, config }, priorOutputs: {} };
}

describe("account actions in a simulation", () => {
  it("simulate without an account, and say a real run needs one", async () => {
    const task = await createTaskActionNodeHandler(ctx("action_create_task", { title: "Call" }, true));
    expect(task.output).toMatchObject({ simulated: true, accountId: null, note: expect.stringContaining("account") });
    const ticket = await createTicketActionNodeHandler(ctx("action_create_ticket", { title: "Bug" }, true));
    expect(ticket.output).toMatchObject({ simulated: true, accountId: null });
    const upd = await updateFieldsActionNodeHandler(ctx("action_update_fields", { entityType: "contact", fields: { title: "VP" } }, true));
    expect(upd.output).toMatchObject({ simulated: true, entityId: null, patch: { title: "VP" } });
  });

  it("a real run still needs the account, and a simulation still checks the config", async () => {
    await expect(createTaskActionNodeHandler(ctx("action_create_task", { title: "Call" }, false))).rejects.toMatchObject({ statusCode: 422 });
    await expect(createTaskActionNodeHandler(ctx("action_create_task", {}, true))).rejects.toMatchObject({ statusCode: 422 });
    await expect(updateFieldsActionNodeHandler(ctx("action_update_fields", { entityType: "contact", fields: { workspaceId: "x" } }, true))).rejects.toMatchObject({ statusCode: 422 });
  });
});
