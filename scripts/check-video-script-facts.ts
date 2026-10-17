// Offline checks: reel scripts grounded in stored key takeaways and FAQ answers. No network, no database.
// Run: pnpm dlx tsx scripts/check-video-script-facts.ts   (exits 1 on any failed expectation)
import { readFileSync } from 'node:fs'
import { scriptPrompt } from '../lib/video-script'
import { ungroundedNumbers } from '../lib/hook-styles'
import { buildGroundingText } from '../lib/post-grounding'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

const title = 'Planning a Caribbean cruise'
const summary = 'What first-time cruisers should know before booking.'
const base = scriptPrompt(title, summary)
expect('prompt without facts has the plain Title/Summary block', base.includes(`Summary: ${summary}\n\nNever claim personal experience`))
expect('blank facts leave the prompt byte-identical', scriptPrompt(title, summary, undefined, '') === base && scriptPrompt(title, summary, undefined, '   ') === base)
expect('no facts block without facts', !base.includes('Facts you may use'))

const facts = '- Most ships sail 7 nights\n- Passports are needed for most ports'
const withFacts = scriptPrompt(title, summary, undefined, facts)
expect('facts block present', withFacts.includes('Facts you may use'))
expect('fact text present', withFacts.includes('Most ships sail 7 nights'))
expect('states nothing outside Title, Summary and Facts may be asserted', withFacts.includes('Nothing outside the Title, Summary and Facts may be asserted'))

expect('number absent from title, summary and facts is flagged', ungroundedNumbers('Save 40 percent', `${title} ${summary} ${facts}`).includes('40'))
expect('number only in facts is not flagged', ungroundedNumbers('Most ships sail 7 nights', `${title} ${summary} ${facts}`).length === 0)
expect('number only in facts is flagged without facts', ungroundedNumbers('Most ships sail 7 nights', `${title} ${summary}`).includes('7'))

expect('empty input returns empty string', buildGroundingText(undefined, undefined) === '' && buildGroundingText([], []) === '' && buildGroundingText('x', 5) === '')
const many = Array.from({ length: 80 }, (_, i) => `takeaway number${i} words here`)
const long = buildGroundingText(many, [{ q: 'Is it safe?', a: 'Yes, with normal care.' }])
expect('output length <= 1200', long.length <= 1200 && long.length > 1000, String(long.length))
expect('cut at a word boundary', /(here|words)$/.test(long) && !/\bnumb$|\btak$|\bnum$/.test(long), long.slice(-20))
const short = buildGroundingText(['One 3 night stay'], [{ q: 'How long?', a: '3 nights.' }])
expect('short input is kept whole with FAQ Q/A', short === '- One 3 night stay\n- How long? 3 nights.', short)
expect('custom maxChars respected', buildGroundingText(many, [], 100).length <= 100)

const dist = readFileSync('lib/distribution.ts', 'utf8')
const auto = readFileSync('lib/autopilot.ts', 'utf8')
expect('distribution.ts imports the shared helper', /buildGroundingText/.test(dist) && dist.includes("@/lib/post-grounding"))
expect('distribution.ts has no duplicate builder', !dist.includes('.slice(0, 1500)') && !/const takeaways = Array\.isArray\(data\.key_takeaways\)/.test(dist))
expect('autopilot.ts imports and passes the helper output', auto.includes("@/lib/post-grounding") && /generateVideoScript\([^\n]*buildGroundingText\(post\.key_takeaways, post\.faq\)/.test(auto))

if (failures) { console.log(`\n${failures} failed`); process.exit(1) }
console.log('\nall passed')
