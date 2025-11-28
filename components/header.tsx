"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Menu, X } from "lucide-react"
import { useState } from "react"
import Image from "next/image"

export function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-black/95 backdrop-blur supports-[backdrop-filter]:bg-black/90">
      <nav className="container mx-auto flex h-16 items-center justify-between px-4">
        <Link href="/" className="flex items-center">
          <Image src="/logo.png" alt="TravelFunBiz.CA" width={180} height={68} className="h-12 w-auto" priority />
        </Link>

        {/* Desktop Navigation */}
        <div className="hidden items-center gap-8 md:flex">
          <a
            href="https://members.travelfunbiz.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium uppercase text-primary transition-colors hover:text-primary/80"
          >
            Travel Agents
          </a>
          <a
            href="https://travelfunbiz.com/in-the-news/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium uppercase text-primary transition-colors hover:text-primary/80"
          >
            In The News
          </a>
          <a
            href="https://travelfunbiz.com/about-us/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium uppercase text-primary transition-colors hover:text-primary/80"
          >
            About Us
          </a>
          <Link
            href="/#contact"
            className="text-sm font-medium uppercase text-primary transition-colors hover:text-primary/80"
          >
            Contact Us
          </Link>
          <a
            href="https://bookings.travelfunbiz.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium uppercase text-primary transition-colors hover:text-primary/80"
          >
            Booking
          </a>
        </div>

        <div className="hidden items-center gap-4 md:flex">
          <Button asChild className="bg-primary text-white hover:bg-primary/90">
            <Link href="/#contact">Get Started</Link>
          </Button>
        </div>

        {/* Mobile Menu Button */}
        <button className="md:hidden" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-label="Toggle menu">
          {mobileMenuOpen ? <X className="h-6 w-6 text-white" /> : <Menu className="h-6 w-6 text-white" />}
        </button>
      </nav>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="border-t border-border bg-black md:hidden">
          <div className="container mx-auto flex flex-col gap-4 px-4 py-6">
            <a
              href="https://members.travelfunbiz.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium uppercase text-primary transition-colors hover:text-primary/80"
              onClick={() => setMobileMenuOpen(false)}
            >
              Travel Agents
            </a>
            <a
              href="https://travelfunbiz.com/in-the-news/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium uppercase text-primary transition-colors hover:text-primary/80"
              onClick={() => setMobileMenuOpen(false)}
            >
              In The News
            </a>
            <a
              href="https://travelfunbiz.com/about-us/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium uppercase text-primary transition-colors hover:text-primary/80"
              onClick={() => setMobileMenuOpen(false)}
            >
              About Us
            </a>
            <Link
              href="/#contact"
              className="text-sm font-medium uppercase text-primary transition-colors hover:text-primary/80"
              onClick={() => setMobileMenuOpen(false)}
            >
              Contact Us
            </Link>
            <a
              href="https://bookings.travelfunbiz.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium uppercase text-primary transition-colors hover:text-primary/80"
              onClick={() => setMobileMenuOpen(false)}
            >
              Booking
            </a>
            <Button asChild className="w-full bg-primary text-white hover:bg-primary/90">
              <Link href="/#contact" onClick={() => setMobileMenuOpen(false)}>
                Get Started
              </Link>
            </Button>
          </div>
        </div>
      )}
    </header>
  )
}
