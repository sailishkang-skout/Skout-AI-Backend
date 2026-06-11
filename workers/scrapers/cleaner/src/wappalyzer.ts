import type { TechStackEntry } from "@skout/scraper-contracts";

/**
 * Self-hosted technographics detection (strategy §3.2 / E2.1).
 * Pattern-matches common B2B SaaS fingerprints in HTML — Wappalyzer OSS rules
 * can replace/extend this table without changing the cleaner interface.
 */
const RULES: { category: TechStackEntry["category"]; technology: string; patterns: RegExp[] }[] = [
  { category: "crm", technology: "HubSpot", patterns: [/hubspot/i, /hs-scripts\.com/i, /hsforms\.net/i] },
  { category: "crm", technology: "Salesforce", patterns: [/salesforce/i, /force\.com/i] },
  { category: "marketing_automation", technology: "Marketo", patterns: [/marketo/i, /mktoresp\.com/i] },
  { category: "marketing_automation", technology: "Mailchimp", patterns: [/mailchimp/i, /list-manage\.com/i] },
  { category: "cms", technology: "WordPress", patterns: [/wp-content/i, /wordpress/i] },
  { category: "cms", technology: "Webflow", patterns: [/webflow/i] },
  { category: "cms", technology: "Shopify", patterns: [/shopify/i, /cdn\.shopify\.com/i] },
  { category: "analytics", technology: "Google Analytics", patterns: [/google-analytics\.com/i, /gtag\(/i, /G-[A-Z0-9]+/] },
  { category: "analytics", technology: "Segment", patterns: [/segment\.com/i, /analytics\.js/i] },
  { category: "payments", technology: "Stripe", patterns: [/stripe\.com/i, /js\.stripe\.com/i] },
  { category: "cloud", technology: "AWS", patterns: [/amazonaws\.com/i] },
  { category: "cloud", technology: "Cloudflare", patterns: [/cloudflare/i] },
];

export function detectTechnologies(html: string): TechStackEntry[] {
  const found: TechStackEntry[] = [];
  const seen = new Set<string>();
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(html))) {
      const key = `${rule.category}:${rule.technology}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ category: rule.category, technology: rule.technology });
      }
    }
  }
  return found;
}
