import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { esignTemplateSchema, LIVE_ENVELOPE_STATUSES, nextEnvelopeStatus, selectEsignTemplate, type EnvelopeStatus, type EsignTemplate } from "@skout/shared";
import { writeCopsAudit } from "./cops-platform.service.js";
import { listConfig } from "./cops-admin-config.service.js";
import { CommercialError, getOpportunity, sendContract, setContractStatus, type CommercialContext } from "./cops-commercial.service.js";
import type { EsignAdapter, EsignSigner } from "./esign/esign-adapter.js";
import { getAccountContractFields } from "./cops-account-fields.service.js";

/**
 * COPS-08 e-signature (Bible p.32). A contract version goes out through the provider adapter and
 * its status then follows the provider's signed webhooks, replacing the manual status of COPS-03
 * (which stays as the fallback for contracts signed outside the provider). Events are verified,
 * deduplicated by provider event id and applied by rank, so any arrival order ends the same way
 * and ContractSigned is emitted once.
 */
const { contracts, contractVersions, signatureEnvelopes, signatureEvents } = schema;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type EnvelopeRow = typeof signatureEnvelopes.$inferSelect;
type EventRow = typeof signatureEvents.$inferSelect;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIVE = [...LIVE_ENVELOPE_STATUSES];
const CLOSED_CONTRACT = ["signed", "declined", "expired"];

function envelopeDto(row: EnvelopeRow, events: EventRow[]) {
  return {
    id: row.id,
    contract_id: row.contractId,
    contract_version: row.contractVersion,
    provider: row.provider,
    provider_ref: row.providerRef,
    status: row.status as EnvelopeStatus,
    template_key: row.templateKey,
    signers: row.signers as EsignSigner[],
    merge_fields: row.mergeFields as Record<string, string>,
    sent_by: row.sentBy,
    sent_at: row.sentAt?.toISOString() ?? null,
    status_changed_at: row.statusChangedAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    /** What the provider told us, in the order it happened there (arrival order when it gave no time). */
    events: events
      .filter((e) => e.envelopeId === row.id)
      .map((e) => ({ event_type: e.eventType, status: e.status, occurred_at: e.occurredAt?.toISOString() ?? null, received_at: e.receivedAt.toISOString(), outcome: e.outcome })),
  };
}
export type EnvelopeDto = ReturnType<typeof envelopeDto>;

export async function listEnvelopes(db: Db, workspaceId: string, where: { contractId?: string; id?: string }): Promise<EnvelopeDto[]> {
  const rows = await db
    .select()
    .from(signatureEnvelopes)
    .where(
      and(
        eq(signatureEnvelopes.workspaceId, workspaceId),
        where.contractId ? eq(signatureEnvelopes.contractId, where.contractId) : undefined,
        where.id ? eq(signatureEnvelopes.id, where.id) : undefined
      )
    )
    .orderBy(desc(signatureEnvelopes.createdAt))
    .limit(100);
  if (rows.length === 0) return [];
  const events = await db
    .select()
    .from(signatureEvents)
    .where(inArray(signatureEvents.envelopeId, rows.map((r) => r.id)))
    .orderBy(asc(signatureEvents.occurredAt), asc(signatureEvents.receivedAt));
  return rows.map((r) => envelopeDto(r, events));
}

async function loadTemplates(db: Db, workspaceId: string): Promise<Array<{ key: string; value: EsignTemplate }>> {
  const configs = await listConfig(db, workspaceId, "esign_template");
  return configs.flatMap((c) => {
    const parsed = esignTemplateSchema.safeParse(c.value);
    return parsed.success ? [{ key: c.key, value: parsed.data }] : [];
  });
}

export interface SendEnvelopeInput {
  signers: EsignSigner[];
  merge_fields?: Record<string, string>;
  /** Used with the deal type to choose the template; the account record does not hold these yet. */
  template_context?: { region?: string; segment?: string; legal_entity?: string };
  message?: string;
}

/**
 * `resolveDocument` turns an internally stored contract (document_url "cops-document:<sha>") into
 * what the provider can take; providers also accept base64 file content. Plain URLs pass through.
 */
