"use client"

import { useState, useEffect, useMemo } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  ArrowLeft, Plus, Pencil, Trash2, Eye, EyeOff, Star, Sparkles,
  ChevronRight, Check, Loader2, Upload, Globe, MessageSquare,
  ArrowUpDown, ArrowUp, ArrowDown, Filter, MoreHorizontal,
  FileSpreadsheet, Link, Wand2, Image, FileText, Share2, X
} from "lucide-react"
import type { DbPackage } from "@/lib/packages"

const categories = [
  "Adventure",
  "Beach & Resort",
  "Cultural",
  "Cruise",
  "Eco-Tourism",
  "Family",
  "Honeymoon",
  "Luxury",
  "Safari",
  "Singles",
  "Wellness & Spa",
]

type SortField = "name" | "available_from" | "destination" | "price_value" | "duration_days" | "supplier" | "status" | "created_at"
type SortDir = "asc" | "desc"

// ─── AI Interview Questions ─────────────────────────────────────────
const interviewQuestions = [
  { id: "destination", question: "Where is this trip going?", placeholder: "e.g., Cancun, Mexico or Caribbean Cruise", field: "destination", required: true },
  { id: "name", question: "What should we call this package?", placeholder: "e.g., Luxury Cancun All-Inclusive Escape", field: "name", required: true },
  { id: "supplier", question: "Who is the tour operator, resort, or cruise line?", placeholder: "e.g., Sandals Resorts, Royal Caribbean", field: "supplier", required: false },
  { id: "start_date", question: "When does this trip start? (leave blank if ongoing)", placeholder: "YYYY-MM-DD", field: "available_from", required: false },
  { id: "end_date", question: "When does this trip end?", placeholder: "YYYY-MM-DD", field: "available_to", required: false },
  { id: "duration", question: "How long is the trip?", placeholder: "e.g., 7 Days / 6 Nights", field: "duration", required: true },
  { id: "price", question: "What's the starting price?", placeholder: "e.g., From $2,499 per person", field: "price_display", required: true },
  { id: "category", question: "What category best describes this trip?", field: "category", type: "select", options: categories, required: true },
  { id: "description", question: "Give a short description for the package card (1-2 sentences)", placeholder: "e.g., Experience the ultimate beach getaway...", field: "short_description", type: "textarea", required: true },
  { id: "full_description", question: "Provide a detailed description (optional)", placeholder: "Full marketing description...", field: "full_description", type: "textarea", required: false },
  { id: "highlights", question: "What are the main highlights? (one per line)", placeholder: "All-inclusive meals\nBeachfront resort\nAirport transfers", field: "highlights", type: "textarea", required: false },
  { id: "included", question: "What's included in the price? (one per line)", placeholder: "Flights\nHotel\nMeals", field: "price_includes", type: "textarea", required: false },
  { id: "image", question: "Image URL for this package?", placeholder: "https://example.com/image.jpg", field: "image_url", required: false },
  { id: "booking_url", question: "Where should 'Book Now' link to?", placeholder: "https://booking-site.com/...", field: "booking_url", required: false },
  { id: "keywords", question: "SEO keywords (comma-separated)", placeholder: "cancun vacation, all-inclusive resort, beach holiday", field: "keywords", required: false },
]

