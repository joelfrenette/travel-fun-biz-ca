// Offline checks for the self-improving loop's pure helpers. Run: pnpm dlx tsx scripts/check-performance.ts
import { chooseWeighted, blogSlugFromPath, styleKeyLabel } from '../lib/style-choice'

let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failed++
}

const CAT = ['listicle', 'how-to', 'comparison', 'faq-led'] as const
const scores = [
  { value: 'listicle', clicksPerPost: 2, posts: 5 },
  { value: 'how-to', clicksPerPost: 9, posts: 4 },
  { value: 'comparison', clicksPerPost: 50, posts: 2 }, // great but thin: must never steer
  { value: 'faq-led', clicksPerPost: 1, posts: 3 },
]

// 70/30 with a fixed rand: below 0.7 exploits the best eligible value, at or above rotates.
check('exploit when rand < 0.7', chooseWeighted(scores, ['listicle'], CAT, () => 0.1) === 'how-to')
check('exploit boundary 0.69', chooseWeighted(scores, ['listicle'], CAT, () => 0.69) === 'how-to')
const rotated = chooseWeighted(scores, ['listicle'], CAT, () => 0.7)
check('rotate when rand >= 0.7 (never the most recent)', rotated !== 'listicle', rotated)

// Thin samples never win the exploit branch even with the best numbers.
check('thin sample is ignored', chooseWeighted(scores, ['listicle'], CAT, () => 0) !== 'comparison')

// Never the most recent, even when it is the best.
check('best is most recent -> picks next best', chooseWeighted(scores, ['how-to'], CAT, () => 0.1) === 'listicle')
let sawRecent = false
for (let i = 0; i < 100; i++) if (chooseWeighted(scores, ['how-to', 'listicle'], CAT, () => i / 100) === 'how-to') sawRecent = true
check('never repeats the most recent across 100 draws', !sawRecent)

// Nothing has 3+ posts: always rotate, least used first, never the most recent.
const thin = [{ value: 'listicle', clicksPerPost: 99, posts: 2 }]
const recent = ['listicle', 'how-to', 'how-to', 'comparison']
const pick = chooseWeighted(thin, recent, CAT, () => 0)
check('all thin -> rotation picks least used, not most recent', pick === 'faq-led', pick)
check('all thin with empty scores', chooseWeighted([], [], CAT, () => 0.5) !== undefined)

// Deterministic given rand.
check('deterministic', chooseWeighted(scores, ['listicle'], CAT, () => 0.8) === chooseWeighted(scores, ['listicle'], CAT, () => 0.8))

// A score for a value no longer in the catalogue is ignored.
check('unknown value ignored', chooseWeighted([{ value: 'gone', clicksPerPost: 100, posts: 9 }], ['listicle'], CAT, () => 0) !== 'gone')

// Single-value catalogue cannot loop or throw.
check('single catalogue', chooseWeighted([], ['only'], ['only'], () => 0.3) === 'only')

// Slug from path.
check('slug basic', blogSlugFromPath('/blog/hello-world') === 'hello-world')
check('slug trailing slash', blogSlugFromPath('/blog/hello-world/') === 'hello-world')
check('slug query', blogSlugFromPath('/blog/hello-world?utm_source=x') === 'hello-world')
check('slug not blog', blogSlugFromPath('/packages/paris') === null)
check('slug blog index', blogSlugFromPath('/blog') === null)
check('slug nested', blogSlugFromPath('/blog/a/b') === null)

check('label', styleKeyLabel('hook_style:instagram') === 'Hook style, instagram' && styleKeyLabel('content_style') === 'Blog post style')

if (failed) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