export async function sendEnvelope(
  db: Db,
  ctx: CommercialContext,
  adapter: EsignAdapter,
  contractId: string,
  input: SendEnvelopeInput,
  resolveDocument: (documentUrl: string) => Promise<string> = async (url) => url
): Promise<EnvelopeDto> {
  if (!adapter.isConfigured()) throw new CommercialError("PROVIDER_UNAVAILABLE", "E-signature is not configured in this environment", { provider: adapter.provider });
  const templates = await loadTemplates(db, ctx.workspaceId);

  // Step 1: claim the contract version. The row exists before the provider is called, so a second
  // request cannot send the same document while the first is still talking to the provider.
  const prepared = await db.transaction(async (tx) => {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(and(eq(contracts.id, contractId), eq(contracts.workspaceId, ctx.workspaceId)))
      .for("update")
      .limit(1);
    if (!contract) throw new CommercialError("NOT_FOUND", "Contract not found");
    if (CLOSED_CONTRACT.includes(contract.status)) throw new CommercialError("BUSINESS_STATE_CONFLICT", `Contract is ${contract.status}`, { status: contract.status });
    const [version] = await tx
      .select()
      .from(contractVersions)
      .where(and(eq(contractVersions.contractId, contractId), eq(contractVersions.version, contract.currentVersion)))
      .limit(1);
    if (!version) throw new Error("Current contract version missing");
    const [live] = await tx
      .select({ id: signatureEnvelopes.id, status: signatureEnvelopes.status })
      .from(signatureEnvelopes)
      .where(and(eq(signatureEnvelopes.contractId, contractId), eq(signatureEnvelopes.contractVersion, version.version), inArray(signatureEnvelopes.status, LIVE)))
      .limit(1);
    if (live) throw new CommercialError("BUSINESS_STATE_CONFLICT", "This version is already out for signature", { envelope_id: live.id, status: live.status });

    const opportunity = await getOpportunity(tx as unknown as Db, ctx.workspaceId, contract.opportunityId);
    // Region, segment and legal entity come from the account; what the sender passes wins.
    const accountFields = opportunity.companyId ? await getAccountContractFields(tx as unknown as Db, ctx.workspaceId, opportunity.companyId) : {};
    const template = selectEsignTemplate(templates, { contract_kind: contract.kind, deal_type: opportunity.dealType, ...accountFields, ...input.template_context });
    const mergeFields: Record<string, string> = {
      contract_title: contract.title,
      opportunity_name: opportunity.name,
      ...(opportunity.currency ? { currency: opportunity.currency } : {}),
      ...input.merge_fields,
    };
    const [envelope] = await tx
      .insert(signatureEnvelopes)
      .values({
        workspaceId: ctx.workspaceId,
        contractId,
        contractVersion: version.version,
        provider: adapter.provider,
        status: "pending_send",
        templateKey: template?.key ?? null,
        signers: input.signers,
        mergeFields,
        sentBy: ctx.userId,
      })
      .returning({ id: signatureEnvelopes.id });
    return { envelopeId: envelope!.id, contract, version, template, mergeFields };
  });

  // Step 2: the provider. Outside any transaction: it is slow and cannot be rolled back.
  let providerRef: string;
  try {
    ({ providerRef } = await adapter.createEnvelope({
      referenceId: prepared.envelopeId,
      title: prepared.contract.title,
      documentUrl: await resolveDocument(prepared.version.documentUrl),
      fileSha256: prepared.version.fileSha256,
      signers: input.signers,
      templateId: prepared.template?.value.provider_template_id ?? null,
      mergeFields: prepared.mergeFields,
      message: input.message,
    }));
  } catch (error) {
    await db.update(signatureEnvelopes).set({ status: "failed", statusChangedAt: new Date() }).where(and(eq(signatureEnvelopes.id, prepared.envelopeId), eq(signatureEnvelopes.status, "pending_send")));
    throw new CommercialError("PROVIDER_ERROR", "The e-signature provider did not accept the envelope; try again", {
      provider: adapter.provider,
      cause: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }

  // Step 3: record it. A webhook may already have moved the envelope on; only a pending one becomes "sent".
  const at = new Date();
  await db.update(signatureEnvelopes).set({ providerRef, sentAt: at }).where(eq(signatureEnvelopes.id, prepared.envelopeId));
  await db.update(signatureEnvelopes).set({ status: "sent", statusChangedAt: at }).where(and(eq(signatureEnvelopes.id, prepared.envelopeId), eq(signatureEnvelopes.status, "pending_send")));
  // The COPS-03 send: marks the version sent (immutable from here), emits ContractSent, moves the commercial state.
  if (!prepared.version.sentAt) await sendContract(db, ctx, contractId);
  await writeCopsAudit(db, {
    tenantId: ctx.workspaceId,
    actor: { type: "user", id: ctx.userId },
    entityType: "signature_envelope",
    entityId: prepared.envelopeId,
    action: "envelope.sent",
    after: { contract_id: contractId, version: prepared.version.version, provider: adapter.provider, template: prepared.template?.key ?? null, signers: input.signers.length },
    correlationId: ctx.requestId,
    sourceChannel: "api",
    occurredAt: at,
  });
  return (await listEnvelopes(db, ctx.workspaceId, { id: prepared.envelopeId }))[0]!;
}

export type EsignWebhookResult =
  | { kind: "unauthorized" }
  | { kind: "bad_request" }
  | { kind: "duplicate" }
  | { kind: "processed"; outcome: "applied" | "no_change" | "ignored" | "unmatched"; status: EnvelopeStatus | null };

/**
 * Applies one provider event. `onSigned` runs in the same transaction as the contract becoming
 * signed (the route uses it to evaluate the provisioning gate), exactly once per contract.
 */
export async function handleEsignWebhook(
  db: Db,
  adapter: EsignAdapter,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  requestId: string,
  onSigned?: (tx: Tx, signed: { workspaceId: string; opportunityId: string; kind: string }) => Promise<void>
): Promise<EsignWebhookResult> {
  if (!adapter.verifyWebhook(rawBody, headers)) return { kind: "unauthorized" };
  const event = adapter.parseWebhook(rawBody, headers);
  if (!event) return { kind: "bad_request" };

  return db.transaction(async (tx) => {
    const byRef = event.providerRef
      ? await tx.select().from(signatureEnvelopes).where(and(eq(signatureEnvelopes.provider, adapter.provider), eq(signatureEnvelopes.providerRef, event.providerRef))).for("update").limit(1)
      : [];
    // The provider echoes our envelope id; it finds an envelope whose provider reference was never saved.
    const byId =
      byRef.length === 0 && event.referenceId && UUID.test(event.referenceId)
        ? await tx.select().from(signatureEnvelopes).where(and(eq(signatureEnvelopes.id, event.referenceId), eq(signatureEnvelopes.provider, adapter.provider))).for("update").limit(1)
        : [];
    const envelope = byRef[0] ?? byId[0];

    const [recorded] = await tx
      .insert(signatureEvents)
      .values({
        workspaceId: envelope?.workspaceId ?? null,
        envelopeId: envelope?.id ?? null,
        provider: adapter.provider,
        providerEventId: event.eventId,
        eventType: event.eventType,
        status: event.status,
        occurredAt: event.occurredAt,
        refs: event.refs,
        outcome: "received",
      })
      .onConflictDoNothing()
      .returning({ id: signatureEvents.id });
    if (!recorded) return { kind: "duplicate" as const };
    const finish = async (outcome: "applied" | "no_change" | "ignored" | "unmatched", status: EnvelopeStatus | null) => {
      await tx.update(signatureEvents).set({ outcome }).where(eq(signatureEvents.id, recorded.id));
      return { kind: "processed" as const, outcome, status };
    };
    // Kept either way: an event we cannot place is a reconciliation issue, not something to drop.
    if (!envelope) return finish("unmatched", null);
    if (!event.status) return finish("ignored", envelope.status as EnvelopeStatus);

    const at = new Date();
    const next = nextEnvelopeStatus(envelope.status as EnvelopeStatus, event.status);
    await tx
      .update(signatureEnvelopes)
      .set({ lastEventAt: at, ...(envelope.providerRef ? {} : { providerRef: event.providerRef }), ...(next ? { status: next, statusChangedAt: at } : {}) })
      .where(eq(signatureEnvelopes.id, envelope.id));
    if (!next) return finish("no_change", envelope.status as EnvelopeStatus);

    if (next === "signed" || next === "declined" || next === "expired") {
      const [contract] = await tx.select({ currentVersion: contracts.currentVersion }).from(contracts).where(eq(contracts.id, envelope.contractId)).limit(1);
      // An envelope for a version that has since been replaced says nothing about the contract now.
      if (contract?.currentVersion === envelope.contractVersion) {
        const ctx: CommercialContext = { workspaceId: envelope.workspaceId, userId: "", requestId };
        try {
          await setContractStatus(
            tx as unknown as Db,
            ctx,
            envelope.contractId,
            { status: next, reason: `${adapter.provider} reported the envelope ${next}`, signedAt: next === "signed" ? (event.occurredAt ?? at) : undefined },
            onSigned ? (innerTx, signed) => onSigned(innerTx as unknown as Tx, { workspaceId: envelope.workspaceId, ...signed }) : undefined,
            { type: "integration", id: adapter.provider }
          );
        } catch (error) {
          // The contract already left "sent" (set by hand, or an earlier terminal event). The envelope
          // keeps what the provider said; a disagreement shows up in reconciliation.
          if (!(error instanceof CommercialError && error.code === "BUSINESS_STATE_CONFLICT")) throw error;
        }
      }
    }
    return finish("applied", next);
  });
}