// ─── Add Method Selection Modal ─────────────────────────────────────
function AddMethodModal({ open, onClose, onSelect }: { open: boolean; onClose: () => void; onSelect: (method: string) => void }) {
  const methods = [
    { id: "interview", title: "AI Interview", description: "Answer questions and let AI help create the package", icon: Sparkles },
    { id: "manual", title: "Add Manually", description: "Fill out all fields yourself in a form", icon: Pencil },
    { id: "scrape", title: "Scrape URL", description: "Enter a URL and extract package details automatically", icon: Globe },
    { id: "upload", title: "Upload Excel", description: "Bulk import packages from a spreadsheet", icon: FileSpreadsheet },
  ]

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add New Package</DialogTitle>
          <DialogDescription>Choose how you want to add a new travel package</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-4">
          {methods.map((method) => (
            <button
              key={method.id}
              onClick={() => onSelect(method.id)}
              className="flex items-center gap-4 rounded-lg border p-4 text-left transition-colors hover:bg-muted"
            >
              <div className="rounded-lg bg-primary/10 p-2">
                <method.icon className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-medium">{method.title}</p>
                <p className="text-sm text-muted-foreground">{method.description}</p>
              </div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── AI Interview Component ─────────────────────────────────────────
function AIInterview({ onComplete, onCancel }: { onComplete: (data: any) => void; onCancel: () => void }) {
  const [currentStep, setCurrentStep] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [currentAnswer, setCurrentAnswer] = useState("")

  const question = interviewQuestions[currentStep]
  const isLastQuestion = currentStep === interviewQuestions.length - 1
  const progress = ((currentStep + 1) / interviewQuestions.length) * 100

  function handleNext() {
    if (question.required && !currentAnswer.trim()) return

    const newAnswers = { ...answers, [question.field]: currentAnswer }
    setAnswers(newAnswers)

    if (isLastQuestion) {
      const packageData: any = {}
      for (const q of interviewQuestions) {
        const value = newAnswers[q.field]
        if (q.field === "highlights" && value) {
          packageData.highlights = value.split("\n").filter((h: string) => h.trim())
        } else if (value) {
          packageData[q.field] = value
        }
      }
      const priceMatch = packageData.price_display?.match(/[\d,]+/)
      if (priceMatch) {
        packageData.price_value = parseFloat(priceMatch[0].replace(/,/g, ""))
      }
      const durationMatch = packageData.duration?.match(/(\d+)\s*day/i)
      if (durationMatch) {
        packageData.duration_days = parseInt(durationMatch[1])
      }
      onComplete(packageData)
    } else {
      setCurrentStep(currentStep + 1)
      setCurrentAnswer(answers[interviewQuestions[currentStep + 1]?.field] || "")
    }
  }

  function handleBack() {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1)
      setCurrentAnswer(answers[interviewQuestions[currentStep - 1]?.field] || "")
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && question.type !== "textarea") {
      e.preventDefault()
      handleNext()
    }
  }

  return (
    <Card className="mx-auto max-w-2xl">
      <CardHeader>
        <div className="flex items-center gap-2 text-primary">
          <Sparkles className="h-5 w-5" />
          <span className="text-sm font-medium">AI Package Builder</span>
        </div>
        <CardTitle className="mt-2">Let's create a new travel package</CardTitle>
        <CardDescription>
          Step {currentStep + 1} of {interviewQuestions.length}
        </CardDescription>
        <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <Label className="text-lg font-medium">{question.question}</Label>
          {question.type === "select" ? (
            <Select value={currentAnswer} onValueChange={setCurrentAnswer}>
              <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
              <SelectContent>
                {question.options?.map((opt) => <SelectItem key={opt} value={opt}>{opt}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : question.type === "textarea" ? (
            <Textarea value={currentAnswer} onChange={(e) => setCurrentAnswer(e.target.value)} placeholder={question.placeholder} rows={4} />
          ) : (
            <Input value={currentAnswer} onChange={(e) => setCurrentAnswer(e.target.value)} onKeyDown={handleKeyDown} placeholder={question.placeholder} autoFocus />
          )}
        </div>
        <div className="flex items-center justify-between pt-4">
          <div className="flex gap-2">
            {currentStep > 0 && <Button variant="outline" onClick={handleBack}>Back</Button>}
            <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          </div>
          <Button onClick={handleNext} disabled={question.required && !currentAnswer.trim()}>
            {isLastQuestion ? <><Check className="mr-1 h-4 w-4" />Create Package</> : <>Next<ChevronRight className="ml-1 h-4 w-4" /></>}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Manual Form Component ──────────────────────────────────────────
function ManualForm({ onComplete, onCancel, initialData }: { onComplete: (data: any) => void; onCancel: () => void; initialData?: Partial<DbPackage> }) {
  const [formData, setFormData] = useState<Record<string, any>>(initialData || {})
  const [saving, setSaving] = useState(false)

  function handleChange(field: string, value: any) {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const data = { ...formData }
    if (data.highlights && typeof data.highlights === "string") {
      data.highlights = data.highlights.split("\n").filter((h: string) => h.trim())
    }
    const priceMatch = data.price_display?.match(/[\d,]+/)
    if (priceMatch) data.price_value = parseFloat(priceMatch[0].replace(/,/g, ""))
    const durationMatch = data.duration?.match(/(\d+)\s*day/i)
    if (durationMatch) data.duration_days = parseInt(durationMatch[1])
    onComplete(data)
  }

  return (
    <Card className="mx-auto max-w-4xl">
      <CardHeader>
        <CardTitle>{initialData?.id ? "Edit Package" : "Add Package Manually"}</CardTitle>
        <CardDescription>Fill out the package details below</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Package Name *</Label>
              <Input value={formData.name || ""} onChange={(e) => handleChange("name", e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label>Destination *</Label>
              <Input value={formData.destination || ""} onChange={(e) => handleChange("destination", e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label>Supplier / Tour Company</Label>
              <Input value={formData.supplier || ""} onChange={(e) => handleChange("supplier", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Category *</Label>
              <Select value={formData.category || ""} onValueChange={(v) => handleChange("category", v)}>
                <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                <SelectContent>
                  {categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Start Date</Label>
              <Input type="date" value={formData.available_from || ""} onChange={(e) => handleChange("available_from", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>End Date</Label>
              <Input type="date" value={formData.available_to || ""} onChange={(e) => handleChange("available_to", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Duration *</Label>
              <Input value={formData.duration || ""} onChange={(e) => handleChange("duration", e.target.value)} placeholder="e.g., 7 Days / 6 Nights" required />
            </div>
            <div className="space-y-2">
              <Label>Price Display *</Label>
              <Input value={formData.price_display || ""} onChange={(e) => handleChange("price_display", e.target.value)} placeholder="e.g., From $2,499" required />
            </div>
            <div className="space-y-2">
              <Label>Image URL</Label>
              <Input value={formData.image_url || ""} onChange={(e) => handleChange("image_url", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Booking URL</Label>
              <Input value={formData.booking_url || ""} onChange={(e) => handleChange("booking_url", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Star Rating</Label>
              <Input type="number" min="1" max="5" step="0.1" value={formData.rating || ""} onChange={(e) => handleChange("rating", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Keywords (comma-separated)</Label>
              <Input value={formData.keywords || ""} onChange={(e) => handleChange("keywords", e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Short Description *</Label>
            <Textarea value={formData.short_description || ""} onChange={(e) => handleChange("short_description", e.target.value)} rows={2} required />
          </div>
          <div className="space-y-2">
            <Label>Full Description</Label>
            <Textarea value={formData.full_description || ""} onChange={(e) => handleChange("full_description", e.target.value)} rows={4} />
          </div>
          <div className="space-y-2">
            <Label>Highlights (one per line)</Label>
            <Textarea value={Array.isArray(formData.highlights) ? formData.highlights.join("\n") : formData.highlights || ""} onChange={(e) => handleChange("highlights", e.target.value)} rows={4} />
          </div>
          <div className="space-y-2">
            <Label>What's Included</Label>
            <Textarea value={formData.price_includes || ""} onChange={(e) => handleChange("price_includes", e.target.value)} rows={3} />
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving..." : initialData?.id ? "Update Package" : "Create Package"}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

// ─── Scrape URL Component ───────────────────────────────────────────
function ScrapeUrlForm({ onComplete, onCancel }: { onComplete: (data: any) => void; onCancel: () => void }) {
  const [url, setUrl] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [packages, setPackages] = useState<any[]>([])
  const [adapter, setAdapter] = useState<string | null>(null)

  async function handleScrape() {
    if (!url.trim()) return
    setLoading(true)
    setError("")
    setPackages([])
    setAdapter(null)

    const token = localStorage.getItem("adminToken")

    try {
      console.log("[scrape] Starting scrape for URL:", url)
      const res = await fetch("/api/admin/scrape", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: url.trim() }),
      })

      console.log("[scrape] Response status:", res.status)
      const result = await res.json()
      console.log("[scrape] Response data:", result)

      if (!res.ok) {
        const errorMsg = result.error || "Failed to scrape URL"
        console.error("[scrape] Error:", errorMsg)
        setError(errorMsg)
        return
      }

      console.log("[scrape] Found packages:", result.packages?.length || 0)
      setPackages(result.packages || [])
      setAdapter(result.adapter || null)
    } catch (err) {
      console.error("[scrape] Network error:", err)
      setError("Network error — please try again. Make sure you're connected to the internet.")
    } finally {
      setLoading(false)
    }
  }

  function handleUseData(pkg: any) {
    onComplete({
      name: pkg.name,
      destination: pkg.destination,
      duration: pkg.duration,
      price_display: pkg.price || pkg.price_display || 'From $1,000',
      price_value: pkg.priceValue,
      short_description: pkg.description,
      image_url: pkg.imageUrl,
      booking_url: pkg.bookingUrl,
      supplier: pkg.supplier,
      category: pkg.category || 'Adventure',
      highlights: pkg.highlights,
      status: 'draft',
    })
  }

  return (
    <Card className="mx-auto max-w-5xl">
      <CardHeader>
        <div className="flex items-center gap-2 text-primary">
          <Globe className="h-5 w-5" />
          <span className="text-sm font-medium">Scrape Package from URL</span>
        </div>
        <CardTitle className="mt-2">Enter a URL to scrape</CardTitle>
        <CardDescription>We'll detect package blocks on the page and extract each one automatically.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label>Package URL</Label>
          <div className="flex gap-2">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://travelfunbiz.com"
              disabled={loading}
              onKeyDown={(e) => e.key === 'Enter' && handleScrape()}
            />
            <Button onClick={handleScrape} disabled={loading || !url.trim()}>
              {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Scraping...</> : "Scrape"}
            </Button>
          </div>
          {adapter && (
            <p className="text-xs text-muted-foreground">
              ✓ Parser: {adapter}
            </p>
          )}
          {error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              <p className="font-medium">Error:</p>
              <p className="mt-1">{error}</p>
              {error.includes("API not configured") && (
                <p className="mt-2 text-xs">
                  Please set <code className="bg-destructive/20 px-1 py-0.5 rounded">SCRAPINGBEE_API_KEY</code> in your .env.local file.
                  Get a free API key from <a href="https://app.scrapingbee.com/api" target="_blank" rel="noopener noreferrer" className="underline hover:text-destructive-foreground">ScrapingBee</a>.
                </p>
              )}
            </div>
          )}
        </div>

        {packages.length > 0 ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-lg font-semibold">Select packages to import</h4>
              <Badge variant="outline" className="text-green-600">
                Found {packages.length} package{packages.length === 1 ? '' : 's'}
              </Badge>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {packages.map((pkg, idx) => (
                <Card key={idx} className="border-primary/20">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">{pkg.name || `Package ${idx + 1}`}</CardTitle>
                    {pkg.destination && <p className="text-xs text-muted-foreground">{pkg.destination}</p>}
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex gap-3">
                      {pkg.imageUrl ? (
                        <div className="h-24 w-32 overflow-hidden rounded bg-muted">
                          <img src={pkg.imageUrl} alt={pkg.name} className="h-full w-full object-cover" />
                        </div>
                      ) : (
                        <div className="flex h-24 w-32 items-center justify-center rounded bg-muted text-xs text-muted-foreground">
                          No image
                        </div>
                      )}
                      <div className="text-sm text-muted-foreground">
                        {pkg.duration && <p><span className="font-medium text-foreground">Duration:</span> {pkg.duration}</p>}
                        {pkg.price && <p><span className="font-medium text-foreground">Price:</span> {pkg.price}</p>}
                        {pkg.bookingUrl && <p className="truncate"><span className="font-medium text-foreground">Link:</span> {pkg.bookingUrl}</p>}
                      </div>
                    </div>
                    {pkg.description && <p className="text-sm text-muted-foreground">{pkg.description}</p>}
                    {pkg.highlights && pkg.highlights.length > 0 && (
                      <ul className="list-inside list-disc text-xs text-muted-foreground">
                        {pkg.highlights.slice(0, 4).map((h: string, i: number) => (
                          <li key={i}>{h}</li>
                        ))}
                      </ul>
                    )}
                    <div className="flex justify-end">
                      <Button onClick={() => handleUseData(pkg)}>
                        <Check className="mr-1 h-4 w-4" />Import Package
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            Paste any travel landing page URL (e.g., travelfunbiz.com) to detect all highlighted packages automatically.
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Upload Excel Component ─────────────────────────────────────────
function UploadExcelForm({ onComplete, onCancel }: { onComplete: (data: any) => void; onCancel: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleUpload() {
    if (!file) return
    setLoading(true)
    // TODO: Implement actual Excel parsing
    setTimeout(() => {
      setLoading(false)
      alert("Excel upload coming soon! For now, use AI Interview or Manual entry.")
      onCancel()
    }, 1500)
  }

  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <div className="flex items-center gap-2 text-primary">
          <FileSpreadsheet className="h-5 w-5" />
          <span className="text-sm font-medium">Upload Excel File</span>
        </div>
        <CardTitle className="mt-2">Bulk import packages</CardTitle>
        <CardDescription>Upload an Excel file with package data</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Excel File (.xlsx, .xls)</Label>
          <Input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={handleUpload} disabled={loading || !file}>
            {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Uploading...</> : "Upload & Import"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Package Table Component ────────────────────────────────────────
function PackageTable({
  packages,
  sortField,
  sortDir,
  onSort,
  onEdit,
  onDelete,
  onToggleStatus,
  onToggleFeatured,
  onAIAction,
  selectedIds,
  onSelectToggle,
  onSelectAll,
}: {
  packages: DbPackage[]
  sortField: SortField
  sortDir: SortDir
  onSort: (field: SortField) => void
  onEdit: (pkg: DbPackage) => void
  onDelete: (id: string) => void
  onToggleStatus: (pkg: DbPackage) => void
  onToggleFeatured: (pkg: DbPackage) => void
  onAIAction: (action: string, pkg: DbPackage) => void
  selectedIds: Set<string>
  onSelectToggle: (id: string) => void
  onSelectAll: () => void
}) {
  const columns: { key: SortField; label: string; className?: string }[] = [
    { key: "name", label: "Package", className: "min-w-[200px]" },
    { key: "available_from", label: "Start Date", className: "w-[100px]" },
    { key: "duration_days", label: "Length", className: "w-[80px]" },
    { key: "supplier", label: "Supplier", className: "w-[150px]" },
    { key: "destination", label: "Destination", className: "w-[150px]" },
    { key: "price_value", label: "Price", className: "w-[100px]" },
    { key: "status", label: "Status", className: "w-[100px]" },
  ]

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) return <ArrowUpDown className="ml-1 h-3 w-3 opacity-50" />
    return sortDir === "asc" ? <ArrowUp className="ml-1 h-3 w-3" /> : <ArrowDown className="ml-1 h-3 w-3" />
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr>
            <th className="w-10 p-3">
              <Checkbox checked={selectedIds.size === packages.length && packages.length > 0} onCheckedChange={onSelectAll} />
            </th>
            <th className="w-16 p-3 text-left text-xs font-medium uppercase text-muted-foreground">Thumb</th>
            {columns.map((col) => (
              <th key={col.key} className={`p-3 text-left text-xs font-medium uppercase text-muted-foreground ${col.className || ""}`}>
                <button onClick={() => onSort(col.key)} className="flex items-center hover:text-foreground">
                  {col.label}
                  <SortIcon field={col.key} />
                </button>
              </th>
            ))}
            <th className="w-20 p-3 text-right text-xs font-medium uppercase text-muted-foreground">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {packages.map((pkg) => (
            <tr key={pkg.id} className="hover:bg-muted/30">
              <td className="p-3">
                <Checkbox checked={selectedIds.has(pkg.id)} onCheckedChange={() => onSelectToggle(pkg.id)} />
              </td>
              <td className="p-3">
                <div className="h-10 w-14 overflow-hidden rounded bg-muted">
                  {pkg.image_url ? (
                    <img src={pkg.image_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[8px] text-muted-foreground">No img</div>
                  )}
                </div>
              </td>
              <td className="p-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{pkg.name}</span>
                  {pkg.featured && <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground" style={{ maxWidth: 200 }}>{pkg.short_description}</p>
              </td>
              <td className="p-3 text-xs">{pkg.available_from || "—"}</td>
              <td className="p-3 text-xs">{pkg.duration_days ? `${pkg.duration_days}d` : pkg.duration || "—"}</td>
              <td className="p-3 text-xs">{pkg.supplier || "—"}</td>
              <td className="p-3 text-xs">{pkg.destination}</td>
              <td className="p-3 text-xs font-medium">{pkg.price_display}</td>
              <td className="p-3">
                <Badge variant={pkg.status === "published" ? "default" : "secondary"} className="text-[10px]">
                  {pkg.status}
                </Badge>
              </td>
              <td className="p-3 text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onEdit(pkg)}>
                      <Pencil className="mr-2 h-4 w-4" />Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onToggleStatus(pkg)}>
                      {pkg.status === "published" ? <EyeOff className="mr-2 h-4 w-4" /> : <Eye className="mr-2 h-4 w-4" />}
                      {pkg.status === "published" ? "Unpublish" : "Publish"}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onToggleFeatured(pkg)}>
                      <Star className="mr-2 h-4 w-4" />{pkg.featured ? "Unfeature" : "Feature"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => onAIAction("faq", pkg)}>
                      <MessageSquare className="mr-2 h-4 w-4" />Generate FAQ
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onAIAction("thumbnail", pkg)}>
                      <Image className="mr-2 h-4 w-4" />Generate Thumbnails
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onAIAction("descriptions", pkg)}>
                      <FileText className="mr-2 h-4 w-4" />Generate Descriptions
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onAIAction("social", pkg)}>
                      <Share2 className="mr-2 h-4 w-4" />Generate Social Posts
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onAIAction("page", pkg)}>
                      <Wand2 className="mr-2 h-4 w-4" />Generate Full Page
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => onDelete(pkg.id)} className="text-destructive">
                      <Trash2 className="mr-2 h-4 w-4" />Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {packages.length === 0 && (
        <div className="py-12 text-center text-muted-foreground">No packages found</div>
      )}
    </div>
  )
}

// ─── Main Packages Admin Page ───────────────────────────────────────
export default function PackagesAdminPage() {
  const router = useRouter()
  const [packages, setPackages] = useState<DbPackage[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<"list" | "interview" | "manual" | "scrape" | "upload">("list")
  const [editingPackage, setEditingPackage] = useState<DbPackage | null>(null)
  const [saving, setSaving] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)

  // Sorting & filtering
  const [sortField, setSortField] = useState<SortField>("created_at")
  const [sortDir, setSortDir] = useState<SortDir>("desc")
  const [filterText, setFilterText] = useState("")
  const [filterStatus, setFilterStatus] = useState<string>("all")
  const [filterCategory, setFilterCategory] = useState<string>("all")

  // Selection for bulk actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Auth check
  useEffect(() => {
    const token = localStorage.getItem("adminToken")
    if (!token) {
      router.push("/admin")
      return
    }
    fetchPackages()
  }, [])

  async function fetchPackages() {
    const token = localStorage.getItem("adminToken")
    try {
      const res = await fetch("/api/admin/packages", { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      setPackages(data.packages || [])
    } catch (error) {
      console.error("Failed to fetch packages:", error)
    } finally {
      setLoading(false)
    }
  }

  // Filtered & sorted packages
  const filteredPackages = useMemo(() => {
    let result = [...packages]

    // Text filter
    if (filterText) {
      const lower = filterText.toLowerCase()
      result = result.filter((p) =>
        p.name.toLowerCase().includes(lower) ||
        p.destination.toLowerCase().includes(lower) ||
        (p.supplier || "").toLowerCase().includes(lower)
      )
    }

    // Status filter
    if (filterStatus !== "all") {
      result = result.filter((p) => p.status === filterStatus)
    }

    // Category filter
    if (filterCategory !== "all") {
      result = result.filter((p) => p.category === filterCategory)
    }

    // Sort
    result.sort((a, b) => {
      let aVal: any = a[sortField]
      let bVal: any = b[sortField]

      // Handle dates
      if (sortField === "available_from") {
        aVal = a.available_from || ""
        bVal = b.available_from || ""
      }

      if (aVal == null) aVal = ""
      if (bVal == null) bVal = ""

      if (typeof aVal === "string") aVal = aVal.toLowerCase()
      if (typeof bVal === "string") bVal = bVal.toLowerCase()

      if (aVal < bVal) return sortDir === "asc" ? -1 : 1
      if (aVal > bVal) return sortDir === "asc" ? 1 : -1
      return 0
    })

    return result
  }, [packages, filterText, filterStatus, filterCategory, sortField, sortDir])

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc")
    } else {
      setSortField(field)
      setSortDir("asc")
    }
  }

  async function handleCreatePackage(data: any) {
    setSaving(true)
    const token = localStorage.getItem("adminToken")
    try {
      const res = await fetch("/api/admin/packages", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...data, status: "draft" }),
      })
      if (res.ok) {
        setView("list")
        fetchPackages()
      }
    } catch (error) {
      console.error("Failed to create package:", error)
    } finally {
      setSaving(false)
    }
  }

  async function handleUpdatePackage(data: any) {
    if (!editingPackage) return
    setSaving(true)
    const token = localStorage.getItem("adminToken")
    try {
      const res = await fetch(`/api/admin/packages/${editingPackage.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(data),
      })
      if (res.ok) {
        setView("list")
        setEditingPackage(null)
        fetchPackages()
      }
    } catch (error) {
      console.error("Failed to update package:", error)
    } finally {
      setSaving(false)
    }
  }

  async function handleToggleStatus(pkg: DbPackage) {
    const token = localStorage.getItem("adminToken")
    const newStatus = pkg.status === "published" ? "draft" : "published"
    try {
      await fetch(`/api/admin/packages/${pkg.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: newStatus }),
      })
      fetchPackages()
    } catch (error) {
      console.error("Failed to update package:", error)
    }
  }

  async function handleToggleFeatured(pkg: DbPackage) {
    const token = localStorage.getItem("adminToken")
    try {
      await fetch(`/api/admin/packages/${pkg.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ featured: !pkg.featured }),
      })
      fetchPackages()
    } catch (error) {
      console.error("Failed to update package:", error)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this package?")) return
    const token = localStorage.getItem("adminToken")
    try {
      await fetch(`/api/admin/packages/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } })
      fetchPackages()
    } catch (error) {
      console.error("Failed to delete package:", error)
    }
  }

  function handleEdit(pkg: DbPackage) {
    setEditingPackage(pkg)
    setView("manual")
  }

  function handleAIAction(action: string, pkg: DbPackage) {
    // TODO: Implement AI actions
    alert(`AI ${action} for "${pkg.name}" coming soon!`)
  }

  function handleSelectToggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleSelectAll() {
    if (selectedIds.size === filteredPackages.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredPackages.map((p) => p.id)))
    }
  }

  function handleAddMethodSelect(method: string) {
    setShowAddModal(false)
    setEditingPackage(null)
    setView(method as any)
  }

  // Render different views
  if (view === "interview") {
    return (
      <div className="min-h-screen bg-background p-6">
        <AIInterview onComplete={handleCreatePackage} onCancel={() => setView("list")} />
      </div>
    )
  }

  if (view === "manual") {
    return (
      <div className="min-h-screen bg-background p-6">
        <ManualForm
          onComplete={editingPackage ? handleUpdatePackage : handleCreatePackage}
          onCancel={() => { setView("list"); setEditingPackage(null) }}
          initialData={editingPackage || undefined}
        />
      </div>
    )
  }

  if (view === "scrape") {
    return (
      <div className="min-h-screen bg-background p-6">
        <ScrapeUrlForm onComplete={handleCreatePackage} onCancel={() => setView("list")} />
      </div>
    )
  }

  if (view === "upload") {
    return (
      <div className="min-h-screen bg-background p-6">
        <UploadExcelForm onComplete={handleCreatePackage} onCancel={() => setView("list")} />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card/50">
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => router.push("/admin")}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Admin</p>
              <h1 className="text-xl font-bold">Travel Packages</h1>
            </div>
          </div>
          <Button onClick={() => setShowAddModal(true)}>
            <Plus className="mr-1 h-4 w-4" />Add Package
          </Button>
        </div>
      </header>

      {/* Filters */}
      <div className="border-b bg-card/30">
        <div className="container mx-auto flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="flex-1">
            <Input
              placeholder="Search packages..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              className="max-w-xs"
            />
          </div>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="published">Published</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filterCategory} onValueChange={setFilterCategory}>
            <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{selectedIds.size} selected</span>
              <Button variant="outline" size="sm" onClick={() => alert("Bulk edit coming soon!")}>
                Bulk Edit
              </Button>
              <Button variant="outline" size="sm" className="text-destructive" onClick={() => alert("Bulk delete coming soon!")}>
                Delete Selected
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <main className="container mx-auto px-4 py-6">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <PackageTable
            packages={filteredPackages}
            sortField={sortField}
            sortDir={sortDir}
            onSort={handleSort}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onToggleStatus={handleToggleStatus}
            onToggleFeatured={handleToggleFeatured}
            onAIAction={handleAIAction}
            selectedIds={selectedIds}
            onSelectToggle={handleSelectToggle}
            onSelectAll={handleSelectAll}
          />
        )}
      </main>

      {/* Add Method Modal */}
      <AddMethodModal open={showAddModal} onClose={() => setShowAddModal(false)} onSelect={handleAddMethodSelect} />
    </div>
  )
}