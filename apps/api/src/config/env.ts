import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

const candidatePaths = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), ".env.local"),
  path.resolve(process.cwd(), "../.env"),
  path.resolve(process.cwd(), "../.env.local"),
  path.resolve(process.cwd(), "../../.env"),
  path.resolve(process.cwd(), "../../.env.local"),
];

for (const envPath of candidatePaths) {
  dotenv.config({ path: envPath });
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().default(3001),
    HOST: z.string().default("0.0.0.0"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    DATABASE_URL: z.string().url().optional(),
    DATABASE_HOST: z.string().optional(),
    DATABASE_PORT: z.coerce.number().optional(),
    DATABASE_NAME: z.string().default("skout"),
    DATABASE_USER: z.string().default("skout"),
    DATABASE_PASSWORD: z.string().optional(),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    CORS_ORIGIN: z
      .string()
      .default("http://localhost:3000")
      .transform((val) => val.split(",").map((s) => s.trim())),
    CLERK_SECRET_KEY: z.string().optional(),
    CLERK_PUBLISHABLE_KEY: z.string().optional(),
    EXPORTS_BUCKET: z.string().optional(),
    OPENSEARCH_URL: z.string().optional(),
    CLICKHOUSE_URL: z.string().optional(),
    AI_SERVICE_URL: z.string().optional(),
  })
  .transform((data) => {
    if (!data.DATABASE_URL && data.DATABASE_HOST && data.DATABASE_PASSWORD) {
      const port = data.DATABASE_PORT ?? 5432;
      return {
        ...data,
        DATABASE_URL: `postgresql://${data.DATABASE_USER}:${encodeURIComponent(data.DATABASE_PASSWORD)}@${data.DATABASE_HOST}:${port}/${data.DATABASE_NAME}`,
      };
    }
    return data;
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }
  return parsed.data;
}
