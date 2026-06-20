import { z } from "zod";

export const seniorityEnum = z.enum([
  "founder",
  "co_founder",
  "ceo",
  "c_level",
  "vp",
  "director",
  "head",
  "manager",
  "individual_contributor",
  "unknown",
]);

// ---------------------------------------------------------------------------
// Filter option constants — consumed by frontend dropdowns
// ---------------------------------------------------------------------------

export const INDUSTRIES = [
  "Software & SaaS",
  "FinTech",
  "Healthcare",
  "Retail & E-Commerce",
  "Manufacturing",
  "Financial Services",
  "Education",
  "Real Estate",
  "Logistics & Supply Chain",
  "Media & Entertainment",
  "Telecommunications",
  "Energy & Utilities",
  "Consulting & Professional Services",
  "Legal",
  "Insurance",
  "Aerospace & Defense",
  "Biotechnology & Pharma",
  "Agriculture",
  "Construction",
  "Government & Public Sector",
] as const;

export const COUNTRIES = [
  { label: "United States", value: "US" },
  { label: "United Kingdom", value: "GB" },
  { label: "Germany", value: "DE" },
  { label: "Canada", value: "CA" },
  { label: "Australia", value: "AU" },
  { label: "France", value: "FR" },
  { label: "India", value: "IN" },
  { label: "Singapore", value: "SG" },
  { label: "Netherlands", value: "NL" },
  { label: "United Arab Emirates", value: "AE" },
] as const;

export const SENIORITY_OPTIONS = [
  { label: "Founder", value: "founder" },
  { label: "Co-Founder", value: "co_founder" },
  { label: "CEO", value: "ceo" },
  { label: "C-Level", value: "c_level" },
  { label: "VP", value: "vp" },
  { label: "Director", value: "director" },
  { label: "Head", value: "head" },
  { label: "Manager", value: "manager" },
  { label: "Individual Contributor", value: "individual_contributor" },
] as const;

export const DEPARTMENTS = [
  "Sales",
  "Marketing",
  "Operations",
  "Engineering",
  "Product",
  "HR",
  "Finance",
  "Customer Success",
] as const;

export const JOB_FUNCTIONS = [
  "Demand Generation",
  "SDR",
  "AE",
  "RevOps",
  "Growth",
  "Product Marketing",
  "Recruiting",
  "Procurement",
] as const;

export const CONTACT_SIGNALS = [
  { label: "Recently Promoted", value: "recently_promoted" },
  { label: "Changed Jobs", value: "changed_jobs" },
  { label: "Posted on LinkedIn", value: "posted_on_linkedin" },
  { label: "Active on Social Media", value: "active_on_social_media" },
] as const;

export const COMPANY_SIZE_BUCKETS = [
  { label: "1–10",    value: "1-10",      min: 1,    max: 10   },
  { label: "11–50",   value: "11-50",     min: 11,   max: 50   },
  { label: "51–200",  value: "51-200",    min: 51,   max: 200  },
  { label: "201–500", value: "201-500",   min: 201,  max: 500  },
  { label: "501–1k",  value: "501-1000",  min: 501,  max: 1000 },
  { label: "1k+",     value: "1001+",     min: 1001, max: undefined },
] as const;

export type CompanySizeBucket = (typeof COMPANY_SIZE_BUCKETS)[number]["value"];

export const COMPANY_STAGES = [
  { label: "Bootstrapped", value: "bootstrapped" },
  { label: "Seed",         value: "seed"         },
  { label: "Series A",     value: "series_a"     },
  { label: "Series B",     value: "series_b"     },
  { label: "Series C+",    value: "series_c_plus"},
  { label: "Public",       value: "public"       },
] as const;

export const FUNDING_ROUNDS = [
  { label: "Pre-Seed",  value: "pre_seed"  },
  { label: "Seed",      value: "seed"      },
  { label: "Series A",  value: "series_a"  },
  { label: "Series B",  value: "series_b"  },
  { label: "Series C",  value: "series_c"  },
  { label: "Series D+", value: "series_d_plus" },
  { label: "IPO",       value: "ipo"       },
  { label: "Acquired",  value: "acquired"  },
] as const;

