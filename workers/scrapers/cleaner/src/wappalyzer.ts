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
  { category: "crm", technology: "Pipedrive", patterns: [/pipedrive/i] },
  { category: "crm", technology: "Freshsales", patterns: [/freshsales/i, /freshworks/i] },
  { category: "marketing_automation", technology: "Pardot", patterns: [/pardot/i, /pi\.pardot\.com/i] },
  { category: "marketing_automation", technology: "ActiveCampaign", patterns: [/activecampaign/i] },
  { category: "marketing_automation", technology: "Klaviyo", patterns: [/klaviyo/i] },
  { category: "analytics", technology: "Amplitude", patterns: [/amplitude\.com/i] },
  { category: "analytics", technology: "Heap", patterns: [/heap-analytics/i, /heapanalytics/i] },
  { category: "analytics", technology: "FullStory", patterns: [/fullstory/i] },
  { category: "analytics", technology: "Plausible", patterns: [/plausible\.io/i] },
  { category: "cms", technology: "Squarespace", patterns: [/squarespace/i, /static\.squarespace/i] },
  { category: "cms", technology: "Wix", patterns: [/wix\.com/i, /parastorage/i] },
  { category: "cms", technology: "Ghost", patterns: [/ghost\.org/i, /ghost-sdk/i] },
  { category: "cloud", technology: "Google Cloud", patterns: [/googleapis\.com/i, /gstatic\.com/i] },
  { category: "cloud", technology: "Azure", patterns: [/azureedge\.net/i, /azure\.com/i] },
  { category: "payments", technology: "Square", patterns: [/squareup\.com/i, /squarecdn/i] },
  { category: "payments", technology: "Braintree", patterns: [/braintreegateway/i] },
  { category: "other", technology: "Vue.js", patterns: [/vue\.js/i, /__vue__/i] },
  { category: "other", technology: "Angular", patterns: [/angular\.js/i, /ng-version/i] },
  { category: "other", technology: "Sentry", patterns: [/sentry\.io/i, /browser\.sentry-cdn/i] },
  { category: "other", technology: "Datadog RUM", patterns: [/datadoghq-browser-agent/i] },
  { category: "other", technology: "LaunchDarkly", patterns: [/launchdarkly/i] },
  { category: "other", technology: "Optimizely", patterns: [/optimizely/i] },
  { category: "other", technology: "Algolia", patterns: [/algolia/i, /algolianet/i] },
  { category: "other", technology: "Twilio", patterns: [/twilio/i] },
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
