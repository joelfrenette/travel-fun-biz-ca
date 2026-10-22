// Dev-only: look at any real reel. Takes a reel URL or a local file, uses ffmpeg from PATH to pull five frames (0.4s, 2.5s, 8s, end-3s,
// end-0.5s) and joins them into one contact sheet PNG, so the owner or Claude can QA a finished reel by eye. Nothing here is used by the
// site; it needs only node and ffmpeg (ffprobe is used for the length when present, ffmpeg's own banner otherwise). No repo dependencies.
//
//   pnpm dlx tsx scripts/inspect-reel.ts <reel-url-or-file> [--out <folder>]
//
// Writes frame-1.png ... frame-5.png and contact-sheet.png into the folder (default: a new folder under the system temp directory) and
// prints their paths. Exit 0 on success, 1 on bad input, 2 when ffmpeg is not installed.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const outFlag = args.indexOf('--out')
const outDir = outFlag >= 0 ? resolve(args[outFlag + 1] ?? '') : ''
const source = args.find((a, i) => !a.startsWith('--') && i !== outFlag + 1)

function usage(): never {
  console.error('Usage: pnpm dlx tsx scripts/inspect-reel.ts <reel-url-or-file> [--out <folder>]')
  process.exit(1)
}
if (!source) usage()

function hasTool(name: string): boolean {
  const r = spawnSync(name, ['-version'], { encoding: 'utf8' })
  return !r.error && r.status === 0
}
if (!hasTool('ffmpeg')) {
  console.error('ffmpeg was not found on PATH. Install it (for example: winget install ffmpeg, or brew install ffmpeg) and run this again.')
  process.exit(2)
}

/** Length in seconds, from ffprobe when present, else from the Duration line ffmpeg prints for any input. */
function durationOf(file: string): number {
  if (hasTool('ffprobe')) {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' })
    const n = Number(String(r.stdout).trim())
    if (Number.isFinite(n) && n > 0) return n
  }
  const r = spawnSync('ffmpeg', ['-i', file], { encoding: 'utf8' })
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(`${r.stderr}`)
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0
}

async function main() {
  const dir = outDir || mkdtempSync(join(tmpdir(), 'reel-inspect-'))
  mkdirSync(dir, { recursive: true })
  let file = source as string
  if (/^https?:\/\//i.test(file)) {
    const res = await fetch(file)
    if (!res.ok) {
      console.error(`Could not download the reel (status ${res.status}).`)
      process.exit(1)
    }
    file = join(dir, 'reel.mp4')
    writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  } else if (!existsSync(file)) {
    console.error(`File not found: ${file}`)
    process.exit(1)
  }

  const length = durationOf(file)
  if (!(length > 0)) {
    console.error('Could not read the length of this video.')
    process.exit(1)
  }
  const times = [0.4, 2.5, 8, length - 3, length - 0.5].map((t) => Math.max(0, Math.min(length - 0.05, t)))
  const frames: string[] = []
  times.forEach((t, i) => {
    const out = join(dir, `frame-${i + 1}.png`)
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=360:-2', out])
    frames.push(out)
  })
  const sheet = join(dir, 'contact-sheet.png')
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...frames.flatMap((f) => ['-i', f]), '-filter_complex', `hstack=inputs=${frames.length}`, sheet])

  console.log(`Reel length ${length.toFixed(1)}s. Frames at ${times.map((t) => `${t.toFixed(1)}s`).join(', ')}.`)
  console.log('Frames:')
  for (const f of frames) console.log(`  ${f}`)
  console.log(`Contact sheet: ${sheet}`)
  console.log('Look for: the cover headline fully readable at 0.4s and 2.5s with no caption over it; b-roll that matches the subject (not a skate park or a dinner table for a river cruise); the end card (red block, call to action) in the last two frames.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
