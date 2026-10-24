import { SeoEnginesPanel } from "@/components/admin/seo-engines-panel"

export default function SeoEnginesPage() {
  return (
    <div className="container mx-auto space-y-4 px-4 py-6">
      <div>
        <h1 className="text-xl font-bold">SEO engines</h1>
        <p className="text-sm text-muted-foreground">
          Four automatic helpers that read Google Search Console, our own pages and a few competitor websites. They suggest and link; they never publish anything and every automatic change can be undone.
        </p>
      </div>
      <SeoEnginesPanel />
    </div>
  )
}
