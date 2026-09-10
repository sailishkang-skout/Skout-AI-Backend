import type { OpenSearchConfig } from "@skout/opensearch";
import type { Env } from "../config/env.js";

export function openSearchConfigFromEnv(env: Env): OpenSearchConfig | null {
  if (!env.OPENSEARCH_URL) return null;
  return {
    url: env.OPENSEARCH_URL,
    username: env.OPENSEARCH_USERNAME,
    password: env.OPENSEARCH_PASSWORD,
    index: env.OPENSEARCH_INDEX,
  };
}
