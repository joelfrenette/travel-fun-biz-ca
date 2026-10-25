import { cleanAgentInput, cleanText, parseOfficeRole, publicName, slugify, type AgentEditable, parseCertifications } from '@/lib/agents'

// CSV / Excel-paste import for the agent roster (pure). Joel's 20+ agents live in a spreadsheet today. He copies the cells
// (Excel pastes tab-separated text) or uploads a CSV, maps each column to a field, sees a PREVIEW, and only then imports.
//
// Rules: nothing is invented. A missing cell stays empty and is listed in `missing`. Every imported agent is a DRAFT with
// both consents OFF, so nobody becomes public by import. Certifications from a sheet are imported as NOT verified.

export const IMPORT_FIELDS = [
  { key: 'display_name', label: 'Name' },
  { key: 'first_name', label: 'First name (joined with last name)' },
  { key: 'last_name', label: 'Last name (joined with first name)' },
  { key: 'email', label: 'Email (private)' },
  { key: 'phone', label: 'Phone (private)' },
  { key: 'address', label: 'Address (private)' },
  { key: 'headline', label: 'Headline' },
  { key: 'bio', label: 'Bio' },
  { key: 'specialties', label: 'Specialties' },
  { key: 'certifications', label: 'Certifications (not verified until you tick them)' },
  { key: 'years_experience', label: 'Years of experience' },
  { key: 'languages', label: 'Languages' },
  { key: 'home_city', label: 'Home city' },
  { key: 'region', label: 'Region' },
  { key: 'photo_url', label: 'Photo link' },
  { key: 'video_urls', label: 'Video links' },
  { key: 'notes', label: 'Notes (private)' },
  { key: 'internal_tags', label: 'Internal tags (private)' },
  { key: 'office_role', label: 'Office role: ceo, cto or mgr (private)' },
  // The next fields have no column of their own: they are kept as labelled lines in the PRIVATE notes, never public.
  { key: 'second_email', label: 'Second email (private, kept in notes)' },
  { key: 'clia', label: 'CLIA number (private, kept in notes; adds an unverified CLIA certification)' },
  { key: 'fsot', label: 'Seller of travel / FSOT number (private, kept in notes)' },
  { key: 'agent_since', label: 'Agent start date (private, kept in notes)' },
  { key: 'renewal_date', label: 'Next renewal date (private, kept in notes)' },
  { key: 'affiliate_link', label: 'Affiliate link (private, kept in notes)' },
  { key: 'commission_sheet', label: 'Commission sheet link (private, kept in notes; only a real https link is kept)' },
  { key: 'active', label: 'Active? (a row marked NO is skipped)' },
] as const

export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key']

/** Words in a header that point at a field. First match wins, in this order. */
const SYNONYMS: [ImportFieldKey, RegExp][] = [
  [
    'first_name',
    /^(first[\s_-]*name|given[\s_-]*name|first)$/i,
  ],
  ['last_name', /^(last[\s_-]*name|surname|family[\s_-]*name|last)$/i],
  ['display_name', /^(name|full[\s_-]*name|agent|agent[\s_-]*name|display[\s_-]*name)$/i],
  ['second_email', /e[\s_-]?mail[\s_-]*(2|two)\b|(second|2nd|other|alt\w*|backup)[\s_-]*e[\s_-]?mail/i],
  ['email', /e[\s_-]?mail/i],
  ['phone', /phone|mobile|cell|tel\b/i],
  ['clia', /^clia\b/i],
  ['fsot', /fsot|seller[\s_-]*of[\s_-]*travel/i],
  ['agent_since', /start[\s_-]*date|date[\s_-]*(joined|started)|joined|(member|agent)[\s_-]*since/i],
  ['renewal_date', /renewal/i],
  ['affiliate_link', /affiliate/i],
  ['commission_sheet', /^commissions?[\s_-]*sheet/i],
  ['active', /^(active|is[\s_-]*active)$/i],
  ['address', /address|mailing|street/i],
  // A column called exactly "role" or "office role" is the office role. Longer titles ("Job title", "Position") stay headlines.
  ['office_role', /^(office[\s_-]*role|role)$/i],
  ['headline', /headline|tagline|title|role|position/i],
  ['bio', /\bbio\b|biography|about|description|profile/i],
  ['specialties', /special|focus|expert|niche/i],
  ['certifications', /certif|designation|credential|accredit/i],
  ['years_experience', /years|experience|yrs|tenure/i],
  ['languages', /language|speaks/i],
  ['home_city', /city|town|based/i],
  ['region', /region|province|state|territory/i],
  ['photo_url', /photo|picture|image|headshot|avatar/i],
  ['video_urls', /video|youtube|vimeo/i],
  ['notes', /note|comment|remark/i],
  ['internal_tags', /tag|label|group|team/i],
]

/** Columns that hold money, tax, ID or birth data. They are NEVER imported, whatever the mapping says: the roster is not the
 * place for them (DOB, income, 1099, W9, contracts, commission split and booked-sales targets). */
