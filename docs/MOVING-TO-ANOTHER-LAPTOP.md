# Moving this project to another laptop

Assumes Claude Code, npm and git are already installed on the new laptop.
Use PowerShell. Never run these from `C:\Windows\System32`.

Replace `<you>` below with the Windows username on the new laptop.

## 1. Install pnpm (any folder)

```
cd $HOME
npm install -g pnpm
```

Close PowerShell and open a new window, then check it:

```
pnpm --version
```

## 2. Clone the project (folder: `C:\CODING`)

```
mkdir C:\CODING
cd C:\CODING
git clone https://github.com/joelfrenette/travel-fun-biz-ca.git
```

The project must end up at `C:\CODING\travel-fun-biz-ca`, or the memory folder name will not match.
If the clone says "repository not found", copy the right address from the green Code button on GitHub.

## 3. Install dependencies (folder: `C:\CODING\travel-fun-biz-ca`)

```
cd C:\CODING\travel-fun-biz-ca
pnpm install --frozen-lockfile
```

Wait for it to finish. It takes a few minutes. Do not use `npm install` here.

## 4. Copy `.env.local` (into `C:\CODING\travel-fun-biz-ca`, next to `package.json`)

Take it from the old laptop's project folder by USB stick or password manager, never email or chat. Check the name stays exactly `.env.local`, not `.env.local.txt`. Every value also lives in Vercel, under the project's Environment Variables.

## 5. Copy the memory folder

From the old laptop:
`C:\Users\joelfrenette\.claude\projects\C--CODING-travel-fun-biz-ca\memory\`

To the new laptop (create the folders if they do not exist):
`C:\Users\<you>\.claude\projects\C--CODING-travel-fun-biz-ca\memory\`

## 6. Copy your rules files

From the old laptop `C:\Users\joelfrenette\.claude\` copy `CLAUDE.md` and `RTK.md` to the new laptop's `C:\Users\<you>\.claude\` (your menu and model rules).

## 7. Install RTK

Install RTK on the new laptop so command rewriting works. Check with `rtk gain`.

## 8. Sign in again

Sign in again to the Supabase and browser plugins in Claude Code.

## 9. Check it works (folder: `C:\CODING\travel-fun-biz-ca`)

```
cd C:\CODING\travel-fun-biz-ca
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

Then start Claude Code in that folder and say "continue". It reads the handoff note from memory.

Do not copy `node_modules` or `.next`; they rebuild. Local-only branches (`qa/...`, `ci/typecheck`, `hub-pointer`) are not needed.
