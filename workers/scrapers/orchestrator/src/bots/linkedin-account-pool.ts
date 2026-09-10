import { Redis } from "ioredis";

export interface LinkedInAccount {
  id: string;
  cookie?: string;
  li_at?: string;
  userAgent?: string;
}

let redis: Redis | null = null;

function getRedis(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!redis) redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
  return redis;
}

export function parseLinkedInAccounts(): LinkedInAccount[] {
  const raw = process.env.LINKEDIN_ACCOUNTS_JSON;
  if (!raw || raw === "[]") return [];
  try {
    const parsed = JSON.parse(raw) as Array<Record<string, string>>;
    return parsed.map((a, i) => ({
      id: a.id ?? `acc-${i}`,
      cookie: a.cookie,
      li_at: a.li_at,
      userAgent: a.userAgent,
    }));
  } catch {
    return [];
  }
}

const HOURLY_CAP = Number(process.env.LINKEDIN_ACCOUNT_HOURLY_CAP ?? 40);

/** Round-robin account with per-account hourly cap (Redis token bucket). */
export async function acquireLinkedInAccount(): Promise<LinkedInAccount | null> {
  const accounts = parseLinkedInAccounts();
  if (accounts.length === 0) return null;

  const r = getRedis();
  const hour = Math.floor(Date.now() / 3_600_000);

  for (let i = 0; i < accounts.length; i++) {
    const idx = (hour + i) % accounts.length;
    const account = accounts[idx]!;
    if (!r) return account;

    try {
      if (r.status !== "ready") await r.connect().catch(() => undefined);
      const key = `scraper:linkedin:acc:${account.id}:${hour}`;
      const count = await r.incr(key);
      if (count === 1) await r.expire(key, 3700);
      if (count <= HOURLY_CAP) return account;
    } catch {
      return account;
    }
  }

  return null;
}
