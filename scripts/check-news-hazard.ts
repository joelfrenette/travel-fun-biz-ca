// Offline self-check for the natural-hazard news sources (GDACS and USGS), added 2026-11-01. No network, no database, no paid model call.
// Run: corepack pnpm dlx tsx scripts/check-news-hazard.ts
// The fixtures are built from the REAL feed shapes fetched on 2026-11-01 (GDACS rss_24h.xml / rss_7d.xml, USGS significant_*.atom, the
// GDACS and NHC robots.txt). Where a real item at the wanted alert level did not exist that day (an Orange earthquake), it is the real
// Green earthquake item with its alert level changed, and the label says so.
import { fakeAdmin, type Db } from './fake-admin'
import { NEWS_SOURCES, inVisitWindow, isAllowedFeedUrl, isHazardSource, maxAgeMs, parseSourcesOff, sourceByKey, enabledSources } from '../lib/news-sources'
import { fetchFeed, parseFeed, robotsAllows, shapeFeedItem, type FetchDeps } from '../lib/news-feed'
import { classifyItem, hazardAdmits } from '../lib/news-relevance'
import { activeSources, expireOldItems, ingestFeeds, reevaluateItems } from '../lib/news-ingest'
import { enrollNewsIfDue } from '../lib/news-distribution'
import { briefProblems, type NewsBrief, type NewsFacts } from '../lib/news-brief'
import { itemStale, runNewsStep } from '../lib/news-run'
import type { NewsItemRow } from '../lib/news-ingest'

delete process.env.ANTHROPIC_API_KEY
globalThis.fetch = (async () => {
  throw new Error('the real network is blocked in this check')
}) as unknown as typeof fetch

let failed = 0
function check(label: string, ok: boolean, extra?: string) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` :: ${extra}` : ''}`)
}

type Row = Record<string, unknown>
const HOUR = 3_600_000
// 05:00 UTC on 2026-11-01: inside the GDACS visit window (04:00 to 06:45 UTC).
const NOW_IN = Date.parse('2026-11-01T05:00:00Z')
// 12:00 UTC: outside it.
const NOW_OUT = Date.parse('2026-11-01T12:00:00Z')
const gdacs = sourceByKey('gdacs-alerts')!
const usgs = sourceByKey('usgs-quakes')!

// ---- real robots.txt of gdacs.org (verbatim, fetched 2026-11-01) ----
const GDACS_ROBOTS = 'User-agent: *\nDisallow: \nRequest-rate: 1/60        # Visita al massimo una pagina ogni 60 secondi\nVisit-time: 0400-0645      # Visita soltanto tra le 4:00 AM e le 6:45 AM UT (GMT)\n'

// ---- real GDACS items (rss_24h / rss_7d, 2026-11-01). The <gdacs:resources> blocks are left out for size. ----
const gItem = (o: { type: string; level: string; title: string; desc: string; id: string; pub: string; link?: string; extra?: string }) => `    <item>
      <title>${o.title}</title>
      <description>${o.desc}</description>
      <enclosure type="image/png" length="1" url="https://www.gdacs.org/contentdata/resources/imgtemp/gdacs/x.png" />
      <gdacs:temporary>false</gdacs:temporary>
      <link>${o.link ?? `http://www.gdacs.org/report.aspx?eventtype=${o.type}&amp;eventid=${o.id}`}</link>
      <pubDate>${o.pub}</pubDate>
      <gdacs:dateadded>${o.pub}</gdacs:dateadded>
      <gdacs:iscurrent>true</gdacs:iscurrent>
      <dc:subject>${o.type}1</dc:subject>
      <guid isPermaLink="false">${o.type}${o.id}</guid>
      <geo:Point><geo:lat>-14.1689</geo:lat><geo:long>165.8242</geo:long></geo:Point>
      <!--gdacs:bbox format = lonmin lonmax latmin latmax-->
      <gdacs:bbox>161.8242 169.8242 -18.1689 -10.1689</gdacs:bbox>
      <gdacs:version>1</gdacs:version>
      <gdacs:eventtype>${o.type}</gdacs:eventtype>
      <gdacs:alertlevel>${o.level}</gdacs:alertlevel>
      <gdacs:episodealertlevel>${o.level}</gdacs:episodealertlevel>
      <gdacs:eventname />
      <gdacs:eventid>${o.id}</gdacs:eventid>${o.extra ?? ''}
    </item>
`
const GDACS_HEAD = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#" xmlns:gdacs="http://www.gdacs.org" xmlns:glide="http://glidenumber.net" xmlns:georss="http://www.georss.org/georss" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>GDACS RSS information</title>
    <link>http://www.gdacs.org/</link>
    <copyright>public domain</copyright>
    <description>Near real-time notification about natural disaster with a potential humanitarian impact</description>
    <!--Records number 263-->
    <pubDate>Sun, 01 Nov 2026 04:55:05 GMT</pubDate>
    <atom:link href="http://www.gdacs.org/xml/rss.xml" rel="self" type="application/rss+xml" />
`
const GDACS_TAIL = '  </channel>\n</rss>\n'
const gfeed = (...items: string[]) => GDACS_HEAD + items.join('') + GDACS_TAIL

