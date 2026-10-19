// Offline check: blog posts link to matching published guides and related posts. No network, no database.
// Run: pnpm dlx tsx scripts/check-blog-links.ts   (exit 1 on a failure)
import { pickGuideAndPostLinks, mergeAllowedLinks, withGuideAndPostLinks, MAX_POST_LINKS, type LinkGuide, type LinkPost } from '../lib/autoblog-run'
import { gateWithRepair, type AllowedLink } from '../lib/blog-composer'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

const guides: LinkGuide[] = [
  { kind: 'cruise-lines', slug: 'viking', name: 'Viking' },
  { kind: 'cruise-lines', slug: 'avalon-waterways', name: 'Avalon Waterways' },
  { kind: 'destinations', slug: 'rome', name: 'Rome' },
  { kind: 'destinations', slug: 'cancun', name: 'Cancun' },
  { kind: 'ships', slug: 'viking-venus', name: 'Viking Venus' },
]
const post = (slug: string, tags: string[], o: Partial<LinkPost> = {}): LinkPost => ({ slug, title: `Title ${slug}`, tags, status: 'published', publish_date: '2026-01-01T00:00:00Z', ...o })
const posts: LinkPost[] = [post('p-new', ['rivers', 'beach']), post('p-old', ['rivers']), post('p-third', ['rivers']), post('p-ski', ['ski'])]

