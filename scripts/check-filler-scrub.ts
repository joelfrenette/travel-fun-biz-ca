// Offline check for scrubFiller (lib/blog-quality.ts): the plain-code swap for the banned filler words "perfect" and "Before moving on,"
// that made the heal reject drafts after 5 model rounds (3 Nov, 6 Nov). Pure functions plus a source assertion; no network.
// Run: pnpm dlx tsx scripts/check-filler-scrub.ts
import { readFileSync } from 'node:fs'
import { bannedPhraseHits, scrubFiller } from '../lib/blog-quality'

let failed = 0
function check(label: string, ok: boolean, extra?: string) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` :: ${extra}` : ''}`)
}

const a = 'Royalton suits groups. It is perfect for families and perfectly suited to a first trip. Before moving on, check the room type.'
const outA = scrubFiller(a)
check('setup: the draft trips the gate', bannedPhraseHits(a).length === 2)
check('the swap clears both banned phrases', outA !== null && bannedPhraseHits(outA).length === 0, outA ?? 'null')
check('well suited to / Check read naturally', outA !== null && /well suited to families/.test(outA) && /\. Check the room type\./.test(outA), outA ?? 'null')
check('the perfect X becomes the right X', scrubFiller('Pick the perfect room.') === 'Pick the right room.')
check('Perfect for at sentence start keeps capital', scrubFiller('Perfect for couples.') === 'Well suited to couples.')
check('clean text is left alone (null)', scrubFiller('A plain sentence about resorts.') === null)
check('no digits are added', outA !== null && !/\d/.test(outA))
const heal = readFileSync('lib/heal-targets.ts', 'utf8')
check('the post heal repair calls scrubFiller', /scrubFiller\(next\.body\)/.test(heal))

if (failed) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
