import { seniorityEnum, type ProspectSummary } from "@skout/shared";
import type { ProspectDocument } from "@skout/opensearch";
import type { ProspectSnapshot } from "./enrichment/service.js";
import { snapshotFromCorpusDoc } from "../utils/verified-email.js";

const VALID_SENIORITIES = new Set(seniorityEnum.options);

export function prospectToSummary(doc: ProspectDocument): ProspectSummary {
  return {
    prospectId: doc.prospectId,
    companyId: doc.companyId,
    fullName: doc.fullName ?? doc.companyName ?? "Unknown",
    title: doc.title ?? "",
    seniority: VALID_SENIORITIES.has(doc.seniority as (typeof seniorityEnum.options)[number])
      ? (doc.seniority as (typeof seniorityEnum.options)[number])
      : "unknown",
    country: doc.country ?? "",
    industry: doc.industry ?? "",
    companyDomain: doc.companyDomain,
    employeeCount: doc.employeeCount,
  };
}

export function prospectToSnapshot(doc: ProspectDocument): ProspectSnapshot {
  return snapshotFromCorpusDoc(doc);
}
