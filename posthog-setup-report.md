<wizard-report>
# PostHog post-wizard report

The wizard has completed a full PostHog integration for the Skout AI FastAPI service (`apps/ai/src/main.py`). A `Posthog` client instance is initialized at startup using environment variables (`POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST`) and shut down gracefully via both the FastAPI lifespan and `atexit`. Exception autocapture is enabled. All four AI endpoints now emit structured analytics events using the prospect or thread ID as the distinct identifier.

| Event name | Description | File |
|---|---|---|
| `prospect_classified` | Fired when the /v1/classify endpoint returns an intent classification for a message thread. | `apps/ai/src/main.py` |
| `prospect_scored` | Fired when the /v1/score endpoint returns an ICP score and outreach readiness band for a prospect. | `apps/ai/src/main.py` |
| `pain_points_detected` | Fired when the /v1/pain-points endpoint returns detected pain points for a prospect (LLM or heuristic). | `apps/ai/src/main.py` |
| `outreach_personalized` | Fired when the /v1/personalize endpoint generates a personalized opener and talking points for a prospect. | `apps/ai/src/main.py` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on AI pipeline behavior:

- [Analytics basics (wizard) — Dashboard](https://us.posthog.com/project/475854/dashboard/1729573)
- [AI Pipeline Volume](https://us.posthog.com/project/475854/insights/spsIdQTg) — Daily call volume across all four endpoints
- [Outreach Readiness Breakdown](https://us.posthog.com/project/475854/insights/iJSn4Ima) — Pie chart of prospect scoring outcomes by readiness band
- [ICP Band Distribution](https://us.posthog.com/project/475854/insights/9yQg3D7S) — Bar chart of scored prospects by ICP quality (strong / medium / weak)
- [HITL Escalation Rate](https://us.posthog.com/project/475854/insights/cnLWfOny) — Stacked bar showing how many classifications require human-in-the-loop escalation
- [AI vs Heuristic Source Mix](https://us.posthog.com/project/475854/insights/jbo6d8Qk) — Bar chart comparing LLM vs heuristic usage for pain-point detection and personalization

## Verify before merging

- [ ] Run a full production build (the wizard only verified the files it touched) and fix any lint or type errors introduced by the generated code.
- [ ] Run the test suite — call sites that were rewritten or instrumented may need updated mocks or fixtures.
- [ ] Add `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` to `apps/ai/.env.example` (or the root `.env.example`) and any bootstrap scripts so collaborators know what to set.

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
