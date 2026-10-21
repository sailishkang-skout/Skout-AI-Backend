# Runbook: workflows (COPS-10)

Bible Appendix I, "Replay failed workflow". Workflows are built at `/workflows`; every action below
needs `workspace:manage` (Owner or Admin) and is audited.

## A run failed
1. Open the workflow, then **Run history**. Filter by status `failed`.
2. Expand the run. The failed step shows its error, attempt count, input and output.
3. Fix the cause: the config, the record, or the integration.
4. Choose how to run it again:
   - **Retry** (failed runs only) resets the failed steps and continues the same run. Steps that
     already succeeded are not repeated.
   - **Replay** starts a new run with the same trigger payload and account, on the same version
     (`POST /automations/runs/:runId/replay` with `{"version":"latest"}` uses the live version).
5. A step in **outcome unknown** (an integration timed out or answered 5xx) is not retried
   automatically. Check in the integration whether the call happened, then replay or leave it.

## A run is waiting
- **Waiting on a delay:** the step shows when it runs. Delays survive restarts; nothing to do.
- **Waiting on approval:** **Approve** runs the step; **Reject** cancels the run.
- **Should not continue:** **Cancel** stops it. Waiting steps are skipped.

## The live version is wrong
**Version history → Roll back to vN** makes vN live again as the next version. Runs already in
progress keep their own version. To stop those as well, cancel them from Run history.

## Nothing runs
- **Trigger:** event and state-change triggers react only to events after the version was
  published; a schedule runs at most every 5 minutes.
- **Worker:** the run worker sweeps every 30 seconds. Check the API log for
  `workflow trigger sweep failed` or `automation due-delay sweep failed`.
- **Redis:** if Redis was down, due delays resume on the next sweep once it is back.

## An action ran twice?
Task, ticket, field-update and notify actions record their effect per step
(`automation_step_effects`). A step re-run after a crash returns the recorded output and does not
repeat the effect. HTTP calls send the step key as `Idempotency-Key`; whether the receiver honours
it is up to the receiver.
