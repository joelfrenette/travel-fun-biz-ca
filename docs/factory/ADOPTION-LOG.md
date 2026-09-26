# Factory parity program — adoption log

Per Joel's working rules: one entry per PR, recording what was ported, what was changed for
travel and why, which Nomad checks were ported, and any deviation from the spec. Anything found
wrong in Nomad itself gets reported back to Joel, not silently worked around here.

## Phase 0 — Audit and decisions (2026-09-26)

**PR:** [joelfrenette/travel-fun-biz-ca#1](https://github.com/joelfrenette/travel-fun-biz-ca/pull/1) (not merged — docs only).

**What happened:** read `docs/factory/PARITY-SPEC.md` and `FACTORY-INTEGRATION.md` in full from
`joelfrenette/nomad-escape-plan` at tag `factory-v8`; wrote `GAP-REPORT.md` comparing this project
against the spec section by section; asked Joel the 9 blocking decisions one at a time.

**Decisions resolved** (full detail and rationale in `GAP-REPORT.md` §9; this is the answer only):

1. **Migration files:** adopt numbered files under `supabase/migrations/`, starting now — no
   retroactive renumbering of the 7 migrations already applied ad hoc.
2. **Admin auth:** confirmed — every new factory route reuses the existing `isAuthorized()` check.
   No new Postgres `current_is_admin()` RPC; this project's admin auth is HMAC-token + service-role,
   not RLS-role-based, so Nomad's pattern doesn't map on directly.
3. **Funnel stages** (travel-specific, no in-house checkout): **Awareness → Visits → Leads →
   Nurture → Quote Started → Booked → Traveled → Loyalty** — 8 stages, not Nomad's 7. Joel added
   **Traveled** after Booked: a confirmed booking and a completed trip are different events for a
   travel business, and it's the natural place "collected" (commission actually paid) sits, since
   suppliers commonly release final commission after travel completes, not at booking. "Collected"
   is tracked as its own timestamp on the order record, not a numbered funnel stage of its own.
4. **GHL contract:** move from the current v1 API key (outbound-only) to a private integration
   token with the scopes Nomad's contract needs (webhooks, `conversations/message.readonly`,
   `socialplanner/statistics.readonly`). Real re-architecture of `lib/gohighlevel.ts`, due at
   Phase 9. Joel generates the token in GHL settings when that phase starts.
5. **Revenue streams:** all three (supplier commissions/affiliate payouts, recruited
   agents/affiliates, direct trip-planning inquiries) are live today, roughly equal weight. No
   single primary to bias the tag scheme or funnel toward — the tag scheme (still needs Joel's
   real supplier/product list) should track all three without favoring one.
6. **Vercel plan:** Pro, confirmed by Joel. Unblocks all 11 factory crons; exact schedule limits
   (max jobs, minimum interval) get confirmed against Vercel's current docs when `vercel.json` is
   actually written for Phase 8+, not assumed from memory now.
7. **AI content composer:** in scope. `ANTHROPIC_API_KEY` and its real per-call cost are accepted,
   effective when Phase 3 (autoblog) starts — not before, since nothing needs it before then.
8. **Compliance wording:** Joel supplies the real CASL/Quebec Law 25/PIPEDA consent wording and
   the actual TICO/BC/QC seller-of-travel registration numbers. None of it is invented, drafted
   from a template, or guessed at by Claude. This blocks Phase 8's consent banner specifically.
9. **GHL capability probing:** probe Social Planner statistics (Phase 6) and coupon-creation
   support (Phase 16.13, the ambassador program) for real against Joel's actual GHL plan at the
   start of each of those phases — never assume from GHL's general docs.

**Tracked:** all 9 decisions plus the audit itself are logged as `done` use-cases under the new
"Factory Parity Program" epic (`e10`) in `/admin/tracker`, sort orders 1001–1009 and 1018, each
with its resolution in the `note` field.

**Deviations from the vanilla spec, and why:** none yet — this phase only made decisions, no code.
The migration-numbering and admin-auth-shim answers above are themselves the two places this
project's own architecture required a real adaptation rather than a literal port; both are
recorded here so a later phase doesn't quietly relitigate them.

**Next:** Phase 1 (`Foundation, dormant` — `cron-auth`, `cron-heartbeat`, `secret-compare`,
`ai-verify`, `site-url`, `utm`, `safe-markdown`, `abuse-guard`, `app_settings`, `modules/site.ts`)
has not started. Waiting on Joel to say go.