export const REVENUE_RANGES = [
  { label: "< $1M",       value: "lt_1m",       min: 0,          max: 1_000_000        },
  { label: "$1M–$10M",    value: "1m_10m",      min: 1_000_000,  max: 10_000_000       },
  { label: "$10M–$50M",   value: "10m_50m",     min: 10_000_000, max: 50_000_000       },
  { label: "$50M–$100M",  value: "50m_100m",    min: 50_000_000, max: 100_000_000      },
  { label: "$100M–$500M", value: "100m_500m",   min: 100_000_000,max: 500_000_000      },
  { label: "$500M+",      value: "gt_500m",     min: 500_000_000,max: undefined        },
] as const;

export const COMPANY_SIGNALS = [
  { label: "Recent Funding",              value: "recent_funding"           },
  { label: "Leadership Change",           value: "leadership_change"        },
  { label: "New Product Launch",          value: "new_product_launch"       },
  { label: "Recent Hiring",               value: "recent_hiring"            },
  { label: "Expansion into New Markets",  value: "expansion_new_markets"    },
  { label: "Website Changes",             value: "website_changes"          },
] as const;

export const HIRING_DEPARTMENTS = [
  "Sales",
  "Engineering",
  "Marketing",
  "Customer Success",
  "Product",
  "Operations",
  "Finance",
  "HR",
] as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const searchFiltersSchema = z.object({
  // Contact information
  fullName: z.string().optional(),
  jobTitle: z.string().optional(),
  department: z.string().optional(),
  seniority: seniorityEnum.optional(),
  jobFunction: z.string().optional(),
  emailAvailable: z.coerce.boolean().optional(),
  phoneAvailable: z.coerce.boolean().optional(),
  linkedInAvailable: z.coerce.boolean().optional(),

  // Company — basic
  companyName: z.string().optional(),
  industry: z.string().optional(),
  subIndustry: z.string().optional(),
  country: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  minEmployees: z.number().int().min(0).optional(),
  maxEmployees: z.number().int().min(0).optional(),

  // Company — stage & funding
  companyStage: z.string().optional(),
  lastFundingRound: z.string().optional(),
  minRevenue: z.number().min(0).optional(),
  maxRevenue: z.number().min(0).optional(),

  // Hiring signals
  currentlyHiring: z.coerce.boolean().optional(),
  hiringDepartments: z.array(z.string()).optional(),

  // Company intent signals (multi-select — OR logic)
  companySignals: z.array(z.string()).optional(),

  // Experience
  minYearsAtCompany: z.number().int().min(0).optional(),
  minYearsInRole: z.number().int().min(0).optional(),
  previousCompany: z.string().optional(),

  // Activity signals (multi-select — OR logic)
  contactSignals: z.array(z.string()).optional(),

  // Tech / intent signals (existing)
  tech: z.string().optional(),
  signal: z.string().optional(),
});

export const prospectSummarySchema = z.object({
  prospectId: z.string(),
  companyId: z.string(),
  fullName: z.string(),
  title: z.string(),
  seniority: seniorityEnum,
  country: z.string(),
  industry: z.string(),
  companyDomain: z.string(),
  employeeCount: z.number().optional(),
  updatedAt: z.string().datetime().optional(),
});

export const searchProspectsRequestSchema = z.object({
  query: z.string().optional(),
  filters: searchFiltersSchema.optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
});

export const searchProspectsResponseSchema = z.object({
  results: z.array(prospectSummarySchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  cached: z.boolean(),
});

export const workspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const createListSchema = z.object({
  name: z.string().min(1).max(255),
  prospectIds: z.array(z.string()).optional(),
});

export const enrollSequenceSchema = z.object({
  listId: z.string().uuid().optional(),
  prospectIds: z.array(z.string()).optional(),
});

export type ProspectSummary = z.infer<typeof prospectSummarySchema>;
export type SearchProspectsRequest = z.infer<typeof searchProspectsRequestSchema>;
export type SearchProspectsResponse = z.infer<typeof searchProspectsResponseSchema>;
export type SearchFiltersInput = z.infer<typeof searchFiltersSchema>;
export type Department = (typeof DEPARTMENTS)[number];
export type JobFunction = (typeof JOB_FUNCTIONS)[number];
export type ContactSignal = (typeof CONTACT_SIGNALS)[number]["value"];
export type CompanyStage = (typeof COMPANY_STAGES)[number]["value"];
export type FundingRound = (typeof FUNDING_ROUNDS)[number]["value"];
export type CompanySignal = (typeof COMPANY_SIGNALS)[number]["value"];
export type HiringDepartment = (typeof HIRING_DEPARTMENTS)[number];
export type Workspace = z.infer<typeof workspaceSchema>;
