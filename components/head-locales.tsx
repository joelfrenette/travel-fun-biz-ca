"use client"

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

const SUPPORTED_LOCALES = ['en', 'fr', 'es']
const DEFAULT_LOCALE = 'en'
const DATA_ATTR = 'data-locales-handler'

function ensureAbsoluteSiteUrl() {
  // Prefer runtime config, fall back to window.location
  const env = (process.env.NEXT_PUBLIC_SITE_URL as string) || ''
  if (env && env.startsWith('http')) return env.replace(/\/$/, '')
  if (typeof window !== 'undefined') return window.location.origin
  return ''
}

export default function HeadLocales() {
  const pathname = usePathname() || '/'

  useEffect(() => {
    const base = ensureAbsoluteSiteUrl() || window.location.origin
    if (!base) return

    // Remove any previously inserted nodes we created
    document.querySelectorAll(`link[${DATA_ATTR}], link[rel='canonical'][${DATA_ATTR}]`).forEach((n) => n.remove())

    // Compute the path without locale prefix
    let path = pathname
    const match = path.match(/^\/(en|fr|es)(\/|$)(.*)/i)
    if (match) {
      path = '/' + (match[3] || '')
    }
    if (!path.startsWith('/')) path = '/' + path

    // Create alternate links for each locale
    for (const locale of SUPPORTED_LOCALES) {
      const url = `${base}/${locale}${path === '/' ? '/' : path}`.replace(/([^:]?)\/\//g, '$1/')
      const link = document.createElement('link')
      link.setAttribute('rel', 'alternate')
      link.setAttribute('hreflang', locale)
      link.setAttribute('href', url)
      link.setAttribute(DATA_ATTR, 'true')
      document.head.appendChild(link)
    }

    // x-default -> default locale (root)
    const xDefaultLink = document.createElement('link')
    xDefaultLink.setAttribute('rel', 'alternate')
    xDefaultLink.setAttribute('hreflang', 'x-default')
    xDefaultLink.setAttribute('href', `${base}/${DEFAULT_LOCALE}${path === '/' ? '/' : path}`)
    xDefaultLink.setAttribute(DATA_ATTR, 'true')
    document.head.appendChild(xDefaultLink)

    // canonical
    const canonical = document.createElement('link')
    canonical.setAttribute('rel', 'canonical')
    canonical.setAttribute('href', `${base}${pathname}`)
    canonical.setAttribute(DATA_ATTR, 'true')
    document.head.appendChild(canonical)

    return () => {
      document.querySelectorAll(`link[${DATA_ATTR}]`).forEach((n) => n.remove())
    }
  }, [pathname])

  return null
}
