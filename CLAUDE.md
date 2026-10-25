# TravelFunBiz.ca

Next.js 14 (App Router) + Supabase lead-gen site for a travel agency, with an admin at `/admin`.
This `.ca` site is the replacement for travelfunbiz.com; the `.com` will later be a config-driven
replica (US company), never a code fork.

## How Joel wants every response

1. **Project update in ASCII** at the top of every response: a box showing what is DONE, what is
   IN PROGRESS, and what is NEXT, split into two lanes: `CLAUDE` (steps Claude does) and
   `JOEL` (steps only Joel can do: Vercel env vars, account sign-ups, approvals, testing on the live site).
2. **End every response with a multi-select menu** of proposed next steps, using the
   AskUserQuestion tool with `multiSelect: true` (2 to 4 options, recommended option first).
3. **Use RTK** for shell commands when the `rtk` CLI is available (`rtk <command>` to cut token
   usage on command output). If it is not installed in the session, say so once, do not fake it.
4. Skeptical senior PM voice: challenge weak asks, name failure modes, offer the simpler option,
   no em dashes, plain-English gloss after jargon, end with `Confidence: XX/100`.
5. **Models**: the main session (orchestrator) runs on Fable 5.1 (Joel's call, 2026-10-09, for the
   multi-agent growth loop; it replaces the 2026-09-25 "main on Sonnet 5" rule). Every sub-agent
   spawned with the Agent tool or a Workflow runs on Sonnet 5 (`model: "sonnet"`), never a heavier
   model, unless Joel says otherwise. Builders and critical QA agents loop until the orchestrator
   decides what merges and pushes.
6. **Token line INSIDE the ASCII board itself** (a row inside the box borders, not a separate
   paragraph after it): real numbers only, never estimated or invented: tokens used this turn
   (prior turn's `<total_tokens>` remaining minus this turn's, from the system reminders) and
   RTK's cumulative savings from `rtk gain` (commands run, tokens saved, %). If a number isn't
   available (no prior turn, rtk not installed, counter reset on a session resume), say so
   inside the box instead of guessing.
7. **Session context and VACHIAI savings, plus ASCII progress art, INSIDE the same board**
   (added 2026-10-24 at Joel's request): add two more rows with real numbers only. (a) SESSION
   CONTEXT: tokens remaining in the session budget (latest `<total_tokens>` value) and, when the
   session has been compacted, how many times and how much was condensed to bookmarks. (b)
   TOKENS SAVED BY VACHIAI: the figure from VACHIAI's own counter when one is reachable in the
   session; if no source exists, print "VACHIAI: no counter available" instead of a number, and
   ask Joel once where the counter lives. Also draw progress as ASCII bars inside the box, one
   per lane (CLAUDE, JOEL), e.g. `CLAUDE [########----] 8/12 steps`, where the step counts are
   the real counts of DONE vs total listed steps.
   RTK gets its own ASCII bar row too (added 2026-10-25): run `rtk gain` each report and draw
   `RTK saved <N>M [####------] <pct>%` from its real total (global scope, all projects). VACHIAI
   has no savings command on Joel's machine (only its installer and statusline at `~/.vachi`, whose
   /v1/usage probe needs a private key); never read `~/.vachi/credentials.json` to get one.

## Working conventions

- Develop on the session branch, then fast-forward `main` and push; Vercel deploys `main` to
  travelfunbiz.ca. Joel has asked for changes to go straight to main once verified.
- Verify before pushing: `pnpm exec tsc --noEmit -p tsconfig.json`, and for UI changes a real
  browser pass with Playwright (`/opt/pw-browsers/chromium`, global playwright via
  `NODE_PATH=/opt/node22/lib/node_modules`). `next build` and `next dev` write to `.next/`; it is
  gitignored and untracked, keep it that way.
- Admin data lives in Supabase project `ldwmbwsxrktpcisqaxrb` (tables: `travel_packages`,
  `roadmap_epics`, `roadmap_features`, `roadmap_usecases`, `keyword_research`). Admin tables have
  RLS on with no policies: only the service role reads or writes them, through `getSupabaseAdmin()`.
- The public site reads `travel_packages` through the anon client (published rows only, by RLS).
- Every admin API route checks `isAuthorized(request)` from `lib/admin-auth.ts` first.
- Never invent data on import (no default prices or categories); leave fields empty and surface it.
- Every API key or credit-costing call is admin-triggered and cached (see `lib/keywords.ts`).
- All env vars are documented in `.env.example`; add new ones there in the same change.
- The setup checklist Joel follows along on lives at https://claude.ai/artifact/PN6caspQe9V6RUUsJ2vNcw
  (grade-5-reading-level steps for every env var/account, plus one-off tasks). It uses the
  Artifact tool's `artifact` runtime capability so checks are shared and Claude-writable, not
  per-browser localStorage: update it (read, then republish) whenever a step gets verified by
  testing, not just when Joel says so.
- Blog topic suggestions have a real admin approval queue, not just a static fallback: the
  "Topics & Autoblog" tab in `app/admin/blog/page.tsx` (`components/admin/blog-topic-queue.tsx`,
  API routes under `app/api/admin/blog/topics/`) lists AI-suggested topics so Joel can
  approve/reject/schedule them, and `lib/autoblog-run.ts` genuinely prefers a due, approved queue
  row (`dueApprovedTopics()`) over the AI-freeform/static fallback (`pickOneTopic()`) - approving a
  row in the admin UI changes what the next autoblog run writes about.

## Roadmap and triage

The roadmap is in the admin at `/admin/tracker` (Supabase-backed). Use cases Joel adds from the
admin land with `epic_id = null`; at the start of a session, query
`roadmap_usecases where epic_id is null`, file each under the right epic/feature with a priority,
and mark shipped work `done`. Add roadmap rows for any new work you take on.


## Cross-site hub

This site is one of several run off a shared playbook kept in the owner's private cross-site hub repo (not linked here).

- Run `/autoblogging` (user-level skill) to pull suggested improvements into this project.
- Run `/contribute` to push portable findings back to the hub as a PR.
- Never put secrets, customer data, pricing or brand voice in the hub.
