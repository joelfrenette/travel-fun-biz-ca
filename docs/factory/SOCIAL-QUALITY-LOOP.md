# Social quality loop: reels, captions, centring, link in bio

Branch `loop-social-quality`, 2026-10-22. Evidence first: what the code did before (file:line are the BEFORE lines on the
branch point 9cdbc0b, then what changed). Nothing here calls Shotstack, Pexels, an AI model or the live database.

## 1. Reels (lib/shotstack.ts, lib/video-script.ts, lib/autopilot.ts)

Canvas is 720 x 1280. Instagram covers the top 250px and bottom 340px of a 1080 x 1920 reel, which is 167px and 227px here.

| Finding (before) | Where | Fix |
| --- | --- | --- |
| Cover red block centred 20% down: a 3 line headline (about 340px tall) started near y=86, inside the top 167px UI zone | shotstack.ts:131 | Block centre 27% down (COVER_BLOCK_CENTER); worst case now starts at about y=176 |
| TRAVELFUNBIZ.CA strip at the bottom, 90px from the edge: inside the bottom 227px zone, and only 30px type | shotstack.ts:232 | Strip moved to mid frame (STRIP_CENTER 56%), 44px type, full 560px box |
| Safe bottom was a hand-picked 220 | shotstack.ts:121 | Derived: REEL_SAFE_TOP 167, REEL_SAFE_BOTTOM 227 |
| Caption track had no explicit horizontal alignment | shotstack.ts:212 | `align.horizontal: 'center'` |
| Beat text had no word cap (the model could send a long line) | shotstack.ts:191 | `beatLine()` cuts to 7 words, no trailing punctuation |
| No end card: the reel stopped on a 1.5s silent tail, so no site name and no call to action on screen at the end | shotstack.ts:113, 201 | 2.5s end card: red block "TRAVELFUNBIZ.CA", one CTA line in the strip spot ("Plan your trip: link in bio" for Instagram/TikTok, "Plan your trip: travelfunbiz.ca/links" for YouTube/Facebook), photo not darkened |
| Hook text on screen in the first second | shotstack.ts:231 | Already true (cover headline starts at 0s, captions start at 0s); now asserted |
| b-roll darkening only under text | shotstack.ts:186 | Already true (cover and end card photos are not darkened); now asserted |
| Min 44px only checked on captions | check-reel-edit.ts | `REEL_MIN_FONT` 44 asserted on every text overlay |
| One render goes to Instagram, TikTok, YouTube and Facebook | autopilot.ts:367 | The end card says "link in bio" when any bio network is a target, else the short URL (`opts.platform`) |

Checks: `reelTextBoxes()` (pure) estimates each text box; `scripts/check-reel-edit.ts` asserts, for 4 samples (short cover,
3 line cover, long beat text, no photo): centre alignment (left margin = right margin within 1px), 80px side margins, inside
the 167/227 safe zones, 44px minimum, readable (stroke or block), hook text at 0s, 7 word beats, 2 to 3 second end card with
red block and one CTA line, no two boxes overlapping while on screen together, darkening only under beat text.

Limit: box sizes are estimated from font size (capitals 0.7, mixed case 0.6 of the size per letter), not measured from a real
render. The first sandbox render is still the real test.

## 2. Captions and CTAs (lib/social-captions.ts, lib/distribution.ts, lib/utm.ts)

