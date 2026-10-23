// Offline check for the owner's rule: EVERY social post on EVERY network carries an image, a carousel, a reel or a video.
// No text-and-link-only posts. Static scans of the sending code plus runtime fakes (no database, no network, no fonts).
// Run: pnpm dlx tsx scripts/check-no-text-only.ts
import fs from 'node:fs'
import path from 'node:path'
import { resolveRowImage, sendWithMedia, noImageNote, NO_IMAGE_NOTE } from '../lib/post-media'
import type { CoverGateOutcome } from '../lib/cover-gate'
import { templateForKind } from '../lib/cover-gate'
import { PLATFORM_ACCEPTS, platformsFor, mediaCapable, activePlatformsOf, type PostingTarget } from '../lib/social-provider'
import { ghlCreatePost } from '../lib/ghl-social'
import { effectiveNetworks, NO_TEXT_ONLY_NOTE } from '../lib/effective-networks'
import { pickRecapQuestion, fitCoverTitle, isSocialCoverKind, socialCoverUrl, RECAP_MAX_WORDS, SOCIAL_COVER_KINDS, type SocialCoverKind } from '../lib/social-cover'
import { recapFacts } from '../lib/fanout-plan'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
const BASE = 'https://example.test'

async function main() {
  // ---------- static scan: no code path sends text only ----------
  const dist = src('lib/distribution.ts')
  const prov = src('lib/social-provider.ts')
  const ghl = src('lib/ghl-social.ts')
  const auto = src('lib/autopilot.ts')
  check('distribution.ts never calls sendText', !/sendText/.test(dist))
  check('social-provider.ts has no sendText and no text kind', !/sendText|uploadPostSendText/.test(prov) && !/export type PostKind = [^\n]*'text'/.test(prov) && !/\btext:\s*\[/.test(prov))
  check('distribution.ts never calls the sender directly (only through sendWithMedia)', !/\.sendPhotos\(|\.sendVideo\(/.test(dist) && /sendWithMedia\(target, sendImage\)/.test(dist))
  check('the send image is a string by then (a row without one is closed before the send)', /const sendImage: string = imageOutcome\.url/.test(dist))
  check('distribution.ts has no "kind = ... text" fallback', !/\?\s*'photo'\s*:\s*'text'/.test(dist) && !/kind\s*=\s*sendImage/.test(dist))
  check('ghl-social.ts refuses a post with an empty media array', /media\.length === 0\) return \{ ok: false, retryable: false/.test(ghl))
  check('autopilot carousel sends slides and the reel needs a video url', /sendPhotos\(carouselTargets, caption, slides\.map/.test(auto) && /row\.video_url && target && videoTargets\.length/.test(auto))
  check('every sender in autopilot passes media (no sendText there)', !/sendText/.test(auto))

  // ---------- runtime: every row type ends in media or a "Skipped: no image" close ----------
  const kinds: Array<{ row: string; kind: SocialCoverKind; slug: string; title: string; cover: string | null }> = [
    { row: 'post', kind: 'blog', slug: 'hosted-group-trip', title: 'What Is Included in a Hosted Group Trip', cover: 'https://images.pexels.com/photos/1/x.jpg' },
    { row: 'post without a cover photo', kind: 'blog', slug: 'no-photo-post', title: 'Best Time to Visit Lisbon', cover: null },
    { row: 'guide', kind: 'guide', slug: 'guide-destination-lisbon', title: 'Lisbon Travel Guide', cover: null },
    { row: 'trip', kind: 'trip', slug: 'rhine-cruise', title: 'Rhine River Cruise', cover: null },
    { row: 'news', kind: 'news', slug: 'news-hurricane-update', title: 'Hurricane watch issued for the Caribbean', cover: null },
    { row: 'recap', kind: 'recap', slug: 'hosted-group-trip', title: 'What Is Included in a Hosted Group Trip', cover: null },
  ]
  const passGate = async (i: { kind: SocialCoverKind; slug: string }): Promise<CoverGateOutcome> => ({ status: 'pass', url: socialCoverUrl(BASE, i.kind, i.slug), attempt: 0, retries: 0, reasons: [], photoId: null, template: templateForKind(i.kind) })
  const skipGate = async (i: { kind: SocialCoverKind; slug: string }): Promise<CoverGateOutcome> => ({ status: 'skip', attempt: 2, retries: 2, reasons: ['the photo is flat or dull'], photoId: null, template: templateForKind(i.kind) })
  for (const k of kinds) {
    const common = { base: BASE, kind: k.kind, slug: k.slug, title: k.title, coverUrl: k.cover, passStart: Date.now(), verified: new Set<string>() }
    const ok = await resolveRowImage({ ...common, gate: passGate })
    check(`${k.row}: a passing card is sent as an image (${k.kind} card address)`, ok.status === 'send' && ok.url === socialCoverUrl(BASE, k.kind, k.slug), JSON.stringify(ok))
    const bad = await resolveRowImage({ ...common, gate: skipGate })
    check(`${k.row}: a card that fails the gate is skipped, never text`, bad.status === 'gate-skip' && noImageNote('x', 2).startsWith(NO_IMAGE_NOTE), JSON.stringify(bad))
    const none = await resolveRowImage({ ...common, title: '', coverUrl: 'https://images.pexels.com/photos/9/y.jpg', gate: passGate })
    check(`${k.row}: no composable card is "no-image" (the bare photo is not a fallback), not text`, none.status === 'no-image', JSON.stringify(none))
  }
  const deferred = await resolveRowImage({ ...{ base: BASE, kind: 'blog' as const, slug: 'a', title: 'A Title Here Now', coverUrl: null, passStart: Date.now(), verified: new Set<string>() }, gate: async () => ({ status: 'deferred', attempt: 0, retries: 0, reasons: ['fetch failed'], photoId: null, template: 'red-block-v1' }) })
  check('a gate that could not run waits for the next tick (no text either)', deferred.status === 'deferred')
  const late = await resolveRowImage({ base: BASE, kind: 'blog', slug: 'late-post', title: 'A Title Here Now', coverUrl: null, passStart: 0, now: () => 10 ** 9, verified: new Set<string>(), gate: passGate })
  check('past the time budget an unverified row waits', late.status === 'budget')
  const warm = new Set<string>([socialCoverUrl(BASE, 'blog', 'late-post')])
  const lateOk = await resolveRowImage({ base: BASE, kind: 'blog', slug: 'late-post', title: 'A Title Here Now', coverUrl: null, passStart: 0, now: () => 10 ** 9, verified: warm, gate: passGate })
  check('past the budget a card already verified is still sent as an image', lateOk.status === 'send')
  check('the skip note starts with the owner wording', NO_IMAGE_NOTE === 'Skipped: no image (not posted as text)' && noImageNote('r').startsWith('Skipped: no image (not posted as text)'))
  check('the distribution pass closes no-image and gate-skip rows as done and counts them as visual skips', /status === 'no-image' \|\| imageOutcome\.status === 'gate-skip'/.test(dist) && /visualSkipped\+\+/.test(dist) && /stage: 'done', last_error: noImageNote/.test(dist) && /\[\.\.\.retryEvents, 'skip'\]/.test(dist))

  // ---------- sendWithMedia: the one payload builder ----------
  const calls: Array<{ platforms: string[]; text: string; images: string[] }> = []
  const fakeTarget: Pick<PostingTarget, 'sendPhotos'> = { sendPhotos: async (platforms, text, images) => (calls.push({ platforms, text, images }), { ok: true }) }
  let threw = false
  try {
    sendWithMedia(fakeTarget, null)
  } catch {
    threw = true
  }
  check('sendWithMedia refuses to build a sender with no image', threw)
  for (const empty of ['', '   ', undefined]) {
    let t = false
    try {
      sendWithMedia(fakeTarget, empty)
    } catch {
      t = true
    }
    check(`sendWithMedia refuses ${JSON.stringify(empty)}`, t)
  }
  await sendWithMedia(fakeTarget, 'https://example.test/social-cover/blog/x')(['bluesky'], 'You asked: hello? https://example.test/blog/x')
  check('a Bluesky post is sent with its image and still carries the caption link', calls.length === 1 && calls[0].images.length === 1 && calls[0].text.includes('https://example.test/blog/x'))

  // ---------- GoHighLevel: an empty media array never reaches the network ----------
  process.env.GOHIGHLEVEL_PRIVATE_TOKEN = 'test-token'
  process.env.GOHIGHLEVEL_LOCATION_ID = 'loc'
  process.env.GOHIGHLEVEL_USER_ID = 'user'
  const realFetch = globalThis.fetch
  let fetched = 0
  let lastBody: { media?: unknown[] } = {}
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    fetched++
    lastBody = JSON.parse(String(init?.body ?? '{}'))
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const emptyRes = await ghlCreatePost({ accountIds: ['a'], text: 'hello' })
  check('ghlCreatePost with no media is refused before any call', !emptyRes.ok && fetched === 0)
  const httpRes = await ghlCreatePost({ accountIds: ['a'], text: 'hello', mediaUrls: ['http://insecure.test/a.png'] })
  check('ghlCreatePost with only unusable media is refused too', !httpRes.ok && fetched === 0)
  const okRes = await ghlCreatePost({ accountIds: ['a'], text: 'hello', mediaUrls: ['https://example.test/a.png'], mediaType: 'image' })
  check('ghlCreatePost with an image goes out with a non-empty media array', okRes.ok && fetched === 1 && Array.isArray(lastBody.media) && lastBody.media.length === 1)
  globalThis.fetch = realFetch

  // ---------- networks that cannot carry media are never automatic targets ----------
  check('there is no text list in PLATFORM_ACCEPTS', !('text' in PLATFORM_ACCEPTS))
  const everyNetwork = ['x', 'twitter', 'reddit', 'facebook', 'instagram', 'bluesky', 'threads', 'linkedin', 'pinterest', 'tiktok', 'youtube', 'google']
  check('Reddit is in no accepted list (photo or video)', !PLATFORM_ACCEPTS.photo.includes('reddit') && !PLATFORM_ACCEPTS.video.includes('reddit'))
  check('platformsFor photo drops Reddit and keeps X (X takes image posts)', !platformsFor('photo', everyNetwork, 'upload-post').includes('reddit') && platformsFor('photo', everyNetwork, 'upload-post').includes('x'))
  check('platformsFor video drops Reddit', !platformsFor('video', everyNetwork, 'ghl').includes('reddit'))
  check('mediaCapable drops Reddit', JSON.stringify(mediaCapable(['reddit', 'x', 'bluesky'])) === JSON.stringify(['x', 'bluesky']))
  check('YouTube takes video only, so an image post skips it', !platformsFor('photo', ['youtube', 'bluesky']).includes('youtube'))
  check('activePlatformsOf (GoHighLevel) excludes Reddit', !activePlatformsOf('ghl', [{ id: '1', platform: 'reddit', name: 'r' }, { id: '2', platform: 'bluesky', name: 'b' }], []).includes('reddit'))
  check('activePlatformsOf (Upload-Post) excludes Reddit', JSON.stringify(activePlatformsOf('upload-post', [], ['reddit', 'x'])) === JSON.stringify(['x']))
  const eff = effectiveNetworks({
    provider: 'upload-post',
    ghl: { configured: false, missing: [], accounts: [], selected: [], error: null },
    upload: { configured: true, profilesError: null, profiles: [{ username: 'u', accounts: [{ platform: 'x' }, { platform: 'reddit' }, { platform: 'bluesky' }] }], selectedProfile: 'u', selectedPlatforms: ['x', 'reddit', 'bluesky'] },
  })
  check('the effective list (Upload-Post) has X and Bluesky but not Reddit', eff.networks.includes('x') && eff.networks.includes('bluesky') && !eff.networks.includes('reddit'), eff.networks.join(','))
  check('the effective list shows the "No text-only posts" line', eff.notes.includes(NO_TEXT_ONLY_NOTE) && NO_TEXT_ONLY_NOTE === 'No text-only posts: networks that cannot take an image are skipped.')
  const effGhl = effectiveNetworks({
    provider: 'ghl',
    ghl: { configured: true, missing: [], accounts: [{ id: '1', platform: 'reddit', active: true, expired: false }, { id: '2', platform: 'threads', active: true, expired: false }], selected: [{ id: '1', platform: 'reddit' }, { id: '2', platform: 'threads' }], error: null },
    upload: { configured: false, profilesError: null, profiles: [], selectedProfile: '', selectedPlatforms: [] },
  })
  check('the effective list (GoHighLevel) drops Reddit and carries the line', !effGhl.networks.includes('reddit') && effGhl.networks.includes('threads') && effGhl.notes.includes(NO_TEXT_ONLY_NOTE))
  check('the Posting card renders the effective notes', /effective\.notes\.map/.test(src('components/admin/posting-card.tsx')))

  // ---------- recap card ----------
  check('recap is a cover kind', isSocialCoverKind('recap') && (SOCIAL_COVER_KINDS as readonly string[]).includes('recap'))
  check('recap uses the red block design the visual gate checks', templateForKind('recap') === 'red-block-v1')
  const route = src('app/social-cover/[kind]/[slug]/route.tsx')
  check('the cover route draws recap with the "Read the answer:" strip and only changes the photo on a retry', /Read the answer|RECAP_STRIP_PREFIX/.test(route) && /kind === 'recap'/.test(route))
  const wc = (s: string) => s.split(/\s+/).filter(Boolean).length
  const q1 = 'What is included?'
  check('a short question is the headline as written', pickRecapQuestion([q1]) === q1)
  check('the first fitting question of 12 words or fewer wins', pickRecapQuestion(['Is it safe?', 'What is included?']) === 'Is it safe?')
  const fit = fitCoverTitle('IS IT SAFE?')
  check('a short question fits at the biggest size on one line', fit.complete && fit.fontSize === 120 && fit.lines.length <= 2, JSON.stringify(fit))
  const mid = pickRecapQuestion(['Do I need a visa for Portugal?'])
  const midFit = fitCoverTitle((mid ?? '').toUpperCase())
  check('a longer question shrinks (72 to 116) and stays inside 3 lines', !!mid && midFit.complete && midFit.fontSize >= 72 && midFit.fontSize < 120 && midFit.lines.length <= 3, JSON.stringify(midFit))
  const veryLong = 'What exactly is included in the price of a fully hosted small group trip with flights and hotels for first time travellers?'
  check('a question too long for 3 lines at 72px is not used', pickRecapQuestion([veryLong]) === null && wc(veryLong) > RECAP_MAX_WORDS)
  check('when the first is too long the shortest whole fitting question is taken', pickRecapQuestion([veryLong, 'Is it worth the money?', 'Is it safe?']) === 'Is it safe?' || pickRecapQuestion([veryLong, 'Is it worth the money?', 'Is it safe?']) === 'Is it worth the money?')
  const manyWords = 'Is a tour or a trip a good fit for me or us?' // 12 words
  const over = 'Can I go on a trip like this if I have never been out of the country at all?' // 17 words
  const sel = pickRecapQuestion([over, manyWords])
  check('a question of 12 words or fewer is preferred over a longer one', sel === manyWords || (sel !== null && wc(sel) <= RECAP_MAX_WORDS), String(sel))
  check('junk questions are ignored', pickRecapQuestion([null, 5, '', '   ', undefined]) === null)
  const facts = recapFacts({ title: 'T', faq: [{ q: 'Long question that goes on and on and on forever and ever amen friend ok?', a: 'Yes.' }, { q: 'Is it safe?', a: 'Yes, very. More text.' }], tags: [] })
  check('the recap caption quotes the same question the card shows', !!facts && facts.faqQuestions?.[0] === 'You asked: Is it safe?', JSON.stringify(facts?.faqQuestions))
  check('a post with no usable FAQ has no recap (nothing to show)', recapFacts({ title: 'T', faq: [] }) === null)
  check('the recap card address uses the recap kind and the blog post slug', socialCoverUrl(BASE, 'recap', 'hosted-group-trip') === `${BASE}/social-cover/recap/hosted-group-trip`)
  check('the distribution pass builds the recap card from the blog post slug', /isRecapRow \? 'recap'/.test(dist) && /isRecapRow \? postSlug/.test(dist))
  check('the recap is no longer sent without an image', !/not !isRecapRow|&& !isRecapRow\) \{\s*\n\s*const picked/.test(dist) && !/A recap is a text post/.test(dist))

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
