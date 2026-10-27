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

// The live provider is Upload-Post (app_settings distribution_provider), so its photo and video sends must set TikTok's own title.
const src = require('node:fs').readFileSync('lib/upload-post.ts', 'utf8') as string
check('Upload-Post sends tiktok_title for photos and videos', (src.match(/form\.set\('tiktok_title', fitTikTokTitle\(input\.text\)\)/g) ?? []).length === 2)

// Upload-Post refuses every Pinterest pin without a board id ("Pinterest Board ID is required", 2026-10-26), so photos and videos send one when it is set.
check('Upload-Post sends pinterest_board_id for photos and videos', (src.match(/form\.set\('pinterest_board_id', pinterestBoardId\(\) as string\)/g) ?? []).length === 2)
import('../lib/upload-post').then(({ pinterestBoardId }) => {
  const keep = process.env.UPLOAD_POST_PINTEREST_BOARD_ID
  process.env.UPLOAD_POST_PINTEREST_BOARD_ID = ' 987654321098765432 '
  check('pinterestBoardId reads a numeric board id and trims it', pinterestBoardId() === '987654321098765432')
  process.env.UPLOAD_POST_PINTEREST_BOARD_ID = 'My Board'
  check('pinterestBoardId ignores a board name (it must be the numeric id)', pinterestBoardId() === null)
  delete process.env.UPLOAD_POST_PINTEREST_BOARD_ID
  check('pinterestBoardId is null when unset, so Pinterest stays paused', pinterestBoardId() === null)
  if (keep !== undefined) process.env.UPLOAD_POST_PINTEREST_BOARD_ID = keep
  if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1) }
  console.log('\nAll checks passed.')
})
