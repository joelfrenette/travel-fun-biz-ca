import Link from "next/link"
import Image from "next/image"
import { aboutLinks, legalLinks, officeInfo, recognitionBadges, socialPromos } from "@/content/footer"
import { cruiseAndResortLinks, destinationsLink } from "@/content/navigation"
import { NewsletterForm } from "@/components/newsletter-form"
import { CookieSettingsLink } from "@/components/cookie-settings-link"
import type { Language } from "@/lib/preferences"
import { translate } from "@/lib/i18n"
import { listTopDestinationGuides } from "@/lib/guides"

interface FooterProps {
  language: Language
}

function FooterTile({ href, src, alt, fit }: { href: string; src: string; alt: string; fit: "contain" | "cover" }) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`relative block aspect-[16/7] w-full overflow-hidden rounded transition-opacity hover:opacity-90 ${fit === "contain" ? "bg-white" : "bg-[#1f1f1f]"}`}
    >
      <Image
        src={src}
        alt={alt}
        fill
        sizes="(min-width: 1024px) 25vw, 100vw"
        className={fit === "contain" ? "object-contain p-2" : "object-cover"}
        unoptimized
      />
    </Link>
  )
}

/** Compact "Trips by destination" list from the published destination guides. Renders nothing when there are none. */
async function FooterDestinations({ language }: { language: Language }) {
  const guides = await listTopDestinationGuides(6)
  if (guides.length === 0) return null
  return (
    <nav aria-label="Trips by destination" className="space-y-2 text-xs text-gray-400">
      <p className="font-semibold uppercase text-white">{translate(language, "Trips by destination")}</p>
      {guides.map((g) => (
        <Link key={g.id} href={`/destinations/${g.slug}`} className="block hover:text-white">
          {g.name}
        </Link>
      ))}
    </nav>
  )
}

export function Footer({ language }: FooterProps) {
  return (
    <footer className="bg-[#2a2a2a] text-white">
      <div className="container mx-auto px-4 py-12">
        <div className="grid gap-8 lg:grid-cols-4">
          <div className="space-y-4">
            <div className="mb-6">
              <Link href="/">
                <Image
                  src="/assets/logo-black-square.png"
                  alt="TravelFun.Biz Logo"
                  width={340}
                  height={140}
                  className="h-auto w-full max-w-[340px]"
                  unoptimized
                />
              </Link>
            </div>

            <div className="space-y-2 text-sm text-gray-300">
              {officeInfo.addressLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
              {officeInfo.phone && <p className="pt-2">{officeInfo.phone}</p>}

              {/* Login link opens in a new tab to avoid embedded preview authentication issues */}
              <div>
                <a href="/admin" target="_blank" rel="noopener noreferrer" className="block mt-2 text-sm hover:text-white">
                  Login
                </a>
              </div>
            </div>

            <nav aria-label="Explore our guides" className="space-y-2 text-xs text-gray-400">
              <p className="font-semibold uppercase text-white">{translate(language, "Explore")}</p>
              {[destinationsLink, ...cruiseAndResortLinks].map((link) => (
                <Link key={link.href} href={link.href} className="block hover:text-white">
                  {translate(language, link.label)}
                </Link>
              ))}
            </nav>

            {/* @ts-expect-error async server component: this repo's React types predate async JSX */}
            <FooterDestinations language={language} />

            <div className="space-y-1 text-xs text-gray-400">
              {officeInfo.registrations.map((item) => (
                <p key={item} className="font-semibold text-white">
                  {item}
                </p>
              ))}
            </div>

            {officeInfo.disclaimers.map((item) => (
              <p key={item} className="text-xs text-gray-400">
                {translate(language, item).replace("{phone}", officeInfo.phone)}
              </p>
            ))}

          </div>

          {/* Every badge and promo sits in an identical tile (same width, same height) so the two columns line up
              whatever the shape of the source picture. Logos are shown whole on white (contain); photo banners fill
              their tile (cover). */}
          <div className="space-y-4">
            {recognitionBadges.map((badge) => (
              <FooterTile key={badge.href} href={badge.href} src={badge.src} alt={badge.alt} fit="contain" />
            ))}
          </div>

          <div className="space-y-4">
            {socialPromos.map((promo) => (
              <FooterTile key={promo.href} href={promo.href} src={promo.src} alt={promo.alt} fit="cover" />
            ))}
          </div>

          {/* Newsletter first on phones, original (last) position from lg up. */}
          <div className="order-first lg:order-none">
            <div className="mb-4 bg-[#e31e24] px-6 py-3 text-center">
              <p className="text-2xl font-bold leading-tight">
                {translate(language, 'NOTIFY ME OF')}
                <br />
                {translate(language, 'TRAVEL DEALS')}
              </p>
            </div>
            <div className="rounded-lg bg-white p-6 text-gray-900">
              <NewsletterForm className="space-y-4" language={language} />
            </div>
          </div>
        </div>

        <nav
          aria-label="Legal and company"
          className="mt-10 flex flex-wrap items-center gap-y-2 border-t border-white/10 pt-6 text-xs text-gray-400"
        >
          {[...aboutLinks, ...legalLinks].map((link, i) => (
            <Link
              key={link.href}
              href={link.href}
              className={`hover:text-white ${i > 0 ? "ml-3 border-l border-white/20 pl-3" : ""}`}
            >
              {translate(language, link.label)}
            </Link>
          ))}
          <CookieSettingsLink
            className="ml-3 border-l border-white/20 pl-3 text-left hover:text-white"
            label={translate(language, "Cookie settings")}
          />
        </nav>
      </div>
    </footer>
  )
}