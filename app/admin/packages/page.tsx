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
  FileSpreadsheet, Link, Wand2, Image, FileText, Share2, X, Download
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
    return data
  })
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [aiImageUrl, setAiImageUrl] = useState<string | null>(null)
  const [generatingField, setGeneratingField] = useState<string | null>(null)
  const [generatingFaqs, setGeneratingFaqs] = useState(false)

  function handleChange(field: string, value: any) {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  async function handleGenerateAIThumbnail() {
    const payload = {
      name: formData.name || '',
      destination: formData.destination || '',
      short_description: formData.short_description || '',
      highlights: Array.isArray(formData.highlights) ? formData.highlights : (typeof formData.highlights === 'string' ? formData.highlights.split('\n') : []),
    }

    setGenerating(true)
    try {
      const token = localStorage.getItem('adminToken')
      const res = await fetch('/api/admin/generate-thumbnail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (res.ok && data.url) {
        setAiImageUrl(data.url)
        handleChange('image_url', data.url)
      } else {
        alert(data.error || 'AI generation failed')
      }
    } catch (err) {
      alert('Failed to generate AI thumbnail')
    } finally {
      setGenerating(false)
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
          short_description: formData.short_description || '',
          highlights: formData.highlights || '',
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
          name: formData.name || '',
          destination: formData.destination || '',
          duration: formData.duration || '',
          price_display: formData.price_display || '',
          short_description: formData.short_description || '',
          highlights: formData.highlights || '',
          price_includes: formData.price_includes || '',
          not_included: formData.not_included || '',
        }),
      })
      const data = await res.json()
      if (res.ok && data.faqs) {
        handleChange('faqs', data.faqs)
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
    
    // Convert categories array to single category (for DB compatibility)
    if (Array.isArray(data.categories) && data.categories.length > 0) {
      data.category = data.categories[0] // Primary category
      data.tags = data.categories // Store all as tags
    }
    
    // Store FAQs in ai_faqs field
    if (data.faqs) {
      data.ai_faqs = data.faqs
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

      {/* Thumbnail cards */}
      <div className="px-6 pb-4">
        <div className="grid grid-cols-2 gap-4">
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

          <div className="rounded-lg border bg-card/50 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">AI Thumbnail</h3>
              <p className="text-xs text-muted-foreground">Generate promotional image</p>
            </div>
            <div className="mt-3 flex items-center gap-4">
              {aiImageUrl ? (
                <img src={aiImageUrl} alt="ai-thumb" className="h-28 w-44 rounded object-cover border" />
              ) : (
                <div className="h-28 w-44 rounded bg-muted flex items-center justify-center text-xs text-muted-foreground">AI preview</div>
              )}
              <div className="flex-1">
                <Button size="sm" onClick={handleGenerateAIThumbnail} disabled={generating}>
                  <Wand2 className="mr-1 h-4 w-4" />
                  {generating ? 'Generating...' : 'Generate'}
                </Button>
              </div>
            </div>
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

function ScrapeUrlForm({ onComplete, onCancel, onImportedBatch }: { onComplete: (data: any) => void; onCancel: () => void; onImportedBatch?: () => void }) {
  const [url, setUrl] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [packages, setPackages] = useState<any[]>([])
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

  function handleUseData(pkg: any) {
    onComplete({
      name: pkg.name,
      destination: pkg.destination,
      duration: pkg.duration,
      available_from: pkg.startDate || '',
      available_to: pkg.endDate || '',
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

  function toggleSelect(idx: number) {
    setSelectedIndexes((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  function selectAll() {
    setSelectedIndexes(new Set(packages.map((_, i) => i)))
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
    setImportProgress({ done: 0, total: selectedList.length })

    try {
      for (let i = 0; i < selectedList.length; i++) {
        const pkg = selectedList[i]
        const payload = {
          name: pkg.name,
          destination: pkg.destination,
          duration: pkg.duration,
          available_from: pkg.startDate || '',
          available_to: pkg.endDate || '',
          price_display: pkg.price || pkg.price_display || 'From $1,000',
          price_value: pkg.priceValue,
          short_description: pkg.description,
          image_url: pkg.imageUrl,
          booking_url: pkg.bookingUrl,
          supplier: pkg.supplier,
          category: pkg.category || 'Adventure',
          highlights: pkg.highlights,
          status: 'draft',
        }

        const res = await fetch('/api/admin/packages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        })

        if (!res.ok) {
          throw new Error(`Failed to import package: ${res.status}`)
        }

        setImportProgress((p) => ({ ...p, done: p.done + 1 }))
      }

      setStatus(`Imported ${selectedList.length} package(s) successfully.`)
      if (onImportedBatch) onImportedBatch()
      else onCancel()
    } catch (err: any) {
      setError(err.message || 'Import failed')
    } finally {
      setImporting(false)
      setSelectedIndexes(new Set())
    }
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
                <p className="mt-1">{error}</p>
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
                <Card key={idx} className="border-primary/20">
                  <CardHeader className="pb-3 flex flex-row items-start gap-3">
                    <Checkbox checked={selectedIndexes.has(idx)} onCheckedChange={() => toggleSelect(idx)} className="mt-1" />
                    <div className="flex-1">
                      <CardTitle className="text-base">{pkg.name || `Package ${idx + 1}`}</CardTitle>
                      {pkg.destination && <p className="text-xs text-muted-foreground">{pkg.destination}</p>}
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
                      <Button size="sm" onClick={() => handleUseData(pkg)}>
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
function UploadExcelForm({ onComplete, onCancel }: { onComplete: (data: any) => void; onCancel: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleUpload() {
    if (!file) return
    setLoading(true)
    setTimeout(() => {
      setLoading(false)
      alert("Excel upload coming soon!")
      onCancel()
    }, 1500)
  }

  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <CardTitle>Bulk import packages</CardTitle>
        <CardDescription>Upload an Excel file with package data</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={handleUpload} disabled={loading || !file}>
            {loading ? "Uploading..." : "Upload & Import"}
          </Button>
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
              <td className="p-3 text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onEdit(pkg)}><Pencil className="mr-2 h-4 w-4" />Edit</DropdownMenuItem>
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
  const router = useRouter()
  const [packages, setPackages] = useState<DbPackage[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<"list" | "interview" | "manual" | "scrape" | "upload">("list")
  const [editingPackage, setEditingPackage] = useState<DbPackage | null>(null)
  const [saving, setSaving] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  const [sortField, setSortField] = useState<SortField>("created_at")
  const [sortDir, setSortDir] = useState<SortDir>("desc")
  const [filterText, setFilterText] = useState("")
  const [filterStatus, setFilterStatus] = useState<string>("all")
  const [filterCategory, setFilterCategory] = useState<string>("all")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkActionLoading, setBulkActionLoading] = useState(false)
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false)

  useEffect(() => {
    const token = localStorage.getItem("adminToken")
    if (!token) { router.push("/admin"); return }
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

  const filteredPackages = useMemo(() => {
    let result = [...packages]
    if (filterText) {
      const lower = filterText.toLowerCase()
      result = result.filter((p) => p.name.toLowerCase().includes(lower) || p.destination.toLowerCase().includes(lower) || (p.supplier || "").toLowerCase().includes(lower))
    }
    if (filterStatus !== "all") result = result.filter((p) => p.status === filterStatus)
    if (filterCategory !== "all") result = result.filter((p) => p.category === filterCategory)
    result.sort((a, b) => {
      let aVal: any = a[sortField]; let bVal: any = b[sortField]
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
      if (res.ok) { setView("list"); fetchPackages() }
    } catch (error) { console.error("Failed to create package:", error) }
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
  function handleAddMethodSelect(method: string) { setShowAddModal(false); setEditingPackage(null); setView(method as any) }

  if (view === "interview") return <div className="min-h-screen bg-background p-6"><AIInterview onComplete={handleCreatePackage} onCancel={() => setView("list")} /></div>
  if (view === "manual") return <div className="min-h-screen bg-background p-6"><ManualForm onComplete={editingPackage ? handleUpdatePackage : handleCreatePackage} onCancel={() => { setView("list"); setEditingPackage(null) }} initialData={editingPackage || undefined} /></div>
  if (view === "scrape") return <div className="min-h-screen bg-background p-6"><ScrapeUrlForm onComplete={handleCreatePackage} onCancel={() => setView("list")} onImportedBatch={() => { fetchPackages(); setView("list") }} /></div>
  if (view === "upload") return <div className="min-h-screen bg-background p-6"><UploadExcelForm onComplete={handleCreatePackage} onCancel={() => setView("list")} /></div>

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/50">
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => router.push("/admin")}><ArrowLeft className="h-4 w-4" /></Button>
            <div><p className="text-xs uppercase tracking-wider text-muted-foreground">Admin</p><h1 className="text-xl font-bold">Travel Packages</h1></div>
          </div>
          <Button onClick={() => setShowAddModal(true)}><Plus className="mr-1 h-4 w-4" />Add Package</Button>
        </div>
      </header>

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