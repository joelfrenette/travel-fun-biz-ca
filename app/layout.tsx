import type React from "react"
import type { Metadata } from "next"
import { Inter } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import "./globals.css"
import { ConsentAnalytics } from "@/components/consent-analytics"
import { CookieBanner } from "@/components/cookie-banner"
import { ThemeProvider } from "@/components/theme-provider"
import { AttributionCapture } from "@/components/attribution-capture"
import { ScrollToTop } from "@/components/scroll-to-top"
import { cookies } from 'next/headers'
import { normalizeLanguage } from '@/lib/preferences'
import { SITE_URL, SITE_NAME, SITE_LOCALE, DEFAULT_OG_IMAGE, hreflangAlternates } from '@/lib/site'

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-sans",
})

const DEFAULT_TITLE = `${SITE_NAME} | Group Trips, Cruises & Singles Travel`
const DEFAULT_DESCRIPTION =
  "Hosted group trips, river and ocean cruises, and singles getaways with real travel advisors. See upcoming departures and request info in one click."

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: DEFAULT_TITLE, template: `%s` },
  description: DEFAULT_DESCRIPTION,
  alternates: { canonical: '/', languages: hreflangAlternates('/') },
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
  const cookieStore = cookies()
  const lang = normalizeLanguage(cookieStore.get('lang')?.value)
  const gaId = process.env.NEXT_PUBLIC_GA_ID

  return (
    <html lang={lang} suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <ScrollToTop />
          <AttributionCapture />
          <Analytics />
        </ThemeProvider>
        {/* Google Analytics only loads after the visitor accepts analytics (components/consent-analytics.tsx). */}
        <ConsentAnalytics gaId={gaId} />
        <CookieBanner />
      </body>
    </html>
  )
}