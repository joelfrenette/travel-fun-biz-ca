# Moving this project to another laptop

Assumes Claude Code, npm and git are already installed on the new laptop.

1. Install pnpm if missing: `npm i -g pnpm`.
2. Clone: `git clone https://github.com/joelfrenette/travel-fun-biz-ca.git C:\CODING\travel-fun-biz-ca`, then `pnpm install` inside it.
3. Copy `.env.local` by hand from the old laptop's project folder (it is gitignored). Use a USB stick or password manager, never email or chat. Every value also lives in Vercel, under the project's Environment Variables.
4. Copy the memory folder from `C:\Users\joelfrenette\.claude\projects\C--CODING-travel-fun-biz-ca\memory\` to the same path on the new laptop. The project must sit at `C:\CODING\travel-fun-biz-ca` or the folder name will not match.
5. Copy `C:\Users\joelfrenette\.claude\CLAUDE.md` and `RTK.md` to the same folder on the new laptop (your menu and model rules).
6. Install RTK on the new laptop so command rewriting works.
7. Sign in again to the Supabase and browser plugins in Claude Code.
8. Check it works: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`, then start Claude Code in the folder.

Do not copy `node_modules` or `.next`; they rebuild. Local-only branches (`qa/...`, `ci/typecheck`, `hub-pointer`) are not needed.