| Finding (before) | Where | Fix |
| --- | --- | --- |
| captionProblems checked the link on clickable networks only; nothing checked a call to action, and "link in bio" on Instagram/TikTok was never required | social-captions.ts:117-145 | New problem "call to action is missing" (`hasCallToAction`): bio networks need the "link in bio" words, others a next-step line after the hook |
| A model caption with no link or CTA was dropped to the shared caption | social-captions.ts:346-348 | `repairCaptionCta` appends the standard CTA line and link (or "link in bio" plus the word-of-mouth line) before the hashtags, refits the limit without cutting the CTA or link, then re-checks. Never dropped for this |
| Last-resort caption (title + description + link) had no CTA and gave a plain URL to bio networks | social-captions.ts:248-250 | Goes through `repairCaptionCta` too |
| The reel caption had a link but no CTA line, and a plain-text URL for Instagram/TikTok | autopilot.ts:372 | `buildVideoCaption`: "Plan your trip: link in bio, or tap here:" then the UTM link, hashtags last |
| Carousel last-resort caption had no CTA | autopilot.ts:337 | Repaired with `repairCaptionCta` |
| utm_content was the literal `fallback` for every fallback caption on every surface, and the hook style for tailored ones | distribution.ts:334, 469 | `socialContent(surface, variant)` in lib/utm.ts: `post-fallback`, `guide-question`, `trip-story`, `news-fallback`, `carousel-<cta>`, `video-<hook>`, `bio-<kind>-<slug>`. utm_campaign is the post slug, utm_source the network (twitter is x). Distinct per post, per surface, per variant |
| Pinterest | upload-post.ts:215, 343 | Pins have no separate title or destination field in our code: the caption goes out as `title`. The first line (the hook, 90 characters at most) is the pin title, and the UTM page link (`utm_source=pinterest`) is in the text. A real destination link field is NOT set: not confirmed in Upload-Post's API from here, so I did not invent one |

"Short word-of-mouth line": the brief did not define it, so I used `Easy to remember: travelfunbiz.ca` (WORD_OF_MOUTH_LINE).
Change it in one place if the owner wants other words.

Hashtag rules per platform were already in lib/hook-styles.ts:44-69 (Instagram 3 in fallbacks and 5 to 8 in the AI prompt,
TikTok 1 to 3, X 1 to 2, LinkedIn none in the prompt, etc.) and are unchanged.

Checks: `scripts/check-captions.ts` now covers, for 9 networks, flagged when link and CTA are missing, repaired to zero problems,
idempotent, hook still the first line, bio wording and no clickable URL on Instagram/TikTok, own UTM link elsewhere; hashtags
stay last; long captions are cut without losing the CTA; distinct utm_content per surface; Pinterest title and destination; the
shared reel caption.

## 3. Centred title check (lib/visual-gate.ts)

Before, only the 100px side margins were checked (visual-gate.ts:245), so a block pushed to one side but inside the margins
passed. Now: block centre within 4% of the frame width of the frame centre, and the white text's centre of mass within 4% too
(`CENTRE_TOLERANCE_SHARE`, metrics `blockCentreOffset` and `textCentreOffset`). Calibrated in `scripts/check-visual-gate.ts`:
centred covers pass with offsets near 0; blocks pushed left or right fail; centred block with words pushed 120px either way
fails; 2.5% and 3% offsets pass. The real live cover sample (`c.png`) passes with block 0.00% and text 0.33% off centre, and all
14 real /public photos still pass.

## 4. Link in bio (app/links/page.tsx, lib/bio-links.ts)

Before: only `/go/[slug]` (affiliate redirects, disallowed in robots) and `/go/p/...` existed; no page to send a "link in bio"
visitor to. Now `/links`: server rendered, noindex (`robots: { index: false }`), newest trips, guides and posts, every link
tagged `utm_source=<src or instagram>&utm_medium=social&utm_campaign=<src>_bio&utm_content=bio-<kind>-<slug>`.
`/links?src=tiktok` credits TikTok (known networks only; anything else is instagram). The end card of YouTube/Facebook reels
says `travelfunbiz.ca/links`. Check: `scripts/check-bio-links.ts`.

## Risks and what to verify

- First real sandbox render: confirm the end card, the mid-frame strip and the moved cover block look right, and that Shotstack
  accepts `align.horizontal` on `rich-caption` (it is documented for rich-text; I believe the caption asset takes it too, not
  seen live). If it rejects it, remove that one line (shotstack.ts:252).
- One reel render is shared by all four video networks, so the end card text is one choice. Separate end cards per network would
  mean separate renders (more Shotstack credits).
- Instagram's bio link must be set to `https://travelfunbiz.ca/links` by the owner (a Joel-side step).
- `call to action is missing` is a new captionProblems reason: any caption path outside the repair helpers that has no CTA line
  will now be dropped or repaired. All existing check scripts still pass.
