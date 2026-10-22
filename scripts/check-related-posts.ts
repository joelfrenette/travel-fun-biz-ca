// Offline check: pickRelatedPosts scoring and the "More stories" block on the blog page. No network.
// Run: pnpm dlx tsx scripts/check-related-posts.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pickRelatedPosts, type Post } from '../lib/posts'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

function mk(slug: string, o: Partial<Post> = {}): Post {
  return {
    id: slug, title: slug, slug, body: '', cover_image_url: null, alt_text: null, tags: [], related_package_id: null,
    status: 'published', publish_date: '2026-01-01T00:00:00Z', meta_title: null, meta_description: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...o,
  }
}

const base = mk('base', { tags: ['cancun', 'beach'], primary_keyword: 'cancun all inclusive resorts', related_package_id: 'pkg1' })
const tagPost = mk('tag', { tags: ['cancun'] })
const kwOnly = mk('kw', { primary_keyword: 'best all inclusive deals' })
const zero = mk('zero', { tags: ['ski'], primary_keyword: 'alps' })
const draft = mk('draft', { tags: ['cancun', 'beach'], status: 'draft' })
const self = mk('base', { id: 'base' })
const all = [base, tagPost, kwOnly, zero, draft, self]

const r = pickRelatedPosts(base, all)
expect('self excluded', !r.some((p) => p.slug === 'base'))
expect('unpublished excluded', !r.some((p) => p.slug === 'draft'))
expect('shared-tag post outranks keyword-only post', r.findIndex((p) => p.slug === 'tag') < r.findIndex((p) => p.slug === 'kw') && r.length === 2, JSON.stringify(r.map((p) => p.slug)))
expect('zero-score candidates not padded', !r.some((p) => p.slug === 'zero'))
expect('returns [] when nothing scores', pickRelatedPosts(base, [zero, draft, self]).length === 0)
const many = Array.from({ length: 6 }, (_, i) => mk(`t${i}`, { tags: ['cancun'], publish_date: `2026-02-0${i + 1}T00:00:00Z` }))
const top = pickRelatedPosts(base, many)
expect('max 3 returned', top.length === 3)
expect('ties go to newest publish_date', top.map((p) => p.slug).join() === 't5,t4,t3', top.map((p) => p.slug).join())
expect('same package bonus outranks one shared tag', pickRelatedPosts(base, [tagPost, mk('pk', { related_package_id: 'pkg1' })])[0].slug === 'pk')
expect('deterministic', JSON.stringify(pickRelatedPosts(base, many)) === JSON.stringify(pickRelatedPosts(base, [...many].reverse())))
expect('limit respected', pickRelatedPosts(base, many, 2).length === 2)

const src = readFileSync(join(__dirname, '..', 'app', 'blog', '[slug]', 'page.tsx'), 'utf8')
expect('blog page renders More stories guarded by a length check', /morePosts\.length > 0 && \([\s\S]*?More stories/.test(src))
expect('blog page uses lazy cover thumbnails with alt', /loading="lazy"/.test(src) && /alt=\{p\.cover_image_url && !isGenericAlt\(p\.alt_text\) \? \(p\.alt_text as string\) : p\.title\}/.test(src))
expect('More stories comes after the FAQ section', src.indexOf('faq-heading') < src.indexOf('More stories'))
expect('no em dashes in new block or helper', !/—/.test(src.slice(src.indexOf('morePosts.length > 0 &&'), src.indexOf('relatedGuides.length > 0 &&'))))

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nAll related-posts checks passed')
