import type { LucideIcon } from "lucide-react"
import {
  LayoutDashboard, Search, FileText, Globe, TrendingUp, Link2, Image,
  Newspaper, MessageSquare, BarChart3, Package, Bot, Settings, Cookie, Milestone,
} from "lucide-react"

export interface AdminNavItem {
  title: string
  description: string
  icon: LucideIcon
  href: string | null
  status: "Active" | "Coming Soon"
  external?: boolean
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
    title: "Travel Packages",
    description: "Manage all travel packages: add via AI interview, scrape URLs, upload Excel, or enter manually. Full CRUD with sorting and filtering.",
    icon: Package,
    status: "Active",
    href: "/admin/packages",
  },
  {
    title: "Project Tracker",
    description: "Roadmap (Gantt), epics with features, and the use-case backlog for the .ca rebuild.",
    icon: Milestone,
    status: "Active",
    href: "https://claude.ai/artifact/6PtefREyG1mewwcAqyJXAq",
    external: true,
  },
  {
    title: "Affiliate Code Manager",
    description: "Set affiliate codes and auto-convert keywords to affiliate hyperlinks across the site.",
    icon: Link2,
    status: "Coming Soon",
    href: null,
  },
  {
    title: "AI Voice & Chat Agent",
    description: "Manage travel info and Q&A files for the AI voice agent and chat agent.",
    icon: Bot,
    status: "Coming Soon",
    href: null,
  },
  {
    title: "Blog Auto-Writer",
    description: "Auto-generate and publish blog articles from trends, news, emails, and curated content.",
    icon: FileText,
    status: "Coming Soon",
    href: null,
  },
  {
    title: "Branchup Email Importer",
    description: "Auto-post Branchup.com email content and promotions to the blog.",
    icon: BarChart3,
    status: "Coming Soon",
    href: null,
  },
  {
    title: "Cookie Lead Collector",
    description: "Auto-collect visitor names, emails, phone numbers, and referrer info via a cookie consent banner on the main site.",
    icon: Cookie,
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
    description: "Mass update alt tags, meta descriptions, OG images, robots.txt, AI.txt, and submit to search engines.",
    icon: Globe,
    status: "Coming Soon",
    href: null,
  },
  {
    title: "Site Settings",
    description: "Manage site-wide settings, navigation, footer content, and general configuration.",
    icon: Settings,
    status: "Coming Soon",
    href: null,
  },
  {
    title: "Travel News Auto-Poster",
    description: "Automatically post the latest travel news, events, and industry updates to the blog.",
    icon: Newspaper,
    status: "Coming Soon",
    href: null,
  },
]

export const adminTools: AdminNavItem[] = [...unsortedTools].sort((a, b) => a.title.localeCompare(b.title))

// Sidebar order: Dashboard pinned first, then every module (active tools before "coming soon" is
// not necessary — alphabetical is predictable and matches the existing dashboard grid ordering).
export const adminNavItems: AdminNavItem[] = [dashboardNavItem, ...adminTools]
