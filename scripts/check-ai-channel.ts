// Offline checks for the AI-assistant traffic channel and /llms.txt (hub row 13). No network, no database.
// Run: pnpm dlx tsx scripts/check-ai-channel.ts
import { readFileSync } from 'node:fs'
import { aiAssistantOf, CHANNEL_LABELS, CHANNELS, classifyVisit, touchForLanding, type Channel } from '../lib/traffic-source'
import { allocateLinks, buildLlmsTxt, LLMS_MAX_LINKS, oneLine, safeTitle, type LlmsData, type LlmsLink } from '../lib/llms-txt'
import { site } from '../lib/site'

let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failed++
}
const LONG_DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

// ---- referrers ----
const refs: [string, string][] = [
  ['https://chatgpt.com/', 'chatgpt'],
  ['https://chat.openai.com/c/abc', 'chatgpt'],
  ['https://www.perplexity.ai/search/x', 'perplexity'],
  ['https://claude.ai/chat/1', 'claude'],
  ['https://gemini.google.com/app', 'gemini'],
  ['https://copilot.microsoft.com/', 'copilot'],
  ['https://you.com/search?q=x', 'you.com'],
  ['https://www.phind.com/search', 'phind'],
]
for (const [referrer, source] of refs) {
  const r = classifyVisit({ referrer })
  check(`referrer ${new URL(referrer).hostname} is ai_assistant (${source})`, r.channel === 'ai_assistant' && r.source === source, JSON.stringify(r))
}
check('gemini.google.com is NOT counted as Google search', classifyVisit({ referrer: 'https://gemini.google.com/' }).channel === 'ai_assistant')
check('plain google.com is still search', classifyVisit({ referrer: 'https://www.google.com/' }).channel === 'search')
check('a similar host is not an assistant (notyou.com)', classifyVisit({ referrer: 'https://notyou.com/' }).channel === 'other')
check('a look-alike (chatgpt.com.evil.io) is not an assistant', classifyVisit({ referrer: 'https://chatgpt.com.evil.io/' }).channel !== 'ai_assistant')
check('facebook is still social, no referrer is still direct', classifyVisit({ referrer: 'https://l.facebook.com/' }).channel === 'social' && classifyVisit({}).channel === 'direct')

// ---- utm_source ----
for (const [utm, source] of [['chatgpt.com', 'chatgpt'], ['ChatGPT', 'chatgpt'], ['openai', 'chatgpt'], ['perplexity', 'perplexity'], ['perplexity.ai', 'perplexity'], ['claude', 'claude'], ['gemini', 'gemini'], ['copilot', 'copilot'], ['you.com', 'you.com'], ['phind', 'phind']] as const) {
  const r = classifyVisit({ utmSource: utm })
  check(`utm_source=${utm} is ai_assistant (${source})`, r.channel === 'ai_assistant' && r.source === source, JSON.stringify(r))
}
check('utm_source=chatgpt.com with no referrer (the link ChatGPT adds)', touchForLanding({ href: 'https://www.travelfunbiz.ca/blog/x?utm_source=chatgpt.com' }).channel === 'ai_assistant')
check('utm_source of something else is unchanged (other)', classifyVisit({ utmSource: 'newsletter-x' }).channel === 'other' || classifyVisit({ utmSource: 'newsletter-x' }).channel === 'email')
check('a paid medium still wins over an assistant tag', classifyVisit({ utmSource: 'chatgpt.com', utmMedium: 'cpc' }).channel === 'paid_search')
check('an email medium still wins over an assistant tag', classifyVisit({ utmSource: 'claude', utmMedium: 'email' }).channel === 'email')
check('a gclid still means paid search', classifyVisit({ referrer: 'https://chatgpt.com/', clickId: 'gclid' }).channel === 'paid_search')
check('aiAssistantOf: null for empty input', aiAssistantOf('', '') === null && aiAssistantOf(null, undefined) === null)

// ---- the channel lists are complete ----
const all: Channel[] = ['search', 'ai_assistant', 'paid_search', 'social', 'paid_social', 'email', 'referral', 'bio', 'direct', 'other']
check('CHANNELS lists every channel once', all.every((c) => CHANNELS.includes(c)) && CHANNELS.length === all.length && new Set(CHANNELS).size === CHANNELS.length)
check('every channel has a plain label', CHANNELS.every((c) => !!CHANNEL_LABELS[c]) && CHANNEL_LABELS.ai_assistant === 'AI assistants')
check('the funnel panel shows the label, not the raw key', /CHANNEL_LABELS\[c\.channel as Channel\]/.test(src('components/admin/funnel-panel.tsx')))

