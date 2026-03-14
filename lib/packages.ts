import { samplePackages } from '@/content/packages'
import type { TravelPackage } from '@/types/travel'
import { fetchGoogleSheetData, mapSheetRowToPackage } from './google-sheets'

/**
 * Returns packages sourced from Google Sheets when configured, otherwise falls back to local sample data.
 */
export async function getPackages(): Promise<TravelPackage[]> {
  const sheetId = process.env.GOOGLE_SHEET_ID

  if (!sheetId) {
    return samplePackages
  }

  try {
    const sheetData = await fetchGoogleSheetData(sheetId)

    if (sheetData.length === 0) {
      return samplePackages
    }

    return sheetData.map(mapSheetRowToPackage)
  } catch (error) {
    console.error('Failed to fetch Google Sheets data, using sample packages:', error)
    return samplePackages
  }
}
