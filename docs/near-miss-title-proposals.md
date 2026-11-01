# Near-miss title and description proposals

Source: Search Console, last 28 days. These pages already show in Google but get few or no clicks. Nothing below has been
applied to the database. Each proposal was written only from text that is on the live page (read 2026-11-01) and run through
`tripGate` / `ctrGate` from `lib/ctr-loop.ts` (no price words, no month the page does not name, no numbers or names that are not
on the page, no long dashes, no exclamation marks, title 20 to 60 characters, description 70 to 155 characters). All passed.

## Where each page's copy lives

| Page | Title and description come from | H1 and first paragraph come from | How to change it |
| --- | --- | --- | --- |
| `/packages/australia-new-zealand` | `travel_packages.meta_title` / `meta_description` (DB), then `tripTitle()` in `lib/package-seo.ts` at render time | `travel_packages.name` through `tripHeading()` (already renders "from Canada"); first line is `short_description` (DB) | Admin package editor, or the CTR loop trip proposals (`ctr_trip_proposals`) |
| `/packages/tahitian-tropical-escape` | `travel_packages.meta_title` / `meta_description` (DB) | `travel_packages.name`; first line is `short_description` (DB) | Admin package editor, or CTR loop trip proposals |
| `/resorts/royalton-resorts` | Published guide row (`kind = resorts`) via `guideMetadata()`; DB | Guide row `name` plus kind label; intro is the guide summary (DB) | Guide edit tools (`lib/guide-edit.ts`), logged to `content_edits` with undo |
| `/blog/royalton-resorts-locations-punta-cana-or-negril` | Blog post row `meta_title` / `meta_description` (DB) | Post body (DB) | Admin blog editor |
| `/destinations/croatia` | Published guide row (`kind = destinations`) via `guideMetadata()`; DB | Guide row; H1 is "<Name>: Travel Guide" | Guide edit tools |
| `/destinations/dominican-republic` | Same as Croatia | Same as Croatia | Guide edit tools |

The `app/destinations/[slug]/page.tsx` fallback title (`<Destination> Trips | TravelFunBiz.ca`) is only used when no published
guide exists, which is not the case for these two pages.

## What was changed in code (this branch)

`lib/package-seo.ts` `tripTitle()` only matched the trip name with a case-sensitive `indexOf`. The live row has the name in upper
case (`AUSTRALIA & NEW ZEALAND`) and the meta title in title case (`Australia & New Zealand | 22-Day Group Tour`), so the
"from Canada" wording never reached the title even though the H1 had it. It now falls back to the "Australia and New Zealand"
wording in any letter case. Result on the live row, with no database change:

- Before: `Australia & New Zealand | 22-Day Group Tour`
- After: `Australia & New Zealand from Canada | 22-Day Group Tour` (55 characters)

This targets the query "australia and new zealand tours from canada" (position 76, 89 impressions). Tests are in
`scripts/check-seo-loop1.ts` (section 4). The DB proposal for the same page is below and also works with this code (the
"from Canada" guard stops a double insert).

Honest limit: position 76 means almost nobody sees the page for that query, so a better title will not move it by itself. The
ranking gain for that query needs the "tours from Canada" wording in the body and links too.

## Proposals (apply through the existing admin tools)

Character counts are exact (title at most 60, description at most 155).

### 1. /packages/australia-new-zealand

Target query: australia and new zealand tours from canada (position 76, 89 impressions); page average position 14.6, 76 impressions.

| Field | Current | Proposed | Chars |
| --- | --- | --- | --- |
| Title | Australia & New Zealand \| 22-Day Group Tour | Australia and New Zealand tour from Canada \| 22 days | 52 |
| Description | A 22-day tour of Australia and New Zealand, Jan 23-Feb 14, 2027, from the Great Barrier Reef to New Zealand's fjords. TravelFunBiz.ca. | Join a 22-day group tour of Australia and New Zealand from Canada, Jan 23 to Feb 14, 2027, from the Great Barrier Reef to the fjords. | 133 |
| H1 | AUSTRALIA & NEW ZEALAND from Canada | No change (already correct, rendered by `tripHeading()`) | |
| First line | Travel through Australia and New Zealand, from reef and Outback to fiords and cosmopolitan cities. | Travel through Australia and New Zealand from Canada on a 22-day group tour, from reef and Outback to fiords and cosmopolitan cities. | 133 |

Page facts used: 22 days, Jan 23 to Feb 14, 2027, group tour (current title), Great Barrier Reef, fjords. "From Canada" is
already the site's H1 wording for this trip. Note the trip's own text uses both "fiords" and "fjords"; pick one spelling.

### 2. /resorts/royalton-resorts

Target query: royalton resorts (position 10.7, 62 impressions).

| Field | Current | Proposed | Chars |
| --- | --- | --- | --- |
| Title | Royalton Resorts: All Inclusive Guide | Royalton Resorts: All Inclusive in the Caribbean and Mexico | 59 |
| Description | A guide to Royalton Resorts, all inclusive hotels in the Caribbean and Mexico, covering the setting, dining, who they suit and group travel tips. | Royalton Resorts are all inclusive hotels in the Caribbean and Mexico, from family resorts to adults only sections. See dining and who they suit. | 145 |
| H1 | Royalton Resorts: Resort Guide | Royalton Resorts: All Inclusive Resort Guide | 44 |
| First paragraph | Royalton Resorts is a collection of all inclusive hotels found across sunny destinations in the Caribbean and Mexico... | No change (it already answers the query in the first sentence) | |

