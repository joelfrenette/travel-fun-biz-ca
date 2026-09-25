import type { ScrapedPackage } from '@/types/scrape'

// Shared by the admin import UI and the server-side sync. Never invents data the source
// page did not have: a made-up price or category would end up on the public card.
export function scrapedToPackage(pkg: ScrapedPackage) {
  return {
    name: pkg.name,
    destination: pkg.destination,
    duration: pkg.duration,
    duration_days: pkg.durationDays,
    available_from: pkg.startDate,
    available_to: pkg.endDate,
    price_display: pkg.price || 'Contact for pricing',
    price_value: pkg.priceValue,
    short_description: pkg.description,
    image_url: pkg.imageUrl,
    booking_url: pkg.bookingUrl,
    supplier: pkg.supplier,
    category: pkg.category,
    highlights: pkg.highlights,
    status: 'draft' as const,
  }
}
