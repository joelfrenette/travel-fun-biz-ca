// Offline check: which header items collapse under "More" on narrower desktops (content/navigation.ts) and that
// nothing is lost. Run: pnpm dlx tsx scripts/check-nav-split.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { primaryNavLinks, splitPrimaryNav, cruiseAndResortLinks, ctaLink } from '../content/navigation'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

const { always, more } = splitPrimaryNav(primaryNavLinks)
const labels = (l: { label: string }[]) => l.map((x) => x.label)
expect('every item is either inline or under More, none lost', always.length + more.length === primaryNavLinks.length)
expect('order is kept', [...always, ...more].every((l) => primaryNavLinks.includes(l)))
expect('Destinations stays inline', labels(always).includes('Destinations'))
expect('Cruises & Resorts group stays inline with all six index pages', always.find((l) => l.label === 'Cruises & Resorts')?.children?.length === cruiseAndResortLinks.length && cruiseAndResortLinks.length === 6)
expect('All Trips and Blog stay inline', labels(always).includes('All Trips') && labels(always).includes('Blog'))
expect('the five less important items go under More', labels(more).join(',') === 'Travel Agents,In The News,About Us,Contact Us,Booking', labels(more).join(','))
expect('Get Started is separate and always visible (not a nav item)', !primaryNavLinks.some((l) => l.href === ctaLink.href && l.label === ctaLink.label))
expect('existing hrefs unchanged', ['/packages', '/destinations', '/cruise-lines', '/blog', 'https://members.travelfunbiz.com', 'https://travelfunbiz.com/in-the-news/', 'https://travelfunbiz.com/about-us/', '/#contact', 'https://bookings.travelfunbiz.com/'].every((h) => primaryNavLinks.some((l) => l.href === h)))
expect('grouped items never collapse', primaryNavLinks.filter((l) => l.children).every((l) => !l.secondary))

const header = readFileSync(join(__dirname, '..', 'components/header.tsx'), 'utf8')
expect('labels never wrap', header.includes('whitespace-nowrap text-sm font-medium uppercase'))
expect('desktop nav starts at lg, phone menu below it', header.includes('lg:flex') && header.includes('lg:hidden') && !/\bmd:(flex|hidden)\b/.test(header))
expect('More drop-down keeps aria-haspopup and aria-expanded and closes on Escape', header.includes('aria-haspopup="true"') && header.includes('aria-expanded={open}') && header.includes('"Escape"'))
expect('secondary items are inline only on wide screens', header.includes('hidden min-[1700px]:inline') && header.includes('min-[1700px]:hidden'))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
