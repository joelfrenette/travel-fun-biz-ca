"use client"

import { Button } from "@/components/ui/button"
import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { useState, useEffect } from "react"

const slides = [
  {
    image: "/group-of-mature-adults-enjoying-river-cruise-deck.jpg",
    title: "Your FUN is our Biz",
  },
  {
    image: "/mature-travelers-relaxing-at-luxury-hotel-pool.jpg",
    title: "FUN is our middle name", // Capitalized FUN to match brand style
  },
  {
    image: "/large-group-of-seniors-celebrating-on-river-cruise.jpg",
    title: "FUN Starts Here",
  },
  {
    image: "/mature-friends-enjoying-poolside-resort-vacation.jpg",
    title: "Your Passport to FUN",
  },
  {
    image: "/group-of-older-adults-having-fun-on-cruise-ship.jpg",
    title: "Making Travel Fun Again",
  },
  {
    image: "/mature-travelers-socializing-at-resort-pool-area.jpg",
    title: "Your FUN is our Biz",
  },
]

export function HeroSection() {
  const [currentSlide, setCurrentSlide] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % slides.length)
    }, 5000)
    return () => clearInterval(timer)
  }, [])

  return (
    <section className="relative overflow-hidden bg-black py-20 md:py-32">
      <div className="absolute inset-0">
        {slides.map((slide, index) => (
          <div
            key={index}
            className={`absolute inset-0 transition-opacity duration-1000 ${
              index === currentSlide ? "opacity-100" : "opacity-0"
            }`}
          >
            <img
              src={slide.image || "/placeholder.svg"}
              alt="People having fun"
              className="h-full w-full object-cover"
            />
            <div className="absolute inset-0 bg-black/60" />
          </div>
        ))}
      </div>

      <div className="container relative z-10 mx-auto px-4">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl md:text-6xl lg:text-7xl">
            {slides[currentSlide].title}
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-gray-300 md:text-xl">
            Specializing in luxury travel, group adventures, and singles vacations. From tropical paradises to cultural
            expeditions, your perfect journey awaits.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Button asChild size="lg" className="w-full bg-primary text-white hover:bg-primary/90 sm:w-auto">
              <Link href="/#packages">
                Explore Packages
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="w-full border-primary text-primary hover:bg-primary hover:text-white sm:w-auto bg-transparent"
            >
              <Link href="/#contact">Plan My Trip</Link>
            </Button>
          </div>

          <div className="mt-8 flex justify-center gap-2">
            {slides.map((_, index) => (
              <button
                key={index}
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
