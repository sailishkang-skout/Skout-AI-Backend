import type { FastifyInstance } from "fastify";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Db } from "@skout/db";
import { getMemberPermissions } from "@skout/auth";
import { copsErrorBody, copsErrorStatus, resolveCorrelationId } from "@skout/shared";
import { inspectDocument, presignDocumentGet, presignDocumentPut, readLocalDocument, writeLocalDocument } from "@skout/storage";
import type { Env } from "../config/env.js";
import { requireAnyCopsPermission, writeCopsAudit } from "../services/cops-platform.service.js";

/**
 * Contract PDFs (Bible p.32, p.77). The browser uploads straight to object storage with a presigned
 * URL and opens files the same way, so file bytes never pass through the API.
 *
 *   POST /contracts/documents/uploads      { file_name, file_sha256, bytes } -> presigned PUT
 *   POST /contracts/documents/:sha/confirm { file_name } -> checks the stored file, returns document_url
 *   GET  /contracts/documents/:sha         -> presigned GET (5 minutes)
 *
 * The PUT is signed with the file's SHA-256, so storage refuses any other body: the hash the
 * contract records is the hash of the stored file. Files are keyed by workspace and hash, so the
 * same PDF uploaded twice is one object.
 *
 * Without a bucket (local dev only) the API hands out its own short-lived signed URLs under
 * /contracts/documents/local/ and keeps files in a local folder. Production refuses instead.
 */
export const CONTRACT_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const UPLOAD_TTL_SECONDS = 15 * 60;
const VIEW_TTL_SECONDS = 5 * 60;
/** Long enough for the e-sign provider to fetch the file while it creates the envelope. */
const PROVIDER_TTL_SECONDS = 60 * 60;

export const CONTRACT_DOCUMENT_SCHEME = "cops-document:";
export const contractDocumentKey = (workspaceId: string, sha256: string) => `contracts/${workspaceId}/${sha256}.pdf`;
export const contractDocumentRef = (sha256: string) => `${CONTRACT_DOCUMENT_SCHEME}${sha256}`;
const contractsBucket = (config: Env) => config.CONTRACTS_BUCKET ?? config.EXPORTS_BUCKET;

// ---- Local dev signing (no bucket). A per-process key: URLs stop working when the API restarts. ----
const LOCAL_KEY = randomBytes(32);
const localSig = (method: string, workspaceId: string, sha: string, exp: number) =>
  createHmac("sha256", LOCAL_KEY).update(`${method}\n${workspaceId}\n${sha}\n${exp}`).digest("hex");
