import type { TravelPackage } from '@/types/travel'

export interface SheetRow {
  [key: string]: string
}

function parsePriceValue(raw?: string): number | undefined {
  if (!raw) return undefined
  const numeric = raw.replace(/[^0-9.]/g, '')
  if (!numeric) return undefined
  const value = Number.parseFloat(numeric)
  return Number.isFinite(value) ? value : undefined
}

export async function fetchGoogleSheetData(sheetId: string, range = "Sheet1"): Promise<SheetRow[]> {
  try {
    // Google Sheets API endpoint for public sheets
    // Format: https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:json&sheet={SHEET_NAME}
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&sheet=${range}`

    const response = await fetch(url, {
      next: { revalidate: 300 }, // Revalidate every 5 minutes for fresh data
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch sheet data: ${response.statusText}`)
    }

    const text = await response.text()
    // Remove the Google Sheets wrapper to get valid JSON
    const jsonString = text.substring(47).slice(0, -2)
    const data = JSON.parse(jsonString)

    // Extract headers and rows
    const headers: string[] = data.table.cols.map((col: any) => col.label || col.id)
    const rows: SheetRow[] = data.table.rows.map((row: any) => {
      const rowData: SheetRow = {}
      row.c.forEach((cell: any, index: number) => {
        rowData[headers[index]] = cell?.v?.toString() || ""
      })
      return rowData
    })

    return rows
  } catch (error) {
    console.error("Error fetching Google Sheet data:", error)
    return []
  }
}

export function mapSheetRowToPackage(row: SheetRow, index: number): TravelPackage {
  const name = row.name || row.Name || row.title || row.Title || `Package ${index + 1}`
  const destination = row.destination || row.Destination || row.location || row.Location || ''
  const category = row.category || row.Category || row.type || row.Type || 'Adventure'
  const ratingSource = row.rating || row.Rating
  const parsedRating = ratingSource ? Number.parseFloat(ratingSource) : undefined
  const price = row.price || row.Price || ''

  return {
    id: row.id || `package-${index}`,
    name,
    destination,
    duration: row.duration || row.Duration || '',
    price,
    priceValue: parsePriceValue(price),
    description: row.description || row.Description || '',
    image:
      row.image ||
      row.Image ||
      row.imageUrl ||
      `/placeholder.svg?height=400&width=600&query=${encodeURIComponent(name)}`,
    category,
    rating: Number.isFinite(parsedRating) ? parsedRating : undefined,
    maxPeople: row.maxPeople || row.MaxPeople || row.capacity || row.Capacity || '',
  }
}