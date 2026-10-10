// Pure checks for the growth loop WP6 share-image path parser, photo allow-list and title wrapper.
// No database, no network. Run: pnpm dlx tsx scripts/check-og-paths.ts
import { parseOgPath, OG_PREFIXES, ogImageUrl, ogImageEntry, isAllowedPhotoUrl, wrapTitle, fitTitle, cleanTitle, OG_WIDTH, OG_HEIGHT } from '../lib/og-path'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

// ---- parseOgPath: valid ----
for (const prefix of OG_PREFIXES) {
  const t = parseOgPath([prefix, 'some-slug'])
  check(`accepts prefix ${prefix}`, !!t && t.prefix === prefix && t.slug === 'some-slug')
}
check('accepts a compare pair slug', parseOgPath(['compare', 'italy-vs-tahiti'])?.slug === 'italy-vs-tahiti')
check('accepts a slug with a dot', parseOgPath(['blog', 'st.-lucia-guide'])?.slug === 'st.-lucia-guide')
check('accepts a slug with digits and underscore', parseOgPath(['packages', 'trip_2026-10'])?.slug === 'trip_2026-10')
check('accepts upper case slug', parseOgPath(['blog', 'My-Post'])?.slug === 'My-Post')

// ---- parseOgPath: rejected ----
check('rejects ".." as a slug', parseOgPath(['blog', '..']) === null)
check('rejects a slug containing ".."', parseOgPath(['blog', 'a..b']) === null)
check('rejects ".." as a prefix', parseOgPath(['..', 'etc']) === null)
check('rejects a slash inside a slug', parseOgPath(['blog', 'a/b']) === null)
check('rejects an encoded slash', parseOgPath(['blog', 'a%2Fb']) === null)
check('rejects a backslash', parseOgPath(['blog', 'a\\b']) === null)
check('rejects a slug starting with a dot', parseOgPath(['blog', '.hidden']) === null)
check('rejects a slug starting with a dash', parseOgPath(['blog', '-x']) === null)
check('rejects spaces', parseOgPath(['blog', 'a b']) === null)
check('rejects unknown prefix', parseOgPath(['admin', 'x']) === null)
check('rejects prefix with different case', parseOgPath(['Blog', 'x']) === null)
check('rejects empty slug', parseOgPath(['blog', '']) === null)
check('rejects empty array', parseOgPath([]) === null)
check('rejects undefined', parseOgPath(undefined) === null)
check('rejects null', parseOgPath(null) === null)
check('rejects one segment', parseOgPath(['blog']) === null)
check('rejects three segments', parseOgPath(['blog', 'a', 'b']) === null)
check('rejects a 200 character slug', parseOgPath(['blog', 'a'.repeat(200)]) === null)
check('rejects the prototype-key prefix', parseOgPath(['constructor', 'x']) === null)

// ---- URL builders ----
check('ogImageUrl is absolute and under /og/', /^https:\/\/[^/]+\/og\/blog\/my-post$/.test(ogImageUrl('blog', 'my-post')), ogImageUrl('blog', 'my-post'))
{
  const e = ogImageEntry('hotels', 'x', 'Alt text')
  check('ogImageEntry carries 1200x630 and alt', e.width === 1200 && e.height === 630 && e.alt === 'Alt text' && OG_WIDTH === 1200 && OG_HEIGHT === 630)
}

// ---- photo allow-list ----
check('allows Pexels', isAllowedPhotoUrl('https://images.pexels.com/photos/1/x.jpeg'))
check('allows Supabase storage', isAllowedPhotoUrl('https://ldwmbwsxrktpcisqaxrb.supabase.co/storage/v1/object/public/a/b.jpg'))
check('allows the site itself', isAllowedPhotoUrl('https://www.travelfunbiz.ca/x.jpg'))
check('rejects http', !isAllowedPhotoUrl('http://images.pexels.com/photos/1/x.jpeg'))
check('rejects other hosts', !isAllowedPhotoUrl('https://evil.example.com/x.jpg'))
check('rejects look-alike host', !isAllowedPhotoUrl('https://images.pexels.com.evil.example.com/x.jpg'))
check('rejects credentials in the URL', !isAllowedPhotoUrl('https://user:pw@images.pexels.com/x.jpg'))
check('rejects data URLs', !isAllowedPhotoUrl('data:image/png;base64,AAAA'))
check('rejects empty and null', !isAllowedPhotoUrl('') && !isAllowedPhotoUrl(null) && !isAllowedPhotoUrl(undefined))
check('rejects garbage', !isAllowedPhotoUrl('not a url'))

// ---- wrapTitle ----
{
  const r = wrapTitle('Short title', 24)
  check('short title is one line, not truncated', r.lines.length === 1 && r.lines[0] === 'Short title' && !r.truncated)
}
{
  const r = wrapTitle('One two three four five six', 14)
  check('wraps on word boundaries within the width', r.lines.length === 2 && r.lines.every((l) => l.length <= 14) && r.lines.join(' ') === 'One two three four five six', JSON.stringify(r))
}
{
  const r = wrapTitle('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi', 12)
  check('never more than 3 lines', r.lines.length === 3, String(r.lines.length))
  check('long text is flagged truncated', r.truncated)
  check('truncated text ends with an ellipsis', r.lines[2].endsWith('…'), r.lines[2])
  check('truncated last line still fits the width', r.lines[2].length <= 12, r.lines[2])
}
{
  const r = wrapTitle('Supercalifragilisticexpialidocious', 10)
  check('splits a word longer than a line', r.lines.length === 3 && r.lines.every((l) => l.length <= 10), JSON.stringify(r))
}
{
  const r = wrapTitle('exactly fits in three lines', 11)
  check('text that exactly fills 3 lines is not truncated', r.lines.length === 3 && !r.truncated, JSON.stringify(r))
}
check('empty text gives no lines', wrapTitle('', 20).lines.length === 0)

// ---- fitTitle ----
{
  const r = fitTitle('Cancun Trips')
  check('short title gets the biggest size', r.fontSize === 76 && r.lines.length === 1 && !r.truncated)
}
{
  const r = fitTitle('Your 7-Night Rhine Float Decoded: Cologne to Basel on a River Cruise with Real Travel Advisors')
  check('long title stays within 3 lines', r.lines.length <= 3, String(r.lines.length))
  check('long title shrinks the font', r.fontSize < 76)
}
{
  const r = fitTitle('word '.repeat(80))
  check('very long title is cut with an ellipsis at the smallest size', r.truncated && r.fontSize === 46 && r.lines.length === 3 && r.lines[2].endsWith('…'), JSON.stringify(r))
}
{
  const r = fitTitle('   spaced    out   title  ')
  check('collapses whitespace', r.lines.join(' ') === 'spaced out title')
}

// ---- cleanTitle ----
check('strips a trailing site-name suffix', cleanTitle('Best Beaches | TravelFunBiz.ca', 'TravelFunBiz.ca') === 'Best Beaches')
check('leaves other titles alone', cleanTitle('A | B', 'TravelFunBiz.ca') === 'A | B')
check('collapses whitespace in titles', cleanTitle('  a   b ') === 'a b')

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll checks passed')
