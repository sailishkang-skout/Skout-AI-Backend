/**
 * §11.3 — in-process business-journey counters for Prometheus /metrics scrape.
 * Increment from hot paths; Datadog Agent scrapes GET /api/v1/metrics.
 */
const counters = {
  evidenceWrite: 0,
  evidenceWriteFail: 0,
  sequenceEnroll: 0,
  hubspotSync: 0,
  identityMergeApply: 0,
  aiPinSuccess: 0,
  aiPinFail: 0,
  prospectCrmLink: 0,
  policyClassify: 0,
  decisionViewCreate: 0,
  workflowRunStart: 0,
  dexterPlanInvoke: 0,
  linkedinVoiceConfirm: 0,
  icpApproved: 0,
  tamApproved: 0,
  regionalBriefApproved: 0,
};

export type JourneyMetric = keyof typeof counters;

export function incrJourneyMetric(name: JourneyMetric, by = 1): void {
  counters[name] += by;
}

export function journeyMetricsSnapshot(): typeof counters {
  return { ...counters };
}

export function formatJourneyMetricsPrometheus(): string {
  const lines: string[] = [
    "# HELP skout_journey_evidence_write_total Evidence ledger writes",
    "# TYPE skout_journey_evidence_write_total counter",
    `skout_journey_evidence_write_total ${counters.evidenceWrite}`,
    "# HELP skout_journey_evidence_write_fail_total Evidence ledger write failures",
    "# TYPE skout_journey_evidence_write_fail_total counter",
    `skout_journey_evidence_write_fail_total ${counters.evidenceWriteFail}`,
    "# HELP skout_journey_sequence_enroll_total Sequence enrollments accepted",
    "# TYPE skout_journey_sequence_enroll_total counter",
    `skout_journey_sequence_enroll_total ${counters.sequenceEnroll}`,
    "# HELP skout_journey_hubspot_sync_total HubSpot native sync runs",
    "# TYPE skout_journey_hubspot_sync_total counter",
    `skout_journey_hubspot_sync_total ${counters.hubspotSync}`,
    "# HELP skout_journey_identity_merge_apply_total Identity merge applies",
    "# TYPE skout_journey_identity_merge_apply_total counter",
    `skout_journey_identity_merge_apply_total ${counters.identityMergeApply}`,
    "# HELP skout_journey_ai_pin_success_total AI claim pins succeeded",
    "# TYPE skout_journey_ai_pin_success_total counter",
    `skout_journey_ai_pin_success_total ${counters.aiPinSuccess}`,
    "# HELP skout_journey_ai_pin_fail_total AI claim pins failed",
    "# TYPE skout_journey_ai_pin_fail_total counter",
    `skout_journey_ai_pin_fail_total ${counters.aiPinFail}`,
    "# HELP skout_journey_prospect_crm_link_total Prospect↔CRM links created",
    "# TYPE skout_journey_prospect_crm_link_total counter",
    `skout_journey_prospect_crm_link_total ${counters.prospectCrmLink}`,
    "# HELP skout_journey_policy_classify_total Policy Gateway classifications",
    "# TYPE skout_journey_policy_classify_total counter",
    `skout_journey_policy_classify_total ${counters.policyClassify}`,
    "# HELP skout_journey_decision_view_create_total Decision views created",
    "# TYPE skout_journey_decision_view_create_total counter",
    `skout_journey_decision_view_create_total ${counters.decisionViewCreate}`,
    "# HELP skout_journey_workflow_run_start_total Observable workflow runs started",
    "# TYPE skout_journey_workflow_run_start_total counter",
    `skout_journey_workflow_run_start_total ${counters.workflowRunStart}`,
    "# HELP skout_journey_dexter_plan_invoke_total Dexter plans invoked",
    "# TYPE skout_journey_dexter_plan_invoke_total counter",
    `skout_journey_dexter_plan_invoke_total ${counters.dexterPlanInvoke}`,
    "# HELP skout_journey_linkedin_voice_confirm_total LinkedIn voice manual confirms",
    "# TYPE skout_journey_linkedin_voice_confirm_total counter",
    `skout_journey_linkedin_voice_confirm_total ${counters.linkedinVoiceConfirm}`,
    "# HELP skout_journey_icp_approved_total ICP versions approved",
    "# TYPE skout_journey_icp_approved_total counter",
    `skout_journey_icp_approved_total ${counters.icpApproved}`,
    "# HELP skout_journey_tam_approved_total TAM versions approved",
    "# TYPE skout_journey_tam_approved_total counter",
    `skout_journey_tam_approved_total ${counters.tamApproved}`,
    "# HELP skout_journey_regional_brief_approved_total Regional brief versions approved",
    "# TYPE skout_journey_regional_brief_approved_total counter",
    `skout_journey_regional_brief_approved_total ${counters.regionalBriefApproved}`,
  ];
  return lines.join("\n");
}
