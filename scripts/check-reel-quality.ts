// Offline checks for the reel quality work (real frames of the 21 Oct reel: docs/factory/evidence/reel-2026-10-21-*.png):
//   A. the script: the hook is a question and never the blog title, no "Picture..." / "Imagine..." scene-setters (Viking example)
//   B. b-roll: searches name the subject type, unrelated clips (skate park, laptop, indoor dinner) are rejected, clips never repeat
//   C. the post-render frame gate: a caption drawn over the cover headline fails, a clean cover and end card pass
// Pure functions and fakes only: nothing here calls Shotstack, Pexels, a model, a database or a network.
// Run: pnpm dlx tsx scripts/check-reel-quality.ts   (exits 1 on any failed expectation)
import { startsWithTitle, hookIsQuestion, hasSceneSetter, stripSceneSetters, reelScriptProblems, repairReelScript, reelNarration } from '../lib/reel-script-rules'
import { shapeBeats, scriptChecks, scriptPrompt, type VideoScript, type VideoBeat } from '../lib/video-script'
import { isAcceptableHook } from '../lib/reel-questions'
import { buildBrollQueries, pickBroll, subjectTypeOf, videoSlug, unrelatedSubjectIn, bestBrollFile, type BrollVideo } from '../lib/broll-select'
import { findBrollForBeats } from '../lib/pexels'
import { analyseReelCover, analyseReelEndCard, gateReelFrames } from '../lib/reel-frame-gate'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const EM = String.fromCharCode(8212)

