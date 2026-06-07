import { z } from "zod";

export const seniorityEnum = z.enum([
  "c_suite",
  "vp",
  "director",
  "manager",
  "individual_contributor",
  "unknown",
]);

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
  filters: z.record(z.union([z.string(), z.array(z.string()), z.number()])).optional(),
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
export type Workspace = z.infer<typeof workspaceSchema>;
