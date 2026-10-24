import type { LucideIcon } from "lucide-react"
import { agentsNavItem } from "@/lib/admin-nav-agents"
import {
  LayoutDashboard, Search, FileText, Globe, TrendingUp, Link2, Image,
  Newspaper, MessageSquare, BarChart3, Package, Bot, Settings, Milestone, Tags, Quote, Activity, LineChart, Receipt, Users, Share2, Layers, Gem, ChartPie, CalendarCheck, ListChecks, ShieldCheck, PencilLine, ClipboardCheck,
} from "lucide-react"

export interface AdminNavItem {
  title: string
  description: string
  icon: LucideIcon
  href: string | null
  status: "Active" | "Coming Soon"
}

// Single source of truth for admin modules — used by both the sidebar nav
// and the dashboard's tool grid, so adding a module only means editing here.
export const dashboardNavItem: AdminNavItem = {
  title: "Dashboard",
  description: "Traffic overview and quick stats.",
  icon: LayoutDashboard,
  href: "/admin/dashboard",
  status: "Active",
}

const unsortedTools: AdminNavItem[] = [
  agentsNavItem,
  {
    title: "Posts: Trips",
    description: "Manage all travel packages: add via AI interview, scrape URLs, paste source material, upload CSV, or enter manually. Full CRUD with sorting and filtering.",
    icon: Package,
    status: "Active",
    href: "/admin/packages",
  },
  {
    title: "Posts: Guides",
    description: "Destination, hotel, resort, cruise line, ship, river cruise and yacht pages: the site writes, improves and publishes them for Google, AI answers and enquiries. One screen for the backfill, the review queue and the searchable list.",
    icon: Layers,
    status: "Active",
    href: "/admin/guides",
  },
  {
    title: "Keyword Research",
    description: "Look up search volume, CPC and trend from DataForSEO and assign each phrase the page it should rank for.",
    icon: Tags,
    status: "Active",
    href: "/admin/keywords",
  },
  {
    title: "Project Tracker",
    description: "Roadmap (Gantt), epics with features, and the use-case backlog for the .ca rebuild. Add ideas by voice or text.",
    icon: Milestone,
    status: "Active",
    href: "/admin/tracker",
  },
  {
    title: "Testimonials",
    description: "Curate reviews shown on the homepage, and later on trip pages and recap pages. Draft rows stay hidden.",
    icon: Quote,
    status: "Active",
    href: "/admin/testimonials",
  },
  {
    title: "Posts: Blog",
    description: "Write articles and trip recaps in Markdown, with a live preview and image upload. Drafts stay hidden until published.",
    icon: FileText,
    status: "Active",
    href: "/admin/blog",
  },
  {
    title: "Leads",
    description: "Every contact-form submission, saved as a backup whether or not it reached GoHighLevel - so a GHL outage never loses one for good.",
    icon: Users,
    status: "Active",
    href: "/admin/leads",
  },
  {
    title: "Orders",
    description: "Purchases GoHighLevel has reported, with a running total collected. Test purchases and refunds are shown but never counted.",
    icon: Receipt,
    status: "Active",
    href: "/admin/orders",
  },
  {
    title: "Search Rankings",
    description: "Where your pages and keywords sit in Google, and which ones moved up or down since the last snapshot.",
    icon: LineChart,
    status: "Active",
    href: "/admin/rankings",
  },
  {
    title: "System Health",
    description: "Whether each scheduled job (autoblog, SEO rankings) is actually running, or has gone quiet since it was last checked.",
    icon: Activity,
    status: "Active",
    href: "/admin/system-health",
  },
  {
    title: "Content Autopilot",
    description: "One switch that runs the whole chain on its own: blog posts, cover images, captions, carousels and short videos, posted to social.",
    icon: Bot,
    status: "Active",
    href: "/admin/autopilot",
  },
  {
    title: "Post Distribution",
    description: "The approval queue for social posts: approve held posts, see what is queued, posted or failed. Posting settings live on Content Autopilot.",
    icon: Share2,
    status: "Active",
    href: "/admin/distribution",
  },
  {
    title: "Website Value",
    description: "What the site is worth to a buyer: profit, traffic, search and content tiles with their source and freshness, a rough low/base/high estimate you can edit, and a CSV for a buyer's data room.",
    icon: Gem,
    status: "Active",
    href: "/admin/value",
  },
  {
    title: "Users and Analytics",
    description: "AI cost per feature per day, admin sign-ins, lead volume and what leads ask about (counts only), and visitors once visit tracking is on.",
    icon: ChartPie,
    status: "Active",
    href: "/admin/users",
  },
  {
    title: "Affiliate Links",
    description: "Create /go short links for affiliate and merchant URLs, edit the destination without republishing anything, and see clicks per link.",
    icon: Link2,
    status: "Active",
    href: "/admin/affiliate-links",
  },
  {
    title: "Link building",
    description: "A checklist and copy-ready drafts for earning real backlinks yourself: free listings, partner link requests, reviews, plus a name, address and phone consistency check and a log of links earned.",
    icon: Link2,
    status: "Active",
    href: "/admin/links-building",
  },
  {
    title: "AI Voice & Chat Agent",
    description: "Manage travel info and Q&A files for the AI voice agent and chat agent.",
    icon: Bot,
    status: "Coming Soon",
    href: null,
  },
  {
    title: "Posts: Blog Auto-Writer",
    description: "AI-suggested blog topics queued for your approval, then auto-written into draft posts on schedule. Lives in the Blog tool's \"Topics & Autoblog\" tab.",
    icon: Bot,
    status: "Active",
    href: "/admin/blog?tab=autoblog",
  },
  {
    title: "Branchup Email Importer",
    description: "Auto-post Branchup.com email content and promotions to the blog.",
    icon: BarChart3,
    status: "Coming Soon",
    href: null,
  },
  {
    title: "Google Trends & Analytics",
    description: "Pull trending keywords and analytics data to auto-generate optimized blog posts.",
    icon: TrendingUp,
    status: "Coming Soon",
    href: null,
  },
  {
    title: "Image & Meta Bulk Editor",
    description: "Bulk update all image alt tags, meta tags, OG descriptions, and OG images site-wide.",
    icon: Image,
    status: "Coming Soon",
    href: null,
  },
  {
    title: "Quora & Reddit Scraper",
    description: "Scrape, post, and answer travel questions on Quora and Reddit to drive traffic.",
    icon: MessageSquare,
    status: "Coming Soon",
    href: null,
  },
  {
    title: "Search Engine Submission",
    description: "Ping new pages, submit sitemaps, manage backlinks, and trigger crawls on Google & Bing.",
    icon: Search,
    status: "Coming Soon",
    href: null,
  },
  {
    title: "SEO & GEO Manager",
    description: "The SEO, AEO, GEO and local checklist in order of impact: what the site passes or fails automatically, what only you can do, and a place to paste tips from influencers.",
    icon: Globe,
    status: "Active",
    href: "/admin/seo-manager",
  },
  {
    title: "SEO engines",
    description: "Searches we should build pages for, pages competing with each other, competitor scans, and the hub and spoke map.",
    icon: Search,
    status: "Active",
    href: "/admin/seo-engines",
  },
  {
    title: "Site Settings",
    description: "Manage site-wide settings, navigation, footer content, and general configuration.",
    icon: Settings,
    status: "Coming Soon",
    href: null,
  },
  {
    title: "Posts: News",
    description: "The travel news auto-poster: which feeds are read and switched on, the Off/Draft/Publish mode, and every item with what became of it.",
    icon: Newspaper,
    status: "Active",
    href: "/admin/news",
  },
  {
    title: "Daily follow-ups",
    description: "Today's short to-do list: the growth tips, the best SEO fixes, leads to answer, the 15 minute social routine and the setup steps still open. Tick Done or push to Later.",
    icon: ListChecks,
    status: "Active",
    href: "/admin/follow-ups",
  },
  {
    title: "System check",
    description: "One list in funnel order, each line green, amber or red with one plain sentence, what the site fixed by itself, and what needs you.",
    icon: ShieldCheck,
    status: "Active",
    href: "/admin/system-check",
  },
  {
    title: "Content edits",
    description: "Every change the site made to its own pages, with the reason, and an Undo for each.",
    icon: PencilLine,
    status: "Active",
    href: "/admin/content-edits",
  },
]

