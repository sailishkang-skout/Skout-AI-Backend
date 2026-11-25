/**
 * The product app's public base, always ending in "/app" (Next.js basePath). Accepts a base given
 * with or without the "/app" suffix, so FRONTEND_URL=https://www.skoutai.io/app and
 * FRONTEND_URL=https://www.skoutai.io both give https://www.skoutai.io/app.
 */
export function productAppUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return /\/app$/.test(trimmed) ? trimmed : `${trimmed}/app`;
}
