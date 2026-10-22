// Offline checks for the deterministic text fitting used by the carousel slides. No fonts, no network.
// Run: pnpm dlx tsx scripts/check-cover-fit.ts
import { fitCoverHeadline, fitFactClaim, fitPanelBody, fitPanelHeadline, coverBlockHeight, brandDomain, COVER_MAX_BLOCK_WIDTH, COVER_PAD_X, COVER_GLYPH_WIDTH, COVER_MAX_FONT, COVER_MIN_FONT, COVER_H, FACT_MAX_FONT, FACT_MIN_FONT, PANEL_BODY_MIN_FONT } from '../lib/cover-fit'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

const heads = ['Is Tulum worth it?', 'Cancun or Tulum', 'Penang vs Phuket', 'Miami to Cozumel by ship', 'Tulum, Cancun, Holbox', 'Cruise cabins decoded', 'Cozumel or Costa Maya?', 'Rome, Nice, Lisbon, Cadiz', 'Which cruise suits you?', 'Seven days in Rome']
for (const h of heads) {
  const f = fitCoverHeadline(h)
  const widest = Math.max(...f.lines.map((l) => l.length)) * f.fontSize * COVER_GLYPH_WIDTH
  check(`"${h}" fits: <=3 lines, size ${f.fontSize}, not cut`, f.lines.length <= 3 && f.fontSize >= COVER_MIN_FONT && f.fontSize <= COVER_MAX_FONT && !f.truncated, JSON.stringify(f))
  check(`"${h}" widest line inside the block`, widest <= COVER_MAX_BLOCK_WIDTH - COVER_PAD_X * 2 + 1, String(widest))
  check(`"${h}" no word was split`, f.lines.join(' ').replace(/\s+/g, ' ') === h.toUpperCase().replace(/\s+/g, ' '), f.lines.join('|'))
}

check('short headline gets the biggest size', fitCoverHeadline('Go now').fontSize === COVER_MAX_FONT)
check('longer headline gets a smaller size', fitCoverHeadline('Cozumel, Roatan, Belize, Costa Maya').fontSize <fitCoverHeadline('Go now').fontSize)
check('size steps are multiples of 4 from 120', [120, 116, 112, 108, 104, 100, 96, 92, 88, 84, 80, 76, 72].includes(fitCoverHeadline('Cancun or Tulum').fontSize))
check('deterministic', JSON.stringify(fitCoverHeadline('Cancun or Tulum')) === JSON.stringify(fitCoverHeadline('Cancun or Tulum')))
check('upper-cases', fitCoverHeadline('Is Tulum worth it?').lines.every((l) => l === l.toUpperCase()))

// A max-length valid headline (36 chars, 6 words, longest word <= 12) must still fit in 3 lines at >= 72px.
const worst = fitCoverHeadline('Is Tulum or Cancun better for us?'.slice(0, 36))
check('36 char headline fits', !worst.truncated && worst.lines.length <= 3, JSON.stringify(worst))
const worst2 = fitCoverHeadline('Cozumel, Roatan, Belize, Costa Maya')
check('36 char comma list fits', !worst2.truncated && worst2.lines.length <= 3, JSON.stringify(worst2))

// Garbage in: never throws, never more than 3 lines.
const silly = fitCoverHeadline('Supercalifragilisticexpialidocious '.repeat(6))
check('overlong input is cut at 3 lines, never thrown', silly.lines.length <= 3 && silly.truncated)
check('empty input does not throw', fitCoverHeadline('').lines.length === 0)

// Block position: the red block (top 20%) ends well above the bottom 90px edge.
const block = coverBlockHeight(fitCoverHeadline('Cozumel, Roatan, Belize, Costa Maya'))
check('block stays inside the safe area', Math.round(COVER_H * 0.2) + block < COVER_H - 90 - 200, String(block))

// Fact claims
const claims = ['Penang runs 3,900 dollars cheaper per year than Phuket', 'Seven nights, three ports, one price', 'Cabins on deck 9 sell out first']
for (const c of claims) {
  const f = fitFactClaim(c)
  check(`fact "${c.slice(0, 24)}..." size ${f.fontSize} in ${FACT_MIN_FONT}..${FACT_MAX_FONT}, not cut`, f.fontSize >= FACT_MIN_FONT && f.fontSize <= FACT_MAX_FONT && !f.truncated, JSON.stringify(f))
  check(`fact "${c.slice(0, 24)}..." fits the card height`, f.lines.length * f.fontSize * 1.12 <= 1350 - 400, String(f.lines.length))
}
const fourteen = fitFactClaim('one two three four five six seven eight nine ten eleven twelve thirteen fourteen')
check('14-word claim fits at the minimum size or above', !fourteen.truncated && fourteen.fontSize >= FACT_MIN_FONT, JSON.stringify(fourteen))

// Photo slide panel text
const body = fitPanelBody('Cozumel is the easiest first stop, with calm water, short taxi rides and plenty of shade for the whole family.')
check('panel body never below 48px', body.fontSize >= PANEL_BODY_MIN_FONT, String(body.fontSize))
check('panel body at most 7 lines', body.lines.length <= 7)
check('panel headline fits', !fitPanelHeadline('Pick the right port first').truncated)

check('brandDomain from a site url', brandDomain('https://travelfunbiz.ca') === 'TRAVELFUNBIZ.CA')
check('brandDomain drops www', brandDomain('https://www.travelfunbiz.ca/') === 'TRAVELFUNBIZ.CA')
check('brandDomain survives junk', brandDomain('not a url') === 'NOT A URL')

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
