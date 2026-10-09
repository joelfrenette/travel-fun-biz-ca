# Privacy Policy: DRAFT for review (TravelFunBiz.ca)

> **Status: draft written 2026-10-09 by Claude, not legal advice.** It describes only what this site
> actually does today (checked against the code). Every `[bracketed]` item is a fact Claude does not
> have and must not guess. Have the owner fill them in and a Canadian privacy lawyer review the whole
> text before it is published. The live Privacy Policy is on travelfunbiz.com (linked from this site's
> footer and cookie banner); this draft is meant to be merged into it or to replace its tracking and
> forms sections.
>
> **Things to confirm before publishing:** the legal entity name, the privacy contact person and email,
> how long records are kept, whether any provider listed below is not used, and that nothing here
> contradicts the existing policy.

## Who we are

TravelFunBiz.ca is operated by **[legal entity name]**, 375 University Avenue, Suite 1072, Toronto, ON
M5G 2J5, telephone (365) 800-6363. We are a travel agency that sells hosted group trips, cruises and
singles getaways.

**Our privacy contact** is **[name, title]**, at **[email address]**. Ask them about anything in this
policy, to see or correct your information, or to withdraw a consent.

## What we collect, and why

| When | What we collect | Why |
|---|---|---|
| You send the **enquiry form** | Name, email, phone (optional), the trip you are interested in, travel date and number of travellers (optional), your message | To answer your enquiry and help you plan a trip |
| You join the **newsletter** | Name, email, mobile phone, the deals you are interested in, and a record that you ticked the consent box | To send you travel deals and updates by email and text message, only if you ticked the box |
| You **accept analytics** in our privacy choices | Which pages you view, your approximate location and device type (Google Analytics), and which ad, social post or search brought you to us (stored in your own browser until you send a form) | To see which trips and articles help people plan, and to improve them |
| You **visit the site** at all | Your language and display choices, and your privacy choice, are remembered in your browser. Our host also keeps ordinary server logs | To make the site work and keep it secure |

We do not collect payment card details on this site.

## Cookies and similar technologies

- **Essential:** a few settings kept in your browser (language, light or dark display, your privacy
  choice). The site needs these to work.
- **Analytics (only if you accept):** Google Analytics. Before you choose, it is not loaded. If you
  choose "Essential only", it is never loaded. You can change your choice at any time with **Cookie
  settings** at the bottom of every page. Withdrawing removes its cookies and erases the
  where-you-came-from record kept in your browser.
- **Vercel Web Analytics:** counts visits in aggregate. It sets no cookie and does not follow you
  between sites.

## Who handles your information for us

We use trusted service providers to run the site and our business. They may only use your information
to provide their service to us.

- **GoHighLevel**: our customer system and the tool we use to send email and text messages
- **Supabase**: the database that stores a copy of the forms you send us
- **Vercel**: hosting
- **Google**: Analytics (only with your consent) and Search Console (search performance, not personal data)
- **[Any other provider, for example a mail or payment provider: confirm]**

**Some of these providers store or process information outside Canada, including in the United
States.** Your information may therefore be subject to the laws of those places, including access by
their authorities. **[Confirm each provider's location.]**

We do not sell your personal information. **[Confirm.]**

## Email and text messages (CASL)

We only send marketing email or text messages if you ticked the consent box on our newsletter form, and
every message tells you who it is from and how to **unsubscribe**. You can unsubscribe at any time using
the link in a message, or by contacting our privacy contact. We keep a record of when and how you
consented.

If you only send us an enquiry, we use your details to answer you. We do not add you to marketing
messages unless you also consent.

## How long we keep it

**[Fill in: for example, enquiries for X years, newsletter details until you unsubscribe plus Y months,
analytics data per Google's setting.]**

## Your rights

You can ask us to:
- tell you what personal information we hold about you and how we use it
- correct information that is wrong
- stop using your information for a purpose you agreed to, or delete it where we are allowed to
- withdraw a consent at any time (this may limit what we can do for you)

Contact our privacy contact above. We will answer within **[30 days]**. If you are not satisfied you can
complain to the **Office of the Privacy Commissioner of Canada** (priv.gc.ca) or, in Quebec, the
**Commission d'accès à l'information du Québec** (cai.gouv.qc.ca).

## Security

We protect your information with access controls and encrypted connections. No system is perfectly
secure, and we will tell you and the regulator if a breach puts you at risk of serious harm.
**[Confirm wording with the lawyer.]**

## Children

Our site and newsletter are for adults. We do not knowingly collect information from children.

## Changes

If we change this policy we will update the date below and, for important changes, tell you on the
site. Last updated: **[date]**.

---

### Notes for the reviewer (not part of the published text)

- The banner and the newsletter checkbox wording live in `components/cookie-banner.tsx`,
  `components/newsletter-form.tsx` and (French) `lib/i18n.ts`.
- The contact form has no marketing consent box on purpose (an enquiry implies consent to reply only).
- Newsletter signups are backed up in our own database table `leads` with a consent line, and tagged
  `email-consent` in GoHighLevel.
- Quebec Law 25 also expects: a privacy-incident register, a documented person responsible, and plain
  notice before non-essential tracking. The banner covers the last point; the other two are internal.
