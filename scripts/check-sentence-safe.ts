// Self-check: abbreviation-aware sentence splitting and the cut-off gate (trip kit and trip copy).
// Run: pnpm dlx tsx scripts/check-sentence-safe.ts
import { splitSentencesSafe, dangling, firstCutOff } from '../lib/sentence-safe'
import { splitSentences, itemsOfSection } from '../lib/trip-kit-facts'
import { tripKitBlockers, thingBlockers, tripKitThingsOk } from '../lib/trip-kit-gate'
import { copyBlockers } from '../lib/package-enrich'

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

if (failed) {
  console.log(`\n${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall sentence-safe checks passed')
