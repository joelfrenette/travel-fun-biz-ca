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
import type { Language } from "@/lib/preferences"
import type { Currency } from "@/lib/currency"
import { translate } from "@/lib/i18n"

const linkClassName =
  "text-sm font-medium uppercase text-primary transition-colors hover:text-primary/80 dark:text-primary dark:hover:text-primary/80"

function renderNavLink(link: NavLink, label: string, onClick?: () => void) {
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
        {label}
      </a>
    )
  }

  return (
    <Link key={link.href} href={link.href} className={linkClassName} onClick={onClick}>
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

  // Use the new square logos and display slightly larger for better readability
  const logoSrc = !mounted
    ? "/assets/logo-black-square.png"
    : resolvedTheme === "dark"
    ? "/assets/logo-white-square.png"
    : "/assets/logo-black-square.png"

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <nav className="container mx-auto flex h-16 items-center justify-between px-4">
        <a href="https://www.travelfunbiz.ca" className="flex items-center">
          <Image
            src={logoSrc}
            alt="TravelFunBiz.CA"
            width={240}
            height={96}
            className="h-14 w-auto sm:h-16"
            priority
            unoptimized
          />
        </a>

        {/* Desktop Navigation */}
        <div className="hidden items-center gap-8 md:flex">
          {primaryNavLinks.map((link) =>
            renderNavLink(link, translate(language, link.label)),
          )}
        </div>

        <div className="hidden items-center gap-2 md:flex">
          <LanguageToggle language={language} />
          <CurrencyToggle currency={currency} />
          <ThemeToggle />
          <Button asChild className="bg-primary text-primary-foreground hover:bg-primary/90">
            <Link href={ctaLink.href}>{translate(language, ctaLink.label)}</Link>
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
            {primaryNavLinks.map((link) =>
              renderNavLink(link, translate(language, link.label), () => setMobileMenuOpen(false)),
            )}
            <Button asChild className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
              <Link href={ctaLink.href} onClick={() => setMobileMenuOpen(false)}>
                {translate(language, ctaLink.label)}
              </Link>
            </Button>
          </div>
        </div>
      )}
    </header>
  )
}