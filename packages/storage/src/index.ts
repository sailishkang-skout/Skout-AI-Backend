import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

export type ScrapeZone = "raw" | "clean" | "quarantine" | "manifests";

export interface StorageConfig {
  bucket: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

export interface ScrapeStorageLike {
  putJson(key: string, data: unknown): Promise<string>;
  putJsonl(key: string, lines: unknown[]): Promise<string>;
  getText(key: string): Promise<string>;
  getJsonl<T = unknown>(key: string): Promise<T[]>;
}

/** S3 layout per scraping-platform-architecture.md */
export function scrapeKey(
  zone: ScrapeZone,
  source: string,
  jobId: string,
  filename = "records.jsonl"
): string {
  const date = new Date().toISOString().slice(0, 10);
  if (zone === "manifests") return `${zone}/${source}/${date}/${jobId}.json`;
  return `${zone}/${source}/${date}/${jobId}/${filename}`;
}

export class ScrapeStorage implements ScrapeStorageLike {
  private readonly client: S3Client;

  constructor(private readonly config: StorageConfig) {
    const opts: S3ClientConfig = {
      region: config.region ?? process.env.AWS_REGION ?? "us-east-1",
    };
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (accessKeyId && secretAccessKey) {
      opts.credentials = { accessKeyId, secretAccessKey };
    }
    if (config.endpoint) {
      opts.endpoint = config.endpoint;
      opts.forcePathStyle = config.forcePathStyle ?? true;
    }
    this.client = new S3Client(opts);
  }

  async putJson(key: string, data: unknown): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: JSON.stringify(data),
        ContentType: "application/json",
      })
    );
    return key;
  }

  async putJsonl(key: string, lines: unknown[]): Promise<string> {
    const body = lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : "");
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: "application/x-ndjson",
      })
    );
    return key;
  }

  async getText(key: string): Promise<string> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key })
    );
    return (await res.Body?.transformToString()) ?? "";
  }

  async getJsonl<T = unknown>(key: string): Promise<T[]> {
    const text = await this.getText(key);
    if (!text.trim()) return [];
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  }
}

/** Local filesystem fallback for dev when SCRAPE_BUCKET is unset. */
export class LocalScrapeStorage implements ScrapeStorageLike {
  constructor(private readonly rootDir: string) {}

  private resolve(key: string) {
    return path.join(this.rootDir, key);
  }

  async putJson(key: string, data: unknown): Promise<string> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data), "utf8");
    return key;
  }

  async putJsonl(key: string, lines: unknown[]): Promise<string> {
    const body = lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : "");
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, "utf8");
    return key;
  }

  async getText(key: string): Promise<string> {
    return readFile(this.resolve(key), "utf8");
  }

  async getJsonl<T = unknown>(key: string): Promise<T[]> {
    const text = await this.getText(key);
    if (!text.trim()) return [];
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  }
}

export function createScrapeStorage(bucket: string): ScrapeStorage {
  return new ScrapeStorage({
    bucket,
    region: process.env.AWS_REGION,
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  });
}

/** Monorepo root `.scrape-data` — shared by all scraper workers in local dev. */
export function defaultLocalScrapeDir(): string {
  if (process.env.SCRAPE_LOCAL_DIR) return process.env.SCRAPE_LOCAL_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "../../..");
  return path.join(repoRoot, ".scrape-data");
}

/** S3 when SCRAPE_BUCKET is set; otherwise repo-root `.scrape-data` (dev). */
export function resolveScrapeStorage(): ScrapeStorageLike {
  const bucket = process.env.SCRAPE_BUCKET;
  if (bucket) return createScrapeStorage(bucket);
  return new LocalScrapeStorage(defaultLocalScrapeDir());
}
