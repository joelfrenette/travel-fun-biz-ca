# Migrations: see what the database is missing

Goal: you never have to guess whether production has every file in `supabase/migrations/`. Nothing here applies a migration for you unless you click the manual button.

## What exists

| Where | What it does |
| --- | --- |
| Admin > System check, stage "Database changes" | Amber when a repo migration has no applied row ("Apply migration 0058"). Amber "could not be read" when the site cannot read the history. Never a false green. |
| `GET /api/admin/migration-drift` | Same check as JSON (admin login required). Read only. |
| `.github/workflows/migrations.yml` | On a push to `main` that touches migrations: runs the offline checks, then lists unapplied migrations in the job summary. |
| `scripts/migration-drift.ts` | The same list from your own computer. |
| `lib/migrations-manifest.ts` | The committed list of migration file names the site compares against. |

## Every time you add a migration

1. Add `supabase/migrations/NNNN_name.sql` (next number, four digits).
2. Add the same file name to the end of `lib/migrations-manifest.ts`.
3. Run `pnpm dlx tsx scripts/check-migration-manifest.ts`. It fails and tells you what to paste if the two disagree.

## One-time setup for the job summary (optional)

Without these the workflow still runs the offline checks. With them it also lists what is unapplied.

1. Supabase dashboard > your avatar > Account > Access Tokens > Generate new token. Copy it.
2. GitHub repo > Settings > Secrets and variables > Actions > New repository secret.
   - Name `SUPABASE_ACCESS_TOKEN`, value: the token.
   - Name `SUPABASE_PROJECT_REF`, value: `ldwmbwsxrktpcisqaxrb`.
3. Push to `main` (or Actions > Migrations > Run workflow). Open the run and read the "Summary" at the bottom.

## Applying (still by you)

Preferred: open the SQL file, paste it into the Supabase SQL editor, run it, then re-run the System check.

Optional button: Actions > Migrations > Run workflow > tick `apply` > Run. This runs `supabase db push` and needs one more secret, `SUPABASE_DB_PASSWORD` (Supabase > Project settings > Database). Take a backup first. A push to `main` never does this.

## Why a stage can say "no record" or "could not be read"

- The site reads `supabase_migrations.schema_migrations`. On a default project that schema is not exposed to the API, so the stage reads "could not be read" (amber). That is honest, not broken. To make it readable: Supabase > Settings > API > Exposed schemas > add `supabase_migrations`.
- Migrations pasted into the SQL editor by hand leave no row in that table. Until the history is in place the stage says no record exists (amber). To backfill, insert one row per migration already applied: `insert into supabase_migrations.schema_migrations (version, name) values ('0057', 'agents_office_role');`. The check matches by number or by name.
