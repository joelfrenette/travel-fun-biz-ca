"use client"

import { Button } from "@/components/ui/button"
import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { useState, useEffect } from "react"
import Image from "next/image"
import { heroSlides } from "@/content/hero"
import type { Language } from "@/lib/preferences"
import { translate } from "@/lib/i18n"

interface HeroSectionProps {
  language: Language
}

export function HeroSection({ language }: HeroSectionProps) {
  const [currentSlide, setCurrentSlide] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % heroSlides.length)
    }, 5000)
    return () => clearInterval(timer)
  }, [])

  const headline = translate(language, heroSlides[currentSlide].title)
  const description = translate(
    language,
    'Specializing in luxury travel, group adventures, and singles vacations. From tropical paradises to cultural expeditions, your perfect journey awaits.',
  )

  return (
    <section className="relative overflow-hidden bg-background py-20 md:py-32">
      <div className="absolute inset-0">
        {heroSlides.map((slide, index) => (
          <div
            key={slide.image}
            className={`absolute inset-0 transition-opacity duration-1000 ${
              index === currentSlide ? "opacity-100" : "opacity-0"
            }`}
          >
            <Image
              src={slide.image || "/placeholder.svg"}
              alt={slide.title}
              fill
              className="object-cover"
              priority={index === 0}
            />
            <div className="absolute inset-0 bg-black/60 dark:bg-black/60" />
          </div>
        ))}
      </div>

      <div className="container relative z-10 mx-auto px-4">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl md:text-6xl lg:text-7xl">
            {headline}
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-gray-200 md:text-xl">{description}</p>
          <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Button asChild size="lg" className="w-full bg-primary text-white hover:bg-primary/90 sm:w-auto">
              <Link href="/#packages">
                {translate(language, 'Explore Packages')}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              className="w-full bg-primary text-white hover:bg-primary/90 sm:w-auto"
            >
              <Link href="/#contact">
                {translate(language, 'Plan My Trip')}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>

          <div className="mt-8 flex justify-center gap-2">
            {heroSlides.map((slide, index) => (
              <button
                key={slide.image}
                onClick={() => setCurrentSlide(index)}
                className={`h-2 w-2 rounded-full transition-all ${
                  index === currentSlide ? "w-8 bg-primary" : "bg-white/50"
                }`}
                aria-label={`Go to slide ${index + 1}`}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}