"use client"

import { useState, useEffect, useMemo, useRef } from "react"
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
  Plus, Pencil, Trash2, Eye, EyeOff, Star, Sparkles,
  ChevronRight, Check, Loader2, Upload, Globe, MessageSquare,
  ArrowUpDown, ArrowUp, ArrowDown, Filter, MoreHorizontal,
  FileSpreadsheet, Link, Wand2, Image, FileText, Share2, X, Download, ExternalLink, RefreshCw, ClipboardPaste, AlertTriangle
} from "lucide-react"
import type { DbPackage } from "@/lib/packages"
import type { ScrapedPackage } from "@/types/scrape"
import { generateSlug } from "@/lib/utils"
import { scrapedToPackage as scrapedToPayload } from "@/lib/scraping/to-package"
import { parsePackagesCsv, csvTemplate, type CsvRow } from "@/lib/import-csv"
import { completenessScore } from "@/lib/package-completeness"
import { PackageSourcesPanel } from "@/components/admin/package-sources-panel"

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

type SortField = "name" | "available_from" | "destination" | "price_value" | "duration_days" | "supplier" | "status" | "created_at" | "completeness"
type SortDir = "asc" | "desc"

// ─── AI Field Generator Button ──────────────────────────────────────
function AIFieldButton({ onClick, loading, title }: { onClick: () => void; loading?: boolean; title?: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-8 w-8 shrink-0"
      onClick={onClick}
      disabled={loading}
      title={title || "Generate with AI"}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4 text-primary" />}
    </Button>
  )
}

