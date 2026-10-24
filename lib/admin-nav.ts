import type { LucideIcon } from "lucide-react"
import {
  LayoutDashboard, Search, FileText, Globe, TrendingUp, Link2, Image,
  Newspaper, MessageSquare, BarChart3, Package, Bot, Settings, Milestone, Tags, Quote, Activity, LineChart, Receipt, Users, Share2, Layers, Gem, ChartPie, CalendarCheck,
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
  href: "/admin",
  status: "Active",
}

const unsortedTools: AdminNavItem[] = [
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
]

export const adminTools: AdminNavItem[] = [...unsortedTools].sort((a, b) => a.title.localeCompare(b.title))

// Sidebar order: Dashboard pinned first, then every module (active tools before "coming soon" is
// not necessary — alphabetical is predictable and matches the existing dashboard grid ordering).
export const adminNavItems: AdminNavItem[] = [dashboardNavItem, ...adminTools]

// ---------------------------------------------------------------------------------------------------
// The sidebar. A short list of groups with short names. It is built from the same items as above (looked up by title,
// so a title typed wrong fails loudly at start-up and scripts/check-today-queue.ts proves every module appears exactly
// once). Today is first and carries the count of cards waiting; Dashboard is the traffic and tools part of the same
// page, lower down. Modules that are not built yet live in one collapsed "Later" group at the bottom.
// ---------------------------------------------------------------------------------------------------
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
  href: "/admin#dashboard",
  status: "Active",
}

export interface AdminNavEntry extends AdminNavItem {
  /** Drawn a little to the right, under the item above it. */
  nested?: boolean
}

export interface AdminNavGroup {
  id: string
  title: string
  items: AdminNavEntry[]
  /** Open the first time the menu is seen. A person's own open/closed choice is remembered after that. */
  defaultOpen: boolean
}

function pick(title: string, nested = false): AdminNavEntry {
  const found = unsortedTools.find((t) => t.title === title)
  if (!found) throw new Error(`admin-nav: no module titled "${title}"`)
  return nested ? { ...found, nested: true } : found
}

const GROUPED_TITLES = [
  "Posts: Blog", "Posts: Blog Auto-Writer", "Posts: News", "Posts: Guides", "Posts: Trips",
  "Content Autopilot", "Post Distribution",
  "Search Rankings", "Keyword Research", "SEO & GEO Manager", "SEO engines", "Link building", "Website Value", "Users and Analytics",
  "Leads", "Orders", "Affiliate Links", "Testimonials",
  "System Health", "Project Tracker",
]

export const adminNavGroups: AdminNavGroup[] = [
  { id: "content", title: "Content", defaultOpen: true, items: [pick("Posts: Blog"), pick("Posts: Blog Auto-Writer", true), pick("Posts: News"), pick("Posts: Guides"), pick("Posts: Trips")] },
  { id: "social", title: "Social", defaultOpen: true, items: [pick("Content Autopilot"), pick("Post Distribution")] },
  { id: "growth", title: "Growth", defaultOpen: true, items: [pick("Search Rankings"), pick("Keyword Research"), pick("SEO & GEO Manager"), pick("SEO engines"), pick("Link building"), pick("Website Value"), pick("Users and Analytics")] },
  { id: "money", title: "Money", defaultOpen: true, items: [pick("Leads"), pick("Orders"), pick("Affiliate Links"), pick("Testimonials")] },
  { id: "system", title: "System", defaultOpen: true, items: [pick("System Health"), pick("Project Tracker")] },
  // Everything not built yet, in one place, closed until someone opens it.
  { id: "later", title: "Later", defaultOpen: false, items: unsortedTools.filter((t) => !GROUPED_TITLES.includes(t.title)).sort((a, b) => a.title.localeCompare(b.title)) },
]

/** The two pinned entries above the groups. */
export const adminNavTop: AdminNavItem[] = [todayNavItem, dashboardAnchorItem]