export const adminTools: AdminNavItem[] = [...unsortedTools].sort((a, b) => a.title.localeCompare(b.title))

// Sidebar order: Dashboard pinned first, then every module (active tools before "coming soon" is
// not necessary — alphabetical is predictable and matches the existing dashboard grid ordering).
export const adminNavItems: AdminNavItem[] = [dashboardNavItem, ...adminTools]


// ---------------------------------------------------------------------------------------------------
// The sidebar, as data. It follows the order of the day: first the things to do (Today, Daily follow-ups, System check),
// then the live numbers, then making and posting, growing, and money. Every link in those five sections carries a step
// number that the menu DRAWS from this data (the number is the position in the list, never typed by hand), so moving a
// link moves its number. Advanced and Setup are not steps: they are closed until someone opens them, and everything not
// built yet sits in one "Later" sub-list inside Advanced.
//
// Modules are looked up by title, so a title typed wrong fails loudly at start-up, and scripts/check-admin-v2.ts proves
// every module appears exactly once.
// ---------------------------------------------------------------------------------------------------

/** The setup checklist Joel follows (grade 5 steps for every account and key). One place; the dashboard uses it too. */
export const SETUP_STEPS_URL = "https://claude.ai/artifact/PN6caspQe9V6RUUsJ2vNcw"

export const todayNavItem: AdminNavItem = {
  title: "Today",
  description: "The yes and no cards that need you, after a quick system check.",
  icon: CalendarCheck,
  href: "/admin",
  status: "Active",
}

export const dashboardAnchorItem: AdminNavItem = {
  title: "Dashboard",
  description: "Traffic overview, funnel and the full tool list.",
  icon: LayoutDashboard,
  href: "/admin/dashboard",
  status: "Active",
}