async function main() {
  // A topic naming a published cruise line gets that guide path.
  const a = pickGuideAndPostLinks({ angle: 'Is a Viking river cruise right for first timers', keyword: 'viking river cruise' }, guides, [])
  expect('named cruise line gets its guide path', a.length === 1 && a[0].path === '/cruise-lines/viking', JSON.stringify(a))
  expect('whole word only (Viking does not match Vikings)', pickGuideAndPostLinks({ angle: 'The Vikings and their boats', keyword: 'history' }, guides, []).length === 0)
  expect('match is case-insensitive', pickGuideAndPostLinks({ angle: 'ROME in spring', keyword: 'x' }, guides, []).some((l) => l.path === '/destinations/rome'))
  expect('match on a keyword in the set', pickGuideAndPostLinks({ angle: 'x', keyword: 'y', keywords: ['cancun resorts'] }, guides, []).some((l) => l.path === '/destinations/cancun'))
  expect('match on a topic tag', pickGuideAndPostLinks({ angle: 'x', keyword: 'y', tags: ['Rome'] }, guides, []).some((l) => l.path === '/destinations/rome'))

  // No match adds nothing and does not throw.
  const none = pickGuideAndPostLinks({ angle: 'Packing tips for a weekend away', keyword: 'packing list' }, guides, posts)
  expect('no match adds nothing', none.length === 0, JSON.stringify(none))
  expect('empty inputs are fine', pickGuideAndPostLinks({ angle: '', keyword: '' }, [], []).length === 0)

  // Caps: 3 guides, 2 posts, 5 in all.
  const many: LinkGuide[] = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map((n) => ({ kind: 'destinations', slug: n.toLowerCase(), name: n }))
  const topic = { angle: 'Alpha Bravo Charlie Delta Echo and rivers', keyword: 'rivers' }
  const picked = pickGuideAndPostLinks(topic, many, posts)
  expect('at most 3 guides', picked.filter((l) => l.path.startsWith('/destinations/')).length === 3)
  expect('at most 2 posts', picked.filter((l) => l.path.startsWith('/blog/')).length === 2)
  const base: AllowedLink[] = [
    { path: '/packages/x', label: 'trip' },
    { path: '/destinations/x', label: 'dest' },
    { path: '/best-time-to-visit/x', label: 'best' },
  ]
  const merged = mergeAllowedLinks(base, picked)
  expect(`total never exceeds ${MAX_POST_LINKS}`, merged.length === MAX_POST_LINKS && merged.slice(0, 3).every((l, i) => l.path === base[i].path), merged.map((l) => l.path).join(','))
  expect('no repeated path', new Set(merged.map((l) => l.path)).size === merged.length)
  expect('merge with nothing keeps base', mergeAllowedLinks(base, []).length === 3)

  // Posts: shared tag picked, newest first, self never linked, drafts and future posts skipped.
  const rivers = pickGuideAndPostLinks({ angle: 'x', keyword: 'y', tags: ['rivers'] }, [], posts)
  expect('posts sharing a tag are picked, newest first', rivers.map((l) => l.path).join() === '/blog/p-new,/blog/p-old', rivers.map((l) => l.path).join())
  const selfSkip = pickGuideAndPostLinks({ angle: 'x', keyword: 'y', tags: ['rivers'] }, [], posts, 'p-new')
  expect('the post being written is never linked to itself', !selfSkip.some((l) => l.path === '/blog/p-new') && selfSkip.length === 2, selfSkip.map((l) => l.path).join())
  const hidden = pickGuideAndPostLinks({ angle: 'x', keyword: 'y', tags: ['rivers'] }, [], [post('d', ['rivers'], { status: 'draft' }), post('f', ['rivers'], { publish_date: '2099-01-01T00:00:00Z' })])
  expect('drafts and future-dated posts are skipped', hidden.length === 0)
  expect('a post with no shared tag is not picked', !rivers.some((l) => l.path === '/blog/p-ski'))
  expect('post tag found as a whole word in the angle', pickGuideAndPostLinks({ angle: 'A ski trip for friends', keyword: 'y' }, [], posts).some((l) => l.path === '/blog/p-ski'))

  // Fail open: a thrown read returns the pre-existing links.
  const okGuides = async () => guides
  const okPosts = async () => posts
  const boom = async (): Promise<never> => { throw new Error('read failed') }
  const origErr = console.error
  console.error = () => {}
  const t1 = await withGuideAndPostLinks(base, topic, boom, okPosts)
  const t2 = await withGuideAndPostLinks(base, topic, okGuides, boom)
  console.error = origErr
  expect('a thrown guide read returns the existing links', t1 === base)
  expect('a thrown post read returns the existing links', t2 === base)
  const good = await withGuideAndPostLinks([], { angle: 'Viking river cruise', keyword: 'viking' }, okGuides, okPosts)
  expect('working reads add the guide with no package', good.length === 1 && good[0].path === '/cruise-lines/viking', JSON.stringify(good))

  // The quality gate accepts guide and post paths that were offered, and still rejects an unlisted one.
  const offered = mergeAllowedLinks([], pickGuideAndPostLinks({ angle: 'Viking river cruise', keyword: 'viking', tags: ['rivers'] }, guides, posts))
  const gateCtx = { allowedPaths: offered.map((l) => l.path), groundingText: 'Viking river cruise', deadlineMs: Date.now() }
  const bodyWith = (...paths: string[]) => `A river cruise is a trip on a river.\n\n${paths.map((p) => `See [this page](${p}) for more.`).join('\n\n')}\n`
  const gate = async (paths: string[]) => {
    const post = { title: 'River cruises for first timers', slug: 'river-cruises-first-timers', body: bodyWith(...paths), seo_title: 'River cruises for first timers', seo_description: 'Plain advice for first timers.', tags: [], faq: [], key_takeaways: [], og_title: '', og_description: '', primary_keyword: 'viking river cruise', secondary_keywords: [], content_style: 'guide' }
    const res = await gateWithRepair(post, new Date(), gateCtx)
    return res.blockers.filter((b) => /link/i.test(b))
  }
  const okRes = await gate(['/cruise-lines/viking', '/blog/p-new'])
  expect('guide and post paths are accepted (no link blocker)', okRes.length === 0, okRes.join(' | '))
  const badRes = await gate(['/cruise-lines/unlisted-line'])
  expect('an unlisted path is still rejected', badRes.some((b) => b.includes('/cruise-lines/unlisted-line')), badRes.join(' | '))
}

main().then(() => {
  if (failures) {
    console.log(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall checks passed')
}).catch((e) => {
  console.error(e)
  process.exit(1)
})
