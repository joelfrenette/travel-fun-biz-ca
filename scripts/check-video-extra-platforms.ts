// Offline check: YouTube Shorts and Instagram Reels sit behind off|log|on switches (default off), use Upload-Post's real field names,
// respect each network's limits, and the self-heal step treats them like the other networks. Nothing is posted and no network is called.
import { readFileSync } from 'node:fs'
import {
  parseVideoExtraMode, splitVideoPlatforms, youtubeShortsFields, instagramReelsFields, capHashtags, buildLogEntry,
  YOUTUBE_SHORTS_MODE_KEY, INSTAGRAM_REELS_MODE_KEY, YOUTUBE_TITLE_MAX, type VideoExtraModes,
} from '../lib/video-extra-platforms'
import { networksNamedIn, uploadPostHealth, healthOf } from '../lib/flywheel/steps/network-recover'
import { platformsFor, mediaCapable } from '../lib/social-provider'

let failed = 0
const check = (name: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failed++ }
const src = (f: string) => readFileSync(f, 'utf8')
const weight = (s: string) => [...s].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff || /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1), 0)

// Switches: exact match, default off.
check('keys are the documented names', YOUTUBE_SHORTS_MODE_KEY === 'social_youtube_shorts_mode' && INSTAGRAM_REELS_MODE_KEY === 'social_instagram_reels_mode')
check('unset, empty, odd case and junk are all off', [null, undefined, '', 'ON', 'On', 'true', '1', ' on', 'yes'].every((v) => parseVideoExtraMode(v as string | null | undefined) === 'off'))
check('exact log and on are honoured', parseVideoExtraMode('log') === 'log' && parseVideoExtraMode('on') === 'on')

// Platform gating.
const modes = (youtube: VideoExtraModes['youtube'], instagram: VideoExtraModes['instagram']): VideoExtraModes => ({ youtube, instagram })
const all = ['instagram', 'tiktok', 'youtube', 'facebook']
let s = splitVideoPlatforms(all, modes('off', 'off'))
check('both off: YouTube and Instagram are dropped, the rest untouched, nothing logged', s.send.join() === 'tiktok,facebook' && s.logOnly.length === 0)
s = splitVideoPlatforms(all, modes('log', 'log'))
check('both log: neither is sent, both are logged', s.send.join() === 'tiktok,facebook' && s.logOnly.join() === 'instagram,youtube')
s = splitVideoPlatforms(all, modes('on', 'off'))
check('youtube on, instagram off', s.send.includes('youtube') && !s.send.includes('instagram') && s.logOnly.length === 0)
s = splitVideoPlatforms(all, modes('on', 'on'))
check('both on: all four are sent', s.send.length === 4)

// YouTube fields.
const long = 'Australia New Zealand Group Tour: a first-timer guide to every stop, what to book early, and how to avoid the costly mistakes most travellers make.\n\nPlan your trip: link in bio, or tap here:\nhttps://www.travelfunbiz.ca/blog/x?utm_source=video&utm_medium=social&utm_campaign=x\n\n#travel #australia #cruise'
const yt = youtubeShortsFields(long)
check('YouTube title is at most 100 and ends with #Shorts', weight(yt.youtube_title) <= YOUTUBE_TITLE_MAX && yt.youtube_title.endsWith('#Shorts'))
check('YouTube title starts with the caption start and has no link', yt.youtube_title.startsWith('Australia New Zealand') && !/https?:/.test(yt.youtube_title))
check('YouTube description keeps the UTM link and is within 5000', yt.youtube_description.includes('utm_source=video') && yt.youtube_description.length <= 5000 && yt.youtube_description.includes('#Shorts'))
check('YouTube privacy and kids declaration use the documented fields', yt.privacyStatus === 'public' && yt.selfDeclaredMadeForKids === 'false')
const hugeYt = youtubeShortsFields('word '.repeat(3000))
check('a huge caption still gives a legal YouTube title and description', weight(hugeYt.youtube_title) <= 100 && hugeYt.youtube_description.length <= 5000 && hugeYt.youtube_description.includes('#Shorts'))
check('an emoji-heavy title stays within 100', weight(youtubeShortsFields('✈️🌴🏝️ ' + 'beach '.repeat(60)).youtube_title) <= 100)

// Instagram fields.
const manyTags = 'Hello Cozumel\n\nPlan your trip: link in bio\nhttps://x.ca/a?utm_source=video\n\n#a #b #c #d #e #f #g'
const ig = instagramReelsFields(manyTags)
check('Instagram uses the documented fields', ig.media_type === 'REELS' && ig.share_to_feed === 'true' && typeof ig.instagram_title === 'string')
check('Instagram caption keeps the link and drops hashtags over the cap', ig.instagram_title.includes('utm_source=video') && (ig.instagram_title.match(/#\w+/g) ?? []).length <= 5)
check('Instagram caption is within 2200', instagramReelsFields('word '.repeat(2000)).instagram_title.length <= 2200)
check('capHashtags keeps the first N and leaves other text', capHashtags('hi #a mid #b #c end', 2) === 'hi #a mid #b end')

// The log records what would be sent, per network, and sends nothing.
const entry = buildLogEntry('my-post', ['youtube', 'instagram'], long, new Date('2026-11-01T00:00:00Z'))
check('log entry carries both networks fields', entry.slug === 'my-post' && !!entry.fields.youtube?.youtube_title && !!entry.fields.instagram?.instagram_title)

// Wiring (source checks: the send path itself is never run here).
const up = src('lib/upload-post.ts')
check('Upload-Post video send sets the YouTube and Instagram fields only for those platforms', /includes\('youtube'\)\) for \(const \[k, v\] of Object\.entries\(youtubeShortsFields/.test(up) && /includes\('instagram'\)\) for \(const \[k, v\] of Object\.entries\(instagramReelsFields/.test(up))
const auto = src('lib/autopilot.ts')
check('autopilot gates the video platforms through the switches and logs the log-only ones', /splitVideoPlatforms\(/.test(auto) && /getVideoExtraModes\(admin\)/.test(auto) && /recordVideoExtraLog\(admin, buildLogEntry\(/.test(auto))
check('log mode never reaches a send (videoLogOnly is not passed to sendVideo)', !/sendVideo\([^)]*videoLogOnly/.test(auto))
const route = src('app/api/admin/posting/route.ts')
check('admin route exposes the modes and checks videoExtra before the posting-mode branch', /videoExtras:/.test(route) && route.indexOf('body.videoExtra') < route.indexOf("typeof body.mode === 'string'"))
check('posting card shows the two switches', /videoExtras/.test(src('components/admin/posting-card.tsx')))
check('.env.example documents both settings', /social_youtube_shorts_mode/.test(src('.env.example')) && /social_instagram_reels_mode/.test(src('.env.example')))

// Platform lists and self-heal treat them like the others.
check('both are video-capable media networks', platformsFor('video', ['youtube', 'instagram']).length === 2 && mediaCapable(['youtube', 'instagram']).length === 2)
check('YouTube takes no photo post (video only)', !platformsFor('photo', ['youtube']).includes('youtube'))
check('a failed post naming youtube or instagram is read by the self-heal step', networksNamedIn('youtube: 401 token expired; instagram: reconnect').sort().join() === 'instagram,youtube')
const health = uploadPostHealth([{ username: 'p', accounts: [{ platform: 'youtube', status: 'connected' }, { platform: 'instagram', status: 'needs reconnect' }] }], 'p')
check('self-heal reads YouTube healthy and Instagram needing reconnect', healthOf(health, 'youtube') === 'healthy' && healthOf(health, 'instagram') === 'unhealthy')

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nAll checks passed.')