function localUrl(method: "PUT" | "GET", workspaceId: string, sha: string, ttl: number) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  return `/api/v1/contracts/documents/local/${sha}?ws=${workspaceId}&exp=${exp}&sig=${localSig(method, workspaceId, sha, exp)}`;
}
function localSigValid(method: string, q: { ws?: string; exp?: string; sig?: string }, sha: string) {
  const exp = Number(q.exp);
  if (!q.ws || !q.sig || !Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const want = Buffer.from(localSig(method, q.ws, sha, exp), "hex");
  const got = Buffer.from(q.sig, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * What the e-sign provider is given for a contract version: a presigned GET it downloads the file
 * from (never the file itself). Plain URLs pass through unchanged.
 */
export async function resolveContractDocumentForProvider(config: Env, workspaceId: string, documentUrl: string): Promise<string> {
  if (!documentUrl.startsWith(CONTRACT_DOCUMENT_SCHEME)) return documentUrl;
  const sha = documentUrl.slice(CONTRACT_DOCUMENT_SCHEME.length);
  if (!SHA.test(sha)) return documentUrl;
  const bucket = contractsBucket(config);
  if (bucket) return presignDocumentGet(bucket, contractDocumentKey(workspaceId, sha), { expiresIn: PROVIDER_TTL_SECONDS });
  // Local dev: the API's own signed link, absolute so a provider (or the mock) can follow it.
  return `${(config.API_PUBLIC_URL ?? "http://localhost:3001").replace(/\/$/, "")}${localUrl("GET", workspaceId, sha, PROVIDER_TTL_SECONDS)}`;
}

const uploadSchema = z
  .object({
    file_name: z.string().trim().min(1).max(300),
    file_sha256: z.string().regex(SHA, "file_sha256 must be a lowercase hex SHA-256"),
    bytes: z.number().int().positive().max(CONTRACT_DOCUMENT_MAX_BYTES, "The file is larger than 10 MB"),
  })
  .strict();
const confirmSchema = z.object({ file_name: z.string().trim().min(1).max(300) }).strict();

export async function copsContractDocumentRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const perms = (ws: string, user: string) => getMemberPermissions(db, ws, user);
  const writeGate = requireAnyCopsPermission(["commercial:write", "commercial:send", "legal:write"], perms);
  const readGate = requireAnyCopsPermission(["commercial:read", "legal:read"], perms);
  const bucket = () => contractsBucket(app.config);
  const localAllowed = () => app.config.NODE_ENV !== "production";

  type Reply = { status: (code: number) => { send: (body: unknown) => unknown } };
  const fail = (reply: Reply, requestId: string, path: string, message: string) =>
    reply.status(copsErrorStatus("VALIDATION_FAILED")).send(copsErrorBody({ code: "VALIDATION_FAILED", message, requestId, details: { fields: [{ path, code: "invalid", message }] } }));
  const noStorage = (reply: Reply, requestId: string) =>
    reply.status(503).send(copsErrorBody({ code: "PROVIDER_ERROR", message: "Contract storage is not configured (CONTRACTS_BUCKET)", requestId, details: {}, retryable: false }));

  app.post("/contracts/documents/uploads", { preHandler: writeGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const parsed = uploadSchema.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, requestId, parsed.error.issues[0]?.path.join(".") || "body", parsed.error.issues[0]?.message ?? "Invalid request");
    const { file_sha256: sha, bytes } = parsed.data;
    const workspaceId = request.workspaceId!;
    const b = bucket();
    if (!b && !localAllowed()) return noStorage(reply, requestId);
    const upload = b
      ? { method: "PUT" as const, ...(await presignDocumentPut(b, contractDocumentKey(workspaceId, sha), { sha256Hex: sha, bytes, contentType: "application/pdf", expiresIn: UPLOAD_TTL_SECONDS })) }
      : { method: "PUT" as const, url: localUrl("PUT", workspaceId, sha, UPLOAD_TTL_SECONDS), headers: { "Content-Type": "application/pdf" } };
    return reply.status(201).send({
      data: { upload, document_url: contractDocumentRef(sha), file_sha256: sha, expires_at: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString() },
    });
  });

  app.post<{ Params: { sha256: string } }>("/contracts/documents/:sha256/confirm", { preHandler: writeGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const sha = request.params.sha256;
    if (!SHA.test(sha)) return fail(reply, requestId, "sha256", "Invalid file hash");
    const parsed = confirmSchema.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, requestId, "file_name", parsed.error.issues[0]?.message ?? "file_name is required");
    const workspaceId = request.workspaceId!;
    const key = contractDocumentKey(workspaceId, sha);
    const b = bucket();
    if (!b && !localAllowed()) return noStorage(reply, requestId);

    let stored: { bytes: number; head: Uint8Array } | null;
    if (b) stored = await inspectDocument(b, key);
    else {
      const file = await readLocalDocument(key);
      stored = file ? { bytes: file.length, head: file.subarray(0, 8) } : null;
    }
    if (!stored) return fail(reply, requestId, "sha256", "The file has not been uploaded yet");
    if (stored.bytes > CONTRACT_DOCUMENT_MAX_BYTES) return fail(reply, requestId, "sha256", "The file is larger than 10 MB");
    if (Buffer.from(stored.head).subarray(0, 5).toString("latin1") !== "%PDF-") return fail(reply, requestId, "sha256", "Only PDF files can be attached");

    await writeCopsAudit(db, {
      tenantId: workspaceId,
      actor: { type: "user", id: request.userId ?? null },
      entityType: "contract_document",
      // Audit ids are UUIDs; the document's id is its hash, shaped into a stable UUID.
      entityId: `${sha.slice(0, 8)}-${sha.slice(8, 12)}-4${sha.slice(13, 16)}-8${sha.slice(17, 20)}-${sha.slice(20, 32)}`,
      action: "contract_document.uploaded",
      after: { file_sha256: sha, file_name: parsed.data.file_name, bytes: stored.bytes },
      correlationId: requestId,
      sourceChannel: "api",
    });
    return { data: { document_url: contractDocumentRef(sha), file_sha256: sha, file_name: parsed.data.file_name, bytes: stored.bytes } };
  });

  app.get<{ Params: { sha256: string } }>("/contracts/documents/:sha256", { preHandler: readGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const sha = request.params.sha256;
    const notFound = () => reply.status(404).send(copsErrorBody({ code: "NOT_FOUND", message: "Document not found", requestId, details: {} }));
    if (!SHA.test(sha)) return notFound();
    const workspaceId = request.workspaceId!;
    const key = contractDocumentKey(workspaceId, sha);
    const b = bucket();
    if (!b && !localAllowed()) return noStorage(reply, requestId);
    if (b ? !(await inspectDocument(b, key)) : !(await readLocalDocument(key))) return notFound();
    const url = b ? await presignDocumentGet(b, key, { expiresIn: VIEW_TTL_SECONDS, fileName: `${sha.slice(0, 12)}.pdf` }) : localUrl("GET", workspaceId, sha, VIEW_TTL_SECONDS);
    return { data: { url, expires_at: new Date(Date.now() + VIEW_TTL_SECONDS * 1000).toISOString() } };
  });
}

/**
 * Local dev stand-in for presigned URLs. Public in the auth plugin; each request carries the HMAC
 * the API issued above. Not registered in production.
 */
export async function copsContractDocumentLocalRoutes(app: FastifyInstance) {
  if (app.config.NODE_ENV === "production") return;
  app.addContentTypeParser("application/pdf", { parseAs: "buffer", bodyLimit: CONTRACT_DOCUMENT_MAX_BYTES }, (_req, body, done) => done(null, body));
  type Local = { Params: { sha256: string }; Querystring: { ws?: string; exp?: string; sig?: string } };

  app.put<Local>("/contracts/documents/local/:sha256", async (request, reply) => {
    const sha = request.params.sha256;
    if (!SHA.test(sha) || !localSigValid("PUT", request.query, sha)) return reply.status(403).send({ error: "Invalid or expired upload URL" });
    const body = request.body as Buffer | undefined;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.status(400).send({ error: "Empty body" });
    // Same guarantee storage gives with the signed checksum: the body must be the file that was hashed.
    if (createHash("sha256").update(body).digest("hex") !== sha) return reply.status(400).send({ error: "The file does not match its SHA-256" });
    await writeLocalDocument(contractDocumentKey(request.query.ws!, sha), body);
    return reply.status(200).send();
  });

  app.get<Local>("/contracts/documents/local/:sha256", async (request, reply) => {
    const sha = request.params.sha256;
    if (!SHA.test(sha) || !localSigValid("GET", request.query, sha)) return reply.status(403).send({ error: "Invalid or expired link" });
    const file = await readLocalDocument(contractDocumentKey(request.query.ws!, sha));
    if (!file) return reply.status(404).send({ error: "Not found" });
    return reply.header("content-type", "application/pdf").header("content-disposition", "inline").send(Buffer.from(file));
  });
}
