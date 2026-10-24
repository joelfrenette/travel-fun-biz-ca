import type React from "react"
import type { Metadata } from "next"
import { Inter } from "next/font/google"
import { SiteAnalytics } from "@/components/site-analytics"
import "./globals.css"
import { ConsentAnalytics } from "@/components/consent-analytics"
import { ThemeProvider } from "@/components/theme-provider"
import { AttributionCapture } from "@/components/attribution-capture"
import { Ga4ClickEvents } from "@/components/ga4-click-events"
import { VisitTracker } from "@/components/visit-tracker"
import { ScrollToTop } from "@/components/scroll-to-top"
import { SITE_URL, SITE_NAME, SITE_LOCALE, DEFAULT_OG_IMAGE } from '@/lib/site'

const inter = Inter({
  subsets: ["latin"],
  // Inter is a variable font: no weight list, so one font file per script covers every weight (400 to 800 render the
  // same) and the generated CSS carries 7 @font-face rules instead of 35. display "swap" keeps text visible while it loads.
  display: "swap",
  variable: "--font-sans",
})

const DEFAULT_TITLE = `${SITE_NAME} | Group Trips, Cruises & Singles Travel`
const DEFAULT_DESCRIPTION =
  "Hosted group trips, river and ocean cruises, and singles getaways with real travel advisors. See upcoming departures and request info in one click."

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: DEFAULT_TITLE, template: `%s` },
  description: DEFAULT_DESCRIPTION,
  // hreflang is set per page (lib/site.ts pageAlternates); a page that sets none must not inherit the home page's alternates.
  alternates: { canonical: '/' },
  authors: [{ name: SITE_NAME }],
  openGraph: {
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    type: "website",
    locale: SITE_LOCALE,
    siteName: SITE_NAME,
    url: '/',
    images: [{ url: DEFAULT_OG_IMAGE, alt: SITE_NAME }],
  },
  twitter: {
    card: "summary_large_image",
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    images: [DEFAULT_OG_IMAGE],
  },
  robots: {
    index: true,
    follow: true,
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // No cookies() here on purpose: reading the visitor's language in the root layout made every page on the site render
  // per request, so nothing could be cached. The language now comes from each page (components/locale-effects.tsx draws
  // the consent banner and sets <html lang> from the page's own language). See lib/cache-routing.ts.
  const gaId = process.env.NEXT_PUBLIC_GA_ID

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Feed discovery (hub WP7). Written here, not in the metadata alternates, because a page that sets its own alternates (most do, for hreflang) replaces the layout's. */}
        <link rel="alternate" type="application/rss+xml" title={`${SITE_NAME} Blog`} href="/feed.xml" />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <ScrollToTop />
          <AttributionCapture />
          {/* Sends nothing unless the visitor accepted analytics AND the admin switch visit_tracking is on (off by default). */}
          <VisitTracker />
          <SiteAnalytics />
          {/* GA4 key events for tel:, sms:, /go/ and "Book a free call" clicks. Fires nothing without analytics consent and a GA id. */}
          <Ga4ClickEvents />
        </ThemeProvider>
        {/* Google Analytics only loads after the visitor accepts analytics (components/consent-analytics.tsx). */}
        <ConsentAnalytics gaId={gaId} />
      </body>
    </html>
  )
}