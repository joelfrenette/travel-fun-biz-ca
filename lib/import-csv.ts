import Papa from 'papaparse'

// Real CSV bulk import (roadmap use case 6989b62b: "the Excel upload" used to just show a spinner
// and say "coming soon" - literally a setTimeout and an alert). Scoped to CSV, not .xlsx/.xls:
// the only actively-maintained xlsx parser on the npm registry (SheetJS's own newer, patched
// releases are only published to their own CDN, not npm) is stuck at a version with known
// prototype-pollution/ReDoS CVEs in exactly the code path an admin file upload would exercise.
// A spreadsheet app's own "Save as CSV" is a one-click workaround; pulling in a vulnerable binary
// parser to avoid asking for that click is not a trade worth making for an admin-only tool.
//
// Never invents data: a row missing a required column is rejected outright, and every other
// column maps straight through as text - no defaults, no guessed categories or prices.

export const REQUIRED_HEADERS = ['name', 'destination', 'duration', 'price_display'] as const

export const OPTIONAL_HEADERS = [
  'category',
  'supplier',
  'short_description',
  'full_description',
  'highlights',
  'price_includes',
  'not_included',
  'booking_url',
  'more_info_url',
  'image_url',
  'video_url',
  'keywords',
  'available_from',
  'available_to',
  'max_people',
  'price_value',
] as const

export const ALL_HEADERS = [...REQUIRED_HEADERS, ...OPTIONAL_HEADERS] as const

// Columns whose cell text is a list; split on a semicolon or a pipe (never a plain comma - price
// includes and highlights routinely contain commas of their own, e.g. "meals, drinks, transfers").
const LIST_COLUMNS = new Set(['highlights', 'price_includes', 'not_included'])

export interface CsvRow {
  rowNumber: number // 1-based, matching what a spreadsheet app shows (header is row 1)
  data: Record<string, unknown>
  errors: string[]
}

export interface ParseCsvResult {
  rows: CsvRow[]
  headers: string[]
  unknownHeaders: string[]
  error: string | null
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/** Parse CSV text into package-shaped rows. Pure and synchronous-enough for a browser file (no
 * network, no DB) - safe to unit test directly. */
export function parsePackagesCsv(text: string): ParseCsvResult {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: true,
    transformHeader: normalizeHeader,
  })

  if (parsed.errors.length > 0 && parsed.data.length === 0) {
    return { rows: [], headers: [], unknownHeaders: [], error: `Could not read this as CSV: ${parsed.errors[0].message}` }
  }

  const headers = parsed.meta.fields ?? []
  const missingRequired = REQUIRED_HEADERS.filter((h) => !headers.includes(h))
  if (missingRequired.length > 0) {
    return { rows: [], headers, unknownHeaders: [], error: `Missing required column(s): ${missingRequired.join(', ')}. Download the template to see the exact column names.` }
  }
  const known = new Set<string>(ALL_HEADERS)
  const unknownHeaders = headers.filter((h) => !known.has(h as any))

  const rows: CsvRow[] = parsed.data.map((raw, i) => {
    const errors: string[] = []
    const data: Record<string, unknown> = {}
    for (const key of REQUIRED_HEADERS) {
      const v = (raw[key] ?? '').trim()
      if (!v) errors.push(`Missing ${key}`)
      else data[key] = v
    }
    for (const key of OPTIONAL_HEADERS) {
      const raw_v = raw[key]
      if (raw_v == null || raw_v.trim() === '') continue
      const v = raw_v.trim()
      if (LIST_COLUMNS.has(key)) {
        data[key] = v.split(/[;|]/).map((s) => s.trim()).filter(Boolean)
      } else if (key === 'price_value' || key === 'max_people') {
        const n = Number(v.replace(/,/g, ''))
        if (Number.isFinite(n)) data[key] = n
        else errors.push(`${key} is not a number ("${v}")`)
      } else if (key === 'available_from' || key === 'available_to') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push(`${key} must be YYYY-MM-DD ("${v}")`)
        else data[key] = v
      } else {
        data[key] = v
      }
    }
    return { rowNumber: i + 2, data, errors }
  })

  return { rows, headers, unknownHeaders, error: null }
}

/** A blank CSV with every recognized column, so "what do I put in the file" never requires
 * guessing. */
export function csvTemplate(): string {
  const example = {
    name: 'Sunset Sailing Escape',
    destination: 'Santorini',
    duration: '7 Nights',
    price_display: 'From $2,199 CAD per person',
    category: 'Cruise',
    supplier: 'Example Cruises',
    short_description: 'A week sailing the Aegean with stops in Mykonos and Crete.',
    full_description: '',
    highlights: 'Sunset in Oia; Private beach day; Wine tasting',
    price_includes: 'All meals; Onboard entertainment; Port taxes',
    not_included: 'Airfare; Gratuities',
    booking_url: '',
    more_info_url: '',
    image_url: '',
    video_url: '',
    keywords: 'santorini cruise, greek islands trip',
    available_from: '2027-06-01',
    available_to: '2027-06-08',
    max_people: '',
    price_value: '2199',
  }
  return Papa.unparse({ fields: [...ALL_HEADERS], data: [ALL_HEADERS.map((h) => (example as Record<string, string>)[h] ?? '')] })
}
