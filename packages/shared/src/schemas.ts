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
  companyDomain: z.string().optional(),
  keyword: z.string().optional(),
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
  minTotalYearsExperience: z.number().int().min(0).optional(),
  previousCompany: z.string().optional(),

  // Company attributes
  minFoundedYear: z.number().int().min(1800).max(2100).optional(),
  maxFoundedYear: z.number().int().min(1800).max(2100).optional(),
  minHeadcountGrowth: z.number().optional(),
  companyEmailProvider: z.string().optional(),

  // Intent & deduplication
  minIntentScore: z.number().int().min(0).max(100).optional(),
  excludeDuplicates: z.coerce.boolean().optional(),
  maxPerCompany: z.number().int().min(1).max(10).optional(),

  // Activity signals (multi-select — OR logic)
  contactSignals: z.array(z.string()).optional(),

  // Tech / intent signals (existing)
  tech: z.string().optional(),
  signal: z.string().optional(),
});

export const prospectSignalSchema = z.object({
  type: z.string(),
  observedAt: z.string(),
  detail: z.string().optional(),
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
  companyName: z.string().optional(),
  recordType: z.enum(["person", "company"]).optional(),
  employeeCount: z.number().optional(),
  icpScore: z.number().int().min(0).max(100).optional(),
  intentScore: z.number().int().min(0).max(100).optional(),
  painPoints: z.array(z.string()).optional(),
  outreachReadiness: z.string().optional(),
  signals: z.array(prospectSignalSchema).optional(),
  techStack: z
    .array(z.object({ category: z.string(), technology: z.string() }))
    .optional(),
  updatedAt: z.string().optional(),
});

/** Full corpus document shape for GET /search/prospects/:id */
export const prospectDetailSchema = prospectSummarySchema.extend({
  email: z.string().optional(),
  phone: z.string().optional(),
  linkedinUrl: z.string().optional(),
  department: z.string().optional(),
  jobFunction: z.string().optional(),
  subIndustry: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  employeeBucket: z.string().optional(),
  companyStage: z.string().optional(),
  annualRevenue: z.number().optional(),
  lastFundingRound: z.string().optional(),
  lastFundingDate: z.string().optional(),
  totalFunding: z.number().optional(),
  currentlyHiring: z.boolean().optional(),
  foundedYear: z.number().int().optional(),
  headcountGrowth: z.number().optional(),
  companyEmailProvider: z.string().optional(),
  yearsAtCompany: z.number().optional(),
  yearsInRole: z.number().optional(),
  totalYearsExperience: z.number().optional(),
  previousCompany: z.string().optional(),
  painPointsRationale: z.string().optional(),
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
  creditsUsed: z.number().int().min(0).optional(),
  source: z.enum(["opensearch", "demo"]).optional(),
});

// ---------------------------------------------------------------------------
// Pain-point enum — shared between LLM prompt, DB, and the prospect detail UI
// ---------------------------------------------------------------------------

export const PAIN_POINT_TYPES = [
  "scaling",
  "hiring",
  "tooling",
  "technical_debt",
  "data_quality",
  "compliance",
  "cost_reduction",
  "integration",
  "customer_retention",
  "pipeline",
  "reporting",
  "onboarding",
] as const;

export type PainPointType = (typeof PAIN_POINT_TYPES)[number];

export const painPointSchema = z.enum(PAIN_POINT_TYPES);

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

export const enrollSequenceSchema = z
  .object({
    listId: z.string().uuid().optional(),
    prospectIds: z.array(z.string().min(1)).min(1).optional(),
  })
  .refine((d) => d.listId !== undefined || (d.prospectIds?.length ?? 0) > 0, {
    message: "listId or prospectIds (non-empty) is required",
  });

export const SEQUENCE_STEP_TYPES = ["email", "linkedin", "wait", "task"] as const;
export const SEQUENCE_STATUSES = ["draft", "active", "paused", "archived"] as const;

export const SEQUENCE_MERGE_TOKENS = [
  "firstName", "lastName", "fullName", "companyName", "companyDomain",
  "title", "senderName", "senderEmail", "unsubscribeUrl",
] as const;

export const createSequenceSchema = z.object({
  name: z.string().min(1).max(255),
});