Page facts used: all inclusive, Caribbean and Mexico, family resorts and adults only sections, dining, who it suits.

### 3. /blog/royalton-resorts-locations-punta-cana-or-negril

Target query: royalton resorts locations. The title already matches the query exactly, so only the description changes. The
current search title (`Royalton Resorts Locations: Punta Cana or Negril?`) is kept; the social title differs
(`Which Royalton Resort Location Actually Fits Your Trip?`) and could be aligned to it.

| Field | Current | Proposed | Chars |
| --- | --- | --- | --- |
| Title | Royalton Resorts Locations: Punta Cana or Negril? | No change | 49 |
| Description | Compare Royalton Resorts locations across the Caribbean to help you pick the right property for couples, families, or solo travelers. | Royalton Resorts locations compared: Punta Cana, Negril, Antigua, St. Lucia and the Bahamas, for couples, families and singles. | 127 |

Caution: the five locations are named in the post's own opening paragraph, but the post is AI written and the guide page says
"Caribbean and Mexico" (the Bahamas are not the Caribbean in the strict sense). Have an advisor confirm the location list
before applying, or drop the Bahamas from the description.

### 4. /destinations/croatia

Target query: croatia trips (position 11, 43 impressions).

| Field | Current | Proposed | Chars |
| --- | --- | --- | --- |
| Title | Croatia Cruise Guide for Travellers | Croatia Trips: Adriatic Cruise Guide for Travellers | 51 |
| Description | Plan a cruise to Croatia along the Adriatic. Learn about the coast, islands, ports, food and when to go on a small ship cruise of Croatia. | Planning Croatia trips? See the Adriatic coast, islands, ports, food and when to go, plus a yacht cruise from Dubrovnik to Split. | 129 |
| H1 | Croatia: Travel Guide | Croatia Trips: Travel Guide | 27 |
| First paragraph | Croatia is a country in southeastern Europe with a long, island-dotted coastline... | No change | |

Page facts used: Adriatic, coast, islands, ports, food, best time, the Croatia Coastline Yacht Cruise listed on the page (route
starts at Dubrovnik and includes Split).

### 5. /destinations/dominican-republic

Target query: dominican trips (position 6.0, 39 impressions). Position 6 with few clicks is the clearest title problem: the
current title says "Cruise Ports" and does not say "trips".

| Field | Current | Proposed | Chars |
| --- | --- | --- | --- |
| Title | Dominican Republic Cruise Ports Guide | Dominican Republic Trips: Cruise Ports and Travel Guide | 55 |
| Description | A guide to cruise ports in the Dominican Republic, from Puerto Plata to Cabo Rojo, plus what to do, eat, and expect on a hosted cruise port day. | Dominican Republic trips and cruise ports from Puerto Plata to Cabo Rojo, with what to do and eat on a hosted port day. Our advisors can help you plan. | 151 |
| H1 | Dominican Republic: Travel Guide | Dominican Republic Trips: Travel Guide | 38 |
| First paragraph | Dominican Republic is a Caribbean country that shares the island of Hispaniola with Haiti... | No change | |

### 6. /packages/tahitian-tropical-escape

Position 1.1, 28 impressions, 0 clicks. Low confidence that wording is the cause: at position 1 on 28 impressions this is
probably people searching the exact trip name, who read the answer in the result and do not need to click, or plain noise.
The current copy is already accurate. The proposal adds the ship line and region so the result stands apart from the
supplier's own listing.

| Field | Current | Proposed | Chars |
| --- | --- | --- | --- |
| Title | Tahitian Tropical Escape \| 7-Night Sail | Tahitian Tropical Escape: Windstar Sail in French Polynesia | 59 |
| Description | A 7-night sail roundtrip from Papeete, Tahiti, Jul 3-10, 2028, aboard Windstar's Wind Star through Bora Bora and Moorea. TravelFunBiz.ca. | A 7-night Windstar sail roundtrip from Papeete, Tahiti, Jul 3 to 10, 2028, through Bora Bora, Moorea and Huahine. Ask an agent for details. | 139 |
| H1 | TAHITIAN TROPICAL ESCAPE | No change | |
| First line | Sail roundtrip from Papeete aboard an intimate yacht through six French Polynesian islands and a private motu escape. | No change | |

Recommendation: do not spend an approval on this one until more impressions arrive; the CTR loop will not touch it anyway
(it needs 200 impressions in 28 days before a click rate counts).

## Applying

1. Packages (1, 6): admin package editor, or let the CTR loop trip proposals carry them (they use the same `tripGate`).
2. Guides (2, 4, 5): guide edit tools; every change is logged to `content_edits` and can be undone from the Content edits page.
3. Blog (3): admin blog editor, after the location check above.
4. Re-check Search Console 28 days after each change; compare click rate against the position curve in `lib/ctr-loop.ts`.