async function main() {
  // ---- A. the script (the Viking example from the real frames) ----
  const TITLE = 'Viking River Cruise Germany: A Rhine guide for solo travelers'
  const idea = { title: TITLE, keyword: 'viking river cruise germany', destination: 'Germany' }
  const beat = (vo: string, text: string, terms: string[] = ['river cruise ship']): VideoBeat => ({ scene: 's', onScreenText: text, voiceover: vo, brollSearchTerms: terms })
  // What the 21 Oct reel said: the title, then the summary, then a "Picture..." scene-setter.
  const real: VideoScript = {
    hook: TITLE,
    title: TITLE,
    description: 'd',
    hashtags: [],
    beats: [
      beat('A Rhine guide for solo travelers. Picture a floating hotel that docks right in the heart of each town.', 'Picture a floating hotel', ['floating hotel']),
      beat('This route builds gently from grand cities to quiet little villages.', 'Grand cities to quiet villages'),
      beat('Wait, nobody tells you this.', 'Nobody tells you this'),
      beat('Before judging on price, compare what each fare includes.', 'Compare what is included'),
      beat('Solo travel is easy because the ship plans the days.', 'Solo travel, made easy'),
      beat('You pass castles on the hillsides almost every hour.', 'Castles at every bend'),
      beat('You unpack one time and wake up somewhere new.', 'Unpack once'),
      beat('Boat or boots: which one are you?', 'Which one are you?'),
    ],
  }
  const before = reelScriptProblems(real, TITLE)
  check('the real 21 Oct script fails the rules (hook is the title, not a question, a Picture scene-setter)', before.length >= 3 && before.some((p) => /starts with the blog title/.test(p)) && before.some((p) => /not a question/.test(p)) && before.some((p) => /Picture/.test(p)), before.join(' | '))
  check('startsWithTitle sees the title and its 6 word prefix, not an unrelated line', startsWithTitle('Viking River Cruise Germany A Rhine guide for solo travelers Picture a floating hotel', TITLE) && startsWithTitle(TITLE, TITLE) && !startsWithTitle('Is a Rhine river cruise right for you?', TITLE))
  check('a short title as a contrast question is a fine hook ("Rhine or Croatia: which one are you?")', !startsWithTitle('Rhine or Croatia: which one are you?', 'Rhine or Croatia') && startsWithTitle('Rhine or Croatia', 'Rhine or Croatia'))
  const fixed = repairReelScript(real, idea)
  check('repaired: the first spoken line is a hook question and not the title', hookIsQuestion(fixed.hook) && !startsWithTitle(fixed.hook, TITLE) && reelNarration(fixed).all.startsWith(fixed.hook) && fixed.usedFallback === true, fixed.hook)
  check('repaired: the spoken script and the burned text do not start with the blog title or its summary line', !startsWithTitle(reelNarration(fixed).all, TITLE) && !reelNarration(fixed).all.startsWith(TITLE) && fixed.beats.every((b) => !startsWithTitle(b.voiceover, TITLE)), reelNarration(fixed).all.slice(0, 80))
  check('repaired: no Picture/Imagine scene-setter in any line, and the line still reads', fixed.beats.every((b) => !hasSceneSetter(b.voiceover) && !hasSceneSetter(b.onScreenText)) && fixed.beats[0].voiceover === 'A Rhine guide for solo travelers. A floating hotel that docks right in the heart of each town.' && fixed.beats[0].onScreenText === 'A floating hotel', fixed.beats[0].voiceover)
  check('repaired script has no problems left', reelScriptProblems(fixed, TITLE).length === 0, reelScriptProblems(fixed, TITLE).join(' | '))
  check('shapeBeats applies the rules (a script straight from the model comes out clean)', reelScriptProblems(shapeBeats(real, idea), TITLE).length === 0, reelScriptProblems(shapeBeats(real, idea), TITLE).join(' | '))
  check('a good hook is kept as it is', repairReelScript({ ...real, hook: 'Is a Rhine river cruise right for you?' }, idea).hook === 'Is a Rhine river cruise right for you?' && repairReelScript({ ...real, hook: 'Is a Rhine river cruise right for you?' }, idea).usedFallback !== true)
  check('stripSceneSetters handles Imagine and Picture mid-script and leaves other text alone', stripSceneSetters('Imagine this: a quiet deck at dawn. Castles drift past.') === 'A quiet deck at dawn. Castles drift past.' && stripSceneSetters('Castles at every bend.') === 'Castles at every bend.')
  check('"Picture this" no longer passes as a second-person hook', !isAcceptableHook('Picture this: a river at dawn') && !isAcceptableHook('Imagine waking up on the Rhine'))
  check('scriptChecks with the post title rejects the title as a hook and a Picture hook; a question passes', !scriptChecks(real, TITLE, TITLE).hookOk && !scriptChecks({ ...real, hook: 'Picture a river at dawn?' }, '', TITLE).hookOk && scriptChecks({ ...real, hook: 'Is a Rhine river cruise right for you?' }, TITLE, TITLE).hookOk)
  const prompt = scriptPrompt(TITLE, 'summary')
  check('the script prompt asks for a question hook, bans the title as an opener and bans Picture/Imagine', /MUST be a question/.test(prompt) && /Never start the hook, or any beat, with the post title/.test(prompt) && /never use a "Picture\.\.\." or "Imagine\.\.\." scene-setter/.test(prompt) && !prompt.includes(EM))

  // ---- B. b-roll relevance (fakes only) ----
  const ctx = { keyword: 'viking river cruise germany', title: TITLE, destination: 'Germany' }
  check('the subject type of the Viking post is a river cruise; others map to beach, old town, ship', subjectTypeOf(ctx)?.id === 'river-cruise' && subjectTypeOf({ keyword: 'best beaches in Cancun' })?.id === 'beach' && subjectTypeOf({ title: 'Old town Prague in a day' })?.id === 'old-town' && subjectTypeOf({ keyword: 'caribbean cruise tips' })?.id === 'ocean-cruise' && subjectTypeOf({ title: 'x' }) === null)
  const q = buildBrollQueries(['floating hotel'], ctx)
  check('a vague beat ("floating hotel") is searched with the subject type, with broader searches after it', q[0] === 'river cruise floating hotel' && q.length === 3 && q.includes('river cruise') && q.every((x) => x.split(' ').length <= 6), JSON.stringify(q))
  check('a beat that already names the subject is not doubled', buildBrollQueries(['river cruise ship deck'], ctx)[0] === 'river cruise ship deck')
  check('no subject type still searches with the place', buildBrollQueries(['market stalls'], { destination: 'Lisbon' })[0] === 'Lisbon market stalls')
  check('videoSlug reads the description from a Pexels page address', videoSlug('https://www.pexels.com/video/aerial-view-of-a-river-cruise-ship-3456789/') === 'aerial view of a river cruise ship' && videoSlug(undefined) === '')
  const files = (w: number, h: number) => [{ link: `https://v.test/${w}x${h}.mp4`, file_type: 'video/mp4', width: w, height: h }]
  const vid = (id: number, slug: string, w: number, h: number, duration = 10): BrollVideo => ({ id, url: `https://www.pexels.com/video/${slug}-${id}/`, duration, video_files: files(w, h) })
  const pool: BrollVideo[] = [
    vid(2, 'man-skateboarding-in-a-skate-park', 720, 1280),
    vid(3, 'people-dining-in-a-restaurant', 720, 1280),
    vid(5, 'woman-using-laptop-on-a-ship-deck', 720, 1280),
    vid(6, 'feet-and-shadow-on-the-ground-near-a-river', 720, 1280),
    vid(4, 'cruise-ship-sailing-on-the-rhine', 1920, 1080),
    vid(1, 'aerial-view-of-a-river-cruise-ship', 720, 1280),
    vid(7, 'river-cruise-ship-at-sunset-clip', 4096, 1080),
    vid(8, 'a-river-boat-passing-a-castle', 720, 1280, 1.5),
  ]
  const p1 = pickBroll(pool, { terms: ['river cruise ship'], ctx })
  check('the pick is the on-topic portrait clip, never the skate park, laptop, dinner or feet clips', p1?.id === '1' && p1.landscape === false, JSON.stringify(p1))
  const p2 = pickBroll(pool, { terms: ['river cruise ship'], ctx, usedIds: new Set(['1']) })
  check('a clip already used in the reel is never picked again: the next best is the landscape clip with a safe crop', p2?.id === '4' && p2.landscape === true, JSON.stringify(p2))
  const p3 = pickBroll(pool, { terms: ['river cruise ship'], ctx, usedIds: new Set(['1', '4']), recentIds: new Set<string>() })
  check('an ultra wide clip (4096x1080) and a 1.5 second clip are not used, so nothing is left: the beat falls back to a still', p3 === null, JSON.stringify(p3))
  check('a clip of a recent reel is skipped', pickBroll(pool, { terms: ['river cruise ship'], ctx, recentIds: new Set(['1']) })?.id === '4')
  check('unrelated subjects are rejected, except when the post is about them', unrelatedSubjectIn('man skateboarding in a skate park', 'river cruise') === 'skateboarding' || !!unrelatedSubjectIn('man skateboarding in a skate park', 'river cruise'), '')
  check('a cooking post may show a kitchen; a river cruise post may not', unrelatedSubjectIn('woman in a kitchen', 'cooking class kitchen in Italy') === null && unrelatedSubjectIn('woman in a kitchen', 'river cruise') !== null)
  check('an indoor dinner clip with no word of the subject is rejected (it was the 8s frame)', pickBroll([vid(3, 'people-dining-in-a-restaurant', 720, 1280)], { terms: ['floating hotel'], ctx }) === null)
  check('bestBrollFile: portrait 720 to 1080 first; a landscape HD file only when the crop is safe', bestBrollFile(files(720, 1280))?.landscape === false && bestBrollFile(files(1920, 1080))?.landscape === true && bestBrollFile(files(4096, 1080)) === null && bestBrollFile(files(640, 360)) === null)

  // The whole reel with a fake Pexels: searches name the subject, clips do not repeat, the ids are remembered.
  process.env.PEXELS_API_KEY = 'test-key'
  const calls: string[] = []
  const fakeFetch = (async (input: unknown) => {
    const url = String(input)
    calls.push(decodeURIComponent(url))
    const videos = url.includes('orientation=landscape') ? pool.filter((v) => (v.video_files?.[0]?.width ?? 0) >= (v.video_files?.[0]?.height ?? 0)) : pool.filter((v) => (v.video_files?.[0]?.height ?? 0) > (v.video_files?.[0]?.width ?? 0))
    return { ok: true, json: async () => ({ videos }) } as Response
  }) as unknown as typeof fetch
  let remembered: string[] = []
  const beats = [{ brollSearchTerms: ['floating hotel'] }, { brollSearchTerms: ['river cruise ship'] }, { brollSearchTerms: ['old town'] }, { brollSearchTerms: ['castle'] }]
  const clips = await findBrollForBeats(beats, ctx, { fetchImpl: fakeFetch, recentIds: new Set<string>(), remember: async (ids) => void (remembered = ids) })
  const ids = clips.filter(Boolean).map((c) => c!.id)
  check('a reel never reuses a clip and never picks an unrelated one', new Set(ids).size === ids.length && ids.length >= 1 && !ids.some((i) => ['2', '3', '5', '6'].includes(i)), JSON.stringify(ids))
  check('every search names the subject type of the post', calls.length > 0 && calls.every((c) => /river cruise/i.test(c)), calls.join(' | '))
  check('the clips used are remembered so the next reels skip them', JSON.stringify(remembered.sort()) === JSON.stringify([...ids].sort()), JSON.stringify(remembered))

  // ---- C. the post-render frame gate (synthetic 360x640 frames) ----
  const W = 360
  const H = 640
  const frame = () => {
    const d = new Uint8Array(W * H * 3)
    for (let i = 0; i < W * H; i++) {
      d[i * 3] = 90
      d[i * 3 + 1] = 140 + ((i / W) % 40)
      d[i * 3 + 2] = 190
    }
    return d
  }
  const rect = (d: Uint8Array, x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) d.set(c, (y * W + x) * 3)
  }
  const RED: [number, number, number] = [216, 31, 38]
  const WHITE: [number, number, number] = [255, 255, 255]
  const BLACK: [number, number, number] = [0, 0, 0]
  /** Letters as separate 6x10 white boxes 4px apart, optionally with a 3px black outline like the burned captions have. */
  const letters = (d: Uint8Array, x0: number, y: number, n: number, outline: boolean) => {
    for (let i = 0; i < n; i++) {
      const x = x0 + i * 10
      if (outline) rect(d, x - 3, y - 3, x + 9, y + 13, BLACK)
    }
    for (let i = 0; i < n; i++) rect(d, x0 + i * 10, y, x0 + i * 10 + 6, y + 10, WHITE)
  }
  const cover = (opts: { caption?: boolean; noBlock?: boolean } = {}) => {
    const d = frame()
    if (!opts.noBlock) {
      rect(d, 40, 98, 320, 248, RED)
      for (const y of [120, 150, 180]) letters(d, 90, y, 18, false)
    }
    rect(d, 110, 340, 250, 372, BLACK)
    letters(d, 122, 351, 10, false)
    if (opts.caption) {
      // The real defect: caption lines with a black outline over the photo above the block and over the headline block itself.
      for (const y of [30, 60, 105, 140]) letters(d, 60, y, 24, true)
    }
    return d
  }
  const endCard = (opts: { noStrip?: boolean } = {}) => {
    const d = frame()
    rect(d, 40, 118, 320, 228, RED)
    for (const y of [150, 185]) letters(d, 90, y, 18, false)
    if (!opts.noStrip) {
      rect(d, 70, 350, 290, 382, BLACK)
      letters(d, 85, 361, 20, false)
    }
    return d
  }
  const good = analyseReelCover(cover(), W, H, 3)
  check('a clean cover (red block, centred, readable, brand strip) passes the cover gate', good.ok, good.reasons.join(' | '))
  const evidence = analyseReelCover(cover({ caption: true }), W, H, 3)
  check('the 21 Oct cover (caption drawn over the headline block) FAILS the cover gate', !evidence.ok, evidence.reasons.join(' | '))
  const inside = cover()
  letters(inside, 140, 200, 8, true)
  const insideRes = analyseReelCover(inside, W, H, 3)
  check('a short caption line drawn inside the block is caught as "dark drawn over the headline block"', !insideRes.ok && insideRes.reasons.some((r) => /dark is drawn over the headline block/.test(r)), insideRes.reasons.join(' | '))
  check('a caption on the photo above the block fails even when the block is clean', !analyseReelCover((() => { const d = cover(); for (const y of [30, 60]) letters(d, 60, y, 24, true); return d })(), W, H, 3).ok)
  check('a cover with no red block fails', !analyseReelCover(cover({ noBlock: true }), W, H, 3).ok)
  check('an unexpected frame size is "cannot say", not a pass or a fail', analyseReelCover(new Uint8Array(100 * 100 * 3), 100, 100, 3).infra === true)
  const endGood = analyseReelEndCard(endCard(), W, H, 3)
  check('a clean end card (red block with the site name and the call to action strip) passes', endGood.ok, endGood.reasons.join(' | '))
  check('an end card without the call to action strip fails', !analyseReelEndCard(endCard({ noStrip: true }), W, H, 3).ok)
  check('an end card that is only footage fails (no red block)', !analyseReelEndCard(frame(), W, H, 3).ok)
  // The live template since 22 Oct 2026: end card block at x 34 to 327 of a 360 wide still (32 px right margin). A 9% margin rejected every one.
  const liveEnd = frame()
  rect(liveEnd, 34, 118, 328, 228, RED)
  for (const y of [150, 185]) letters(liveEnd, 90, y, 18, false)
  rect(liveEnd, 70, 350, 290, 382, BLACK)
  letters(liveEnd, 85, 361, 20, false)
  const liveEndRes = analyseReelEndCard(liveEnd, W, H, 3)
  check('the live end card (block x 34 to 327 of 360) passes the side margin check', liveEndRes.ok, liveEndRes.reasons.join(' | '))
  const edgeEnd = frame()
  rect(edgeEnd, 3, 118, 357, 228, RED)
  for (const y of [150, 185]) letters(edgeEnd, 90, y, 18, false)
  rect(edgeEnd, 70, 350, 290, 382, BLACK)
  letters(edgeEnd, 85, 361, 20, false)
  const edgeEndRes = analyseReelEndCard(edgeEnd, W, H, 3)
  check('a block that touches the frame edge still fails the side margin check', !edgeEndRes.ok && edgeEndRes.reasons.some((r) => /side margins/.test(r)), edgeEndRes.reasons.join(' | '))

  // gateReelFrames with fake fetch and decode: pass, fail (never post), unknown (no still / fetch fails), retry once.
  const images = new Map<string, Uint8Array>([['good-cover', cover()], ['bad-cover', cover({ caption: true })], ['good-end', endCard()], ['bad-end', endCard({ noStrip: true })]])
  const fetchImage = async (url: string) => (images.has(url) ? ({ ok: true as const, buf: Buffer.from(url), headers: { photoId: null, template: null } }) : ({ ok: false as const, error: 'status 404' }))
  const decode = async (buf: Buffer) => ({ data: images.get(buf.toString())!, width: W, height: H, channels: 3 })
  const passRes = await gateReelFrames({ posterUrl: 'good-cover', endUrl: 'good-end' }, { fetchImage, decode })
  const failRes = await gateReelFrames({ posterUrl: 'bad-cover', endUrl: 'good-end' }, { fetchImage, decode })
  const unknownRes = await gateReelFrames({}, { fetchImage, decode })
  const missing = await gateReelFrames({ posterUrl: 'nope' }, { fetchImage, decode })
  check('gateReelFrames: clean frames pass', passRes.verdict === 'pass' && passRes.checked.cover && passRes.checked.end, JSON.stringify(passRes))
  check('gateReelFrames: a covered headline is a fail (never posted) with a reason', failRes.verdict === 'fail' && failRes.reasons.some((r) => /^cover:/.test(r)), JSON.stringify(failRes))
  check('gateReelFrames: a bad end card is a fail too', (await gateReelFrames({ posterUrl: 'good-cover', endUrl: 'bad-end' }, { fetchImage, decode })).verdict === 'fail')
  check('gateReelFrames: no poster and no thumbnail returned is "unknown"', unknownRes.verdict === 'unknown' && !unknownRes.checked.cover && !unknownRes.checked.end)
  check('gateReelFrames: a still that cannot be fetched is "unknown", never a pass or a fail', missing.verdict === 'unknown', JSON.stringify(missing))
  let attempts = 0
  const flaky = async (url: string) => (++attempts === 1 ? ({ ok: false as const, error: 'timeout' }) : fetchImage(url))
  const retried = await gateReelFrames({ posterUrl: 'good-cover' }, { fetchImage: flaky, decode })
  check('gateReelFrames: one failed fetch is retried once and then judged', retried.verdict === 'pass' && attempts === 2, `${retried.verdict} ${attempts}`)
  check('gateReelFrames: it never throws', (await gateReelFrames({ posterUrl: 'good-cover' }, { fetchImage: async () => { throw new Error('boom') }, decode })).verdict === 'unknown')

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
