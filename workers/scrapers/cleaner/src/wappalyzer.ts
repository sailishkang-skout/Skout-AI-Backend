import type { TechStackEntry } from "@skout/scraper-contracts";

/**
 * Self-hosted technographics detection (strategy §3.2 / E2.1).
 * Pattern-matches common B2B SaaS fingerprints in HTML — Wappalyzer OSS rules
 * can replace/extend this table without changing the cleaner interface.
 */
const RULES: { category: TechStackEntry["category"]; technology: string; patterns: RegExp[] }[] = [
  { category: "crm", technology: "HubSpot", patterns: [/hubspot/i, /hs-scripts\.com/i, /hsforms\.net/i] },
  { category: "crm", technology: "Salesforce", patterns: [/salesforce/i, /force\.com/i] },
  { category: "crm", technology: "Intercom", patterns: [/intercomcdn\.com/i, /widget\.intercom\.io/i] },
  { category: "crm", technology: "Zendesk", patterns: [/zendesk/i, /zdassets\.com/i] },
  { category: "marketing_automation", technology: "Marketo", patterns: [/marketo/i, /mktoresp\.com/i] },
  { category: "marketing_automation", technology: "Mailchimp", patterns: [/mailchimp/i, /list-manage\.com/i] },
  { category: "marketing_automation", technology: "Drift", patterns: [/drift\.com/i, /js\.driftt\.com/i] },
  { category: "cms", technology: "WordPress", patterns: [/wp-content/i, /wordpress/i] },
  { category: "cms", technology: "Webflow", patterns: [/webflow/i] },
  { category: "cms", technology: "Shopify", patterns: [/shopify/i, /cdn\.shopify\.com/i] },
  { category: "cms", technology: "Contentful", patterns: [/contentful\.com/i] },
  { category: "analytics", technology: "Google Analytics", patterns: [/google-analytics\.com/i, /gtag\(/i, /G-[A-Z0-9]+/] },
  { category: "analytics", technology: "Segment", patterns: [/segment\.com/i, /cdn\.segment\.com/i] },
  { category: "analytics", technology: "Hotjar", patterns: [/hotjar\.com/i, /static\.hotjar\.com/i] },
  { category: "analytics", technology: "Mixpanel", patterns: [/mixpanel\.com/i] },
  { category: "payments", technology: "Stripe", patterns: [/js\.stripe\.com/i, /stripe\.com\/v3/i] },
  { category: "payments", technology: "PayPal", patterns: [/paypal\.com/i, /paypalobjects\.com/i] },
  { category: "cloud", technology: "AWS", patterns: [/amazonaws\.com/i] },
  { category: "cloud", technology: "Cloudflare", patterns: [/cloudflare/i, /cdnjs\.cloudflare\.com/i] },
  { category: "cloud", technology: "Vercel", patterns: [/vercel\.app/i, /_vercel/i] },
  { category: "other", technology: "React", patterns: [/react-dom/i, /__NEXT_DATA__/i] },
];

export interface DetectTechnologiesOptions {
  /** Skip first-party payment/CMS fingerprints (e.g. stripe.com → Stripe). */
  domain?: string;
}

function isFirstParty(rule: (typeof RULES)[number], domain?: string): boolean {
  if (!domain) return false;
  const brand = domain.split(".")[0]?.toLowerCase();
  if (!brand) return false;
  if (rule.technology.toLowerCase() === brand) return true;
  if (rule.category === "payments" && domain.includes("stripe") && rule.technology === "Stripe") return true;
  if (rule.category === "cms" && domain.includes("shopify") && rule.technology === "Shopify") return true;
  return false;
}

export function detectTechnologies(html: string, opts?: DetectTechnologiesOptions): TechStackEntry[] {
  const found: TechStackEntry[] = [];
  const seen = new Set<string>();
  for (const rule of RULES) {
    if (isFirstParty(rule, opts?.domain)) continue;
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
