# Architecture review checklist — batch 2

Source: Skout AI Enterprise Platform Engineering Vision v2.1, §7 (Target platform
architecture), §8 (Detailed product domains), §10 (Cross-domain workflows), §11 (Enterprise
platform requirements) and §11.2 (Reliability targets), §13 (Stage 0 reconciliation). These
are the rollup/governance items from the "next 10" batch that don't carry their own code —
§7.1, §8.12, §11.1 and §11.3 shipped real code and have their own ADRs (0003, 0002-update,
0004); this document covers the remaining six.

## §7 — Target platform architecture (seven planes)

Recognizable in outline (experience/domain-services/workflow/intelligence/data/integration
planes all map to real services), but the platform plane — tenant isolation, feature flags,
billing/entitlements as one explicit shared layer — is still thin. §7.1's read-model
exceptions (ADR 0003) and this pass's Tenancy/RBAC tables (ADR 0002) are steps toward it, not
completion. **No separate ticket beyond what 7.1–7.3 already schedule**, per the vision doc's
own text — status tracked via those subsections.

## §8 — Detailed product domains (rollup, no independent action)

Exists for numbering completeness only; §8.12 (CRM Intelligence) is the one subsection
assigned to this list and shipped real code this pass (BuyingCommittee, RetentionRule — see
`packages/db/src/schema/crm-intelligence.ts` and the CRM Intelligence rename check below).
The other fourteen subsections (§8.1–§8.11, §8.13–§8.15) belong to other developers per the
task-division doc and are out of scope here.

**CRM Intelligence naming check:** grepped the backend for the literal string "Deal
Intelligence" per §8.12's "rename Deal Intelligence to CRM Intelligence across UI copy and
internal naming" ask — zero matches in `apps/api`, `apps/crm`, or `packages/`. The backend
never used that name internally; if it appears anywhere, it's frontend-only UI copy, which is
out of scope for this backend-only pass (the Frontend repo wasn't touched — see the
implementation summary).

## §10 — Cross-domain workflows (five journeys become acceptance tests)

Per the vision doc's own completion plan, these five journeys "become the acceptance tests
for Phases 1-5, not separate tickets — each should be written as an actual automated
end-to-end test once its component domains are built." None of the five journeys have all
their component domains built yet (each spans multiple in-progress or not-started items), so
writing the end-to-end tests now would be testing against an incomplete system. **Status:
correctly not started — blocked on component-domain completion, not on this pass.** Revisit
after each journey's named component domains ship.

## §11 — Enterprise platform requirements (rollup — three pillars)

| Pillar | Status |
|---|---|
| §11.1 Security and tenancy | **Partially shipped** this pass — step-up/privileged-audit primitives (`packages/auth/src/step-up.ts`), wired into the identity-merge resolve/reverse routes as the worked example. SSO/SAML/OIDC/SCIM remain explicitly Stage-6/backlog per the vision doc's own text. |
| §11.2 Reliability targets | **Not started** — see below; explicitly gated on §11.3. |
| §11.3 Observability | **Wave 1 shipped** this pass (ADR 0004) — OpenTelemetry tracing baseline. |

## §11.2 — Reliability targets

Per the vision doc's own completion plan, this "depends on D17 (Observability) landing first
to have real latency/availability data to set targets against" and is explicitly framed as
"an instrumentation-and-target-setting exercise, not a pure engineering build." §11.3's Wave 1
tracing baseline shipped this pass, but Wave 2 (an OTLP exporter to a real backend, wired into
every queue) has not — there is no real trace data to derive p95/RPO/RTO targets from yet.
**Status: correctly not started.** Revisit once §11.3's Wave 2 lands and real latency data
exists; availability targets additionally require confirming which customer commitments are
already contractual, which is a product/sales question, not an engineering one.

## §13 — Stage 0: mandatory repository reconciliation

Two internal review passes (a structural desk review, a deeper code-level pass) plus this
task list itself and the "first 10"/"next 10" implementation passes now constitute a
substantial evidence base, but the vision doc requires the *formal* §18 audit — assigned
named owners and a due date — as a distinct coordination action, not something an engineering
pass can complete on its own. **Status: not run.** Recommended next step: run the §18
copy-paste prompt now (see below) using this document and the companion documents as the
starting evidence base, and assign a named owner + due date as the first concrete action —
both are leadership decisions, not code.

### §13.2 Reconciliation matrix — status unchanged

Coverage from this pass (ADR 0002, ADR 0003, ADR 0004, and this document) should be merged
into `Skout_AI_Reconciliation_and_WBS.xlsx`'s Reconciliation Matrix tab as the next step, per
the vision doc's own completion plan — not done in this pass, since it's a cross-document
merge into a workbook this pass doesn't have write access to verify against.

### §18 — Copy-paste master prompt for the engineering repository audit

Per the vision doc: "Run it now, using this document and the companion documents as a head
start rather than a starting point of zero. This is a one-time coordination action, not an
engineering build." Not run in this pass for the same reason as §13 above — it requires a
named human owner and a due date, which this pass cannot assign on its own.
