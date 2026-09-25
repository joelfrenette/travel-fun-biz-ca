import { Star } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import type { Testimonial } from "@/lib/testimonials"
import type { Language } from "@/lib/preferences"
import { translate } from "@/lib/i18n"

interface TripTestimonialsProps {
  testimonials: Testimonial[]
  language: Language
}

// Reviews attached to one specific trip. Separate from TestimonialsSection (the homepage's mixed
// pool of every published review) so a trip page only shows what travelers said about THIS trip.
export function TripTestimonials({ testimonials, language }: TripTestimonialsProps) {
  if (testimonials.length === 0) return null

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-foreground">{translate(language, "What travelers said about this trip")}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {testimonials.map((t) => (
          <Card key={t.id} className="border-border/50 bg-card">
            <CardContent className="p-5">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-semibold text-foreground">{t.author}</span>
                <span className="flex">{Array.from({ length: t.rating }).map((_, i) => <Star key={i} className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />)}</span>
              </div>
              {t.source && <p className="mb-2 text-xs text-muted-foreground">{t.source}</p>}
              <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{t.text}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
