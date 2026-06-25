import { ProxyAgent, type Dispatcher } from "undici";

let cachedDispatcher: Dispatcher | undefined;

function proxyUrl(): string | undefined {
  const raw = process.env.PROXY_URL?.trim();
  if (!raw || raw === "replace-me") return undefined;
  const user = process.env.PROXY_USERNAME?.trim();
  const pass = process.env.PROXY_PASSWORD?.trim();
  if (user && pass && !raw.includes("@")) {
    const u = new URL(raw);
    u.username = user;
    u.password = pass;
    return u.toString();
  }
  return raw;
}

export function getProxyDispatcher(): Dispatcher | undefined {
  if (cachedDispatcher) return cachedDispatcher;
  const url = proxyUrl();
  if (!url) return undefined;
  cachedDispatcher = new ProxyAgent(url);
  return cachedDispatcher;
}

export interface FetchPageResult {
  html: string;
  status: number;
}

const DEFAULT_HEADERS = {
  "User-Agent": process.env.SCRAPER_USER_AGENT ?? "SkoutBot/1.0 (+https://skout.ai)",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
};

export async function fetchPage(
  url: string,
  init?: RequestInit & { headers?: Record<string, string> }
): Promise<FetchPageResult | null> {
  const dispatcher = getProxyDispatcher();
  const timeout = Number(process.env.SCRAPER_REQUEST_TIMEOUT_MS ?? 20_000);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...DEFAULT_HEADERS, ...init?.headers },
      signal: AbortSignal.timeout(timeout),
      redirect: "follow",
      // @ts-expect-error undici dispatcher
      dispatcher,
    });
    if (!res.ok) return null;
    return { html: await res.text(), status: res.status };
  } catch {
    return null;
  }
}

/** Optional Playwright render for JS-heavy pages (SCRAPER_USE_PLAYWRIGHT=true). */
export async function fetchPageWithPlaywright(url: string): Promise<string | null> {
  if (process.env.SCRAPER_USE_PLAYWRIGHT !== "true") return null;
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        userAgent: DEFAULT_HEADERS["User-Agent"],
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return await page.content();
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.warn("[scraper] Playwright fetch failed, falling back to HTTP:", err);
    return null;
  }
}

export async function fetchPageSmart(url: string): Promise<FetchPageResult | null> {
  const rendered = await fetchPageWithPlaywright(url);
  if (rendered) return { html: rendered, status: 200 };
  return fetchPage(url);
}