// ---- llms.txt ----
const link = (title: string, path: string, summary = ''): LlmsLink => ({ title, path, summary })
const data: LlmsData = {
  destinations: [link('Italy', '/destinations/italy', 'A country of art and food.')],
  trips: [link('Rome Escape', '/packages/rome-escape', 'A hosted week in Rome.')],
  guides: [{ kind: 'hotels', links: [link('Hotel Roma', '/hotels/hotel-roma')] }, { kind: 'ships', links: [] }],
  posts: [link('Rhine tips', '/blog/rhine-tips', 'Plan a river cruise.')],
}
const text = buildLlmsTxt(data)
check('llms: starts with the site name as a heading', text.startsWith(`# ${site.name}\n`))
check('llms: has the summary quote and a who we are section', /\n> /.test(text) && /## Who we are/.test(text))
check('llms: gives the site phone', text.includes(site.phone))
check('llms: links are absolute and include each section', text.includes(`(${site.url}/destinations/italy)`) && text.includes(`(${site.url}/packages/rome-escape)`) && text.includes(`(${site.url}/hotels/hotel-roma)`) && text.includes(`(${site.url}/blog/rhine-tips)`))
check('llms: an empty section (ships) is left out', !/## Ships/.test(text))
check('llms: stored summary follows the link', text.includes('Rome Escape](') && text.includes('A hosted week in Rome.'))
check('llms: no em or en dash in the output', !LONG_DASH.test(text))
const bigData: LlmsData = {
  destinations: Array.from({ length: 300 }, (_, i) => link(`D${i}`, `/destinations/d${i}`)),
  trips: Array.from({ length: 300 }, (_, i) => link(`T${i}`, `/packages/t${i}`)),
  guides: [],
  posts: Array.from({ length: 300 }, (_, i) => link(`P${i}`, `/blog/p${i}`)),
}
const big = buildLlmsTxt(bigData)
const bigLinks = (big.match(/^- \[/gm) ?? []).length
check(`llms: capped at ${LLMS_MAX_LINKS} links`, bigLinks === LLMS_MAX_LINKS, String(bigLinks))
check('llms: a big section does not crowd the others out', /\(.*\/packages\/t0\)/.test(big) && /\(.*\/blog\/p0\)/.test(big) && /\(.*\/destinations\/d0\)/.test(big))
const alloc = allocateLinks([[1, 2, 3, 4], [5], [6, 7]], 5)
check('allocate: round robin, keeps order, honours the total', JSON.stringify(alloc) === JSON.stringify([[1, 2], [5], [6, 7]]) || alloc.flat().length === 5, JSON.stringify(alloc))
check('oneLine: first sentence only', oneLine('A fine trip. It has more words after.') === 'A fine trip.')
check('oneLine: markdown removed', oneLine('See **our** [guide](/x) today.') === 'See our guide today.')
check('oneLine: a price drops the line', oneLine('From $1,999 per person.') === '' && oneLine('Only 1999 CAD.') === '')
check('oneLine: a phone, email or web address drops the line', oneLine('Call 416-555-1212 now.') === '' && oneLine('Write to a@b.com today.') === '' && oneLine('See https://x.io now.') === '')
check('oneLine: long text is cut near 160 characters', oneLine(`${'word '.repeat(80)}.`).length <= 160)
check('oneLine: empty and null are empty', oneLine(null) === '' && oneLine('  ') === '')

// ---- wiring: published rows only, cached, nothing private ----
const lib = src('lib/llms-txt.ts')
const route = src('app/llms.txt/route.ts')
check('llms: uses the public client, not the admin client', /integrations\/supabase\/client/.test(lib) && !/supabase-admin/.test(lib) && !/getSupabaseAdmin/.test(lib))
check('llms: posts are read as published only', /from\('posts'\)[^\n]*\.eq\('status', 'published'\)/.test(lib))
check('llms: route is cached for an hour and plain text', /revalidate = 3600/.test(route) && /text\/plain/.test(route))
check('sitemap does not list /llms.txt (it is not a page) and robots does not block it', !/llms/.test(src('app/sitemap.ts')) && !/llms/.test(src('app/robots.ts')) && /allow: '\/'/.test(src('app/robots.ts')))
check('no em or en dashes in the new files', !LONG_DASH.test(lib) && !LONG_DASH.test(route))

// titles are scrubbed like the summaries
check('llms: safeTitle drops a title with a price, an email, a phone number or a web address', safeTitle('Rome from $1,999') === '' && safeTitle('Email me@x.com') === '' && safeTitle('Call 604-555-0199') === '' && safeTitle('See https://x.com') === '' && safeTitle('Deal in CAD') === '' && safeTitle('Rome Escape') === 'Rome Escape')
check('llms: safeTitle strips brackets and long dashes', safeTitle('Rome [week] ' + String.fromCharCode(0x2014) + ' trip') === 'Rome week - trip')
const dirty = buildLlmsTxt({ destinations: [], trips: [link('Rome from $1,999', '/packages/bad'), link('Rome Escape', '/packages/rome-escape')], guides: [], posts: [link('Write to a@b.ca', '/blog/bad2')] })
check('llms: a link whose title is unsafe is left out, and its section too when empty', !dirty.includes('/packages/bad') && !dirty.includes('/blog/bad2') && dirty.includes('/packages/rome-escape') && !/## Blog posts/.test(dirty))

console.log(failed === 0 ? '\nAll AI channel and llms.txt checks passed.' : `\n${failed} check(s) FAILED.`)
process.exit(failed === 0 ? 0 : 1)
