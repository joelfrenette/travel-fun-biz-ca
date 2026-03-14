import { Star } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { testimonials } from "@/content/testimonials"
import Image from "next/image"
import { SectionHeading } from "@/components/section-heading"
import type { Language } from "@/lib/preferences"
import { translate } from "@/lib/i18n"

interface TestimonialsSectionProps {
  language: Language
}

export function TestimonialsSection({ language }: TestimonialsSectionProps) {
  return (
    <section id="testimonials" className="py-20">
      <div className="container mx-auto px-4">
        <SectionHeading
          title={translate('What Our Travelers Say', language)}
          subtitle={translate("Don't just take our word for it. Here's what our happy travelers have to say about their experiences.", language)}
        />

        <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {testimonials.map((testimonial) => (
            <Card key={testimonial.id} className="border-border/50 bg-card">
              <CardContent className="p-6">
                <div className="mb-4 flex items-center gap-4">
                  <Image
                    src={testimonial.image || "/placeholder.svg"}
                    alt={testimonial.name}
                    width={64}
                    height={64}
                    className="h-16 w-16 rounded-full object-cover"
                  />
                  <div>
                    <h3 className="font-semibold text-foreground">{testimonial.name}</h3>
                    <p className="text-sm text-muted-foreground">{translate(testimonial.location, language)}</p>
                  </div>
                </div>

                <div className="mb-3 flex gap-1">
                  {Array.from({ length: testimonial.rating }).map((_, i) => (
                    <Star key={i} className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                  ))}
                </div>

                <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{translate(testimonial.text, language)}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  )
}