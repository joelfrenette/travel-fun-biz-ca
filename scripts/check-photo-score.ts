// Offline checks for the stock-photo selector (lib/photo-score.ts) and the colour maths in lib/pexels.ts.
// No network, no database. Run: pnpm dlx tsx scripts/check-photo-score.ts
import {
  BANNED_ALT,
  isBannedAlt,
  queryTokens,
  vividnessOf,
  scoreCandidate,
  rankCandidates,
  parseRecentIds,
  pushRecentId,
  RECENT_PHOTO_CAP,
  type PhotoCandidate,
  type ScoreContext,
} from '../lib/photo-score'
import { colourStatsOfRgb } from '../lib/pexels'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

const vivid = { meanSaturation: 0.55, meanLuma: 0.5, lumaStd: 0.25 }
const dull = { meanSaturation: 0.05, meanLuma: 0.5, lumaStd: 0.05 }
const dark = { meanSaturation: 0.5, meanLuma: 0.08, lumaStd: 0.1 }
const ctx = (tokens: string[], recent: number[] = []): ScoreContext => ({ tokens, recentIds: new Set(recent), minWidth: 1200, minHeight: 800 })
const photo = (id: number, alt: string | null, extra: Partial<PhotoCandidate> = {}): PhotoCandidate => ({ id, url: `https://images.pexels.com/photos/${id}/x.jpeg`, alt, width: 1880, height: 1253, ...extra })

// ---- banned subjects ----
for (const alt of ['Laptop on a wooden table', 'A desk with plants', 'Modern OFFICE interior', 'Computer screen', 'Business people', 'Businessman on a phone', 'Office worker at a screen', 'Keyboard close up', 'Open notebook and pen', 'Spreadsheet on a monitor']) {
  check(`bans alt: ${alt}`, isBannedAlt(alt))
}
for (const alt of ['Post office in Lisbon', 'Coffee plantation in Colombia', 'Meeting of the Waters, Manaus', 'cup of coffee on a cafe terrace in Rome', 'Friends meeting on a beach', 'Business Bay skyline', 'Deskside view', 'Notebooks']) {
  // 'Business Bay' and 'Notebooks'/'Deskside' show whole-word matching: only the exact words are banned.
  const expectBanned = alt === 'Business Bay skyline'
  check(`${expectBanned ? 'bans' : 'allows'} alt: ${alt}`, isBannedAlt(alt) === expectBanned)
}
check('does not ban a beach photo', !BANNED_ALT.test('Aerial view of a white sand beach in Santorini'))
check('banned photo is rejected even when it names the place', scoreCandidate(photo(1, 'Laptop on a table in Santorini'), ctx(['santorini'])).rejected === 'banned-subject')

// ---- query tokens ----
const tok = queryTokens('Best time to visit Santorini, Greece')
check('tokens keep place words', tok.includes('santorini') && tok.includes('greece'), tok.join(','))
check('tokens drop filler words', !tok.includes('best') && !tok.includes('visit') && !tok.includes('the'), tok.join(','))
check('tokens strip accents', queryTokens('Québec City').includes('quebec'))
check('tokens of empty query', queryTokens('').length === 0)

// ---- resolution ----
check('too-small width rejected', scoreCandidate(photo(2, 'Santorini', { width: 800, height: 1200 }), ctx(['santorini'])).rejected === 'too-small')
check('too-small height rejected', scoreCandidate(photo(3, 'Santorini', { width: 1600, height: 500 }), ctx(['santorini'])).rejected === 'too-small')
check('big enough accepted', scoreCandidate(photo(4, 'Santorini sunset'), ctx(['santorini'])).rejected === null)
check('missing url is invalid', scoreCandidate({ ...photo(5, 'x'), url: '' }, ctx([])).rejected === 'invalid')

// ---- vividness ----
check('vivid beats dull', vividnessOf(vivid) > vividnessOf(dull))
check('vivid beats dark', vividnessOf(vivid) > vividnessOf(dark))
check('unknown stats are neutral', vividnessOf(null) === 0.5 && vividnessOf(undefined) === 0.5)
check('NaN stats are neutral', vividnessOf({ meanSaturation: NaN, meanLuma: 0.5, lumaStd: 0.1 }) === 0.5)
check('vividness stays in 0..1', [vivid, dull, dark].every((s) => vividnessOf(s) >= 0 && vividnessOf(s) <= 1))

