export interface ScrapedPackage {
  name: string
  description?: string
  destination?: string
  startDate?: string
  endDate?: string
  duration?: string
  durationDays?: number
  price?: string
  priceValue?: number
  category?: string
  imageUrl?: string
  bookingUrl?: string
  supplier?: string
  sourceUrl: string
  highlights?: string[]
  rawHtml?: string
}

export interface ScrapeResult {
  packages: ScrapedPackage[]
  adapter: string
  htmlLength: number
}
