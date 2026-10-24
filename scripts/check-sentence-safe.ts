// Self-check: abbreviation-aware sentence splitting and the cut-off gate (trip kit and trip copy).
// Run: pnpm dlx tsx scripts/check-sentence-safe.ts
import { splitSentencesSafe, dangling, firstCutOff } from '../lib/sentence-safe'
import { splitSentences, itemsOfSection } from '../lib/trip-kit-facts'
import { tripKitBlockers, thingBlockers, tripKitThingsOk } from '../lib/trip-kit-gate'
import { copyBlockers } from '../lib/package-enrich'
import { sheetHasCutOff } from '../lib/trip-kit-fill'

let failed = 0
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra !== undefined ? ` -> ${JSON.stringify(extra).slice(0, 300)}` : ''}`)
}
const one = (s: string) => splitSentencesSafe(s).length === 1

// ─── Splitting never breaks at an abbreviation ───────────────────────────────────────
check('St. Lawrence stays whole', one('Walk up to the Cathedral of St. Lawrence for the view.'), splitSentencesSafe('Walk up to the Cathedral of St. Lawrence for the view.'))
check('Mt. Etna', one('Hike Mt. Etna at sunrise.'))
check('Dr. and Fr. and Mr. and Mrs. and Ms.', one('Dr. Smith, Fr. Jones, Mr. Lee, Mrs. Kim and Ms. Park joined us.'))
check('No. and vs.', one('Room No. 5 is vs. the garden.'))
check('approx.', one('The walk takes approx. an hour.'))
check('e.g. and i.e.', one('Bring layers, e.g. a fleece, i.e. something warm.'))
check('initials J. K. Rowling', one('We follow J. K. Rowling through Edinburgh.'))
check('decimal 3.5', one('The ship is 3.5 km from town.'))
check('a.m./p.m.', one('Breakfast is at 7:30 a.m. and dinner is at 7 p.m. sharp.'))
check('two real sentences still split', splitSentencesSafe('We sail to Hvar. Then we visit Vis.').length === 2)
check('a sentence ending in a plain word still splits', splitSentencesSafe('See the old town! Walk the walls? Lovely.').length === 3)
check('trip-kit splitSentences is the safe one', splitSentences('Visit St. Mark Square. Then relax.').length === 2)

// ─── Cut-off detection ───────────────────────────────────────────────────────────────
check('dangling: "of St."', !!dangling('Climb to the prized Cathedral of St.'))
check('dangling: "of St and gardens"', !!firstCutOff('Wander the Fortress of St and gardens.'))
check('dangling: ends on of / the / and', !!dangling('Stroll through the old town of') && !!dangling('Enjoy the') && !!dangling('Sail past Hvar and.'))
check('dangling: "Cathedral of St. For beach time" (cut at the stop, next sentence began)', !!firstCutOff('Visit the House of Culture, along with the Cathedral of St. For beach time, relax at the beach.'))
check('dangling: Croatian "sv." (saint) cut off', !!dangling('Walk or cycle along the Kanal sv.') && !!dangling('Visit the Tvrđava sv.'))
check('not dangling: "Kanal sv. Ante" kept whole', firstCutOff('Walk along the Kanal sv. Ante to the harbour.') === null && one('Walk along the Kanal sv. Ante to the harbour.'))
check('itemsOfSection keeps an English "Cathedral of St. Ante" whole', itemsOfSection('\n5 Cathedral of St. Ante, Vodice. A fine old cathedral by the harbour.\n').some((i) => i.name === 'Cathedral of St. Ante'))
check('itemsOfSection drops the Croatian "Kanal sv. Ante" (no English title; names are never translated)', !itemsOfSection('\n5 Kanal sv. Ante, Vodice. A channel.\n').some((i) => /sv\./.test(i.name)))
check('not dangling: St. Thomas / St. Johns / Mt. Etna mid-sentence', firstCutOff('Charlotte Amalie in St. Thomas and St. Johns in Antigua, near Mt. Etna.') === null)
check('not dangling: sentence starter after a real abbreviation-free stop', firstCutOff('Visit the cathedral. For beach time, relax.') === null)
check('not dangling: sentences that legitimately end on to / by', firstCutOff('There is plenty to look forward to. Relax as the river rolls by. Who is this trip suited to?') === null)
check('not dangling: Church of Saint Blaise', dangling('Visit the Church of Saint Blaise.') === null)
check('not dangling: St. Lawrence full', firstCutOff('Visit the Cathedral of St. Lawrence in Trogir.') === null)
check('not dangling: ordinary sentence', firstCutOff('We sail to Hvar. Then we visit the walled city of Dubrovnik.') === null)

// ─── The gate rejects them ───────────────────────────────────────────────────────────
const g = 'Cathedral of St. Lawrence Fortress of St. Michael Dubrovnik Trogir'
check('gate rejects the exact broken line 1', tripKitBlockers('Climb to the prized Cathedral of St.', { grounding: g, field: 'thing' }).some((b) => /cut off/.test(b)))
check('gate rejects the exact broken line 2', tripKitBlockers('Stroll the Fortress of St and gardens.', { grounding: g, field: 'thing' }).some((b) => /cut off/.test(b)))
check('copyBlockers rejects it for a description too', copyBlockers('Climb to the prized Cathedral of St.', { grounding: g, field: 'full_description' }).some((b) => /cut off/.test(b)))
check('gate accepts the complete line', !tripKitBlockers('Climb to the prized Cathedral of St. Lawrence.', { grounding: g, field: 'thing' }).some((b) => /cut off/.test(b)))
check('url fields are not checked', !copyBlockers('https://example.com/of', { grounding: '', field: 'booking_url' }).some((b) => /cut off/.test(b)))
check('things-to-do: broken lines dropped, whole kept', (() => {
  const kept = tripKitThingsOk(['Climb to the prized Cathedral of St.', 'Stroll the Fortress of St and gardens.', 'Climb to the prized Cathedral of St. Lawrence.'], ['Cathedral of St. Lawrence', 'Fortress of St. Michael'], g)
  return kept.length === 1 && kept[0].endsWith('Lawrence.')
})())
check('thingBlockers flags a dangling line', thingBlockers('Wander up to the Cathedral of St.', ['Cathedral of St. Lawrence'], g).some((b) => /cut off/.test(b)))

// ─── Reference extraction keeps the full name ────────────────────────────────────────
const body = '\n5 Cathedral of St. Lawrence, Trg Ivana Pavla II. A Romanesque cathedral with a carved portal.\n6 Fortress of St. Michael (Kamerlengo), Obala. A walled fort at the edge of town.\n7 Church of Saint Blaise, Placa. A baroque church.\n'
const items = itemsOfSection(body)
check('itemsOfSection keeps "Cathedral of St. Lawrence"', items.some((i) => i.name === 'Cathedral of St. Lawrence'), items)
check('itemsOfSection keeps "Fortress of St. Michael"', items.some((i) => i.name === 'Fortress of St. Michael'), items)
check('itemsOfSection keeps Church of Saint Blaise', items.some((i) => i.name === 'Church of Saint Blaise'), items)
check('no item name ends in a bare abbreviation', items.every((i) => !/\b(St|Mt|Dr)$/.test(i.name)), items)

// ─── A fact sheet cached before the fix is never reused ──────────────────────────────
const mkSheet = (name: string, blurb: string) => ({ v: 1 as const, fetchedAt: '', rowHash: '', routeKnown: true, supplier: null, places: [{ mention: { name: 'Trogir', region: null, kind: 'city' as const, near: null }, ref: { place: 'Trogir', title: 'Trogir', label: 'Wikivoyage' as const, url: '', intro: 'A old town.', see: [{ name, blurb }], doItems: [], context: '' } }] })
check('cached sheet with "Basilica of St" is rejected', sheetHasCutOff(mkSheet('Basilica of St', 'A church.')))
check('cached sheet with a blurb ending "on St." is rejected', sheetHasCutOff(mkSheet('Museum', 'Photos of sites on St.')))
check('cached sheet with full names is kept', !sheetHasCutOff(mkSheet('Cathedral of St. Lawrence', 'A Romanesque cathedral.')))

if (failed) {
  console.log(`\n${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall sentence-safe checks passed')
