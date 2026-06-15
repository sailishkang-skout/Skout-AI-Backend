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

export class ScrapeStorage {
  private readonly client: S3Client;

  constructor(private readonly config: StorageConfig) {
    const opts: S3ClientConfig = { region: config.region ?? process.env.AWS_REGION ?? "us-east-1" };
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

export function createScrapeStorage(bucket: string): ScrapeStorage {
  return new ScrapeStorage({
    bucket,
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  });
}
