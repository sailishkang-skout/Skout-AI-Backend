import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { checkSendEligibility } from "./email-intel.service.js";

const log = createLogger("send-eligibility-guard");

/** Policy decisions that should hard-block a send. */
const BLOCKING_DECISIONS = new Set(["DO_NOT_USE", "MANUAL_REVIEW"]);

/**
 * Inconclusive verification (SMTP timeout, port-25 blocked in VPC, etc.) must not block
 * sending — same fail-open posture as an unreachable email-intel service.
 */
const INCONCLUSIVE_DECISIONS = new Set(["RETRY_VERIFICATION", "SMTP_ERROR", "UNAVAILABLE", "NO_DECISION"]);

export interface SendEligibilityGateResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Shared pre-send gate used by every outbound path (sequence steps, AI draft send, manual
 * inbox reply) — same role as the existing suppression-list check, but backed by email-intel's
 * policy engine instead of a static list. Blocks sends the engine marks DO_NOT_USE/MANUAL_REVIEW
 * (e.g. catch-all domains, which Skout's own SENDABLE_STATUSES otherwise treats as sendable).
 *
 * Fails open (never blocks) on any error, timeout, or when EMAIL_INTEL_SERVICE_URL isn't
 * configured — this is a safety enhancement layered on suppression, not a hard dependency.
 */
export async function isSendBlockedByEligibility(
  config: Pick<Env, "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS">,
  email: string
): Promise<SendEligibilityGateResult> {
  try {
    const check = await checkSendEligibility(config, email);
    if (!check.allowed) {
      if (INCONCLUSIVE_DECISIONS.has(check.decision) || !BLOCKING_DECISIONS.has(check.decision)) {
        log.info("send-eligibility inconclusive — failing open", {
          email,
          decision: check.decision,
          reason: check.reason,
        });
        return { blocked: false };
      }
      log.info("send blocked by email-intel eligibility policy", {
        email,
        decision: check.decision,
        reason: check.reason,
      });
      return { blocked: true, reason: check.reason ?? check.decision };
    }
    return { blocked: false };
  } catch (err) {
    log.warn("send-eligibility check failed — failing open", { email, err });
    return { blocked: false };
  }
}
