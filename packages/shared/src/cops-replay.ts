/**
 * COPS-01 — replay selection for outbox events (epic: "replay by id/range").
 * Pure validation of a replay request. The worker turns the plan into a query; replays re-queue
 * rows with the same event_id, so consumers skip anything already processed.
 */
export interface CopsReplayRequest {
  eventIds?: string[];
  from?: Date;
  to?: Date;
  tenantId: string;
}

export const COPS_REPLAY_MAX_EVENTS = 1_000;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class CopsReplayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopsReplayValidationError";
  }
}

/** Returns a normalised plan or throws. Exactly one of ids or range must be given. */
export function buildCopsReplayPlan(req: CopsReplayRequest) {
  if (!req.tenantId) throw new CopsReplayValidationError("tenantId is required");
  const hasIds = Array.isArray(req.eventIds) && req.eventIds.length > 0;
  const hasRange = Boolean(req.from || req.to);
  if (hasIds === hasRange) {
    throw new CopsReplayValidationError("Provide either event ids or a time range, not both or neither");
  }
  if (hasIds) {
    const ids = [...new Set(req.eventIds!)];
    if (ids.length > COPS_REPLAY_MAX_EVENTS) {
      throw new CopsReplayValidationError(`At most ${COPS_REPLAY_MAX_EVENTS} events per replay`);
    }
    const bad = ids.find((id) => !UUID.test(id));
    if (bad) throw new CopsReplayValidationError(`Not a valid event id: ${bad}`);
    return { kind: "ids" as const, tenantId: req.tenantId, eventIds: ids };
  }
  if (!req.from || !req.to) throw new CopsReplayValidationError("A range needs both from and to");
  if (req.from >= req.to) throw new CopsReplayValidationError("from must be before to");
  return { kind: "range" as const, tenantId: req.tenantId, from: req.from, to: req.to, limit: COPS_REPLAY_MAX_EVENTS };
}
