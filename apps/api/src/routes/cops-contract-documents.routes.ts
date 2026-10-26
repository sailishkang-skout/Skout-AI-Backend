import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "@skout/db";
import { getMemberPermissions } from "@skout/auth";
import { copsErrorBody, copsErrorStatus, resolveCorrelationId } from "@skout/shared";
import { readDocument, storeDocument } from "@skout/storage";
import { requireAnyCopsPermission, writeCopsAudit } from "../services/cops-platform.service.js";

/** Contract files are PDFs up to 10 MB. Base64 adds a third, so the body limit is set above that. */
export const CONTRACT_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;

/**
 * Internal reference stored as a contract version's document_url. The e-sign service turns it into
 * the file itself when it sends an envelope, so the document never needs a public URL.
 */
export const CONTRACT_DOCUMENT_SCHEME = "cops-document:";
export const contractDocumentKey = (workspaceId: string, sha256: string) => `contracts/${workspaceId}/${sha256}.pdf`;
export const contractDocumentRef = (sha256: string) => `${CONTRACT_DOCUMENT_SCHEME}${sha256}`;

/** Reads a stored contract by its reference; null when the URL is not an internal one. */
export async function loadContractDocument(bucket: string | undefined, workspaceId: string, documentUrl: string): Promise<Uint8Array | null> {
  if (!documentUrl.startsWith(CONTRACT_DOCUMENT_SCHEME)) return null;
  const sha = documentUrl.slice(CONTRACT_DOCUMENT_SCHEME.length);
  if (!SHA.test(sha)) return null;
  return readDocument(bucket, contractDocumentKey(workspaceId, sha));
}

const uploadSchema = z
  .object({
    file_name: z.string().trim().min(1).max(300),
    content_base64: z.string().min(1),
  })
  .strict();

/**
 * POST /contracts/documents — upload a contract PDF; returns the document_url and file_sha256 that
 * POST /opportunities/:id/contracts expects. The hash is computed here, never trusted from the
 * client, and the file is stored under it, so the same PDF uploaded twice is one file.
 * GET /contracts/documents/:sha256 — download it again (commercial or legal read).
 */
export async function copsContractDocumentRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const perms = (ws: string, user: string) => getMemberPermissions(db, ws, user);
  const writeGate = requireAnyCopsPermission(["commercial:write", "commercial:send", "legal:write"], perms);
  const readGate = requireAnyCopsPermission(["commercial:read", "legal:read"], perms);
  const bucket = () => app.config.CONTRACTS_BUCKET ?? app.config.EXPORTS_BUCKET;

  app.post("/contracts/documents", { preHandler: writeGate, bodyLimit: Math.ceil(CONTRACT_DOCUMENT_MAX_BYTES * 1.4) }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const fail = (path: string, message: string) =>
      reply.status(copsErrorStatus("VALIDATION_FAILED")).send(copsErrorBody({ code: "VALIDATION_FAILED", message, requestId, details: { fields: [{ path, code: "invalid", message }] } }));
    const parsed = uploadSchema.safeParse(request.body ?? {});
    if (!parsed.success) return fail(parsed.error.issues[0]?.path.join(".") || "body", parsed.error.issues[0]?.message ?? "Invalid request");

    const bytes = Buffer.from(parsed.data.content_base64, "base64");
    if (bytes.length === 0) return fail("content_base64", "The file is empty");
    if (bytes.length > CONTRACT_DOCUMENT_MAX_BYTES) return fail("content_base64", "The file is larger than 10 MB");
    if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return fail("content_base64", "Only PDF files can be attached");

    // Production keeps contracts in object storage only; the local folder is a dev convenience.
    if (!bucket() && app.config.NODE_ENV === "production") {
      return reply
        .status(503)
        .send(copsErrorBody({ code: "PROVIDER_ERROR", message: "Contract storage is not configured (CONTRACTS_BUCKET)", requestId, details: {}, retryable: false }));
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const workspaceId = request.workspaceId!;
    await storeDocument(bucket(), contractDocumentKey(workspaceId, sha256), bytes, "application/pdf");
    await writeCopsAudit(db, {
      tenantId: workspaceId,
      actor: { type: "user", id: request.userId ?? null },
      entityType: "contract_document",
      // Audit ids are UUIDs; the document's id is its hash, shaped into a stable UUID.
      entityId: `${sha256.slice(0, 8)}-${sha256.slice(8, 12)}-4${sha256.slice(13, 16)}-8${sha256.slice(17, 20)}-${sha256.slice(20, 32)}`,
      action: "contract_document.uploaded",
      after: { file_sha256: sha256, file_name: parsed.data.file_name, bytes: bytes.length },
      correlationId: requestId,
      sourceChannel: "api",
    });
    return reply.status(201).send({
      data: { document_url: contractDocumentRef(sha256), file_sha256: sha256, file_name: parsed.data.file_name, bytes: bytes.length },
    });
  });

  app.get<{ Params: { sha256: string } }>("/contracts/documents/:sha256", { preHandler: readGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const sha = request.params.sha256;
    const notFound = () => reply.status(404).send(copsErrorBody({ code: "NOT_FOUND", message: "Document not found", requestId, details: {} }));
    if (!SHA.test(sha)) return notFound();
    let bytes: Uint8Array;
    try {
      bytes = await readDocument(bucket(), contractDocumentKey(request.workspaceId!, sha));
    } catch {
      return notFound();
    }
    return reply.header("content-type", "application/pdf").header("cache-control", "private, max-age=300").send(Buffer.from(bytes));
  });
}
