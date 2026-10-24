// READ-ONLY scan: finds trips whose stored text holds a cut-off sentence ("... Cathedral of St.", "... Fortress of St and gardens").
// Reads travel_packages (every text, list and JSON field) and the app_settings keys trip_kit:<id>. Writes nothing to the database.
// Run: pnpm dlx tsx scripts/scan-trip-cutoffs.ts [--json=path]   (needs .env.local with the Supabase service role; never committed)
import fs from 'node:fs'
import path from 'node:path'

function loadEnv() {
  const file = path.join(process.cwd(), '.env.local')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '')
  }
}
loadEnv()

interface Hit {
  slug: string
  status: string
  where: string
  why: string
}

function walk(v: unknown, where: string, out: { where: string; text: string }[]) {
  if (typeof v === 'string') {
    const t = v.trim()
    if (t.length >= 20 && /\s/.test(t) && !/^https?:/i.test(t)) out.push({ where, text: t })
  } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as object)) walk(x, `${where}.${k}`, out)
}

async function main() {
  const { getSupabaseAdmin } = await import('../lib/supabase-admin')
  const { firstCutOff } = await import('../lib/sentence-safe')
  const admin = getSupabaseAdmin()
  const { data: rows, error } = await admin.from('travel_packages').select('*')
  if (error) throw error
  const hits: Hit[] = []
  const latent: { slug: string; names: string[] }[] = []
  const bySlug = new Map<string, { slug: string; status: string }>()
  for (const r of (rows ?? []) as Record<string, unknown>[]) {
    const slug = String(r.slug)
    const status = String(r.status ?? (r.published ? 'published' : 'draft'))
    bySlug.set(String(r.id), { slug, status })
    const strings: { where: string; text: string }[] = []
    for (const [k, v] of Object.entries(r)) {
      if (['id', 'slug', 'booking_url', 'more_info_url', 'cover_image_url'].includes(k)) continue
      walk(v, k, strings)
    }
    for (const s of strings) {
      const why = firstCutOff(s.text)
      if (why) hits.push({ slug, status, where: s.where, why })
    }
  }
  const { data: sets, error: e2 } = await admin.from('app_settings').select('key, value').like('key', 'trip_kit%')
  if (e2) throw e2
  for (const s of (sets ?? []) as { key: string; value: unknown }[]) {
    if (s.key.startsWith('trip_kit_prev:')) continue
    if (s.key.startsWith('trip_kit_facts:')) {
      // The cached reference sheet: not shown on the page, but it feeds the writer. A bad name here repeats the bug on the next
      // fill unless the fill is run with refresh. Counted separately.
      const meta = bySlug.get(s.key.slice('trip_kit_facts:'.length)) ?? { slug: `(unknown ${s.key})`, status: '?' }
      const raw = typeof s.value === 'string' ? s.value : JSON.stringify(s.value)
      const names = [...raw.matchAll(/"name":"([^"]*?\b(?:St|Mt|Dr|Fr|Mr|Mrs|Ms|Ft))"/g)].map((m) => m[1])
      if (names.length) latent.push({ slug: meta.slug, names })
      continue
    }
    if (!s.key.startsWith('trip_kit:')) continue
    const id = s.key.slice('trip_kit:'.length)
    const meta = bySlug.get(id) ?? { slug: `(unknown ${id})`, status: '?' }
    let parsed: unknown = s.value
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed)
      } catch {
        /* plain text */
      }
    }
    const strings: { where: string; text: string }[] = []
    walk(parsed, 'trip_kit', strings)
    for (const x of strings) {
      const why = firstCutOff(x.text)
      if (why) hits.push({ slug: meta.slug, status: meta.status, where: x.where, why })
    }
  }
  const slugs = [...new Set(hits.map((h) => h.slug))]
  console.log(`${hits.length} cut-off(s) in ${slugs.length} trip(s) of ${(rows ?? []).length}`)
  for (const h of hits) console.log(`${h.slug} [${h.status}] ${h.where}: ${h.why}`)
  for (const l of latent) console.log(`LATENT (cached reference sheet, not on the page) ${l.slug}: ${l.names.join(' | ')}`)
  const out = process.argv.find((a) => a.startsWith('--json='))?.slice(7)
  if (out) fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), slugs, hits, latent }, null, 1))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
