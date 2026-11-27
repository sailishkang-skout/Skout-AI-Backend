import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform, finished, pipeline, type Readable } from "node:stream";
import { pipeline as pipelineDone } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { deleteDocument, getObjectStream, putObjectFromFile } from "@skout/storage";
import type { Env } from "../config/env.js";

/**
 * Where CSV imports keep files (WB2-020): the uploaded file until the import finishes, and the skipped-rows report.
 * Object storage (the exports bucket, which already expires objects after 30 days) when one is configured, otherwise a
 * local folder outside production. Keys are built here from ids and never come from a request.
 */
export interface ImportStorage {
  put(key: string, filePath: string): Promise<void>;
  /** Null when the object is not there. */
  open(key: string): Promise<Readable | null>;
  /** Removing an object that is not there is not an error. */
  remove(key: string): Promise<void>;
}

export const uploadKey = (workspaceId: string, importId: string) => `workbook-imports/${workspaceId}/${importId}/upload.csv`;
export const reportKey = (workspaceId: string, importId: string) => `workbook-imports/${workspaceId}/${importId}/report.csv`;

/** Repo-root `.workbook-imports` in local development. */
export function localImportDir(): string {
  if (process.env.WORKBOOK_IMPORTS_LOCAL_DIR) return process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..", ".workbook-imports");
}

function localStorage(root: string): ImportStorage {
  const at = (key: string) => path.join(root, key);
  return {
    async put(key, filePath) {
      await mkdir(path.dirname(at(key)), { recursive: true, mode: 0o700 });
      await copyFile(filePath, at(key));
    },
    async open(key) {
      try {
        await stat(at(key));
      } catch {
        return null;
      }
      return createReadStream(at(key));
    },
    async remove(key) {
      await rm(at(key), { force: true });
    },
  };
}

function bucketStorage(bucket: string): ImportStorage {
  return {
    put: (key, filePath) => putObjectFromFile(bucket, key, filePath, "text/csv; charset=utf-8"),
    open: (key) => getObjectStream(bucket, key),
    remove: (key) => deleteDocument(bucket, key),
  };
}

/** Null when files cannot be kept: production without a bucket. */
export function importStorage(config: Env): ImportStorage | null {
  if (config.EXPORTS_BUCKET) return bucketStorage(config.EXPORTS_BUCKET);
  return config.NODE_ENV === "production" ? null : localStorage(localImportDir());
}

// ── Temporary files ──────────────────────────────────────────────────────────

export const importTempDir = () => path.join(os.tmpdir(), "skout-workbook-imports");

/** A private temporary file that is removed when `run` ends, however it ends. */
export async function withTempFile<T>(run: (file: string) => Promise<T>): Promise<T> {
  await mkdir(importTempDir(), { recursive: true, mode: 0o700 });
  const file = path.join(importTempDir(), randomUUID());
  try {
    return await run(file);
  } finally {
    await rm(file, { force: true });
  }
}

/** Temporary files left behind by a process that died. */
export async function removeStaleTempFiles(olderThanMs: number): Promise<number> {
  const names = await readdir(importTempDir()).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    const file = path.join(importTempDir(), name);
    const info = await stat(file).catch(() => null);
    if (!info || Date.now() - info.mtimeMs < olderThanMs) continue;
    await rm(file, { force: true });
    removed += 1;
  }
  return removed;
}

export class UploadTooLarge extends Error {
  constructor() {
    super("upload too large");
    this.name = "UploadTooLarge";
  }
}

/**
 * Writes a request body to `file`, stopping at `maxBytes`. The body is not destroyed when it is too large: the rest is
 * read and thrown away, so the connection stays up long enough for the refusal to reach the sender.
 */
export function receiveUpload(body: Readable, file: string, maxBytes: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > maxBytes) done(new UploadTooLarge());
        else done(null, chunk);
      },
    });
    pipeline(limit, createWriteStream(file, { flags: "wx", mode: 0o600 }), (error) => {
      if (!error) return resolve(bytes);
      body.unpipe(limit);
      body.resume();
      reject(error);
    });
    // A sender that disconnects part-way must not leave a half file looking complete.
    finished(body, (error) => {
      if (error) limit.destroy(error);
    });
    body.pipe(limit);
  });
}

export const saveStream = (stream: Readable, file: string) => pipelineDone(stream, createWriteStream(file, { flags: "w", mode: 0o600 }));