/** Which number the menu shows next to a link: the Today card count, the open follow-ups, or the system check light. */
export type NavBadge = "today" | "followups" | "check"

export interface NavLink extends AdminNavItem {
  /** Stable id for the link. Modules use their title. */
  key: string
  badge?: NavBadge
  /** Opens in a new tab (the setup checklist). */
  external?: boolean
  /** Drawn a little to the right, under the link above it. */
  nested?: boolean
  /** A second door into a module that already has its own numbered link: never counted as a module, never highlighted. */
  shortcut?: boolean
}

export interface NavSection {
  id: string
  title: string
  /** One line under the section name (a tooltip, and the heading text for screen readers). */
  hint: string
  /** True for the daily steps: their links get consecutive step numbers. */
  numbered: boolean
  /** Open the first time the menu is seen. A person's own open/closed choice is remembered after that. */
  defaultOpen: boolean
  links: NavLink[]
  /** Advanced only: modules that are not built yet, in one greyed sub-list. */
  later?: NavLink[]
}

export interface NumberedNavLink extends NavLink {
  /** 1, 2, 3 ... in menu order for the daily sections; null for Advanced and Setup. */
  step: number | null
}
export interface NumberedNavSection extends Omit<NavSection, "links"> {
  links: NumberedNavLink[]
}

function mod(title: string, extra: Partial<Pick<NavLink, "badge" | "nested">> = {}): NavLink {
  const found = unsortedTools.find((t) => t.title === title)
  if (!found) throw new Error(`admin-nav: no module titled "${title}"`)
  return { ...found, key: title, ...extra }
}

const SECTIONS: NavSection[] = [
  {
    id: "do-first",
    title: "Do first",
    hint: "The four things to open every day, in this order.",
    numbered: true,
    defaultOpen: true,
    links: [
      mod("System check", { badge: "check" }),
      { ...todayNavItem, key: "Today", badge: "today" },
      mod("Daily follow-ups", { badge: "followups" }),
      { ...dashboardAnchorItem, key: "Dashboard" },
    ],
  },
  {
    id: "live",
    title: "Live numbers",
    hint: "How the site is doing right now.",
    numbered: true,
    defaultOpen: true,
    links: [mod("Search Rankings"), mod("Users and Analytics"), mod("Website Value")],
  },
  {
    id: "make",
    title: "Make and post",
    hint: "What gets written and sent out.",
    numbered: true,
    defaultOpen: true,
    links: [mod("Posts: Blog"), mod("Posts: News"), mod("Posts: Guides"), mod("Posts: Trips"), mod("Content Autopilot"), mod("Post Distribution")],
  },
  {
    id: "grow",
    title: "Grow",
    hint: "Ways to get more visitors.",
    numbered: true,
    defaultOpen: true,
    links: [mod("SEO & GEO Manager"), mod("SEO engines"), mod("Keyword Research"), mod("Link building")],
  },
  {
    id: "money",
    title: "Money",
    hint: "Leads, orders and the pages that earn.",
    numbered: true,
    defaultOpen: true,
    links: [mod("Leads"), mod("Travel Agents"), mod("Orders"), mod("Affiliate Links"), mod("Testimonials")],
  },
  {
    id: "advanced",
    title: "Advanced",
    hint: "Not needed every day.",
    numbered: false,
    defaultOpen: false,
    links: [mod("Posts: Blog Auto-Writer"), mod("Project Tracker"), mod("System Health"), mod("Content edits")],
    // Everything not built yet, in one place.
    later: unsortedTools
      .filter((t) => t.status === "Coming Soon")
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((t) => ({ ...t, key: t.title })),
  },
  {
    id: "setup",
    title: "Setup",
    hint: "One-off jobs: the checklist and the link building tasks.",
    numbered: false,
    defaultOpen: false,
    links: [
      {
        key: "Setup checklist",
        title: "Setup checklist",
        description: "The step by step list for every account and key.",
        icon: ClipboardCheck,
        href: SETUP_STEPS_URL,
        status: "Active",
        external: true,
      },
      { ...mod("Link building"), key: "Link building tasks", title: "Link building tasks", shortcut: true },
    ],
  },
]

/** Gives every link in a numbered section its step number: 1, 2, 3 ... in the order the sections and links are listed. */
export function numberSections(sections: NavSection[]): NumberedNavSection[] {
  let step = 0
  return sections.map((s) => ({
    ...s,
    links: s.links.map((l) => ({ ...l, step: s.numbered ? ++step : null })),
  }))
}

export const adminNavSections: NumberedNavSection[] = numberSections(SECTIONS)

/** Every link that opens a page, in menu order (the phone bottom bar and the checks use it). */
export const adminNavLinks: NumberedNavLink[] = adminNavSections.flatMap((s) => s.links)

/** The numbered step of a link by key, or null. */
export function stepOf(key: string): number | null {
  return adminNavLinks.find((l) => l.key === key)?.step ?? null
}
