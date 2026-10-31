"use client"

// The print button on the private itinerary page. Hidden when printing.
export function ItineraryPrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="rounded-md bg-primary px-4 py-2 text-sm font-bold text-primary-foreground print:hidden">
      Print this page
    </button>
  )
}
