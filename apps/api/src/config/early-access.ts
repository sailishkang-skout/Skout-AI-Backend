import type { Env } from "./env.js";

/**
 * Early access gate (spec 2026-11-17): new password/Google/Microsoft self-signups wait for COPS
 * approval. On by default in production only; EARLY_ACCESS_GATE_ENABLED=true|false overrides
 * (false is the emergency switch that lets new sign-ups straight in).
 */
export function earlyAccessGateEnabled(config: Pick<Env, "NODE_ENV"> & { EARLY_ACCESS_GATE_ENABLED?: "true" | "false" }): boolean {
  if (config.EARLY_ACCESS_GATE_ENABLED) return config.EARLY_ACCESS_GATE_ENABLED === "true";
  return config.NODE_ENV === "production";
}
