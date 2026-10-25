# Flywheel registry (WP1)

Foundation for the autopilot work packages in `docs/factory/AUTOPILOT-AUDIT.md` (section 5). It removes the shared hotspots (`lib/auto-decisions.ts`, `lib/pipeline.ts`) so WP2 to WP11 each live in their own file.

## Policy names (final)

All are in `PolicyName`, `POLICY_LABELS` and `POLICY_CAPS` (`lib/auto-decisions.ts`) and in `FLYWHEEL_POLICIES`. Switch key is `auto_policy_<name>`. Cap is per UTC day, counted from the decisions log.

| Package | Policy / step id | Step file | Cap per day | Switch default | Order | Time floor |
|---|---|---|---|---|---|---|
| WP2 Order-to-lead booked sync | `booked_sync` | `lib/flywheel/steps/booked-sync.ts` | 10 | on | 20 | 5 s |
| WP3 Lead-to-GHL retry ladder | `lead_retry` | `lib/flywheel/steps/lead-retry.ts` | 5 | on | 30 | 10 s |
| WP4 Scheduled AI auto-heal | `ai_heal` | `lib/flywheel/steps/ai-heal.ts` | 3 | on | 40 | 60 s (max run 120 s) |
| WP5 Dead-letter and stale-issue sweeper | `dead_letter` | `lib/flywheel/steps/dead-letter.ts` | 10 | on | 50 | 10 s |
| WP6 Publish-verify remediation | `verify_fix` | `lib/flywheel/steps/verify-fix.ts` | 6 | on | 60 | 20 s |
| WP7 Network un-pause and re-probe | `network_recover` | `lib/flywheel/steps/network-recover.ts` | 2 | on | 70 | 15 s |
| WP8 Conversion-weighted promote pick | `promote_pick` | `lib/flywheel/steps/promote-pick.ts` | 1 | on | 80 | 10 s |
| WP9 Keyword target-page assignment | `keyword_assign` | `lib/flywheel/steps/keyword-assign.ts` | 5 | on | 90 | 10 s |
| WP10 Recap and testimonial auto-draft | `recap_auto` | `lib/flywheel/steps/recap-auto.ts` | 2 | on | 100 | 60 s (max run 120 s) |
| WP11 Autonomy ladder | `autonomy_ladder` | `lib/flywheel/steps/autonomy.ts` | 1 | OFF (needs exactly `on`) | 110 | 5 s |

"Switch default on" means the step runs unless its switch is exactly `off`. WP11 (`defaultOn: false`) runs only when the switch is exactly `on`.

## How it runs

`lib/pipeline.ts` has one call, step 1f, after the automatic decisions and before posting: `runFlywheelSteps({ admin, startedAt, budgetMs: TIME_BUDGET_MS, run })`. It only runs when Autopilot is on, not paused, not in dry run, and the pass is not over budget (the existing early returns).

For each step, in `order`, `runFlywheelSteps` (`lib/flywheel/registry.ts`):

1. skips when a dry run is active (`ctx.dryRun` or `isDryRunActive()`);
2. skips when the pass budget is used up or less than `floorMs` is left;
3. asks the existing `policyGate` (kill switch, own switch, daily cap), plus the exact-`on` rule for opt-in steps;
4. runs `step.run(ctx)` with a cut-off of `maxMs` (default 60 s) and the remaining budget;
5. catches an error for that step only and carries on with the next;
6. writes a heartbeat `app_settings.flywheel_last_run:<id>` = `{at, ok, note}` for a step that ran or failed (no-ops and skips write nothing), and adds one `flywheel` line to the pass log (`pipeline_last_run`) when something ran or failed.

No new tables, no new crons.

## How a later builder plugs in

1. Open ONLY your own `lib/flywheel/steps/<name>.ts`. Replace `run: async () => NOT_BUILT` with real work. Do not edit `registry.ts`, `pipeline.ts`, `auto-decisions.ts`.
2. `run(ctx)` gets `{ admin, now, startedAt, budgetMs, dryRun, remainingMs(), room }`. `room` is how many actions your cap still allows today. Return `{ ran: true, note, acted }`, or `{ ran: false, reason }` when there was nothing to do.
3. Helpers in `lib/flywheel/ctx.ts` (all wrappers over existing code): `todayCount`, `capRoom`, `isVetoed`, `logDecision` (writes an "Autopilot decisions" line), `readSetting` / `readNumberSetting` / `readJsonSetting` with defaults, `writeSetting` / `writeJsonSetting`.
4. For an Undo button on a decision: log it with `{ kind: 'fw:<your id>', ref }` and implement `undo(admin, ref)` on your step. The Autopilot decisions Undo route hands it to you (`undoFlywheel`). Return `{ ok:false, message }` when it cannot be undone.
5. If you change an existing file (for example `lib/heal.ts` for WP3), keep it to the files the audit names for your package.
6. Add a check for your step as a new `scripts/check-<name>.ts`; do not extend `check-flywheel-registry.ts` beyond the id list.

## Rules every step keeps (from the audit)

Capped per day; every change logged with an Undo; never touch unpublished trips, never write a price, never call `assignLead`, send nothing to a person except existing alerts; respect dry run (do not write) and the veto list (`isVetoed`).

## Check

`pnpm dlx tsx scripts/check-flywheel-registry.ts` (offline, in-memory fake).