export const updateSequenceSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    status: z.enum(SEQUENCE_STATUSES).optional(),
  })
  .refine((d) => d.name !== undefined || d.status !== undefined, {
    message: "At least one of name or status is required",
  });

export const SEQUENCE_DELAY_UNITS = ["minutes", "hours", "days", "weeks"] as const;

export const createSequenceStepSchema = z.object({
  stepType: z.enum(SEQUENCE_STEP_TYPES),
  delayDays: z.number().int().min(0).default(0),
  delayUnit: z.enum(SEQUENCE_DELAY_UNITS).default("days"),
  linkedinAction: z.enum(["connect", "message"]).optional(),
  subject: z.string().max(500).optional(),
  bodyTemplate: z.string().optional(),
});

export const updateSequenceStepSchema = z
  .object({
    stepType: z.enum(SEQUENCE_STEP_TYPES).optional(),
    delayDays: z.number().int().min(0).optional(),
    delayUnit: z.enum(SEQUENCE_DELAY_UNITS).optional(),
    linkedinAction: z.enum(["connect", "message"]).nullable().optional(),
    subject: z.string().max(500).nullable().optional(),
    bodyTemplate: z.string().nullable().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one field is required",
  });

export const reorderSequenceStepsSchema = z.object({
  stepIds: z.array(z.string().uuid()).min(1),
});

export type SequenceStepType = (typeof SEQUENCE_STEP_TYPES)[number];
export type SequenceDelayUnit = (typeof SEQUENCE_DELAY_UNITS)[number];
export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number];
export type CreateSequenceInput = z.infer<typeof createSequenceSchema>;
export type UpdateSequenceInput = z.infer<typeof updateSequenceSchema>;
export type CreateSequenceStepInput = z.infer<typeof createSequenceStepSchema>;
export type UpdateSequenceStepInput = z.infer<typeof updateSequenceStepSchema>;

// --- CRM (native companies/contacts/deals/pipelines/tasks/activities) ---

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const companyListQuerySchema = paginationQuerySchema.extend({
  ownerId: z.string().uuid().optional(),
});

export const contactListQuerySchema = paginationQuerySchema.extend({
  companyId: z.string().uuid().optional(),
});

export const dealListQuerySchema = paginationQuerySchema.extend({
  stageId: z.string().uuid().optional(),
  status: z.enum(["open", "won", "lost"]).optional(),
  ownerId: z.string().uuid().optional(),
});

export const taskListQuerySchema = paginationQuerySchema.extend({
  assignedTo: z.string().uuid().optional(),
  status: z.enum(["open", "done"]).optional(),
  relatedEntityType: z.enum(["contact", "company", "deal"]).optional(),
  relatedEntityId: z.string().uuid().optional(),
});

export const activityListQuerySchema = paginationQuerySchema.extend({
  entityType: z.enum(["contact", "company", "deal"]),
  entityId: z.string().uuid(),
});

export const COMPANY_STATUSES = ["active", "customer", "churned"] as const;
export const CONTACT_LIFECYCLE_STAGES = ["lead", "mql", "sql", "customer"] as const;
export const DEAL_STATUSES = ["open", "won", "lost"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high"] as const;
export const TASK_STATUSES = ["open", "done"] as const;
export const CRM_ENTITY_TYPES = ["contact", "company", "deal"] as const;
export const ACTIVITY_TYPES = ["note", "call", "email", "meeting", "stage_change"] as const;

export const companyCreateSchema = z.object({
  name: z.string().min(1).max(255),
  domain: z.string().max(255).optional(),
  industry: z.string().max(255).optional(),
  employeeCount: z.number().int().min(0).optional(),
  revenue: z.number().min(0).optional(),
  location: z.string().max(255).optional(),
  ownerId: z.string().uuid().optional(),
  status: z.enum(COMPANY_STATUSES).default("active"),
  sourceProspectCompanyId: z.string().optional(),
});

export const companyUpdateSchema = companyCreateSchema
  .partial()
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one field is required",
  });