const RED_TC = gItem({
  type: 'TC',
  level: 'Red',
  id: '1001346',
  pub: 'Sun, 01 Nov 2026 02:23:45 GMT',
  title: 'Red notification for tropical cyclone MURASU-26. Population affected by Category 1 (120 km/h) wind speeds or higher is 1.196 million .',
  desc: 'From 01/11/2026 to 01/11/2026, a Tropical Storm (maximum wind speed of 130 km/h) MURASU-26 was active in NorthIndian. The cyclone affects these countries: India (vulnerability High). Estimated population affected by category 1 (120 km/h) wind speeds or higher is 1.196 million .',
})
const GREEN_EQ = gItem({
  type: 'EQ',
  level: 'Green',
  id: '1575068',
  pub: 'Sun, 01 Nov 2026 02:02:33 GMT',
  title: 'Green earthquake (Magnitude 6M, Depth:10km) in Vanuatu 01/11/2026 11:47 UTC, 2 thousand in MMI IV.',
  desc: 'On 11/1/2026 11:47:03 AM, an earthquake occurred in Vanuatu potentially affecting 2 thousand in MMI IV. The earthquake had Magnitude 6M, Depth:10km.',
})
// DERIVED: the real Green earthquake item above with its alert level changed to Orange (no real Orange earthquake existed on 2026-11-01).
const ORANGE_EQ = gItem({
  type: 'EQ',
  level: 'Orange',
  id: '1575068',
  pub: 'Sun, 01 Nov 2026 03:10:00 GMT',
  title: 'Orange earthquake (Magnitude 6M, Depth:10km) in Vanuatu 01/11/2026 11:47 UTC, 2 thousand in MMI IV.',
  desc: 'On 11/1/2026 11:47:03 AM, an earthquake occurred in Vanuatu potentially affecting 2 thousand in MMI IV. The earthquake had Magnitude 6M, Depth:10km.',
})
const RED_EQ = gItem({
  type: 'EQ',
  level: 'Red',
  id: '1575068',
  pub: 'Sun, 01 Nov 2026 04:30:00 GMT',
  title: 'Red earthquake (Magnitude 6M, Depth:10km) in Vanuatu 01/11/2026 11:47 UTC, 2 thousand in MMI IV.',
  desc: 'On 11/1/2026 11:47:03 AM, an earthquake occurred in Vanuatu potentially affecting 2 thousand in MMI IV. The earthquake had Magnitude 6M, Depth:10km.',
})
const GREEN_WF = gItem({
  type: 'WF',
  level: 'Green',
  id: '1033409',
  pub: 'Sun, 01 Nov 2026 04:08:01 GMT',
  title: 'Green forest fire notification in Central African Republic, Sudan',
  desc: 'On 22/10/2026, a forest fire started in Central African Republic, Sudan,  until 01/11/2026.',
})
const ORANGE_DR = gItem({
  type: 'DR',
  level: 'Orange',
  id: '1016000',
  pub: 'Sun, 01 Nov 2026 04:00:00 GMT',
  title: 'Drought is on going in Democratic Republic of Congo, Central African Republic, Cameroon, Eritrea, Ethiopia, Kenya, Niger, Nigeria, Sudan, South Sudan, Chad, Tanzania, Uganda',
  desc: 'The  Drought notification level is Orange.',
})
const GREEN_FL = gItem({
  type: 'FL',
  level: 'Green',
  id: '1102800',
  pub: 'Sun, 01 Nov 2026 03:30:00 GMT',
  title: 'Green flood alert in Bhutan',
  desc: 'On 29/10/2026, a flood started in Bhutan, lasting until 31/10/2026 (last update). The flood caused 0 deaths and 200 displaced .',
})
// DERIVED: a flood at Orange, same wording as the real Green flood item.
const ORANGE_FL = gItem({
  type: 'FL',
  level: 'Orange',
  id: '1102801',
  pub: 'Sun, 01 Nov 2026 03:31:00 GMT',
  title: 'Orange flood alert in Indonesia',
  desc: 'On 24/10/2026, a flood started in Indonesia, lasting until 31/10/2026 (last update). The flood caused 3 deaths and 4662 displaced .',
})

// ---- real USGS Atom shapes ----
const USGS_WEEK = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:georss="http://www.georss.org/georss"><title>USGS Significant Earthquakes, Past Week</title><updated>2026-11-01T21:59:45Z</updated><author><name>U.S. Geological Survey</name><uri>https://earthquake.usgs.gov/</uri></author><id>https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.atom</id><link rel="self" href="https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.atom"/><icon>https://earthquake.usgs.gov/favicon.ico</icon>
<entry><id>urn:earthquake-usgs-gov:us:7000ttxz</id><title>M 6.4 - southeast of Easter Island</title><updated>2026-10-30T10:38:47.040Z</updated><link rel="alternate" type="text/html" href="https://earthquake.usgs.gov/earthquakes/eventpage/us7000ttxz"/><summary type="html"><![CDATA[<p class="quicksummary"><a href="https://earthquake.usgs.gov/earthquakes/eventpage/us7000ttxz#pager" title="PAGER estimated impact alert level" class="pager-green">PAGER - <strong class="roman">GREEN</strong></a> <a href="https://earthquake.usgs.gov/earthquakes/eventpage/us7000ttxz#shakemap" title="ShakeMap maximum estimated intensity" class="mmi-I">ShakeMap - <strong class="roman">I</strong></a></p><dl><dt>Time</dt><dd>2026-10-29 07:49:50 UTC</dd><dd>2026-10-29 07:49:50 UTC at epicenter</dd><dt>Location</dt><dd>36.406&deg;S 98.049&deg;W</dd><dt>Depth</dt><dd>10.00 km (6.21 mi)</dd></dl>]]></summary><georss:point>-36.4058 -98.0489</georss:point><georss:elev>-10000</georss:elev><category label="Age" term="Past Week"/><category label="Magnitude" term="Magnitude 6"/><category label="Contributor" term="us"/><category label="Author" term="us"/></entry>
</feed>
`
// The real "past day" answer of 2026-11-01: a valid Atom feed with NO entry (559 bytes).
const USGS_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:georss="http://www.georss.org/georss"><title>USGS Significant Earthquakes, Past Day</title><updated>2026-11-01T22:11:53Z</updated><author><name>U.S. Geological Survey</name><uri>https://earthquake.usgs.gov/</uri></author><id>https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_day.atom</id><link rel="self" href="https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_day.atom"/><icon>https://earthquake.usgs.gov/favicon.ico</icon>
</feed>
`
// A fresh quake (the real week entry moved to 2 hours before the run) for the ingest checks.
const usgsFresh = (nowMs: number, ageH: number) => USGS_WEEK.replace('2026-10-30T10:38:47.040Z', new Date(nowMs - ageH * HOUR).toISOString())

