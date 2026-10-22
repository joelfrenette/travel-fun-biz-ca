// Offline checks for the "link in bio" page (lib/bio-links.ts, app/links/page.tsx). No network, no database.
// Run: pnpm dlx tsx scripts/check-bio-links.ts
import { readFileSync } from 'node:fs'
import { buildBioLinks, bioSource, bioHref } from '../lib/bio-links'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

const input = {
  guides: [
    { path: '/destinations/cancun', slug: 'cancun', name: 'Cancun guide' },
    { path: '/hotels/riu-palace', slug: 'riu-palace', name: 'RIU Palace' },
    { path: '/resorts/x', slug: '', name: 'No slug' },
  ],
  trips: [{ slug: 'riviera-maya', name: 'Riviera Maya trip' }, { name: 'No slug trip' }],
  posts: [{ slug: 'cancun-or-tulum', title: 'Cancun or Tulum' }, { slug: 'rhine', title: '' }],
}
const links = buildBioLinks(input, 'instagram')
const all = [...links.guide, ...links.trip, ...links.post]

expect('guides, trips and posts are listed, items missing a slug or title are left out', links.guide.length === 2 && links.trip.length === 1 && links.post.length === 1, JSON.stringify(Object.values(links).map((l) => l.length)))
expect('every link is tagged: utm_source=instagram, utm_medium=social, utm_campaign=instagram_bio', all.every((l) => /utm_source=instagram/.test(l.href) && /utm_medium=social/.test(l.href) && /utm_campaign=instagram_bio/.test(l.href)))
expect('every link has its own utm_content (bio-<kind>-<slug>)', new Set(all.map((l) => new URL(l.href).searchParams.get('utm_content'))).size === all.length && all.every((l) => (new URL(l.href).searchParams.get('utm_content') ?? '').startsWith('bio-')))
expect('links point at the right pages', links.guide[0].href.includes('/destinations/cancun?') && links.trip[0].href.includes('/packages/riviera-maya?') && links.post[0].href.includes('/blog/cancun-or-tulum?'))
expect('the limit is honoured per kind', buildBioLinks(input, 'instagram', 1).guide.length === 1)
expect('?src= picks a known network, anything else is instagram', bioSource('tiktok') === 'tiktok' && bioSource(['youtube', 'x']) === 'youtube' && bioSource('evil<script>') === 'instagram' && bioSource(undefined) === 'instagram')
expect('a tiktok visitor is credited to tiktok_bio', bioHref('/blog/a', 'tiktok', 'post', 'a').includes('utm_source=tiktok') && bioHref('/blog/a', 'tiktok', 'post', 'a').includes('utm_campaign=tiktok_bio'))

const page = readFileSync('app/links/page.tsx', 'utf8')
expect('the /links page is noindex', /robots:\s*\{\s*index:\s*false/.test(page))
expect('the /links page has no em dash', !page.includes(String.fromCharCode(8212)) && !readFileSync('lib/bio-links.ts', 'utf8').includes(String.fromCharCode(8212)))

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll bio link checks passed')