// ─── Multi-Select Category Component ────────────────────────────────
function CategoryMultiSelect({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  function toggle(cat: string) {
    if (value.includes(cat)) {
      onChange(value.filter(c => c !== cat))
    } else {
      onChange([...value, cat])
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {categories.map((cat) => (
        <label key={cat} className="flex items-center gap-1.5 cursor-pointer">
          <Checkbox checked={value.includes(cat)} onCheckedChange={() => toggle(cat)} />
          <span className="text-sm">{cat}</span>
        </label>
      ))}
    </div>
  )
}

// ─── FAQ Item Component ─────────────────────────────────────────────
interface FAQItem {
  question: string
  answer: string
}

function FAQEditor({ faqs, onChange }: { faqs: FAQItem[]; onChange: (faqs: FAQItem[]) => void }) {
  function updateFaq(idx: number, field: 'question' | 'answer', value: string) {
    const updated = [...faqs]
    updated[idx] = { ...updated[idx], [field]: value }
    onChange(updated)
  }

  function addFaq() {
    onChange([...faqs, { question: '', answer: '' }])
  }

  function removeFaq(idx: number) {
    onChange(faqs.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-3">
      {faqs.map((faq, idx) => (
        <div key={idx} className="rounded-lg border p-3 space-y-2">
          <div className="flex items-start gap-2">
            <div className="flex-1 space-y-2">
              <Input
                placeholder="Question"
                value={faq.question}
                onChange={(e) => updateFaq(idx, 'question', e.target.value)}
              />
              <Textarea
                placeholder="Answer"
                value={faq.answer}
                onChange={(e) => updateFaq(idx, 'answer', e.target.value)}
                rows={2}
              />
            </div>
            <Button type="button" variant="ghost" size="icon" onClick={() => removeFaq(idx)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addFaq}>
        <Plus className="mr-1 h-4 w-4" />Add FAQ
      </Button>
    </div>
  )
}

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
    { id: "paste", title: "Paste source material", description: "Paste a supplier email, flyer text or a link; AI extracts only the facts it finds and builds a draft for you to review", icon: ClipboardPaste },
    { id: "interview", title: "AI Interview", description: "Answer questions and let AI help create the package", icon: Sparkles },
    { id: "manual", title: "Add Manually", description: "Fill out all fields yourself in a form", icon: Pencil },
    { id: "scrape", title: "Scrape URL", description: "Enter a URL and extract package details automatically", icon: Globe },
    { id: "upload", title: "Upload CSV", description: "Bulk import packages from a CSV file (save your spreadsheet as CSV first)", icon: FileSpreadsheet },
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

// ─── Trip Journal Editor ─────────────────────────────────────────────
// Dated traveler updates ("where we went, what happened") - roadmap use case 6aed9806. Admin
// types these by hand; no AI button here, deliberately - this is a first-person account of a
// real day, not marketing copy the AI tools are grounded to write.
interface JournalEntryForm { date: string; title: string; body: string }

function JournalEditor({ entries, onChange }: { entries: JournalEntryForm[]; onChange: (entries: JournalEntryForm[]) => void }) {
  function update(idx: number, field: keyof JournalEntryForm, value: string) {
    const updated = [...entries]
    updated[idx] = { ...updated[idx], [field]: value }
    onChange(updated)
  }
  function add() {
    onChange([...entries, { date: "", title: "", body: "" }])
  }
  function remove(idx: number) {
    onChange(entries.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-3">
      {entries.map((entry, idx) => (
        <div key={idx} className="rounded-lg border p-3 space-y-2">
          <div className="flex items-start gap-2">
            <div className="flex-1 space-y-2">
              <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
                <Input type="date" value={entry.date} onChange={(e) => update(idx, "date", e.target.value)} />
                <Input placeholder="Entry title (e.g. Day 3: Arrived in Split)" value={entry.title} onChange={(e) => update(idx, "title", e.target.value)} />
              </div>
              <Textarea placeholder="What happened this day..." value={entry.body} onChange={(e) => update(idx, "body", e.target.value)} rows={3} />
            </div>
            <Button type="button" variant="ghost" size="icon" onClick={() => remove(idx)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus className="mr-1 h-4 w-4" />Add journal entry
      </Button>
    </div>
  )
}

// ─── Paste Source Material (AI draft builder) ───────────────────────
// Roadmap use case 09dd2acd. The server (lib/package-extract.ts) only keeps facts it can find
// in the pasted text; anything else lands in "dropped" with a reason, and the admin finishes the
// draft in the normal form. Nothing is saved until they press Save there, always as a draft.
const FIELD_LABELS: Record<string, string> = {
  name: "Package name", destination: "Destination", country: "Country", region: "Region", supplier: "Supplier",
  duration: "Duration", duration_days: "Days", price_display: "Price", price_value: "Price (number)", currency: "Currency",
  available_from: "Starts", available_to: "Ends", departure_dates: "Departure dates", highlights: "Highlights",
  price_includes: "Included", not_included: "Not included", max_people: "Max people", booking_url: "Booking link",
  more_info_url: "More info link", category: "Category", short_description: "Short description",
  full_description: "Full description", meta_title: "SEO title", meta_description: "SEO description", keywords: "Keywords",
}
const REQUIRED_FOR_SAVE = ["name", "destination", "duration", "price_display"]

interface ExtractResponse {
  draft: { fields: Record<string, unknown>; evidence: Record<string, string>; missing: string[]; dropped: { field: string; value: string; reason: string }[]; model: string }
  formData: Record<string, unknown>
  source: { chars: number; fetched: boolean; url: string | null }
}

function PasteSourceForm({ onDraft, onCancel }: { onDraft: (formData: Record<string, unknown>) => void; onCancel: () => void }) {
  const [text, setText] = useState("")
  const [url, setUrl] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState<ExtractResponse | null>(null)

  async function handleExtract() {
    if (!text.trim() && !url.trim()) { setError("Paste some source material, or give a link."); return }
    setLoading(true); setError(""); setResult(null)
    try {
      const token = localStorage.getItem("adminToken")
      const res = await fetch("/api/admin/packages/extract-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text, url: url.trim() || undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error || `Extraction failed (HTTP ${res.status})`); return }
      setResult(data as ExtractResponse)
    } catch {
      setError("Network error while extracting")
    } finally {
      setLoading(false)
    }
  }

  const fieldEntries = result ? Object.entries(result.draft.fields).filter(([, v]) => v != null && v !== "") : []
  const missingRequired = result ? REQUIRED_FOR_SAVE.filter((f) => result.draft.fields[f] == null || result.draft.fields[f] === "") : []
  const fmt = (v: unknown) => (Array.isArray(v) ? v.join(" · ") : String(v))

  return (
    <Card className="mx-auto max-w-4xl">
      <CardHeader>
        <CardTitle>Paste source material</CardTitle>
        <CardDescription>
          A supplier email, a flyer's text, a post, a brochure page. The AI copies out only the facts it can find; it never fills in a
          price, date or detail the source doesn't state. You review everything in the form before saving, and it saves as a draft.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Source text</Label>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} placeholder="Paste the trip details here..." disabled={loading} />
          <p className="text-xs text-muted-foreground">{text.length.toLocaleString()} characters</p>
        </div>
        <div className="space-y-2">
          <Label>Or a public link (used only when the text box is empty)</Label>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://supplier.example.com/trip" disabled={loading} />
          <p className="text-xs text-muted-foreground">Facebook and Instagram posts need a login to read, so copy their text into the box above instead.</p>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button type="button" onClick={handleExtract} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
            {loading ? "Extracting (up to a minute)..." : result ? "Extract again" : "Extract a draft"}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>Cancel</Button>
        </div>

        {result && (
          <div className="space-y-4 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">What the AI found ({fieldEntries.length} fields)</h3>
              <p className="text-xs text-muted-foreground">
                {result.source.fetched ? `Read ${result.source.chars.toLocaleString()} characters from the link` : `${result.source.chars.toLocaleString()} characters of pasted text`} · {result.draft.model}
              </p>
            </div>

            {fieldEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing usable was found. If this came from a link, the page probably needed a login; copy its text and paste it instead.</p>
            ) : (
              <div className="divide-y rounded-md border">
                {fieldEntries.map(([field, value]) => (
                  <div key={field} className="grid gap-1 p-3 text-sm sm:grid-cols-[160px_1fr]">
                    <div className="font-medium">{FIELD_LABELS[field] || field}</div>
                    <div>
                      <div className="whitespace-pre-wrap break-words">{fmt(value)}</div>
                      {result.draft.evidence[field] && (
                        <div className="mt-1 text-xs text-muted-foreground">Source: &ldquo;{result.draft.evidence[field]}&rdquo;</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {result.draft.dropped.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/40">
                <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" />Removed because the source doesn't back it up</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {result.draft.dropped.map((d, i) => (
                    <li key={i}><span className="font-medium">{FIELD_LABELS[d.field] || d.field}:</span> &ldquo;{d.value.length > 140 ? d.value.slice(0, 140) + "…" : d.value}&rdquo; <span className="text-muted-foreground">({d.reason})</span></li>
                  ))}
                </ul>
              </div>
            )}

            {result.draft.missing.length > 0 && (
              <div className="text-sm">
                <p className="font-medium">Not in the source (fill in yourself if you know it):</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {result.draft.missing.map((f) => (
                    <Badge key={f} variant={REQUIRED_FOR_SAVE.includes(f) ? "destructive" : "secondary"}>{FIELD_LABELS[f] || f}{REQUIRED_FOR_SAVE.includes(f) ? " (required)" : ""}</Badge>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" onClick={() => onDraft(result.formData)} disabled={fieldEntries.length === 0}>
                <ChevronRight className="mr-1 h-4 w-4" />Review in the form
              </Button>
              {missingRequired.length > 0 && (
                <p className="text-xs text-muted-foreground">You'll need to type in: {missingRequired.map((f) => FIELD_LABELS[f]).join(", ")}. The photo is picked up automatically (Pexels) when you save.</p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Manual Form Component ──────────────────────────────────────────
function ManualForm({ onComplete, onCancel, initialData }: { onComplete: (data: any) => void; onCancel: () => void; initialData?: Partial<DbPackage> }) {
  const [formData, setFormData] = useState<Record<string, any>>(() => {
    const data: Record<string, any> = { ...initialData } || {}
    // Ensure categories is an array
    if (typeof data.category === 'string') {
      data.categories = data.category ? [data.category] : []
    } else if (Array.isArray(data.categories)) {
      // already good
    } else {
      data.categories = []
    }
    // Parse FAQs
    if (data.ai_faqs && typeof data.ai_faqs === 'object') {
      data.faqs = data.ai_faqs
    } else {
      data.faqs = []
    }
    // Parse journal entries
    data.journal = Array.isArray(data.journal_entries) ? data.journal_entries : []
    return data
  })
  const [saving, setSaving] = useState(false)
  const [generatingField, setGeneratingField] = useState<string | null>(null)
  const [generatingFaqs, setGeneratingFaqs] = useState(false)
  const galleryFileInputRef = useRef<HTMLInputElement>(null)
  const [uploadingGalleryPhoto, setUploadingGalleryPhoto] = useState(false)
  const [generatingVariants, setGeneratingVariants] = useState(false)
  const [generatingAiImage, setGeneratingAiImage] = useState(false)
  const [variantsError, setVariantsError] = useState<string | null>(null)
  const [photoCredit, setPhotoCredit] = useState<{ photographer: string; photographerUrl: string } | null>(null)

  function handleChange(field: string, value: any) {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  // Image format pipeline: smart-crops the source image (or, if there is none, a real Pexels
  // photo of the destination) into every shape the site and social media need. Only callable
  // once the package has an id — a brand-new, unsaved package has nothing yet to attach the
  // generated images to.
  async function handleGenerateImageVariants() {
    if (!initialData?.id) {
      setVariantsError('Save the package first, then generate formats.')
      return
    }
    setGeneratingVariants(true)
    setVariantsError(null)
    setPhotoCredit(null)
    try {
      const token = localStorage.getItem('adminToken')
      const res = await fetch(`/api/admin/packages/${initialData.id}/generate-image-variants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sourceUrl: formData.image_url || undefined }),
      })
      const data = await res.json()
      if (!res.ok) {
        setVariantsError(data.error || 'Could not generate image formats')
        return
      }
      handleChange('image_url', data.package.image_url)
      handleChange('image_url_square', data.package.image_url_square)
      handleChange('image_url_portrait', data.package.image_url_portrait)
      handleChange('image_url_banner', data.package.image_url_banner)
      handleChange('image_source', data.package.image_source)
      if (data.photoCredit) setPhotoCredit(data.photoCredit)
    } catch (err) {
      setVariantsError('Could not generate image formats')
    } finally {
      setGeneratingVariants(false)
    }
  }

  // Real per-image cost (OpenAI) — a deliberate, separate action, never an automatic fallback
  // when Pexels comes up empty. Only for a package with no real photo and no Pexels match.
  async function handleGenerateAiImage() {
    if (!initialData?.id) {
      setVariantsError('Save the package first, then generate an AI image.')
      return
    }
    if (!confirm('Generate an AI illustration for this package? This calls OpenAI and costs real money per image. Use this only when there is no real photo and Pexels has no match.')) return
    setGeneratingAiImage(true)
    setVariantsError(null)
    setPhotoCredit(null)
    try {
      const token = localStorage.getItem('adminToken')
      const res = await fetch(`/api/admin/packages/${initialData.id}/generate-image-variants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ useAi: true }),
      })
      const data = await res.json()
      if (!res.ok) {
        setVariantsError(data.error || 'Could not generate an AI image')
        return
      }
      handleChange('image_url', data.package.image_url)
      handleChange('image_url_square', data.package.image_url_square)
      handleChange('image_url_portrait', data.package.image_url_portrait)
      handleChange('image_url_banner', data.package.image_url_banner)
      handleChange('image_source', data.package.image_source)
    } catch (err) {
      setVariantsError('Could not generate an AI image')
    } finally {
      setGeneratingAiImage(false)
    }
  }

  async function handleUploadGalleryPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    setUploadingGalleryPhoto(true)
    try {
      const token = localStorage.getItem("adminToken")
      const body = new FormData()
      body.append("file", file)
      const res = await fetch("/api/admin/upload-image", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Upload failed")
      const existing = Array.isArray(formData.gallery_urls) ? formData.gallery_urls.join("\n") : formData.gallery_urls || ""
      handleChange("gallery_urls", existing ? `${existing}\n${data.url}` : data.url)
    } catch (err) {
      alert(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setUploadingGalleryPhoto(false)
    }
  }

  async function handleGenerateField(field: string) {
    setGeneratingField(field)
    try {
      const token = localStorage.getItem('adminToken')
      const res = await fetch('/api/admin/generate-field', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          field,
          name: formData.name || '',
          destination: formData.destination || '',
          duration: formData.duration || '',
          price_display: formData.price_display || '',
          supplier: formData.supplier || '',
          short_description: formData.short_description || '',
          full_description: formData.full_description || '',
          highlights: formData.highlights || '',
          price_includes: formData.price_includes || '',
          not_included: formData.not_included || '',
          categories: formData.categories || [],
        }),
      })
      const data = await res.json()
      if (res.ok && data.value) {
        handleChange(field, data.value)
      } else {
        alert(data.error || 'AI generation failed')
      }
    } catch (err) {
      alert('Failed to generate content')
    } finally {
      setGeneratingField(null)
    }
  }

  async function handleGenerateFaqs() {
    setGeneratingFaqs(true)
    try {
      const token = localStorage.getItem('adminToken')
      const res = await fetch('/api/admin/generate-faqs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          package_id: formData.id || '',
          name: formData.name || '',
          destination: formData.destination || '',
          duration: formData.duration || '',
          price_display: formData.price_display || '',
          short_description: formData.short_description || '',
          full_description: formData.full_description || '',
          highlights: formData.highlights || '',
          price_includes: formData.price_includes || '',
          not_included: formData.not_included || '',
          min_people: formData.min_people ?? '',
          max_people: formData.max_people ?? '',
        }),
      })
      const data = await res.json()
      if (res.ok && data.faqs) {
        handleChange('faqs', data.faqs)
        if (data.notice) alert(data.notice)
      } else {
        alert(data.error || 'FAQ generation failed')
      }
    } catch (err) {
      alert('Failed to generate FAQs')
    } finally {
      setGeneratingFaqs(false)
    }
  }

  function handleExportFaqs() {
    const faqs = formData.faqs || []
    if (faqs.length === 0) {
      alert('No FAQs to export')
      return
    }

    // Create markdown content
    let content = `# FAQ: ${formData.name || 'Travel Package'}\n\n`
    content += `**Destination:** ${formData.destination || 'N/A'}\n`
    content += `**Duration:** ${formData.duration || 'N/A'}\n`
    content += `**Price:** ${formData.price_display || 'N/A'}\n\n`
    content += `---\n\n`

    faqs.forEach((faq: FAQItem, idx: number) => {
      content += `## Q${idx + 1}: ${faq.question}\n\n`
      content += `${faq.answer}\n\n`
    })

    // Download as file
    const blob = new Blob([content], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `faq-${(formData.name || 'package').toLowerCase().replace(/\s+/g, '-')}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const data = { ...formData }
    
    // Convert highlights to array
    if (data.highlights && typeof data.highlights === "string") {
      data.highlights = data.highlights.split("\n").filter((h: string) => h.trim())
    }

    // Convert gallery URLs to array
    if (typeof data.gallery_urls === "string") {
      data.gallery_urls = data.gallery_urls.split("\n").map((u: string) => u.trim()).filter(Boolean)
    }
    
    // Convert categories array to single category (for DB compatibility)
    if (Array.isArray(data.categories) && data.categories.length > 0) {
      data.category = data.categories[0] // Primary category
      data.tags = data.categories // Store all as tags
    }
    
    // Store FAQs in ai_faqs field
    if (data.faqs) {
      data.ai_faqs = data.faqs
    }

    // Store journal entries, sorted by date and dropping any still-blank rows, in journal_entries
    if (Array.isArray(data.journal)) {
      data.journal_entries = data.journal
        .filter((e: JournalEntryForm) => e.date && e.title.trim())
        .sort((a: JournalEntryForm, b: JournalEntryForm) => a.date.localeCompare(b.date))
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
        <CardTitle>{initialData?.id ? "Edit Package" : initialData ? "Review the AI draft" : "Add Package Manually"}</CardTitle>
        <CardDescription>{initialData && !initialData.id ? "Everything below came from your source material or is blank. Check it, fill the blanks, then save; it stays a draft until you publish it." : "Fill out the package details below"}</CardDescription>
      </CardHeader>

      {/* Thumbnail card */}
      <div className="px-6 pb-4">
        <div className="rounded-lg border bg-card/50 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Current Thumbnail</h3>
            <p className="text-xs text-muted-foreground">From source</p>
          </div>
          <div className="mt-3 flex items-center gap-4">
            {formData.image_url ? (
              <img src={formData.image_url} alt="thumbnail" className="h-28 w-44 rounded object-cover border" />
            ) : (
              <div className="h-28 w-44 rounded bg-muted flex items-center justify-center text-xs text-muted-foreground">No image</div>
            )}
            <div className="flex-1 text-sm text-muted-foreground">
              <p className="font-medium">Source image</p>
              <p className="truncate text-xs">{formData.image_url || 'No image URL'}</p>
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-lg border bg-card/50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium">Image formats (horizontal / square / portrait / banner)</h3>
              <p className="text-xs text-muted-foreground">
                Smart-crops the source image above into every shape the site and social posts need, instead of stretching one photo into all of
                them. No source image yet? This looks up a real photo of the destination on Pexels instead.
              </p>
            </div>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={handleGenerateImageVariants} disabled={generatingVariants}>
                {generatingVariants ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
                {generatingVariants ? "Generating..." : "Generate formats"}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={handleGenerateAiImage} disabled={generatingAiImage} title="Real per-image cost via OpenAI — only for a package with no real photo and no Pexels match">
                {generatingAiImage ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Wand2 className="mr-1 h-4 w-4" />}
                {generatingAiImage ? "Generating..." : "Generate AI image ($)"}
              </Button>
            </div>
          </div>
          {variantsError && <p className="mt-2 text-xs text-destructive">{variantsError}</p>}
          {photoCredit && (
            <p className="mt-2 text-xs text-muted-foreground">
              Photo via Pexels, by{" "}
              <a href={photoCredit.photographerUrl} target="_blank" rel="noreferrer" className="underline">{photoCredit.photographer}</a>.
            </p>
          )}
          {formData.image_source && (
            <p className="mt-2 text-xs text-muted-foreground">
              Current image source: <Badge variant={formData.image_source === "ai_generated" ? "destructive" : "secondary"}>{formData.image_source.replace("_", " ")}</Badge>
              {formData.image_source === "ai_generated" && " — an illustration, not a real photo of this destination."}
            </p>
          )}
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { key: "image_url", label: "Horizontal" },
              { key: "image_url_square", label: "Square" },
              { key: "image_url_portrait", label: "Portrait" },
              { key: "image_url_banner", label: "Banner" },
            ].map(({ key, label }) => (
              <div key={key} className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">{label}</p>
                {formData[key] ? (
                  <img src={formData[key]} alt={label} className="h-20 w-full rounded border object-cover" />
                ) : (
                  <div className="flex h-20 w-full items-center justify-center rounded border bg-muted text-[10px] text-muted-foreground">Not generated</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Info */}
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
            <div className="space-y-2 sm:col-span-2">
              <Label>Categories *</Label>
              <CategoryMultiSelect value={formData.categories || []} onChange={(v) => handleChange("categories", v)} />
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
              <div className="flex items-center justify-between">
                <Label>Keywords (comma-separated)</Label>
                <AIFieldButton onClick={() => handleGenerateField('keywords')} loading={generatingField === 'keywords'} />
              </div>
              <Input value={formData.keywords || ""} onChange={(e) => handleChange("keywords", e.target.value)} />
            </div>
          </div>

          {/* Short Description */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Short Description *</Label>
              <AIFieldButton onClick={() => handleGenerateField('short_description')} loading={generatingField === 'short_description'} />
            </div>
            <Textarea value={formData.short_description || ""} onChange={(e) => handleChange("short_description", e.target.value)} rows={2} required />
          </div>

          {/* Full Description */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Full Description</Label>
              <AIFieldButton onClick={() => handleGenerateField('full_description')} loading={generatingField === 'full_description'} />
            </div>
            <Textarea value={formData.full_description || ""} onChange={(e) => handleChange("full_description", e.target.value)} rows={4} />
          </div>

          {/* Highlights */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Highlights (one per line)</Label>
              <AIFieldButton onClick={() => handleGenerateField('highlights')} loading={generatingField === 'highlights'} />
            </div>
            <Textarea value={Array.isArray(formData.highlights) ? formData.highlights.join("\n") : formData.highlights || ""} onChange={(e) => handleChange("highlights", e.target.value)} rows={4} />
          </div>

          {/* What's Included */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>What's Included</Label>
              <AIFieldButton onClick={() => handleGenerateField('price_includes')} loading={generatingField === 'price_includes'} />
            </div>
            <Textarea value={formData.price_includes || ""} onChange={(e) => handleChange("price_includes", e.target.value)} rows={3} />
          </div>

          {/* Not Included */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Not Included</Label>
              <AIFieldButton onClick={() => handleGenerateField('not_included')} loading={generatingField === 'not_included'} />
            </div>
            <Textarea value={formData.not_included || ""} onChange={(e) => handleChange("not_included", e.target.value)} rows={3} placeholder="e.g., Flights, Travel insurance, Personal expenses..." />
          </div>

          {/* Recap gallery & video */}
          <div className="rounded-lg border p-4 space-y-4">
            <div>
              <h3 className="font-medium">Recap photos &amp; video</h3>
              <p className="text-sm text-muted-foreground">Shown on the public page once this trip's dates are in the past (the recap layout switches automatically).</p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Gallery photo URLs (one per line)</Label>
                <div>
                  <input ref={galleryFileInputRef} type="file" accept="image/*" className="hidden" onChange={handleUploadGalleryPhoto} />
                  <Button type="button" size="sm" variant="outline" onClick={() => galleryFileInputRef.current?.click()} disabled={uploadingGalleryPhoto}>
                    {uploadingGalleryPhoto ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1 h-3.5 w-3.5" />}
                    Upload a photo
                  </Button>
                </div>
              </div>
              <Textarea
                value={Array.isArray(formData.gallery_urls) ? formData.gallery_urls.join("\n") : formData.gallery_urls || ""}
                onChange={(e) => handleChange("gallery_urls", e.target.value)}
                rows={4}
                placeholder="https://.../photo1.jpg&#10;https://.../photo2.jpg"
              />
            </div>
            <div className="space-y-2">
              <Label>Video URL</Label>
              <Input value={formData.video_url || ""} onChange={(e) => handleChange("video_url", e.target.value)} placeholder="YouTube, Vimeo, or a direct video file link" />
            </div>
          </div>

          {/* SEO */}
          <div className="rounded-lg border p-4 space-y-4">
            <div>
              <h3 className="font-medium">Search & sharing</h3>
              <p className="text-sm text-muted-foreground">How this trip's page appears in Google and when the link is shared. Leave blank to use the name and short description.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <div className="flex items-center justify-between">
                  <Label>Page title (meta title)</Label>
                  <AIFieldButton onClick={() => handleGenerateField('meta_title')} loading={generatingField === 'meta_title'} />
                </div>
                <Input value={formData.meta_title || ""} onChange={(e) => handleChange("meta_title", e.target.value)} maxLength={70} placeholder={`${formData.name || "Trip name"} | ${formData.destination || "Destination"} | TravelFunBiz.ca`} />
                <p className="text-xs text-muted-foreground">{(formData.meta_title || "").length}/70 · put the target phrase first</p>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <div className="flex items-center justify-between">
                  <Label>Meta description</Label>
                  <AIFieldButton onClick={() => handleGenerateField('meta_description')} loading={generatingField === 'meta_description'} />
                </div>
                <Textarea value={formData.meta_description || ""} onChange={(e) => handleChange("meta_description", e.target.value)} rows={2} maxLength={160} />
                <p className="text-xs text-muted-foreground">{(formData.meta_description || "").length}/160</p>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Share image URL (OG image)</Label>
                <Input value={formData.og_image_url || ""} onChange={(e) => handleChange("og_image_url", e.target.value)} placeholder="Defaults to the package image" />
              </div>
            </div>
          </div>

          {/* FAQ Section */}
          <div className="rounded-lg border p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">Frequently Asked Questions</h3>
                <p className="text-sm text-muted-foreground">Common questions and answers about this package</p>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={handleExportFaqs} disabled={(formData.faqs || []).length === 0}>
                  <Download className="mr-1 h-4 w-4" />Export FAQ
                </Button>
                <Button type="button" size="sm" onClick={handleGenerateFaqs} disabled={generatingFaqs}>
                  <Wand2 className="mr-1 h-4 w-4" />
                  {generatingFaqs ? 'Generating...' : 'Generate FAQs'}
                </Button>
              </div>
            </div>
            <FAQEditor faqs={formData.faqs || []} onChange={(faqs) => handleChange('faqs', faqs)} />
          </div>

          {/* Trip Journal Section */}
          <div className="rounded-lg border p-4 space-y-4">
            <div>
              <h3 className="font-medium">Trip Journal</h3>
              <p className="text-sm text-muted-foreground">Dated updates from the trip (where you went, what happened) that show up as a timeline on the package page. Written by hand - no AI button, this is your account of a real day.</p>
            </div>
            <JournalEditor entries={formData.journal || []} onChange={(journal) => handleChange('journal', journal)} />
          </div>

          {/* Submit */}
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
const presetSites = [
  { name: "TravelFunBiz", url: "https://travelfunbiz.com" },
  { name: "Best Single Travel - Cruises", url: "https://www.bestsingletravel.com/single-cruises.html" },
  { name: "WestJet - Last Minute", url: "https://www.westjetvacations.com/en/packages/last-minute-vacations" },
  { name: "Exoticca - Last Minute Tours", url: "https://www.exoticca.com/us/landing/last-minute-tours" },
  { name: "Collette - Deals", url: "https://www.gocollette.com/en-us/deals" },
  { name: "Sunwing - Last Minute", url: "https://www.sunwing.ca/en/promotion/packages/last-minute-vacations" },
  { name: "WestJet - All Inclusive", url: "https://www.westjetvacations.com/en/packages/vacation-packages#all-inclusive" },
  { name: "Transat - All Inclusive", url: "https://www.transat.com/en-CA/book/type-accomodation/all-inclusive-vacation?search=package" },
]

function ScrapeUrlForm({ onComplete, onCancel, onImported, existingSlugs }: { onComplete: (data: any) => void; onCancel: () => void; onImported: () => void; existingSlugs: Set<string> }) {
  const [url, setUrl] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [packages, setPackages] = useState<ScrapedPackage[]>([])
  const [importedSlugs, setImportedSlugs] = useState<Set<string>>(new Set())
  const isImported = (pkg: ScrapedPackage) => {
    const slug = generateSlug(pkg.name)
    return existingSlugs.has(slug) || importedSlugs.has(slug)
  }
  const [adapter, setAdapter] = useState<string | null>(null)
  const [selectedPreset, setSelectedPreset] = useState<string>("")
  const [status, setStatus] = useState<string>("")
  const [selectedIndexes, setSelectedIndexes] = useState<Set<number>>(new Set())
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{done:number;total:number}>({done:0,total:0})

  function handlePresetChange(value: string) {
    setSelectedPreset(value)
    const preset = presetSites.find(p => p.url === value)
    if (preset) {
      setUrl(preset.url)
      setError("")
      setStatus("")
    }
  }

  async function handleScrape() {
    if (!url.trim()) {
      setError("Please enter a URL to scrape")
      return
    }
    
    setLoading(true)
    setError("")
    setPackages([])
    setAdapter(null)
    setStatus("Connecting to scraping service...")

    const token = localStorage.getItem("adminToken")
    if (!token) {
      setError("You must be logged in as admin to scrape.")
      setLoading(false)
      setStatus("")
      return
    }

    try {
      setStatus("Fetching page content (this may take 10-30 seconds)...")
      
      const res = await fetch("/api/admin/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url: url.trim() }),
      })

      setStatus("Processing response...")
      const result = await res.json()

      if (!res.ok) {
        setError(result.error || "Failed to scrape URL")
        setStatus("")
        return
      }

      setPackages(result.packages || [])
      setAdapter(result.adapter || null)
      setStatus(result.packages?.length > 0 
        ? `Found ${result.packages.length} package(s)!` 
        : "No packages found on this page.")
    } catch (err) {
      setError("Network error — please try again.")
      setStatus("")
    } finally {
      setLoading(false)
    }
  }

  function handleUseData(pkg: ScrapedPackage) {
    onComplete(scrapedToPayload(pkg))
  }

  function toggleSelect(idx: number) {
    setSelectedIndexes((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  function selectAll() {
    setSelectedIndexes(new Set(packages.map((pkg, i) => (isImported(pkg) ? -1 : i)).filter((i) => i >= 0)))
  }

  function clearSelection() {
    setSelectedIndexes(new Set())
  }

  async function handleImportSelected() {
    if (selectedIndexes.size === 0) return
    const token = localStorage.getItem('adminToken')
    if (!token) {
      setError('You must be logged in as admin.')
      return
    }

    const selectedList = Array.from(selectedIndexes).map(i => packages[i])
    setImporting(true)
    setError("")
    setImportProgress({ done: 0, total: selectedList.length })

    // One bad package must not abort the batch; import the rest and report each failure by name.
    const failures: string[] = []
    for (const pkg of selectedList) {
      try {
        const res = await fetch('/api/admin/packages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(scrapedToPayload(pkg)),
        })
        if (res.ok) {
          setImportedSlugs((prev) => new Set(prev).add(generateSlug(pkg.name)))
        } else {
          const data = await res.json().catch(() => ({}))
          failures.push(`${pkg.name}: ${data.error || `HTTP ${res.status}`}`)
        }
      } catch {
        failures.push(`${pkg.name}: network error`)
      }
      setImportProgress((p) => ({ ...p, done: p.done + 1 }))
    }

    const imported = selectedList.length - failures.length
    setImporting(false)
    setSelectedIndexes(new Set())
    setStatus(`Imported ${imported} of ${selectedList.length} package(s) as drafts.`)
    if (failures.length > 0) setError(`Not imported:\n${failures.join('\n')}`)
    // Refresh the list whenever anything landed; only leave this screen when nothing failed,
    // so the failure list stays readable.
    if (imported > 0) onImported()
    if (imported > 0 && failures.length === 0) onCancel()
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
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Quick Select (Optional)</Label>
            <Select value={selectedPreset} onValueChange={handlePresetChange}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a preset site..." />
              </SelectTrigger>
              <SelectContent>
                {presetSites.map((site) => (
                  <SelectItem key={site.url} value={site.url}>
                    {site.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

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
            
            {status && !error && (
              <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300">
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                <span>{status}</span>
              </div>
            )}
            
            {adapter && <p className="text-xs text-muted-foreground">✓ Parser: {adapter}</p>}
            {error && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                <p className="font-medium">Error:</p>
                <p className="mt-1 whitespace-pre-line">{error}</p>
              </div>
            )}
          </div>
        </div>

        {packages.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-lg font-semibold">Select packages to import</h4>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-green-600">Found {packages.length}</Badge>
                <Button variant="outline" size="sm" onClick={selectAll}>Select All</Button>
                <Button variant="outline" size="sm" onClick={clearSelection}>Clear</Button>
                <Button onClick={handleImportSelected} disabled={importing || selectedIndexes.size === 0}>
                  {importing ? `Importing ${importProgress.done}/${importProgress.total}` : 'Import Selected'}
                </Button>
              </div>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {packages.map((pkg, idx) => (
                <Card key={idx} className={isImported(pkg) ? "border-muted opacity-60" : "border-primary/20"}>
                  <CardHeader className="pb-3 flex flex-row items-start gap-3">
                    <Checkbox checked={selectedIndexes.has(idx)} onCheckedChange={() => toggleSelect(idx)} className="mt-1" disabled={isImported(pkg)} />
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="text-base">{pkg.name || `Package ${idx + 1}`}</CardTitle>
                        {isImported(pkg) && <Badge variant="secondary" className="text-[10px]">Already imported</Badge>}
                        {!pkg.destination && <Badge variant="outline" className="text-[10px] text-destructive">Needs destination</Badge>}
                      </div>
                      {pkg.destination && <p className="text-xs text-muted-foreground">{pkg.destination}{pkg.category ? ` · ${pkg.category}` : ''}</p>}
                      {(pkg.startDate || pkg.endDate) && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {pkg.startDate && `Start: ${pkg.startDate}`}
                          {pkg.startDate && pkg.endDate && ' | '}
                          {pkg.endDate && `End: ${pkg.endDate}`}
                        </p>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex gap-3">
                      {pkg.imageUrl ? (
                        <img src={pkg.imageUrl} alt={pkg.name} className="h-24 w-32 rounded object-cover" />
                      ) : (
                        <div className="h-24 w-32 rounded bg-muted flex items-center justify-center text-xs">No image</div>
                      )}
                      <div className="text-sm text-muted-foreground">
                        {pkg.duration && <p><span className="font-medium">Duration:</span> {pkg.duration}</p>}
                        {pkg.price && <p><span className="font-medium">Price:</span> {pkg.price}</p>}
                      </div>
                    </div>
                    {pkg.description && <p className="text-sm text-muted-foreground line-clamp-2">{pkg.description}</p>}
                    <div className="flex justify-end">
                      <Button size="sm" onClick={() => handleUseData(pkg)} disabled={isImported(pkg)}>
                        <Check className="mr-1 h-4 w-4" />Import
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
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
// Real CSV bulk import (roadmap 6989b62b). Was previously a fake spinner + "coming soon" alert.
// Scoped to CSV, not .xlsx/.xls - see lib/import-csv.ts's header comment for why. Parses the file
// entirely client-side (lib/import-csv.ts), shows every row with its errors before anything is
// sent anywhere, and imports selected rows the same way ScrapeUrlForm does: one POST per package
// through the existing create endpoint, so image lookup and validation stay identical either way.
function UploadExcelForm({ onComplete, onCancel, onImported, existingSlugs }: { onComplete: (data: any) => void; onCancel: () => void; onImported: () => void; existingSlugs: Set<string> }) {
  const [fileName, setFileName] = useState<string | null>(null)
  const [rows, setRows] = useState<CsvRow[]>([])
  const [unknownHeaders, setUnknownHeaders] = useState<string[]>([])
  const [error, setError] = useState("")
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [importedSlugs, setImportedSlugs] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 })
  const [status, setStatus] = useState("")

  function isImported(row: CsvRow) {
    const slug = generateSlug(String(row.data.name || ""))
    return existingSlugs.has(slug) || importedSlugs.has(slug)
  }

  function handleDownloadTemplate() {
    const blob = new Blob([csvTemplate()], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "package-import-template.csv"
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    setFileName(file.name)
    setError("")
    setRows([])
    setSelected(new Set())
    const text = await file.text()
    const result = parsePackagesCsv(text)
    if (result.error) {
      setError(result.error)
      return
    }
    setRows(result.rows)
    setUnknownHeaders(result.unknownHeaders)
    setSelected(new Set(result.rows.filter((r) => r.errors.length === 0).map((r) => r.rowNumber)))
  }

  function toggle(rowNumber: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(rowNumber)) next.delete(rowNumber)
      else next.add(rowNumber)
      return next
    })
  }

  async function handleImportSelected() {
    const token = localStorage.getItem("adminToken")
    if (!token) { setError("You must be logged in as admin."); return }
    const toImport = rows.filter((r) => selected.has(r.rowNumber) && r.errors.length === 0)
    if (toImport.length === 0) return

    setImporting(true)
    setImportProgress({ done: 0, total: toImport.length })
    const failures: string[] = []
    for (const row of toImport) {
      try {
        const res = await fetch("/api/admin/packages", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ ...row.data, status: "draft" }),
        })
        if (res.ok) {
          setImportedSlugs((prev) => new Set(prev).add(generateSlug(String(row.data.name))))
        } else {
          const data = await res.json().catch(() => ({}))
          failures.push(`Row ${row.rowNumber} (${row.data.name}): ${data.error || `HTTP ${res.status}`}`)
        }
      } catch {
        failures.push(`Row ${row.rowNumber} (${row.data.name}): network error`)
      }
      setImportProgress((p) => ({ ...p, done: p.done + 1 }))
    }
    const imported = toImport.length - failures.length
    setImporting(false)
    setSelected(new Set())
    setStatus(`Imported ${imported} of ${toImport.length} package(s) as drafts.`)
    if (failures.length > 0) setError(`Not imported:\n${failures.join("\n")}`)
    if (imported > 0) onImported()
    if (imported > 0 && failures.length === 0) onCancel()
  }

  const validCount = rows.filter((r) => r.errors.length === 0).length

  return (
    <Card className="mx-auto max-w-4xl">
      <CardHeader>
        <CardTitle>Bulk import packages from a CSV</CardTitle>
        <CardDescription>
          Not an Excel file directly - in Excel, Numbers or Google Sheets, use "Save as" / "Export" and pick CSV first. Every row is checked before
          anything is imported, and everything imports as a draft.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input type="file" accept=".csv,text/csv" onChange={handleFile} className="max-w-xs" />
          <Button type="button" variant="outline" size="sm" onClick={handleDownloadTemplate}>
            <Download className="mr-1 h-4 w-4" />Download CSV template
          </Button>
          {fileName && <span className="text-sm text-muted-foreground">{fileName}</span>}
        </div>

        {error && <div className="whitespace-pre-line rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        {status && !error && <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300">{status}</div>}
        {unknownHeaders.length > 0 && (
          <p className="text-xs text-muted-foreground">Ignored unrecognized column(s): {unknownHeaders.join(", ")}. Download the template to see the exact column names.</p>
        )}

        {rows.length > 0 && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-semibold">
                {rows.length} row(s) read, {validCount} ready to import{validCount < rows.length ? `, ${rows.length - validCount} with errors` : ""}
              </h4>
              <Button type="button" onClick={handleImportSelected} disabled={importing || selected.size === 0}>
                {importing ? `Importing ${importProgress.done}/${importProgress.total}...` : `Import ${selected.size} selected`}
              </Button>
            </div>
            <div className="max-h-[28rem] overflow-y-auto rounded-lg border divide-y">
              {rows.map((row) => (
                <div key={row.rowNumber} className={`flex items-start gap-3 p-3 text-sm ${isImported(row) ? "opacity-60" : ""}`}>
                  <Checkbox checked={selected.has(row.rowNumber)} onCheckedChange={() => toggle(row.rowNumber)} disabled={row.errors.length > 0 || isImported(row)} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">Row {row.rowNumber}: {String(row.data.name || "(no name)")}</span>
                      {isImported(row) && <Badge variant="secondary">Already imported</Badge>}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{String(row.data.destination ?? "")} · {String(row.data.duration ?? "")} · {String(row.data.price_display ?? "")}</p>
                    {row.errors.length > 0 && <p className="mt-1 text-xs text-destructive">{row.errors.join("; ")}</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Package Table Component ────────────────────────────────────────
function PackageTable({
  packages, sortField, sortDir, onSort, onEdit, onDelete, onToggleStatus, onToggleFeatured, onAIAction, selectedIds, onSelectToggle, onSelectAll,
}: {
  packages: DbPackage[]; sortField: SortField; sortDir: SortDir; onSort: (field: SortField) => void; onEdit: (pkg: DbPackage) => void; onDelete: (id: string) => void; onToggleStatus: (pkg: DbPackage) => void; onToggleFeatured: (pkg: DbPackage) => void; onAIAction: (action: string, pkg: DbPackage) => void; selectedIds: Set<string>; onSelectToggle: (id: string) => void; onSelectAll: () => void
}) {
  const columns: { key: SortField; label: string }[] = [
    { key: "name", label: "Package" },
    { key: "available_from", label: "Start" },
    { key: "duration_days", label: "Length" },
    { key: "supplier", label: "Supplier" },
    { key: "destination", label: "Destination" },
    { key: "price_value", label: "Price" },
    { key: "status", label: "Status" },
    { key: "completeness", label: "Page" },
  ]

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr>
            <th className="w-10 p-3"><Checkbox checked={selectedIds.size === packages.length && packages.length > 0} onCheckedChange={onSelectAll} /></th>
            <th className="w-16 p-3 text-left text-xs font-medium uppercase">Thumb</th>
            {columns.map((col) => (
              <th key={col.key} className="p-3 text-left text-xs font-medium uppercase">
                <button onClick={() => onSort(col.key)} className="flex items-center hover:text-foreground">
                  {col.label}
                  {sortField === col.key ? (sortDir === "asc" ? <ArrowUp className="ml-1 h-3 w-3" /> : <ArrowDown className="ml-1 h-3 w-3" />) : <ArrowUpDown className="ml-1 h-3 w-3 opacity-50" />}
                </button>
              </th>
            ))}
            <th className="w-20 p-3 text-right text-xs font-medium uppercase">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {packages.map((pkg) => (
            <tr key={pkg.id} className="hover:bg-muted/30">
              <td className="p-3"><Checkbox checked={selectedIds.has(pkg.id)} onCheckedChange={() => onSelectToggle(pkg.id)} /></td>
              <td className="p-3">
                <div className="h-10 w-14 overflow-hidden rounded bg-muted">
                  {pkg.image_url ? <img src={pkg.image_url} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-[8px]">No img</div>}
                </div>
              </td>
              <td className="p-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{pkg.name}</span>
                  {pkg.featured && <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />}
                </div>
              </td>
              <td className="p-3 text-xs">{pkg.available_from || "—"}</td>
              <td className="p-3 text-xs">{pkg.duration_days ? `${pkg.duration_days}d` : pkg.duration || "—"}</td>
              <td className="p-3 text-xs">{pkg.supplier || "—"}</td>
              <td className="p-3 text-xs">{pkg.destination}</td>
              <td className="p-3 text-xs font-medium">{pkg.price_display}</td>
              <td className="p-3"><Badge variant={pkg.status === "published" ? "default" : "secondary"} className="text-[10px]">{pkg.status}</Badge></td>
              <td className="p-3">
                {(() => {
                  const c = completenessScore(pkg)
                  const tone = c.thin ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200" : c.score < 80 ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200" : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                  return (
                    <button type="button" onClick={() => onEdit(pkg)} title={c.reasons.length ? `Missing: ${c.reasons.join("; ")}. Click to add details.` : "Complete. Click to open."} className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
                      {c.thin ? "Thin " : ""}{c.score}
                    </button>
                  )
                })()}
              </td>
              <td className="p-3 text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onEdit(pkg)}><Pencil className="mr-2 h-4 w-4" />Edit</DropdownMenuItem>
                    <DropdownMenuItem disabled={pkg.status !== "published"} onClick={() => window.open(`/packages/${pkg.slug}`, "_blank", "noopener,noreferrer")}>
                      <ExternalLink className="mr-2 h-4 w-4" />{pkg.status === "published" ? "View page" : "View page (publish first)"}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onToggleStatus(pkg)}>{pkg.status === "published" ? <EyeOff className="mr-2 h-4 w-4" /> : <Eye className="mr-2 h-4 w-4" />}{pkg.status === "published" ? "Unpublish" : "Publish"}</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onToggleFeatured(pkg)}><Star className="mr-2 h-4 w-4" />{pkg.featured ? "Unfeature" : "Feature"}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => onDelete(pkg.id)} className="text-destructive"><Trash2 className="mr-2 h-4 w-4" />Delete</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {packages.length === 0 && <div className="py-12 text-center text-muted-foreground">No packages found</div>}
    </div>
  )
}

// ─── Main Packages Admin Page ───────────────────────────────────────
export default function PackagesAdminPage() {
  const [packages, setPackages] = useState<DbPackage[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<"list" | "interview" | "manual" | "scrape" | "upload" | "paste">("list")
  const [editingPackage, setEditingPackage] = useState<DbPackage | null>(null)
  // Prefill for a NEW package coming out of the paste-source AI draft builder (never an existing row).
  const [seedData, setSeedData] = useState<Partial<DbPackage> | null>(null)
  const [saving, setSaving] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  // Thin trip pages first by default (lowest completeness score on top); every column header still sorts.
  const [sortField, setSortField] = useState<SortField>("completeness")
  const [sortDir, setSortDir] = useState<SortDir>("asc")
  // Bumped whenever the Add details card changes the trip, so the form below reloads with the new values
  // instead of saving the old ones back over them.
  const [formKey, setFormKey] = useState(0)
  const openedFromLink = useRef(false)
  const [filterText, setFilterText] = useState("")
  const [filterStatus, setFilterStatus] = useState<string>("all")
  const [filterCategory, setFilterCategory] = useState<string>("all")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkActionLoading, setBulkActionLoading] = useState(false)
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<{ found?: number; created?: string[]; skipped?: string[]; failed?: { name: string; error: string }[]; error?: string } | null>(null)

  useEffect(() => {
    fetchPackages()
  }, [])

  async function handleSync() {
    setSyncing(true)
    try {
      const res = await fetch("/api/admin/sync/travelfunbiz", { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem("adminToken")}` } })
      const data = await res.json().catch(() => ({}))
      setSyncResult(res.ok ? data : { error: data.error || `HTTP ${res.status}` })
      if (res.ok && data.created?.length) fetchPackages()
    } catch {
      setSyncResult({ error: "Network error while syncing" })
    } finally {
      setSyncing(false)
    }
  }

  async function fetchPackages() {
    const token = localStorage.getItem("adminToken")
    try {
      const res = await fetch("/api/admin/packages", { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      setPackages(data.packages || [])
      // A link such as /admin/packages?edit=<id> (from a Needs attention item) opens that trip's editor, once.
      if (!openedFromLink.current) {
        openedFromLink.current = true
        const wanted = new URLSearchParams(window.location.search).get("edit")
        const target = wanted ? (data.packages || []).find((p: DbPackage) => p.id === wanted) : null
        if (target) { setEditingPackage(target); setView("manual") }
      }
    } catch (error) {
      console.error("Failed to fetch packages:", error)
    } finally {
      setLoading(false)
    }
  }

  // After the Add details card changes the trip: load the saved row, refresh the list, and reload the form.
  async function reloadEditing(id: string) {
    const token = localStorage.getItem("adminToken")
    try {
      const res = await fetch(`/api/admin/packages/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (res.ok && data.package) { setEditingPackage(data.package); setFormKey((k) => k + 1) }
    } catch (error) {
      console.error("Failed to reload package:", error)
    }
    fetchPackages()
  }

  const filteredPackages = useMemo(() => {
    let result = [...packages]
    if (filterText) {
      const lower = filterText.toLowerCase()
      result = result.filter((p) => p.name.toLowerCase().includes(lower) || p.destination.toLowerCase().includes(lower) || (p.supplier || "").toLowerCase().includes(lower))
    }
    if (filterStatus !== "all") result = result.filter((p) => p.status === filterStatus)
    if (filterCategory !== "all") result = result.filter((p) => p.category === filterCategory)
    result.sort((a, b) => {
      let aVal: any = sortField === "completeness" ? completenessScore(a).score : a[sortField]
      let bVal: any = sortField === "completeness" ? completenessScore(b).score : b[sortField]
      if (aVal == null) aVal = ""; if (bVal == null) bVal = ""
      if (typeof aVal === "string") aVal = aVal.toLowerCase()
      if (typeof bVal === "string") bVal = bVal.toLowerCase()
      if (aVal < bVal) return sortDir === "asc" ? -1 : 1
      if (aVal > bVal) return sortDir === "asc" ? 1 : -1
      return 0
    })
    return result
  }, [packages, filterText, filterStatus, filterCategory, sortField, sortDir])

  function handleSort(field: SortField) {
    if (sortField === field) setSortDir(sortDir === "asc" ? "desc" : "asc")
    else { setSortField(field); setSortDir("asc") }
  }

  async function handleCreatePackage(data: any) {
    setSaving(true)
    const token = localStorage.getItem("adminToken")
    try {
      const res = await fetch("/api/admin/packages", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...data, status: "draft" }) })
      if (res.ok) { setView("list"); setSeedData(null); fetchPackages() }
      else { const body = await res.json().catch(() => ({})); alert(body.error || `Failed to create package (HTTP ${res.status})`) }
    } catch (error) { console.error("Failed to create package:", error); alert("Network error while creating package") }
    finally { setSaving(false) }
  }

  async function handleUpdatePackage(data: any) {
    if (!editingPackage) return
    setSaving(true)
    const token = localStorage.getItem("adminToken")
    try {
      const res = await fetch(`/api/admin/packages/${editingPackage.id}`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(data) })
      if (res.ok) { setView("list"); setEditingPackage(null); fetchPackages() }
    } catch (error) { console.error("Failed to update package:", error) }
    finally { setSaving(false) }
  }

  async function handleToggleStatus(pkg: DbPackage) {
    const token = localStorage.getItem("adminToken")
    const newStatus = pkg.status === "published" ? "draft" : "published"
    try { await fetch(`/api/admin/packages/${pkg.id}`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ status: newStatus }) }); fetchPackages() }
    catch (error) { console.error("Failed to update package:", error) }
  }

  async function handleToggleFeatured(pkg: DbPackage) {
    const token = localStorage.getItem("adminToken")
    try { await fetch(`/api/admin/packages/${pkg.id}`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ featured: !pkg.featured }) }); fetchPackages() }
    catch (error) { console.error("Failed to update package:", error) }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this package?")) return
    const token = localStorage.getItem("adminToken")
    try { await fetch(`/api/admin/packages/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); fetchPackages() }
    catch (error) { console.error("Failed to delete package:", error) }
  }

  // ─── Bulk Actions ───────────────────────────────────────────────
  async function handleBulkPublish() {
    const token = localStorage.getItem("adminToken")
    setBulkActionLoading(true)
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          fetch(`/api/admin/packages/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ status: "published" }) })
        )
      )
      setSelectedIds(new Set())
      fetchPackages()
    } catch (error) { console.error("Bulk publish failed:", error) }
    finally { setBulkActionLoading(false) }
  }

  async function handleBulkFeature() {
    const token = localStorage.getItem("adminToken")
    setBulkActionLoading(true)
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          fetch(`/api/admin/packages/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ featured: true }) })
        )
      )
      setSelectedIds(new Set())
      fetchPackages()
    } catch (error) { console.error("Bulk feature failed:", error) }
    finally { setBulkActionLoading(false) }
  }

  async function handleBulkDelete() {
    const token = localStorage.getItem("adminToken")
    setBulkActionLoading(true)
    setShowBulkDeleteConfirm(false)
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          fetch(`/api/admin/packages/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } })
        )
      )
      setSelectedIds(new Set())
      fetchPackages()
    } catch (error) { console.error("Bulk delete failed:", error) }
    finally { setBulkActionLoading(false) }
  }

  function handleBulkEdit() {
    const firstId = Array.from(selectedIds)[0]
    const pkg = packages.find((p) => p.id === firstId)
    if (pkg) { setEditingPackage(pkg); setView("manual") }
  }

  function handleEdit(pkg: DbPackage) { setEditingPackage(pkg); setView("manual") }
  function handleAIAction(action: string, pkg: DbPackage) { alert(`AI ${action} for "${pkg.name}" coming soon!`) }
  function handleSelectToggle(id: string) { setSelectedIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next }) }
  function handleSelectAll() { if (selectedIds.size === filteredPackages.length) setSelectedIds(new Set()); else setSelectedIds(new Set(filteredPackages.map((p) => p.id))) }
  function handleAddMethodSelect(method: string) { setShowAddModal(false); setEditingPackage(null); setSeedData(null); setView(method as any) }

  if (view === "interview") return <div className="p-6"><AIInterview onComplete={handleCreatePackage} onCancel={() => setView("list")} /></div>
  if (view === "paste") return <div className="p-6"><PasteSourceForm onDraft={(data) => { setSeedData(data as Partial<DbPackage>); setEditingPackage(null); setView("manual") }} onCancel={() => setView("list")} /></div>
  if (view === "manual") return <div className="p-6">{editingPackage && <div id="add-details"><PackageSourcesPanel packageId={editingPackage.id} onChanged={() => reloadEditing(editingPackage.id)} /></div>}<ManualForm key={formKey} onComplete={editingPackage ? handleUpdatePackage : handleCreatePackage} onCancel={() => { setView("list"); setEditingPackage(null); setSeedData(null) }} initialData={editingPackage || seedData || undefined} /></div>
  if (view === "scrape") return <div className="p-6"><ScrapeUrlForm onComplete={handleCreatePackage} onCancel={() => setView("list")} onImported={fetchPackages} existingSlugs={new Set(packages.map((p) => p.slug))} /></div>
  if (view === "upload") return <div className="p-6"><UploadExcelForm onComplete={handleCreatePackage} onCancel={() => setView("list")} onImported={fetchPackages} existingSlugs={new Set(packages.map((p) => p.slug))} /></div>

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <h1 className="text-xl font-bold">Travel Packages</h1>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={handleSync} disabled={syncing} title="Import any new trips from travelfunbiz.com as drafts">
              {syncing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
              {syncing ? "Syncing…" : "Sync from TravelFunBiz.com"}
            </Button>
            <Button onClick={() => setShowAddModal(true)}><Plus className="mr-1 h-4 w-4" />Add Package</Button>
          </div>
        </div>
      </div>

      <div className="border-b bg-card/30">
        <div className="container mx-auto flex flex-wrap items-center gap-3 px-4 py-3">
          <Input placeholder="Search packages..." value={filterText} onChange={(e) => setFilterText(e.target.value)} className="max-w-xs" />
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

          {/* Bulk Actions — shown when items are selected */}
          {selectedIds.size > 0 && (
            <>
              <div className="h-6 w-px bg-border" />
              <span className="text-sm font-medium text-muted-foreground">
                {selectedIds.size} selected
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleBulkEdit}
                disabled={bulkActionLoading}
                title="Edit first selected package"
              >
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleBulkPublish}
                disabled={bulkActionLoading}
                className="border-green-500/50 text-green-600 hover:bg-green-50 hover:text-green-700 dark:hover:bg-green-950"
              >
                {bulkActionLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Eye className="mr-1.5 h-3.5 w-3.5" />}
                Publish
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleBulkFeature}
                disabled={bulkActionLoading}
                className="border-yellow-500/50 text-yellow-600 hover:bg-yellow-50 hover:text-yellow-700 dark:hover:bg-yellow-950"
              >
                {bulkActionLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Star className="mr-1.5 h-3.5 w-3.5" />}
                Feature
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowBulkDeleteConfirm(true)}
                disabled={bulkActionLoading}
                className="border-destructive/50 text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete
              </Button>
            </>
          )}
        </div>
      </div>

      <main className="container mx-auto px-4 py-6">
        {loading ? <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div> : (
          <PackageTable packages={filteredPackages} sortField={sortField} sortDir={sortDir} onSort={handleSort} onEdit={handleEdit} onDelete={handleDelete} onToggleStatus={handleToggleStatus} onToggleFeatured={handleToggleFeatured} onAIAction={handleAIAction} selectedIds={selectedIds} onSelectToggle={handleSelectToggle} onSelectAll={handleSelectAll} />
        )}
      </main>

      <AddMethodModal open={showAddModal} onClose={() => setShowAddModal(false)} onSelect={handleAddMethodSelect} />

      {/* Sync summary */}
      <Dialog open={!!syncResult} onOpenChange={(open) => !open && setSyncResult(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{syncResult?.error ? "Sync failed" : "Sync from TravelFunBiz.com"}</DialogTitle>
            <DialogDescription>
              {syncResult?.error
                ? syncResult.error
                : `Found ${syncResult?.found ?? 0} trip(s) on travelfunbiz.com. New trips are imported as drafts; publish them from the list when ready.`}
            </DialogDescription>
          </DialogHeader>
          {!syncResult?.error && (
            <div className="space-y-3 text-sm">
              <div>
                <p className="font-medium text-green-700 dark:text-green-400">Imported ({syncResult?.created?.length ?? 0})</p>
                {syncResult?.created?.length ? <ul className="ml-4 list-disc text-muted-foreground">{syncResult.created.map((n) => <li key={n}>{n}</li>)}</ul> : <p className="text-muted-foreground">Nothing new.</p>}
              </div>
              {!!syncResult?.skipped?.length && (
                <div>
                  <p className="font-medium">Already here ({syncResult.skipped.length})</p>
                  <p className="text-muted-foreground">{syncResult.skipped.join(" · ")}</p>
                </div>
              )}
              {!!syncResult?.failed?.length && (
                <div>
                  <p className="font-medium text-destructive">Not imported ({syncResult.failed.length})</p>
                  <ul className="ml-4 list-disc text-muted-foreground">{syncResult.failed.map((f) => <li key={f.name}>{f.name}: {f.error}</li>)}</ul>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setSyncResult(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation Dialog */}
      <Dialog open={showBulkDeleteConfirm} onOpenChange={setShowBulkDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selectedIds.size} package{selectedIds.size !== 1 ? "s" : ""}?</DialogTitle>
            <DialogDescription>
              This will permanently delete {selectedIds.size} selected package{selectedIds.size !== 1 ? "s" : ""}. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkDeleteConfirm(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleBulkDelete}>
              <Trash2 className="mr-1.5 h-4 w-4" />
              Delete {selectedIds.size} package{selectedIds.size !== 1 ? "s" : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}