// ---- ranking ----
{
  const cands = [photo(10, 'A laptop and coffee at a desk'), photo(11, 'Colourful street in Lisbon', { stats: dull }), photo(12, 'Santorini caldera at sunset', { stats: vivid }), photo(13, 'Santorini white houses', { stats: dull })]
  const r = rankCandidates(cands, ctx(['santorini']))
  check('banned photo never ranked', !r.ranked.some((s) => s.photo.id === 10) && r.rejectedCount === 1)
  check('relevant vivid photo wins', r.ranked[0].photo.id === 12, r.ranked.map((s) => s.photo.id).join(','))
  check('relevant dull photo beats irrelevant photo', r.ranked[1].photo.id === 13 && r.ranked[2].photo.id === 11, r.ranked.map((s) => s.photo.id).join(','))
  check('not failed open when a photo matched', r.failedOpen === false)
}
{
  const cands = [photo(20, 'Mountain lake', { stats: dull }), photo(21, 'Desert dunes', { stats: vivid }), photo(22, null)]
  const r = rankCandidates(cands, ctx(['santorini']))
  check('fails open to best remaining when nothing matches', r.ranked.length === 3 && r.failedOpen === true)
  check('fail-open still prefers the vivid one', r.ranked[0].photo.id === 21)
}
{
  const cands = [photo(30, 'Laptop'), photo(31, 'Office desk')]
  const r = rankCandidates(cands, ctx(['santorini']))
  check('only banned photos: nothing is returned, never a banned subject', r.ranked.length === 0)
}
{
  const cands = [photo(40, 'Santorini at dusk', { stats: vivid }), photo(41, 'Santorini harbour', { stats: dull })]
  const r = rankCandidates(cands, ctx(['santorini'], [40]))
  check('a recently used photo drops behind a fresh one', r.ranked[0].photo.id === 41 && r.ranked[1].photo.id === 40)
  const all = rankCandidates(cands, ctx(['santorini'], [40, 41]))
  check('all recent: still returns photos (fail open)', all.ranked.length === 2)
}
{
  const a = rankCandidates([photo(50, 'Rome', { stats: vivid }), photo(51, 'Rome', { stats: vivid })], ctx(['rome']))
  const b = rankCandidates([photo(51, 'Rome', { stats: vivid }), photo(50, 'Rome', { stats: vivid })], ctx(['rome']))
  check('ranking is deterministic whatever the input order', a.ranked.map((s) => s.photo.id).join() === b.ranked.map((s) => s.photo.id).join())
}

// ---- recent id list ----
check('parseRecentIds handles null', parseRecentIds(null).length === 0)
check('parseRecentIds handles junk', parseRecentIds('{not json').length === 0 && parseRecentIds('{"a":1}').length === 0)
check('parseRecentIds keeps numbers only', parseRecentIds('[1,"x",2,null,3]').join() === '1,2,3')
{
  let list: number[] = []
  for (let i = 1; i <= 40; i++) list = pushRecentId(list, i)
  check('recent list capped at 30, newest kept', list.length === RECENT_PHOTO_CAP && list[0] === 11 && list[29] === 40)
  check('re-using an id moves it to the end without duplicating', pushRecentId([1, 2, 3], 1).join() === '2,3,1')
  check('oversized stored list is trimmed on read', parseRecentIds(JSON.stringify(Array.from({ length: 50 }, (_, i) => i))).length === RECENT_PHOTO_CAP)
}

// ---- colour maths (the pure half of the sharp check) ----
{
  const grey = new Uint8Array([128, 128, 128, 128, 128, 128])
  const red = new Uint8Array([255, 0, 0, 255, 0, 0])
  const g = colourStatsOfRgb(grey, 3)
  const r = colourStatsOfRgb(red, 3)
  check('grey pixels have zero saturation', !!g && g.meanSaturation === 0)
  check('pure red pixels have full saturation', !!r && r.meanSaturation === 1)
  check('empty buffer gives null', colourStatsOfRgb(new Uint8Array([]), 3) === null)
  const mixed = colourStatsOfRgb(new Uint8Array([0, 0, 0, 255, 255, 255]), 3)
  check('black and white pixels have high luminance spread', !!mixed && mixed.lumaStd > 0.4)
  check('saturated photo scores more vivid than grey', vividnessOf(r) > vividnessOf(g))
}

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll photo score checks passed')