export const companyResponseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  employeeCount: z.number().nullable(),
  revenue: z.number().nullable(),
  location: z.string().nullable(),
  ownerId: z.string().uuid().nullable(),
  status: z.enum(COMPANY_STATUSES),
  sourceProspectCompanyId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const contactCreateSchema = z.object({
  firstName: z.string().min(1).max(255),
  lastName: z.string().max(255).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  title: z.string().max(255).optional(),
  linkedinUrl: z.string().url().optional(),
  companyId: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional(),
  lifecycleStage: z.enum(CONTACT_LIFECYCLE_STAGES).default("lead"),
  sourceProspectId: z.string().optional(),
});

export const contactUpdateSchema = contactCreateSchema
  .partial()
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one field is required",
  });

export const contactResponseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  companyId: z.string().uuid().nullable(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  title: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  ownerId: z.string().uuid().nullable(),
  lifecycleStage: z.enum(CONTACT_LIFECYCLE_STAGES),
  sourceProspectId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const pipelineCreateSchema = z.object({
  name: z.string().min(1).max(255),
});

export const pipelineStageCreateSchema = z.object({
  name: z.string().min(1).max(255),
  orderIndex: z.number().int().min(0),
  probability: z.number().int().min(0).max(100).default(0),
  isClosedWon: z.boolean().default(false),
  isClosedLost: z.boolean().default(false),
});

export const pipelineStageResponseSchema = z.object({
  id: z.string().uuid(),
  pipelineId: z.string().uuid(),
  name: z.string(),
  orderIndex: z.number(),
  probability: z.number(),
  isClosedWon: z.boolean(),
  isClosedLost: z.boolean(),
});

export const pipelineResponseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  isDefault: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  stages: z.array(pipelineStageResponseSchema),
});

export const dealCreateSchema = z.object({
  name: z.string().min(1).max(255),
  companyId: z.string().uuid(),
  pipelineId: z.string().uuid().optional(),
  stageId: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional(),
  amount: z.number().min(0).optional(),
  currency: z.string().length(3).default("USD"),
  closeDate: z.string().date().optional(),
  probability: z.number().int().min(0).max(100).optional(),
});

export const dealUpdateSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    companyId: z.string().uuid().optional(),
    pipelineId: z.string().uuid().optional(),
    stageId: z.string().uuid().optional(),
    ownerId: z.string().uuid().optional(),
    amount: z.number().min(0).optional(),
    currency: z.string().length(3).optional(),
    closeDate: z.string().date().optional(),
    probability: z.number().int().min(0).max(100).optional(),
    status: z.enum(DEAL_STATUSES).optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one field is required",
  });

export const dealResponseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  companyId: z.string().uuid().nullable(),
  pipelineId: z.string().uuid(),
  stageId: z.string().uuid(),
  ownerId: z.string().uuid().nullable(),
  name: z.string(),
  amount: z.number().nullable(),
  currency: z.string(),
  closeDate: z.string().nullable(),
  probability: z.number().nullable(),
  status: z.enum(DEAL_STATUSES),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const dealsSummaryResponseSchema = z.object({
  workspaceId: z.string().uuid(),
  openDeals: z.number(),
  pipelineValue: z.number(),
  currency: z.string(),
  stages: z.array(
    z.object({
      stageId: z.string().uuid(),
      name: z.string(),
      count: z.number(),
      value: z.number(),
    })
  ),
});

export const taskCreateSchema = z.object({
  title: z.string().min(1).max(255),
  assignedTo: z.string().uuid().optional(),
  relatedEntityType: z.enum(CRM_ENTITY_TYPES).optional(),
  relatedEntityId: z.string().uuid().optional(),
  dueDate: z.string().datetime().optional(),
  priority: z.enum(TASK_PRIORITIES).default("medium"),
});

export const taskUpdateSchema = z
  .object({
    title: z.string().min(1).max(255).optional(),
    assignedTo: z.string().uuid().optional(),
    relatedEntityType: z.enum(CRM_ENTITY_TYPES).optional(),
    relatedEntityId: z.string().uuid().optional(),
    dueDate: z.string().datetime().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    status: z.enum(TASK_STATUSES).optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one field is required",
  });