function feedDeps(routes: Record<string, string>, nowMs: () => number, robots = ''): FetchDeps & { log: string[] } {
  const log: string[] = []
  return {
    log,
    now: nowMs,
    fetch: (async (url: string) => {
      log.push(String(url))
      if (String(url).endsWith('/robots.txt')) return robots ? new Response(robots, { status: 200, headers: { 'content-type': 'text/plain' } }) : new Response('', { status: 404 })
      const r = routes[String(url)]
      if (r === undefined) return new Response('', { status: 404 })
      return new Response(r, { status: 200, headers: { 'content-type': 'application/xml' } })
    }) as unknown as typeof fetch,
  }
}
const world = (settings: Record<string, string> = {}, tables: Record<string, Row[]> = {}) => {
  const db: Db = { tables: { app_settings: Object.entries(settings).map(([key, value]) => ({ key, value })), ...tables } }
  return { db, admin: fakeAdmin(db) }
}
const rowsOf = (db: Db, t: string) => db.tables[t] ?? []

async function main() {
  // ------------------------------------------------------------------------------------------------
  // 1. The registry
  // ------------------------------------------------------------------------------------------------
  check('registry: both hazard sources exist, are tier 1, https, enabled and flagged hazard', [gdacs, usgs].every((s) => s && s.hazard === true && s.tier === 1 && s.enabled && s.feedUrl.startsWith('https://') && s.confidence === 'verified'))
  check('registry: their feed urls are on the allowlist', isAllowedFeedUrl(gdacs.feedUrl) && isAllowedFeedUrl(usgs.feedUrl))
  check('registry: no other source is a hazard source (the advisory feeds are untouched)', NEWS_SOURCES.filter((s) => s.hazard).map((s) => s.key).join() === 'gdacs-alerts,usgs-quakes')
  check('registry: every source key still fits the news_sources_off key pattern, so the admin switch works for the new ones', NEWS_SOURCES.every((s) => parseSourcesOff(s.key).has(s.key)))
  check('registry: Joint Typhoon Warning Center and Smartraveller are NOT in the allowlist (refused, see docs section 10)', !NEWS_SOURCES.some((s) => /metoc\.navy\.mil|smartraveller/.test(s.feedUrl)) && enabledSources().every((s) => s.confidence !== 'unverified'))
  check('hazard: isHazardSource is true for the two and false for the advisory feeds and trade outlets', isHazardSource('gdacs-alerts') && isHazardSource('usgs-quakes') && !isHazardSource('us-state-dept') && !isHazardSource('nhc-atlantic') && !isHazardSource('skift') && !isHazardSource(undefined))

  // ------------------------------------------------------------------------------------------------
  // 2. robots.txt and the visit window
  // ------------------------------------------------------------------------------------------------
  check('robots: the real GDACS robots.txt (empty Disallow plus the non-standard Request-rate and Visit-time lines) allows the feed', robotsAllows(GDACS_ROBOTS, '/xml/rss_24h.xml'))
  check('robots: an empty robots.txt (USGS answers 404) allows the feed', robotsAllows('', '/earthquakes/feed/v1.0/summary/significant_day.atom'))
  check('window: GDACS is inside its window at 04:00 and 06:44 UTC, outside at 03:59, 06:45 and noon', inVisitWindow(gdacs, Date.parse('2026-11-01T04:00:00Z')) && inVisitWindow(gdacs, Date.parse('2026-11-01T06:44:00Z')) && !inVisitWindow(gdacs, Date.parse('2026-11-01T03:59:00Z')) && !inVisitWindow(gdacs, Date.parse('2026-11-01T06:45:00Z')) && !inVisitWindow(gdacs, NOW_OUT))
  check('window: USGS and every older source have no window', inVisitWindow(usgs, NOW_OUT) && NEWS_SOURCES.filter((s) => s.visitWindowUtc).map((s) => s.key).join() === 'gdacs-alerts')

  // ------------------------------------------------------------------------------------------------
  // 3. Parsing the real shapes
  // ------------------------------------------------------------------------------------------------
  const full = gfeed(RED_TC, GREEN_EQ, ORANGE_EQ, GREEN_WF, ORANGE_DR, GREEN_FL, ORANGE_FL)
  const parsed = parseFeed(full, { now: NOW_IN, maxBytes: gdacs.maxBytes, maxItems: gdacs.maxItems, upgradeHttpHosts: gdacs.linkHosts })
  check('gdacs parse: RSS read, all 7 items, none skipped (links are http:// in the real feed and are upgraded to https)', parsed.format === 'rss' && parsed.items.length === 7 && parsed.skipped === 0, JSON.stringify({ f: parsed.format, n: parsed.items.length, s: parsed.skipped }))
  check('gdacs parse: every link is https on gdacs.org with the query kept', parsed.items.every((i) => i.url.startsWith('https://www.gdacs.org/report.aspx?eventtype=') && /eventid=\d+$/.test(i.url)))
  check('gdacs parse: without the upgrade option the http:// links are skipped (nothing is upgraded for other sources)', parseFeed(full, { now: NOW_IN, maxItems: 150, maxBytes: 1_500_000 }).items.length === 0)
  const tc = parsed.items[0]
  check('gdacs parse: title, summary, guid, date, alert level and event type of the real Red cyclone', tc.title.startsWith('Red notification for tropical cyclone MURASU-26') && tc.summary.includes('NorthIndian') && tc.guid === 'TC1001346' && tc.publishedAt === '2026-11-01T02:23:45.000Z' && tc.alertLevel === 'red' && tc.eventType === 'TC', JSON.stringify(tc))
  check('gdacs parse: episodealertlevel is not mistaken for alertlevel; DR and WF types are read', parsed.items.map((i) => `${i.eventType}:${i.alertLevel}`).join() === 'TC:red,EQ:green,EQ:orange,WF:green,DR:orange,FL:green,FL:orange')
  check('gdacs parse: only the short description is kept, no HTML, at most 600 characters', parsed.items.every((i) => i.summary.length <= 600 && !/[<>]/.test(i.summary)))
  check('gdacs parse: the 24 hour feed size class is within the source cap (a real one was 360 KB, the cap is 1.5 MB)', (gdacs.maxBytes ?? 0) >= 1_000_000 && full.length < (gdacs.maxBytes ?? 0))
  check('gdacs parse: a feed over the source cap is refused', parseFeed('x'.repeat((gdacs.maxBytes ?? 0) + 1), { maxBytes: gdacs.maxBytes }).error !== undefined)
  const shapedOrange = shapeFeedItem('gdacs-alerts', parsed.items[2])
  const shapedRed = shapeFeedItem('gdacs-alerts', { ...parsed.items[2], alertLevel: 'red' })
  check('gdacs shape: the alert level joins the guid, so Orange then Red of one event are two items and one level is one item', shapedOrange.guid === 'EQ1575068:orange' && shapedRed.guid === 'EQ1575068:red' && shapeFeedItem('gdacs-alerts', shapedOrange).guid === 'EQ1575068:orange')
  check('gdacs shape: no other source is reshaped by it', shapeFeedItem('skift', parsed.items[2]).guid === 'EQ1575068')

  const uw = parseFeed(USGS_WEEK, { now: NOW_IN, maxBytes: usgs.maxBytes, maxItems: usgs.maxItems })
  check('usgs parse: Atom read, one entry with title, https event link, id and updated date', uw.format === 'atom' && uw.items.length === 1 && uw.items[0].title === 'M 6.4 - southeast of Easter Island' && uw.items[0].url === 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000ttxz' && uw.items[0].guid === 'urn:earthquake-usgs-gov:us:7000ttxz' && uw.items[0].publishedAt === '2026-10-30T10:38:47.040Z', JSON.stringify(uw.items[0]))
  check('usgs parse: the HTML summary becomes plain text', !/[<>]/.test(uw.items[0].summary) && uw.items[0].summary.includes('Depth 10.00 km') && uw.items[0].summary.includes('PAGER - GREEN'), uw.items[0].summary)
  const ue = parseFeed(USGS_EMPTY, { now: NOW_IN, maxBytes: usgs.maxBytes, maxItems: usgs.maxItems })
  check('usgs parse: the real EMPTY past-day feed is a valid Atom feed with zero items, not an error', ue.format === 'atom' && ue.items.length === 0 && ue.error === undefined, JSON.stringify(ue))
  check('usgs parse: a web page or an RSS feed with no items is still handled as before (page = error, empty RSS = zero items)', parseFeed('<html><body>hi</body></html>').error !== undefined && parseFeed('<rss><channel><title>x</title></channel></rss>').items.length === 0 && parseFeed('<rss><channel><title>x</title></channel></rss>').error === undefined)

  // ------------------------------------------------------------------------------------------------
  // 4. Relevance: Orange and Red only, five event types, a hazard stays a hazard
  // ------------------------------------------------------------------------------------------------
  const verdicts = parsed.items.map((i) => `${i.eventType}:${hazardAdmits(gdacs, i).ok ? 'keep' : 'drop'}`).join()
  check('relevance: Red cyclone, Orange earthquake and Orange flood are kept; Green earthquake, Green wildfire, Green flood and Orange DROUGHT are dropped', verdicts === 'TC:keep,EQ:drop,EQ:keep,WF:drop,DR:drop,FL:drop,FL:keep', verdicts)
  check('relevance: a Green alert gets a plain reason, a drought another', /Green alert/.test(hazardAdmits(gdacs, parsed.items[1]).reason) && /event type/.test(hazardAdmits(gdacs, parsed.items[4]).reason))
  check('relevance: an item with no alert level or no event type is dropped (unknown shape fails closed)', !hazardAdmits(gdacs, { eventType: 'EQ' }).ok && !hazardAdmits(gdacs, { alertLevel: 'red' }).ok && hazardAdmits(usgs, {}).ok)
  check('relevance: wildfire and volcano Orange/Red would be kept (types WF and VO are on the list), tsunami is not', hazardAdmits(gdacs, { eventType: 'WF', alertLevel: 'orange' }).ok && hazardAdmits(gdacs, { eventType: 'VO', alertLevel: 'red' }).ok && !hazardAdmits(gdacs, { eventType: 'TS', alertLevel: 'red' }).ok)
  check('relevance: the cyclone is category storm, the earthquake and flood are category disaster', classifyItem(gdacs, { title: tc.title, summary: tc.summary }).category === 'storm' && classifyItem(gdacs, { title: parsed.items[2].title, summary: parsed.items[2].summary }).category === 'disaster' && classifyItem(usgs, { title: uw.items[0].title, summary: uw.items[0].summary }).category === 'disaster')
  const visaQuake = classifyItem(usgs, { title: 'M 6.9 - near the coast of Peru', summary: 'Visa rules, a travel advisory, do not travel, entry requirements and a border closure were mentioned.' })
  check('relevance: a quake is NEVER filed as an advisory, entry or any other category, whatever words it carries', visaQuake.relevant && visaQuake.category === 'disaster')
  check('relevance: every hazard category is storm or disaster, never advisory', [gdacs, usgs].every((s) => s.defaultCategory === 'disaster'))
  check('relevance: stored rows are re-judged by classifyItem alone (no alert level is stored), and a hazard row stays relevant', classifyItem(gdacs, { title: parsed.items[6].title, summary: parsed.items[6].summary }).relevant)

  // ------------------------------------------------------------------------------------------------
  // 5. Fetching: robots, the visit window, the cap
  // ------------------------------------------------------------------------------------------------
  {
    const d = feedDeps({ [gdacs.feedUrl]: full }, () => NOW_IN, GDACS_ROBOTS)
    const out = await fetchFeed(gdacs, { fails: 0 }, d)
    check('fetch: GDACS with its real robots.txt reads robots.txt first, then exactly the feed url', out.kind === 'ok' && d.log.length === 2 && d.log[0] === 'https://www.gdacs.org/robots.txt' && d.log[1] === gdacs.feedUrl, d.log.join(' '))
    const blocked = await fetchFeed(gdacs, { fails: 0 }, feedDeps({ [gdacs.feedUrl]: full }, () => NOW_IN, 'User-agent: *\nDisallow: /xml/\n'))
    check('fetch: if GDACS ever disallows the feed in robots.txt, it is not read', blocked.kind === 'error' && /robots/.test(blocked.error))
    const big = await fetchFeed(gdacs, { fails: 0, robotsAt: new Date(NOW_IN - 60_000).toISOString(), robotsAllowed: true }, feedDeps({ [gdacs.feedUrl]: 'y'.repeat((gdacs.maxBytes ?? 0) + 10) }, () => NOW_IN))
    check('fetch: a GDACS answer over its own byte cap is refused', big.kind === 'error')
  }

  // ------------------------------------------------------------------------------------------------
  // 6. Ingest: GDACS
  // ------------------------------------------------------------------------------------------------
  {
    const { db, admin } = world()
    const deps = feedDeps({ [gdacs.feedUrl]: full }, () => NOW_OUT, GDACS_ROBOTS)
    const outside = await ingestFeeds(admin, { fetchDeps: deps, now: new Date(NOW_OUT), sources: [gdacs] })
    check('ingest gdacs: outside 04:00 to 06:45 UTC the feed is not touched at all (no request, no failure, no attempt recorded)', deps.log.length === 0 && outside.waiting.join() === 'gdacs-alerts' && outside.fetched.length === 0 && outside.failed.length === 0 && rowsOf(db, 'app_settings').length === 0, JSON.stringify(outside))
  }
  {
    const { db, admin } = world()
    const deps = feedDeps({ [gdacs.feedUrl]: full }, () => NOW_IN, GDACS_ROBOTS)
    const r = await ingestFeeds(admin, { fetchDeps: deps, now: new Date(NOW_IN), sources: [gdacs] })
    const stored = rowsOf(db, 'news_items')
    check('ingest gdacs: inside the window it reads once and stores only the Red cyclone, the Orange earthquake and the Orange flood', r.fetched.join() === 'gdacs-alerts' && stored.length === 3 && stored.map((x) => String(x.guid)).sort().join() === 'EQ1575068:orange,FL1102801:orange,TC1001346:red', stored.map((x) => x.guid).join())
    // The read stops at the source cap (3 new items), so how many of the four unwanted items were looked at before that depends on the order.
    check('ingest gdacs: the Green earthquake, Green wildfire, Green flood and the Orange drought are never stored (counted as not relevant)', r.notRelevant >= 1 && stored.every((x) => !/Green|Drought|forest fire/.test(String(x.title))), String(r.notRelevant))
    check('ingest gdacs: stored with tier 1, an https gdacs.org link, status new; the cyclone is storm, the others disaster', stored.every((x) => x.tier === 1 && x.status === 'new' && String(x.url).startsWith('https://www.gdacs.org/report.aspx')) && stored.find((x) => x.guid === 'TC1001346:red')?.category === 'storm' && stored.filter((x) => x.category === 'disaster').length === 2)
    // a second read in the same window, 31 minutes later: the same events are duplicates, a raised alert is NEW
    const t2 = NOW_IN + 31 * 60_000
    const redLater = gfeed(RED_TC, RED_EQ, ORANGE_FL)
    const r2 = await ingestFeeds(admin, { fetchDeps: feedDeps({ [gdacs.feedUrl]: redLater }, () => t2, GDACS_ROBOTS), now: new Date(t2), sources: [gdacs] })
    const after = rowsOf(db, 'news_items')
    check('ingest gdacs: a later read keeps the same cyclone and flood as duplicates and stores the earthquake raised from Orange to Red as a new item', r2.stored === 1 && after.length === 4 && after.some((x) => x.guid === 'EQ1575068:red') && r2.duplicates >= 2, JSON.stringify({ r2, guids: after.map((x) => x.guid) }))
  }
  {
    // The per-read cap: more than 3 new Orange/Red items in one read store only 3.
    const many = gfeed(...[1, 2, 3, 4, 5].map((n) => gItem({ type: 'FL', level: 'Orange', id: String(2000 + n), pub: 'Sun, 01 Nov 2026 04:00:00 GMT', title: `Orange flood alert in Place${'abcde'[n - 1]} Land`, desc: `On 30/10/2026, a flood started in Place${'abcde'[n - 1]} Land.` })))
    const { db, admin } = world()
    const r = await ingestFeeds(admin, { fetchDeps: feedDeps({ [gdacs.feedUrl]: many }, () => NOW_IN), now: new Date(NOW_IN), sources: [gdacs] })
    check('ingest gdacs: at most 3 new items are stored per read (the source cap), however many Orange events the feed lists', r.stored === 3 && rowsOf(db, 'news_items').length === 3, String(r.stored))
  }
  {
    // 36 hour freshness: an Orange event published 40 hours ago is not stored; one from 30 hours ago is.
    const old = gfeed(gItem({ type: 'EQ', level: 'Orange', id: '9001', pub: new Date(NOW_IN - 40 * HOUR).toUTCString(), title: 'Orange earthquake (Magnitude 6.1M, Depth:10km) in Chile', desc: 'An earthquake occurred in Chile. The earthquake had Magnitude 6.1M, Depth:10km.' }), gItem({ type: 'EQ', level: 'Orange', id: '9002', pub: new Date(NOW_IN - 30 * HOUR).toUTCString(), title: 'Orange earthquake (Magnitude 6.2M, Depth:10km) in Peru', desc: 'An earthquake occurred in Peru. The earthquake had Magnitude 6.2M, Depth:10km.' }))
    const { db, admin } = world()
    const r = await ingestFeeds(admin, { fetchDeps: feedDeps({ [gdacs.feedUrl]: old }, () => NOW_IN), now: new Date(NOW_IN), sources: [gdacs] })
    check('ingest gdacs: a hazard item is fresh for 36 hours (40 hours old = too old, 30 hours old = stored), not for 7 days', r.tooOld === 1 && rowsOf(db, 'news_items').length === 1 && String(rowsOf(db, 'news_items')[0].guid).startsWith('EQ9002'), JSON.stringify(r))
  }
  {
    // The failure counter is not touched by the window, and a bad feed still counts as a failure inside it.
    const { db, admin } = world()
    const r = await ingestFeeds(admin, { fetchDeps: feedDeps({ [gdacs.feedUrl]: '<html>blocked</html>' }, () => NOW_IN), now: new Date(NOW_IN), sources: [gdacs] })
    void db
    check('ingest gdacs: a web page instead of the feed is one failure, as for every source', r.failed.length === 1 && r.failed[0].key === 'gdacs-alerts')
  }

  // ------------------------------------------------------------------------------------------------
  // 7. Ingest: USGS
  // ------------------------------------------------------------------------------------------------
  {
    const { db, admin } = world()
    const r = await ingestFeeds(admin, { fetchDeps: feedDeps({ [usgs.feedUrl]: USGS_EMPTY }, () => NOW_OUT), now: new Date(NOW_OUT), sources: [usgs] })
    const st = JSON.parse(String(rowsOf(db, 'app_settings').find((x) => x.key === 'news_feed_state:usgs-quakes')?.value ?? '{}')) as { fails?: number; lastError?: string }
    check('ingest usgs: the real EMPTY past-day feed is a good read: no failure, no item, the failure counter stays 0', r.failed.length === 0 && r.stored === 0 && r.fetched.join() === 'usgs-quakes' && (st.fails ?? 0) === 0 && !st.lastError, JSON.stringify({ r, st }))
  }
  {
    const { db, admin } = world()
    const r = await ingestFeeds(admin, { fetchDeps: feedDeps({ [usgs.feedUrl]: usgsFresh(NOW_OUT, 2) }, () => NOW_OUT), now: new Date(NOW_OUT), sources: [usgs] })
    const stored = rowsOf(db, 'news_items')
    check('ingest usgs: a significant quake is stored (no alert-level filter: USGS already chose significant), tier 1, category disaster, https usgs.gov link', r.stored === 1 && stored[0].category === 'disaster' && stored[0].tier === 1 && stored[0].source_key === 'usgs-quakes' && String(stored[0].url).startsWith('https://earthquake.usgs.gov/earthquakes/eventpage/'), JSON.stringify(r))
    const stale = world()
    const r2 = await ingestFeeds(stale.admin, { fetchDeps: feedDeps({ [usgs.feedUrl]: usgsFresh(NOW_OUT, 40) }, () => NOW_OUT), now: new Date(NOW_OUT), sources: [usgs] })
    check('ingest usgs: an entry last updated 40 hours ago is too old (36 hour life)', r2.stored === 0 && r2.tooOld === 1)
  }
  {
    const evil = USGS_WEEK.replace('https://earthquake.usgs.gov/earthquakes/eventpage/us7000ttxz"/><summary', 'https://evil.example.com/quake"/><summary').replace('2026-10-30T10:38:47.040Z', new Date(NOW_OUT - HOUR).toISOString())
    const { db, admin } = world()
    const r = await ingestFeeds(admin, { fetchDeps: feedDeps({ [usgs.feedUrl]: evil }, () => NOW_OUT), now: new Date(NOW_OUT), sources: [usgs] })
    check('ingest usgs: an item linking to another host is dropped (link host check applies as for every source)', r.offSite === 1 && rowsOf(db, 'news_items').length === 0)
  }

  // ------------------------------------------------------------------------------------------------
  // 8. Switch off without a deploy
  // ------------------------------------------------------------------------------------------------
  {
    const { admin } = world({ news_sources_off: 'gdacs-alerts, usgs-quakes' })
    const active = (await activeSources(admin)).map((s) => s.key)
    check('switch: news_sources_off removes the hazard feeds from the active list and leaves the others', !active.includes('gdacs-alerts') && !active.includes('usgs-quakes') && active.includes('nhc-atlantic') && active.includes('skift'))
    const on = world()
    const activeOn = (await activeSources(on.admin)).map((s) => s.key)
    check('switch: with nothing switched off both hazard feeds are active', activeOn.includes('gdacs-alerts') && activeOn.includes('usgs-quakes'))
    const deps = feedDeps({ [usgs.feedUrl]: usgsFresh(NOW_OUT, 2), [gdacs.feedUrl]: full }, () => NOW_IN, GDACS_ROBOTS)
    const r = await runNewsStep(admin, { fetchDeps: deps, now: new Date(NOW_IN), model: async () => null, ping: async () => undefined })
    check('switch: a news step with both switched off reads neither feed', !!r && deps.log.every((u) => !u.includes('gdacs.org') && !u.includes('usgs.gov')), deps.log.join(' '))
  }

  // ------------------------------------------------------------------------------------------------
  // 9. Staleness and expiry
  // ------------------------------------------------------------------------------------------------
  {
    check('age: maxAgeMs is 36 hours for a hazard source in category disaster, 7 days for the same category from a trade source', maxAgeMs('disaster', false, 'usgs-quakes') === 36 * HOUR && maxAgeMs('disaster', false, 'gdacs-alerts') === 36 * HOUR && maxAgeMs('disaster', false, 'skift') === 7 * 24 * HOUR && maxAgeMs('disaster', false) === 7 * 24 * HOUR)
    const base = { id: 'x', guid: 'g', url: 'https://x', title: 'M 6.4 - near Peru', summary_raw: 'Depth 10 km', fetched_at: new Date(NOW_OUT - 40 * HOUR).toISOString(), published_at: new Date(NOW_OUT - 40 * HOUR).toISOString(), category: 'disaster', tier: 1, status: 'new', reject_reason: null, post_slug: null, decided_at: null, created_at: '' } as NewsItemRow
    check('age: a 40 hour old quake is stale for the writer, a 40 hour old trade disaster item is not', itemStale({ ...base, source_key: 'usgs-quakes' }, NOW_OUT) && !itemStale({ ...base, source_key: 'skift', tier: 2 }, NOW_OUT))
    const w = world({}, { news_items: [{ ...base, id: 'a', source_key: 'usgs-quakes' }, { ...base, id: 'b', source_key: 'skift', tier: 2 }] })
    const expired = await expireOldItems(w.admin, new Date(NOW_OUT))
    check('age: the expiry pass expires the 40 hour old quake and leaves the trade item', expired === 1 && rowsOf(w.db, 'news_items').find((x) => x.id === 'a')?.status === 'expired' && rowsOf(w.db, 'news_items').find((x) => x.id === 'b')?.status === 'new')
    const re = world({}, { news_items: [{ ...base, id: 'c', source_key: 'gdacs-alerts', status: 'new', fetched_at: new Date(NOW_OUT).toISOString(), published_at: new Date(NOW_OUT - HOUR).toISOString() }] })
    check('re-check: a stored hazard row is not expired by the relevance re-check', (await reevaluateItems(re.admin)) === 0 && rowsOf(re.db, 'news_items')[0].status === 'new')
  }

  // ------------------------------------------------------------------------------------------------
  // 10. Never social
  // ------------------------------------------------------------------------------------------------
  {
    const post = { slug: 'news-quake-near-peru', title: 'News: Quake near Peru', status: 'published' }
    const items = (key: string) => [{ id: 'i1', source_key: key, post_slug: post.slug, status: 'published' }]
    const settings = { distribution_mode: 'auto', news_social_posts: 'true' }
    const hz = world(settings, { news_items: items('usgs-quakes') })
    check('social: a published hazard brief (found by its post slug) is NOT enrolled, even with distribution on auto and news on social on', (await enrollNewsIfDue(hz.admin, post, 2)) === 'skipped' && rowsOf(hz.db, 'post_distribution').length === 0)
    const hz2 = world(settings, { news_items: items('gdacs-alerts') })
    check('social: the same when the caller names the source key', (await enrollNewsIfDue(hz2.admin, { ...post, sourceKey: 'gdacs-alerts' }, 2)) === 'skipped' && rowsOf(hz2.db, 'post_distribution').length === 0)
    const lie = world(settings, { news_items: items('usgs-quakes') })
    check('social: a caller that names a non-hazard source key cannot override the news item row (it still says hazard, so nothing is enrolled)', (await enrollNewsIfDue(lie.admin, { ...post, sourceKey: 'nhc-atlantic' }, 2)) === 'skipped' && rowsOf(lie.db, 'post_distribution').length === 0)
    const ok2 = world(settings, { news_items: [{ id: 'i2', source_key: 'us-state-dept', post_slug: 'news-haiti', status: 'published' }] })
    check('social: an advisory brief found by its post slug is enrolled', (await enrollNewsIfDue(ok2.admin, { slug: 'news-haiti', title: 'News: Haiti', status: 'published' }, 2)) === 'enrolled' && rowsOf(ok2.db, 'post_distribution').length === 1)
    const none = world(settings)
    check('social: a news post with no news item row at all keeps the old behaviour (enrolled)', (await enrollNewsIfDue(none.admin, { slug: 'news-orphan', title: 'News: x', status: 'published' }, 2)) === 'enrolled')
    // an unreadable news_items lookup fails closed
    const broken = new Proxy(world(settings).admin, {
      get: (t, k) => {
        if (k !== 'from') return (t as unknown as Record<string | symbol, unknown>)[k]
        return (table: string) => {
          if (table !== 'news_items') return (t as unknown as { from: (x: string) => unknown }).from(table)
          const err: unknown = new Proxy(() => undefined, { get: (_o, p) => (p === 'then' ? (res: (v: unknown) => unknown) => res({ data: null, error: { message: 'down' } }) : () => err), apply: () => err })
          return err
        }
      },
    }) as ReturnType<typeof fakeAdmin>
    check('social: when the news item cannot be read, nothing is enrolled (fail closed)', (await enrollNewsIfDue(broken, post, 2)) === 'skipped')
  }

  // ------------------------------------------------------------------------------------------------
  // 11. Quality gates and the whole step: a hazard item is written by the SAME gate and judge, and never reaches social
  // ------------------------------------------------------------------------------------------------
  {
    const facts: NewsFacts = { sourceName: gdacs.name, tier: 1, title: tc.title, summary: tc.summary, url: tc.url, publishedAt: tc.publishedAt, category: 'storm' }
    const GOOD: NewsBrief = {
      headline: 'Red notification for tropical cyclone MURASU-26',
      happened: 'The Global Disaster Alert and Coordination System (GDACS) reports a Red notification for tropical cyclone MURASU-26.',
      means: ['The source says the cyclone affects these countries: India.', 'According to the source, a Tropical Storm with maximum wind speed of 130 km/h was active in NorthIndian.'],
    }
    const good = briefProblems(GOOD, facts)
    check('gate: a brief that only repeats the GDACS headline and description passes the tier 1 gate', good.length === 0, good.join(' | '))
    check('gate: invented detail is refused (a death toll, a landfall, a coast, a forecast, a number)', briefProblems({ ...GOOD, means: [...GOOD.means, 'The source says the cyclone will make landfall near Chennai and 40 people died.'] }, facts).length > 0 && briefProblems({ ...GOOD, means: ['The source says the cyclone is expected to strengthen.'] }, facts).length > 0)
    check('gate: advice is refused (an earthquake or cyclone brief cannot tell anyone what to do)', briefProblems({ ...GOOD, means: ['The source says travellers should avoid India.'] }, facts).some((p) => /advice/.test(p)))
    const qfacts: NewsFacts = { sourceName: usgs.name, tier: 1, title: uw.items[0].title, summary: uw.items[0].summary, url: uw.items[0].url, publishedAt: uw.items[0].publishedAt, category: 'disaster' }
    check('gate: a quake brief that adds a damage or tsunami claim not in the USGS item is refused', briefProblems({ headline: 'Magnitude 6.4 quake near Easter Island', happened: 'The US Geological Survey reports an earthquake southeast of Easter Island.', means: ['The source says the earthquake caused damage and a tsunami warning.'] }, qfacts).length > 0)

    // The whole step in publish mode with news-on-social ON and distribution ON: the brief goes live, the ledger stays empty.
    const mk = (settings: Record<string, string> = {}) => world({ travel_news_mode: 'publish', travel_news_per_day: '2', distribution_mode: 'auto', news_social_posts: 'true', ...settings })
    const judgeOk = '{"pass":true,"failures":[]}'
    const model = async (prompt: string) => (/independent fact checker/.test(prompt) ? judgeOk : JSON.stringify(GOOD))
    const redOnly = gfeed(RED_TC)
    const w = mk()
    const r = await runNewsStep(w.admin, { fetchDeps: feedDeps({ [gdacs.feedUrl]: redOnly }, () => NOW_IN, GDACS_ROBOTS), model, now: new Date(NOW_IN), sources: [gdacs], ping: async () => undefined })
    const items = rowsOf(w.db, 'news_items')
    const posts = rowsOf(w.db, 'posts')
    check('step: the hazard item goes through the writer, the gate and the judge and is published as a news post', !!r && r.ok && items.length === 1 && items[0].status === 'published' && posts.length === 1 && posts[0].status === 'published' && String(posts[0].slug).startsWith('news-'), JSON.stringify({ r, items: items.map((x) => [x.status, x.reject_reason]) }))
    check('step: and NOTHING is enrolled for social posting (post_distribution stays empty) although social is switched on', rowsOf(w.db, 'post_distribution').length === 0)
    const body = String(posts[0]?.body ?? '')
    check('step: the post carries the official link on gdacs.org and the GDACS name, and says nothing about advisories', body.includes('https://www.gdacs.org/report.aspx?eventtype=TC&eventid=1001346') && body.includes('Global Disaster Alert and Coordination System') && !/travel advisory level/i.test(body), body.slice(0, 400))
    check('step: no country advisory page or log row was written for a hazard item', rowsOf(w.db, 'country_advisories').length === 0 && rowsOf(w.db, 'country_advisory_log').length === 0)
    // The control: the same step with an unfit brief writes nothing live.
    const w2 = mk()
    const r2 = await runNewsStep(w2.admin, { fetchDeps: feedDeps({ [gdacs.feedUrl]: redOnly }, () => NOW_IN, GDACS_ROBOTS), model: async (p) => (/independent fact checker/.test(p) ? judgeOk : JSON.stringify({ ...GOOD, means: ['The source says the cyclone will hit Chennai with 200 km/h winds and 12 people died.'] })), now: new Date(NOW_IN), sources: [gdacs], ping: async () => undefined })
    check('step: a brief with invented detail is rejected by the gate and nothing goes live', !!r2 && rowsOf(w2.db, 'posts').filter((p) => p.status === 'published').length === 0 && rowsOf(w2.db, 'news_items')[0]?.status === 'rejected', JSON.stringify(rowsOf(w2.db, 'news_items').map((x) => [x.status, x.reject_reason])))
  }

  if (failed) {
    console.log(`\n${failed} hazard news check(s) FAILED.`)
    process.exit(1)
  }
  console.log('\nAll hazard news checks passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
