// Offline check: a TikTok title always fits TikTok's limit of 90 (an emoji counts as 2).
import { fitTikTokTitle } from '../lib/ghl-social'

let failed = 0
const check = (name: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failed++ }
const weight = (s: string) => [...s].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff || /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1), 0)

const long = 'Australia New Zealand Group Tour: a first-timer guide to every stop, what to book early, and how to avoid the costly mistakes most travellers make on their first trip.\n\nRead the full guide https://www.travelfunbiz.ca/blog/x\n#travel #australia'
check('a 400-character caption becomes a title of 90 or less', weight(fitTikTokTitle(long)) <= 90)
check('keeps the start of the caption', fitTikTokTitle(long).startsWith('Australia New Zealand Group Tour'))
check('drops hashtags and links', !/#|https?:/.test(fitTikTokTitle(long)))
check('cuts at a whole word', !fitTikTokTitle(long).endsWith('-') && long.includes(fitTikTokTitle(long)))
const emoji = '✈️🌴🏝️ ' + 'beach '.repeat(40)
check('emoji count as 2', weight(fitTikTokTitle(emoji)) <= 90)
check('a short caption is unchanged', fitTikTokTitle('Cozumel in 60 seconds') === 'Cozumel in 60 seconds')
check('one huge word is cut by weight', weight(fitTikTokTitle('x'.repeat(300))) <= 90 && fitTikTokTitle('x'.repeat(300)).length > 0)
check('empty text gives empty title', fitTikTokTitle('') === '')

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nAll checks passed.')
