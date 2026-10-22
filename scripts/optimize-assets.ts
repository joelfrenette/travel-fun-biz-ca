// Makes lighter WebP copies of the heavy PNG/JPG pictures in public/ and public/assets (anything over 300 KB).
// The original is never touched or deleted: a WebP copy is written next to it (same name, .webp) only when it is under
// the size limit (200 KB). Point a page at the .webp copy yourself (this script prints what it made and the sizes).
// Run: pnpm dlx tsx scripts/optimize-assets.ts          (add --dry to only print the plan)
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import sharp from 'sharp'

const ROOT = join(__dirname, '..', 'public')
const MIN_BYTES = 300 * 1024
const MAX_OUT_BYTES = 200 * 1024
const QUALITIES = [80, 74, 68, 62]
const dry = process.argv.includes('--dry')

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
}

async function main() {
  const heavy = walk(ROOT).filter((f) => /\.(png|jpe?g)$/i.test(f) && statSync(f).size >= MIN_BYTES)
  console.log(`${heavy.length} picture(s) over ${MIN_BYTES / 1024} KB`)
  for (const file of heavy) {
    const before = statSync(file).size
    let best: Buffer | null = null
    let used = 0
    for (const q of QUALITIES) {
      const buf = await sharp(file).webp({ quality: q, effort: 5 }).toBuffer()
      best = buf
      used = q
      if (buf.length <= MAX_OUT_BYTES) break
    }
    if (!best) continue
    const out = file.slice(0, file.length - extname(file).length) + '.webp'
    const ok = best.length <= MAX_OUT_BYTES
    console.log(`${ok ? 'OK  ' : 'SKIP'} ${basename(file)}: ${(before / 1024).toFixed(0)} KB -> ${(best.length / 1024).toFixed(0)} KB (webp q${used})${ok ? '' : ' (still over the limit, not written)'}`)
    if (ok && !dry) writeFileSync(out, best)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
