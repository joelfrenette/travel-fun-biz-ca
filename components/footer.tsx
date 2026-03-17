import Link from "next/link"
import Image from "next/image"
import { legalLinks, officeInfo, recognitionBadges, socialPromos } from "@/content/footer"
import { NewsletterForm } from "@/components/newsletter-form"
import type { Language } from "@/lib/preferences"
import { translate } from "@/lib/i18n"

interface FooterProps {
  language: Language
}

export function Footer({ language }: FooterProps) {
  return (
    <footer className="bg-[#2a2a2a] text-white">
      <div className="container mx-auto px-4 py-12">
        <div className="grid gap-8 lg:grid-cols-4">
          <div className="space-y-4">
            <div className="mb-6">
              <a href="https://www.travelfunbiz.ca" target="_blank" rel="noopener noreferrer">
                <Image
                  src="/assets/logo-black-square.png"
                  alt="TravelFun.Biz Logo"
                  width={340}
                  height={140}
                  className="h-auto w-full max-w-[340px]"
                  unoptimized
                />
              </a>
            </div>

            <div className="space-y-2 text-sm text-gray-300">
              {officeInfo.addressLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
              <p className="pt-2">{officeInfo.phone}</p>

              {/* Login link opens in a new tab to avoid embedded preview authentication issues */}
              <div>
                <a href="/admin" target="_blank" rel="noopener noreferrer" className="block mt-2 text-sm hover:text-white">
                  Login
                </a>
              </div>
            </div>

            <div className="space-y-2 text-xs text-gray-400">
              {legalLinks.map((link) => (
                <Link key={link.href} href={link.href} className="block hover:text-white">
                  {translate(language, link.label)}
                </Link>
              ))}
            </div>

            <div className="space-y-1 text-xs text-gray-400">
              {officeInfo.registrations.map((item) => (
                <p key={item} className="font-semibold text-white">
                  {item}
                </p>
              ))}
            </div>

            {officeInfo.disclaimers.map((item) => (
              <p key={item} className="text-xs text-gray-400">
                {translate(language, item)}
              </p>
            ))}

            <div className="pt-4">
              <Image
                src="https://travelfunbiz.com/wp-content/uploads/2025/10/logo-IATAN.png"
                alt="IATAN - International Airlines Travel Agent Network"
                width={300}
                height={120}
                className="h-auto w-[300px]"
                unoptimized
              />
            </div>
          </div>

          <div className="space-y-4">
            {recognitionBadges.map((badge) => (
              <Link
                key={badge.href}
                href={badge.href}
                target="_blank"
                rel="noopener noreferrer"
                className="block transition-opacity hover:opacity-90"
              >
                <Image
                  src={badge.src}
                  alt={badge.alt}
                  width={320}
                  height={140}
                  className="h-auto w-full rounded"
                  unoptimized
                />
              </Link>
            ))}
          </div>

          <div className="space-y-4">
            {socialPromos.map((promo) => (
              <Link
                key={promo.href}
                href={promo.href}
                target="_blank"
                rel="noopener noreferrer"
                className="block transition-opacity hover:opacity-90"
              >
                <Image
                  src={promo.src}
                  alt={promo.alt}
                  width={320}
                  height={140}
                  className="h-auto w-full rounded"
                  unoptimized
                />
              </Link>
            ))}
          </div>

          <div>
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
      </div>
    </footer>
  )
}