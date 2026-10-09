"use client"

import { Button } from "@/components/ui/button"
import { setConsent, useConsent } from "@/lib/consent"
import { legalLinks } from "@/content/footer"

// Asks before any non-essential tracking runs. "Essential only" is as easy to pick as "Accept", and
// neither is pre-selected. Wording drafted 2026-10-09 in plain English for a Canadian audience
// (PIPEDA, Quebec Law 25): it names what is used and why, and says how to change the choice. It is a
// good-faith draft, not legal advice; have it and the Privacy Policy it links to reviewed.
export function CookieBanner() {
  const { decided } = useConsent()
  if (decided) return null
  const privacy = legalLinks.find((l) => l.label === "Privacy Policy")?.href

  return (
    <div role="dialog" aria-labelledby="cookie-title" aria-describedby="cookie-text" className="fixed inset-x-0 bottom-0 z-50 border-t bg-background p-4 shadow-lg">
      <div className="container mx-auto flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="max-w-3xl text-sm">
          <p id="cookie-title" className="mb-1 font-semibold">Your privacy choices</p>
          <p id="cookie-text" className="text-muted-foreground">
            We use cookies that are essential to make this site work. With your permission we would also use Google Analytics, and remember which ad, post or search brought you here. This shows us which trips and articles are helpful so we can improve them. Nothing optional runs unless you say yes, and you can change your mind any time with &ldquo;Cookie settings&rdquo; at the bottom of every page.{" "}
            {privacy && (
              <a href={privacy} target="_blank" rel="noopener noreferrer" className="underline">
                Read our Privacy Policy
              </a>
            )}
            .
          </p>
        </div>
        <div className="flex shrink-0 gap-3">
          <Button variant="outline" onClick={() => setConsent(false)}>Essential only</Button>
          <Button variant="outline" onClick={() => setConsent(true)}>Accept analytics</Button>
        </div>
      </div>
    </div>
  )
}
