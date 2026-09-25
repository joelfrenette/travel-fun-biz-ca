import { Star } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { testimonials as fallbackTestimonials } from "@/content/testimonials"
import Image from "next/image"
import { SectionHeading } from "@/components/section-heading"
import type { Language } from "@/lib/preferences"
import { translate } from "@/lib/i18n"
import type { Testimonial } from "@/lib/testimonials"

interface TestimonialsSectionProps {
  language: Language
  testimonials?: Testimonial[]
}

// Normalizes the DB shape and the static fallback (content/testimonials.ts, used only if the
// testimonials table is empty) to the same display shape.
function toDisplay(t: Testimonial | (typeof fallbackTestimonials)[number]) {
  if ("author" in t) {
    return { id: t.id, name: t.author, location: t.source || t.trip_name || "", rating: t.rating, text: t.text, image: t.image_url || "/placeholder.svg" }
  }
  return { id: String(t.id), name: t.name, location: t.location, rating: t.rating, text: t.text, image: t.image || "/placeholder.svg" }
}

export function TestimonialsSection({ language, testimonials }: TestimonialsSectionProps) {
  const items = (testimonials && testimonials.length > 0 ? testimonials : fallbackTestimonials).map(toDisplay)
  if (items.length === 0) return null

  return (
    <section id="testimonials" className="py-20">
      <div className="container mx-auto px-4">
        <SectionHeading
          title={translate(language, 'What Our Travelers Say')}
          subtitle={translate(
            language,
            "Don't just take our word for it. Here's what our happy travelers have to say about their experiences.",
          )}
        />

        <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {items.map((testimonial) => (
            <Card key={testimonial.id} className="border-border/50 bg-card">
              <CardContent className="p-6">
                <div className="mb-4 flex items-center gap-4">
                  <Image
                    src={testimonial.image}
                    alt={testimonial.name}
                    width={64}
                    height={64}
                    className="h-16 w-16 rounded-full object-cover"
                  />
                  <div>
                    <h3 className="font-semibold text-foreground">{testimonial.name}</h3>
                    <p className="text-sm text-muted-foreground">{testimonial.location}</p>
                  </div>
                </div>

                <div className="mb-3 flex gap-1">
                  {Array.from({ length: testimonial.rating }).map((_, i) => (
                    <Star key={i} className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                  ))}
                </div>

                <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{testimonial.text}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  )
}