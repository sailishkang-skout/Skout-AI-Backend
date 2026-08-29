/**
 * Lets any node's config field reference an earlier step's output, e.g. an action_http node's
 * output feeding an action_crm_writeback node's subject — `{{n1.status}}`. This is the general
 * fix for cross-node data passing: adding a dedicated node type per source/destination pair
 * doesn't scale, and every node handler already receives `priorOutputs` keyed by nodeId, so
 * templating is the natural place to resolve references, not the node handlers themselves.
 *
 * A config value that is *exactly* one token (e.g. "{{n1.status}}", nothing else in the string)
 * resolves to the raw referenced value, preserving its type — this matters for fields like
 * delay's `seconds` (needs a number) or a writeback's `entityId` (needs the raw id, not a
 * stringified copy). A token embedded in a larger string (e.g. "Status: {{n1.status}}")
 * stringifies the referenced value inline. An unresolved reference (unknown nodeId or field)
 * resolves to an empty string, matching how a missing prior-output field already behaves
 * elsewhere (e.g. condition.node.ts's lookup).
 */
const TOKEN_PATTERN = /\{\{\s*([\w-]+)\.([\w-]+)\s*\}\}/g;
const EXACT_TOKEN_PATTERN = /^\{\{\s*([\w-]+)\.([\w-]+)\s*\}\}$/;

function resolveToken(nodeId: string, field: string, priorOutputs: Record<string, unknown>): unknown {
  const output = priorOutputs[nodeId];
  if (!output || typeof output !== "object") return undefined;
  return (output as Record<string, unknown>)[field];
}

function stringifyForInterpolation(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function interpolateString(value: string, priorOutputs: Record<string, unknown>): unknown {
  const exact = value.match(EXACT_TOKEN_PATTERN);
  if (exact) return resolveToken(exact[1]!, exact[2]!, priorOutputs);

  return value.replace(TOKEN_PATTERN, (_match, nodeId: string, field: string) =>
    stringifyForInterpolation(resolveToken(nodeId, field, priorOutputs))
  );
}

function interpolateValue(value: unknown, priorOutputs: Record<string, unknown>): unknown {
  if (typeof value === "string") return interpolateString(value, priorOutputs);
  if (Array.isArray(value)) return value.map((v) => interpolateValue(v, priorOutputs));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateValue(v, priorOutputs)]));
  }
  return value;
}

export function interpolateConfig(
  config: Record<string, unknown>,
  priorOutputs: Record<string, unknown>
): Record<string, unknown> {
  return interpolateValue(config, priorOutputs) as Record<string, unknown>;
}
