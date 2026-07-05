import { CSV_EXPORT_PRESIGN_SECONDS, readCsvExport, storeCsvExport } from "@skout/storage";
import type { Env } from "../config/env.js";

export { CSV_EXPORT_PRESIGN_SECONDS };

export interface StoredExport {
  key: string;
  filename: string;
  inline: boolean;
  content?: string;
}

export async function storeListCsvExport(
  config: Env,
  workspaceId: string,
  listId: string,
  filename: string,
  content: string
): Promise<StoredExport> {
  return storeCsvExport(config.EXPORTS_BUCKET, workspaceId, listId, filename, content);
}

export async function readListCsvExport(config: Env, key: string): Promise<string> {
  const bucket = config.EXPORTS_BUCKET;
  if (!bucket) throw new Error("exports_bucket_not_configured");
  return readCsvExport(bucket, key);
}
