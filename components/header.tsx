"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Menu, X } from "lucide-react"
import { useState } from "react"
import Image from "next/image"
import { ctaLink, primaryNavLinks, type NavLink } from "@/content/navigation"

const linkClassName = "text-sm font-medium uppercase text-primary transition-colors hover:text-primary/80"

function renderNavLink(link: NavLink, onClick?: () => void) {
  if (link.external) {
    return (
      <a
        key={link.href}
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClassName}
        onClick={onClick}
      >
        {link.label}
      </a>
    )
  }

  return (
    <Link key={link.href} href={link.href} className={linkClassName} onClick={onClick}>
      {link.label}
    </Link>
  )
}

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
          {primaryNavLinks.map((link) => renderNavLink(link))}
        </div>

        <div className="hidden items-center gap-4 md:flex">
          <Button asChild className="bg-primary text-white hover:bg-primary/90">
            <Link href={ctaLink.href}>{ctaLink.label}</Link>
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
            {primaryNavLinks.map((link) => renderNavLink(link, () => setMobileMenuOpen(false)))}
            <Button asChild className="w-full bg-primary text-white hover:bg-primary/90">
              <Link href={ctaLink.href} onClick={() => setMobileMenuOpen(false)}>
                {ctaLink.label}
              </Link>
            </Button>
          </div>
        </div>
      )}
    </header>
  )
}