// Writes docs/seo-playbook/playbook.json and docs/seo-playbook/PLAYBOOK.md from lib/seo-playbook.ts (the single source of truth),
// so the same list can be copied into the shared autoblogging hub and other projects.
// Run: pnpm dlx tsx scripts/export-seo-playbook.ts      (re-run after editing the playbook; scripts/check-seo-playbook.ts fails if the files are stale)
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildMarkdown, buildJson } from './seo-playbook-export-lib'

const dir = join(__dirname, '..', 'docs', 'seo-playbook')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'playbook.json'), buildJson(), 'utf8')
writeFileSync(join(dir, 'PLAYBOOK.md'), buildMarkdown(), 'utf8')
console.log('Wrote docs/seo-playbook/playbook.json and docs/seo-playbook/PLAYBOOK.md')