const SENSITIVE_HEADER = /\b(dob|birth\w*|born)\b|income|1099|\bw-?9\b|commission|booked|\bssn\b|\bsin\b|\btax\w*|salary|payout|payroll|\bbank\w*|contracts?\b|\blevel\b|\d+\s*k\b/i

/** The one exception: the column that holds each agent's commission SHEET link. The link is kept (private notes); the figures stay out. */
const COMMISSION_SHEET_HEADER = /^commissions?[\s_-]*sheet\b/i

export const isSensitiveHeader = (header: string): boolean => !COMMISSION_SHEET_HEADER.test(header.trim()) && SENSITIVE_HEADER.test(header)

/** Sheet placeholders that mean "nothing here". Treated as an empty cell so they are never stored as data. */
const PLACEHOLDER = /^(n\/?a|na|none|nil|null|tbd|unknown|\?+|-+|—+)$/i
export const isPlaceholder = (v: string): boolean => PLACEHOLDER.test(v.trim())

/** An Excel date serial (a raw exported number such as 46333) becomes YYYY-MM-DD. Any other text is returned as it was typed. */
export function readSheetDate(v: string): string {
  const t = v.trim()
  if (/^\d{5}(\.\d+)?$/.test(t)) {
    const n = Math.floor(Number(t))
    if (n > 20000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + n * 86_400_000).toISOString().slice(0, 10)
  }
  return t
}

export function guessField(header: string): ImportFieldKey | '' {
  const h = header.trim()
  if (!h || isSensitiveHeader(h)) return ''
  for (const [key, re] of SYNONYMS) if (re.test(h)) return key
  return ''
}

/** Parses delimited text (comma, tab or semicolon; quoted cells; quoted newlines). Returns rows of raw cells. */
export function parseDelimited(text: string): string[][] {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const firstLine = src.split('\n', 1)[0] ?? ''
  const count = (ch: string) => firstLine.split(ch).length - 1
  const delim = count('\t') > 0 && count('\t') >= count(',') ? '\t' : count(';') > count(',') ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += c
    } else if (c === '"' && cell === '') quoted = true
    else if (c === delim) {
      row.push(cell)
      cell = ''
    } else if (c === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

export const IMPORT_MAX_ROWS = 200
export const IMPORT_MAX_CHARS = 400_000

export interface ParsedSheet {
  headers: string[]
  rows: string[][]
  /** header index -> guessed field ('' = ignore) */
  guess: (ImportFieldKey | '')[]
  /** Headers left out on purpose because they hold money, tax, ID or birth data. */
  skippedPrivate: string[]
}

export function parseSheet(text: string): { ok: true; sheet: ParsedSheet } | { ok: false; error: string } {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'Paste the cells from your sheet, or choose a CSV file.' }
  if (text.length > IMPORT_MAX_CHARS) return { ok: false, error: 'That is too much text at once. Import 200 agents or fewer at a time.' }
  const all = parseDelimited(text)
  if (all.length < 2) return { ok: false, error: 'I need a header row and at least one agent row.' }
  const headers = all[0].map((h) => cleanText(h, 80))
  const rows = all.slice(1, IMPORT_MAX_ROWS + 1)
  const used = new Set<string>()
  const guess = headers.map((h) => {
    const g = guessField(h)
    if (!g || used.has(g)) return ''
    used.add(g)
    return g
  })
  return { ok: true, sheet: { headers, rows, guess, skippedPrivate: headers.filter((h) => h && isSensitiveHeader(h)) } }
}

export interface PreviewRow {
  index: number
  ok: boolean
  slug: string
  value: AgentEditable | null
  /** Plain-English list of fields left empty (surfaced, never filled in). */
  missing: string[]
  warnings: string[]
  /** 'new' or 'exists' (a row with this slug or email is already in the roster). */
  action: 'new' | 'exists'
}

const WATCH: [ImportFieldKey | 'display_name', string][] = [
  ['bio', 'bio'],
  ['specialties', 'specialties'],
  ['headline', 'headline'],
  ['years_experience', 'years of experience'],
  ['photo_url', 'photo'],
  ['languages', 'languages'],
]

