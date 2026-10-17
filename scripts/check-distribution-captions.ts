// Offline checks for per-network fallback captions and UTM source in the default send path. No network, no database.
// Run: pnpm dlx tsx scripts/check-distribution-captions.ts   (exits 1 on any failed expectation)
import { buildNetworkFallbacks, groupNetworksForSend, PLATFORM_CHAR_LIMITS } from '../lib/social-captions'
import { hashtagCapFor } from '../lib/hook-styles'
import { canonicalNetwork, utmLink } from '../lib/utm'
import { readFileSync } from 'node:fs'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

expect('canonicalNetwork twitter is x', canonicalNetwork('twitter') === 'x')
expect('canonicalNetwork Twitter (case) is x', canonicalNetwork(' Twitter ') === 'x')
for (const n of ['facebook', 'linkedin', 'threads', 'instagram', 'x', 'bluesky']) {
  expect(`canonicalNetwork idempotent for ${n}`, canonicalNetwork(canonicalNetwork(n)) === n && canonicalNetwork(n) === n)
}
expect('canonicalNetwork null is empty', canonicalNetwork(null) === '')

const slug = 'rhine-river-cruise'
const pageUrl = `https://travelfunbiz.ca/blog/${slug}`
const linkFor = (p: string) => utmLink(pageUrl, { source: canonicalNetwork(p), medium: 'social', campaign: slug, content: 'fallback' })
const facts = {
  title: 'Rhine River Cruise: What First Timers Should Know',
  metaDescription: 'A plain guide to a 7 day Rhine cruise for first timers, with what to pack and how to choose a cabin. '.repeat(3).trim(),
  faqQuestions: ['Is a river cruise right for a first big trip?'],
  keyTakeaways: ['A 7 day Rhine sailing suits first timers.'],
  tags: ['river cruise', 'Rhine', 'Europe', 'Family Travel', 'Germany'],
}

const networks = ['twitter', 'x', 'facebook', 'linkedin', 'threads', 'bluesky', 'instagram', 'tiktok', 'pinterest', 'youtube']
const caps = buildNetworkFallbacks(facts, networks, linkFor)
expect('one caption per network', networks.every((n) => typeof caps[n] === 'string' && caps[n].length > 0))
for (const n of networks) {
  const c = caps[n]
  expect(`${n}: length within its own limit`, c.length <= PLATFORM_CHAR_LIMITS[n], `${c.length} > ${PLATFORM_CHAR_LIMITS[n]}`)
  const tags = c.match(/#\w+/g) ?? []
  expect(`${n}: hashtags within cap ${hashtagCapFor(n)}`, tags.length <= hashtagCapFor(n), `${tags.length}`)
  expect(`${n}: no em dash`, !c.includes(String.fromCharCode(8212)))
  const m = c.match(/https?:\/\/\S+/)
  if (n === 'instagram' || n === 'tiktok') {
    expect(`${n}: bio wording, no link`, !m)
    continue
  }
  const u = m ? new URL(m[0]) : null
  expect(`${n}: link has utm_source=${canonicalNetwork(n)}`, u?.searchParams.get('utm_source') === canonicalNetwork(n), String(u?.search))
  expect(`${n}: link has utm_medium=social`, u?.searchParams.get('utm_medium') === 'social')
  expect(`${n}: link has utm_campaign=slug`, u?.searchParams.get('utm_campaign') === slug)
}
expect('twitter caption links with source x', new URL(caps['twitter'].match(/https?:\/\/\S+/)![0]).searchParams.get('utm_source') === 'x')
expect('X caption cannot exceed 280', caps['x'].length <= 280)
expect('LinkedIn caption can exceed 280', caps['linkedin'].length > 280, String(caps['linkedin'].length))
expect('Facebook caption can exceed 280', caps['facebook'].length > 280, String(caps['facebook'].length))

// Grouping: identical limit, hashtag cap and clickability share one group; never more groups than networks.
const same = groupNetworksForSend(['twitter', 'x'])
expect('twitter and x share one group', same.length === 1 && same[0].length === 2)
expect('empty list gives no groups', groupNetworksForSend([]).length === 0)
const g = groupNetworksForSend(networks)
expect('groups never exceed networks', g.length <= networks.length)
expect('every network appears exactly once', g.flat().length === networks.length && new Set(g.flat()).size === networks.length)
expect('networks with different limits are split', g.some((grp) => grp.includes('x') && !grp.includes('linkedin')))
expect('clickable and non-clickable never share a group', !g.some((grp) => grp.includes('instagram') && grp.includes('facebook')))
for (const grp of g) {
  const lim = new Set(grp.map((n) => PLATFORM_CHAR_LIMITS[n]))
  const cap = new Set(grp.map(hashtagCapFor))
  expect(`group ${grp.join('/')} has one limit and one cap`, lim.size === 1 && cap.size === 1)
}

// Source: the default send path no longer builds one social-sourced link.
const src = readFileSync('lib/distribution.ts', 'utf8')
expect("distribution.ts has no utmLink with source 'social'", !/source:\s*'social'/.test(src))
expect('distribution.ts uses per-network fallbacks', src.includes('buildNetworkFallbacks('))
expect('distribution.ts groups Upload-Post sends', src.includes('groupNetworksForSend('))

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