export const taskResponseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  assignedTo: z.string().uuid().nullable(),
  relatedEntityType: z.enum(CRM_ENTITY_TYPES).nullable(),
  relatedEntityId: z.string().uuid().nullable(),
  title: z.string(),
  dueDate: z.string().nullable(),
  priority: z.enum(TASK_PRIORITIES),
  status: z.enum(TASK_STATUSES),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const activityCreateSchema = z.object({
  entityType: z.enum(CRM_ENTITY_TYPES),
  entityId: z.string().uuid(),
  activityType: z.enum(ACTIVITY_TYPES),
  subject: z.string().max(500).optional(),
  body: z.string().optional(),
});

export const activityResponseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  entityType: z.enum(CRM_ENTITY_TYPES),
  entityId: z.string().uuid(),
  activityType: z.enum(ACTIVITY_TYPES),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  ownerId: z.string().uuid().nullable(),
  occurredAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

export const MEETING_TYPES = ["call", "video", "in_person"] as const;

export const meetingListQuerySchema = paginationQuerySchema.extend({
  dealId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
});

export const meetingCreateSchema = z.object({
  title: z.string().min(1).max(255),
  scheduledAt: z.string().datetime(),
  durationMinutes: z.number().int().min(0).optional(),
  meetingType: z.enum(MEETING_TYPES).default("call"),
  contactId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  organizerId: z.string().uuid().optional(),
  summary: z.string().optional(),
  outcome: z.string().optional(),
});

export const meetingUpdateSchema = z
  .object({
    title: z.string().min(1).max(255).optional(),
    scheduledAt: z.string().datetime().optional(),
    durationMinutes: z.number().int().min(0).optional(),
    meetingType: z.enum(MEETING_TYPES).optional(),
    contactId: z.string().uuid().optional(),
    companyId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
    organizerId: z.string().uuid().optional(),
    summary: z.string().optional(),
    outcome: z.string().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one field is required",
  });

export const meetingResponseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  contactId: z.string().uuid().nullable(),
  companyId: z.string().uuid().nullable(),
  dealId: z.string().uuid().nullable(),
  organizerId: z.string().uuid().nullable(),
  title: z.string(),
  scheduledAt: z.string().datetime(),
  durationMinutes: z.number().nullable(),
  meetingType: z.enum(MEETING_TYPES),
  summary: z.string().nullable(),
  outcome: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const dashboardOverviewResponseSchema = z.object({
  workspaceId: z.string().uuid(),
  companies: z.number(),
  contacts: z.number(),
  openDeals: z.number(),
  pipelineValue: z.number(),
  currency: z.string(),
  openTasks: z.number(),
  overdueTasks: z.number(),
  upcomingMeetings: z.number(),
  recentActivities: z.array(activityResponseSchema),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type MeetingType = (typeof MEETING_TYPES)[number];
export type MeetingListQuery = z.infer<typeof meetingListQuerySchema>;
export type MeetingCreateInput = z.infer<typeof meetingCreateSchema>;
export type MeetingUpdateInput = z.infer<typeof meetingUpdateSchema>;
export type CompanyListQuery = z.infer<typeof companyListQuerySchema>;
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;
export type DealListQuery = z.infer<typeof dealListQuerySchema>;
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
export type ActivityListQuery = z.infer<typeof activityListQuerySchema>;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];
export type ContactLifecycleStage = (typeof CONTACT_LIFECYCLE_STAGES)[number];
export type DealStatus = (typeof DEAL_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type CrmEntityType = (typeof CRM_ENTITY_TYPES)[number];
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export type CompanyCreateInput = z.infer<typeof companyCreateSchema>;
export type CompanyUpdateInput = z.infer<typeof companyUpdateSchema>;
export type ContactCreateInput = z.infer<typeof contactCreateSchema>;
export type ContactUpdateInput = z.infer<typeof contactUpdateSchema>;
export type PipelineCreateInput = z.infer<typeof pipelineCreateSchema>;
export type PipelineStageCreateInput = z.infer<typeof pipelineStageCreateSchema>;
export type DealCreateInput = z.infer<typeof dealCreateSchema>;
export type DealUpdateInput = z.infer<typeof dealUpdateSchema>;
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;
export type ActivityCreateInput = z.infer<typeof activityCreateSchema>;

export type ProspectSummary = z.infer<typeof prospectSummarySchema>;
export type ProspectDetail = z.infer<typeof prospectDetailSchema>;
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