/** Builds the preview. `mapping` is one entry per header ('' = ignore). `existing` lists slugs and emails already stored. */
export function buildPreview(sheet: { headers: string[]; rows: string[][] }, mapping: (ImportFieldKey | '')[], existing: { slugs: string[]; emails: string[]; officeRoles?: string[] }): PreviewRow[] {
  const slugs = new Set(existing.slugs.map((s) => s.toLowerCase()))
  const emails = new Set(existing.emails.map((s) => s.toLowerCase()))
  const seen = new Set<string>()
  // Office roles already held in the roster, then those claimed earlier in this paste. Import never moves a role.
  const takenRoles = new Set((existing.officeRoles ?? []).map((r) => r.toLowerCase()))
  return sheet.rows.map((cells, index) => {
    const raw: Record<string, string> = {}
    mapping.forEach((field, i) => {
      // A sensitive column is dropped even if someone mapped it by hand.
      if (!field || isSensitiveHeader(sheet.headers[i] ?? '')) return
      const v = (cells[i] ?? '').trim()
      if (v && !isPlaceholder(v)) raw[field] = raw[field] ? `${raw[field]}; ${v}` : v
    })
    const inactive = raw.active !== undefined && /^(no|n|false|0|inactive|former|left)$/i.test(raw.active.trim())
    const name = raw.display_name || [raw.first_name, raw.last_name].filter(Boolean).join(' ')
    const input: Record<string, unknown> = {}
    if (name) input.display_name = name
    for (const k of ['email', 'phone', 'address', 'headline', 'bio', 'home_city', 'region', 'notes', 'photo_url'] as const) if (raw[k]) input[k] = raw[k]
    if (raw.specialties) input.specialties = raw.specialties
    if (raw.languages) input.languages = raw.languages
    if (raw.internal_tags) input.internal_tags = raw.internal_tags
    if (raw.years_experience) input.years_experience = raw.years_experience
    if (raw.video_urls) input.video_urls = raw.video_urls
    // A sheet cell lists certification names. They come in as NOT verified (parseCertifications only trusts an explicit true).
    const certs = raw.certifications ? raw.certifications.split(/[;,\n|]/).map((n) => ({ name: n, issuer: '', year: null, verified: false })).filter((c) => c.name.trim()) : []
    // A CLIA number in the sheet means a CLIA membership claim: add the certification NOT verified, number kept private.
    if (raw.clia && !certs.some((c) => /clia/i.test(c.name))) certs.push({ name: 'CLIA', issuer: '', year: null, verified: false })
    if (certs.length) input.certifications = certs
    // Details with no column of their own become labelled lines in the private notes (never public).
    const extra = [
      raw.clia && `CLIA #: ${raw.clia}`,
      raw.fsot && `Seller of travel (FSOT) #: ${raw.fsot}`,
      raw.agent_since && `Agent start date: ${readSheetDate(raw.agent_since)}`,
      raw.renewal_date && `Next renewal: ${readSheetDate(raw.renewal_date)}`,
      raw.second_email && `Second email: ${raw.second_email}`,
      raw.affiliate_link && `Affiliate link: ${raw.affiliate_link}`,
      // Only a real https link is stored, never the words "Commission sheet" or a pasted figure.
      raw.commission_sheet && /^https:\/\/\S+$/i.test(raw.commission_sheet) && `Commission sheet: ${raw.commission_sheet}`,
    ].filter(Boolean) as string[]
    if (extra.length) input.notes = [raw.notes, ...extra].filter(Boolean).join('\n')
    const warnings: string[] = []
    if (!name) return { index, ok: false, slug: '', value: null, missing: ['name'], warnings: ['No name in this row, so it cannot be imported.'], action: 'new' as const }
    if (inactive) return { index, ok: false, slug: slugify(name), value: null, missing: [], warnings: ['Marked not active in the sheet, so this row is skipped.'], action: 'new' as const }
    const slug = slugify(name)
    // A parenthetical in the sheet name (a maiden name) never goes public: it is dropped from the display name and slug and
    // kept only in the private notes.
    if (publicName(name) !== name.replace(/\s+/g, ' ').trim()) input.notes = [input.notes ?? raw.notes, `Name in sheet: ${name}`].filter(Boolean).join('\n')
    input.slug = slug
    const cleaned = cleanAgentInput(input)
    if (!cleaned.ok) return { index, ok: false, slug, value: null, missing: [], warnings: cleaned.errors, action: 'new' as const }
    const value = cleaned.value
    const missing: string[] = []
    if (raw.office_role) {
      const role = parseOfficeRole(raw.office_role)
      if (role === 'invalid') warnings.push('The office role must be ceo, cto or mgr, so it was left empty.')
      else if (role && takenRoles.has(role)) warnings.push('That office role is already held by someone else (or earlier in this paste), so it was left empty. Change it in the editor if you mean to move it.')
      else if (role) {
        value.office_role = role
        takenRoles.add(role)
      }
    }
    for (const [k, label] of WATCH) {
      const v = (value as Record<string, unknown>)[k]
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) missing.push(label)
    }
    if (raw.commission_sheet && !/^https:\/\/\S+$/i.test(raw.commission_sheet)) warnings.push('The commission sheet cell was not a full https link (just text), so it was not stored. Paste the real link.')
    if (raw.photo_url && !value.photo_url) warnings.push('The photo link was not a valid https link, so it was left empty.')
    if (raw.video_urls && !(value.video_urls?.length)) warnings.push('No video link was a YouTube or Vimeo https link, so the videos were left empty.')
    if (raw.years_experience && value.years_experience == null) warnings.push('Years of experience was not a number from 0 to 80, so it was left empty.')
    if (raw.certifications && parseCertifications(value.certifications).length === 0) warnings.push('Certifications could not be read.')
    let action: 'new' | 'exists' = 'new'
    if (slugs.has(slug) || (value.email && emails.has(value.email))) {
      action = 'exists'
      warnings.push('Already in the roster, so this row is skipped.')
    }
    if (seen.has(slug)) {
      action = 'exists'
      warnings.push('The same name appears twice in this paste, so this row is skipped.')
    }
    seen.add(slug)
    return { index, ok: true, slug, value, missing, warnings, action }
  })
}
