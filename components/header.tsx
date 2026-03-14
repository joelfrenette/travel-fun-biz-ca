"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Menu, X } from "lucide-react"
import { useEffect, useState } from "react"
import Image from "next/image"
import { ctaLink, primaryNavLinks, type NavLink } from "@/content/navigation"
import { ThemeToggle } from "@/components/theme-toggle"
import { useTheme } from "next-themes"
import { LanguageToggle } from "@/components/language-toggle"
import { CurrencyToggle } from "@/components/currency-toggle"
import type { Language, Currency } from "@/lib/preferences"
import { translate } from "@/lib/i18n"

const linkBaseClass = "text-sm font-medium uppercase transition-colors"

function renderNavLink(link: NavLink, language: Language, onClick?: () => void) {
  const label = translate(link.label, language)
  const className = `${linkBaseClass} text-primary hover:text-primary/80 dark:text-primary dark:hover:text-primary/80`

  if (link.external) {
    return (
      <a
        key={link.href}
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        onClick={onClick}
      >
        {label}
      </a>
    )
  }

  return (
    <Link key={link.href} href={link.href} className={className} onClick={onClick}>
      {label}
    </Link>
  )
}

interface HeaderProps {
  language: Language
  currency: Currency
}

export function Header({ language, currency }: HeaderProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const { resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const logoSrc = !mounted || resolvedTheme === "dark" ? "/logo.png" : "/logo-light.png"

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <nav className="container mx-auto flex h-16 items-center justify-between px-4">
        <Link href="/" className="flex items-center">
          <Image src={logoSrc} alt="TravelFunBiz.CA" width={180} height={68} className="h-12 w-auto" priority />
        </Link>

        {/* Desktop Navigation */}
        <div className="hidden items-center gap-8 md:flex">
          {primaryNavLinks.map((link) => renderNavLink(link, language))}
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <LanguageToggle language={language} />
          <CurrencyToggle currency={currency} />
          <ThemeToggle />
          <Button asChild className="bg-primary text-primary-foreground hover:bg-primary/90">
            <Link href={ctaLink.href}>{translate(ctaLink.label, language)}</Link>
          </Button>
        </div>

        {/* Mobile Menu Button */}
        <div className="flex items-center gap-2 md:hidden">
          <LanguageToggle language={language} />
          <CurrencyToggle currency={currency} />
          <ThemeToggle />
          <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-label="Toggle menu">
            {mobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
      </nav>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="border-t border-border bg-background md:hidden">
          <div className="container mx-auto flex flex-col gap-4 px-4 py-6">
            {primaryNavLinks.map((link) => renderNavLink(link, language, () => setMobileMenuOpen(false)))}
            <Button asChild className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
              <Link href={ctaLink.href} onClick={() => setMobileMenuOpen(false)}>
                {translate(ctaLink.label, language)}
              </Link>
            </Button>
          </div>
        </div>
      )}
    </header>
  )
}