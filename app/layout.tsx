import type React from "react"
import type { Metadata } from "next"
import { Inter } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import Script from "next/script"
import { Suspense } from "react"
import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { cookies } from 'next/headers'
import { normalizeLanguage } from '@/lib/preferences'

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-sans",
})

export const metadata: Metadata = {
  title: "TravelFunBiz.ca | Discover Your Next Adventure",
  description:
    "Explore curated travel packages to the world's most breathtaking destinations. Find your perfect getaway with exclusive deals and personalized travel experiences.",
  keywords:
    "travel packages, vacation deals, holiday packages, travel destinations, adventure travel, luxury travel, TravelFunBiz",
  authors: [{ name: "TravelFunBiz.ca" }],
  openGraph: {
    title: "TravelFunBiz.ca | Discover Your Next Adventure",
    description: "Explore curated travel packages to the world's most breathtaking destinations.",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "TravelFunBiz.ca | Discover Your Next Adventure",
    description: "Explore curated travel packages to the world's most breathtaking destinations.",
  },
  robots: {
    index: true,
    follow: true,
  },
    generator: 'v0.app'
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
          <Suspense fallback={null}>{children}</Suspense>
          <Analytics />
        </ThemeProvider>
        {gaId && (
          <>
            <Script src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gaId)}`} strategy="afterInteractive" />
            <Script id="ga4-init" strategy="afterInteractive">
              {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', ${JSON.stringify(gaId)});`}
            </Script>
          </>
        )}
      </body>
    </html>
  )
}