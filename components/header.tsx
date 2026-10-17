"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { ChevronDown, Menu, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import Image from "next/image"
import { ctaLink, primaryNavLinks, splitPrimaryNav, MORE_LABEL, type NavLink } from "@/content/navigation"
import { ThemeToggle } from "@/components/theme-toggle"
import { useTheme } from "next-themes"
import { LanguageToggle } from "@/components/language-toggle"
import { CurrencyToggle } from "@/components/currency-toggle"
import type { Language } from "@/lib/preferences"
import type { Currency } from "@/lib/currency"
import { SITE_NAME } from "@/lib/site"
import { translate } from "@/lib/i18n"

const linkClassName =
  "whitespace-nowrap text-sm font-medium uppercase text-primary transition-colors hover:text-primary/80 dark:text-primary dark:hover:text-primary/80"

// Wide desktops show every item inline; narrower ones put the secondary items under a "More" drop-down.

/** A grouped item ("Cruises & Resorts", "More"): a button that opens a short list of links. Closes on a click outside,
 * on Escape and after a choice. In the phone menu the same links are shown as an indented list instead. */
function NavGroup({ link, label, language, onChoose, align = "left", className = "" }: { link: NavLink; label: string; language: Language; onChoose?: () => void; align?: "left" | "right"; className?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])
  return (
    <div ref={ref} className={`relative ${className}`}>
      <button type="button" className={`${linkClassName} inline-flex items-center gap-1`} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <ul className={`absolute ${align === "right" ? "right-0" : "left-0"} top-full z-50 mt-2 min-w-[12rem] rounded-md border border-border bg-background py-2 shadow-lg`}>
          {(link.children ?? []).map((child) => (
            <li key={child.href}>
              {child.external ? (
                <a href={child.href} target="_blank" rel="noopener noreferrer" className="block whitespace-nowrap px-4 py-2 text-sm font-medium uppercase text-primary hover:bg-muted" onClick={() => { setOpen(false); onChoose?.() }}>
                  {translate(language, child.label)}
                </a>
              ) : (
                <Link href={child.href} className="block whitespace-nowrap px-4 py-2 text-sm font-medium uppercase text-primary hover:bg-muted" onClick={() => { setOpen(false); onChoose?.() }}>
                  {translate(language, child.label)}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function renderNavLink(link: NavLink, label: string, onClick?: () => void, extraClass = "") {
  if (link.external) {
    return (
      <a
        key={link.href}
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${linkClassName} ${extraClass}`}
        onClick={onClick}
      >
        {label}
      </a>
    )
  }

  return (
    <Link key={link.href} href={link.href} className={`${linkClassName} ${extraClass}`} onClick={onClick}>
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
  const { more } = splitPrimaryNav(primaryNavLinks)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Dark mode → dark-background logo; light mode → white-background logo
  const logoSrc = !mounted
    ? "/assets/logo-white-trim.png"
    : resolvedTheme === "dark"
    ? "/assets/logo-black-trim.png"
    : "/assets/logo-white-trim.png"

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <nav className="container mx-auto flex h-16 items-center justify-between gap-2 px-4 lg:gap-4">
        <a href="/" className="flex items-center lg:shrink-0">
          <Image
            src={logoSrc}
            alt={SITE_NAME}
            width={280}
            height={112}
            className="h-16 w-auto py-2 sm:h-18 lg:h-14 xl:h-16"
            priority
            unoptimized
            suppressHydrationWarning
          />
        </a>

        {/* Desktop Navigation */}
        <div className={`hidden min-w-0 items-center gap-3 lg:flex xl:gap-5 min-[1700px]:gap-7`}>
          {primaryNavLinks.map((link) =>
            link.children ? (
              <NavGroup key={link.label} link={link} label={translate(language, link.label)} language={language} />
            ) : (
              renderNavLink(link, translate(language, link.label), undefined, link.secondary ? "hidden min-[1700px]:inline" : "")
            ),
          )}
          {/* Narrower desktops: the secondary items live under one "More" drop-down (hidden once they fit inline). */}
          {more.length > 0 && (
            <NavGroup
              link={{ label: MORE_LABEL, href: "#", children: more }}
              label={translate(language, MORE_LABEL)}
              language={language}
              align="right"
              className="min-[1700px]:hidden"
            />
          )}
        </div>

        <div className="hidden shrink-0 items-center gap-2 lg:flex">
          <LanguageToggle language={language} />
          <CurrencyToggle currency={currency} />
          <ThemeToggle />
          <Button asChild className="bg-primary text-primary-foreground hover:bg-primary/90">
            <Link href={ctaLink.href}>{translate(language, ctaLink.label)}</Link>
          </Button>
        </div>

        {/* Mobile Menu Button */}
        <div className="flex items-center gap-2 lg:hidden">
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
        <div className="border-t border-border bg-background lg:hidden">
          <div className="container mx-auto flex flex-col gap-4 px-4 py-6">
            {primaryNavLinks.map((link) =>
              link.children ? (
                <div key={link.label} className="flex flex-col gap-3">
                  <span className="text-sm font-medium uppercase text-muted-foreground">{translate(language, link.label)}</span>
                  <div className="flex flex-col gap-3 border-l border-border pl-4">
                    {link.children.map((child) => renderNavLink(child, translate(language, child.label), () => setMobileMenuOpen(false)))}
                  </div>
                </div>
              ) : (
                renderNavLink(link, translate(language, link.label), () => setMobileMenuOpen(false))
              ),
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