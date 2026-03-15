"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ArrowLeft, Plus, Pencil, Trash2, Eye, EyeOff, Star, Sparkles,
  ChevronRight, Check, Loader2
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

// ─── AI Interview Questions ─────────────────────────────────────────
const interviewQuestions = [
  {
    id: "destination",
    question: "Where is this trip going?",
    placeholder: "e.g., Cancun, Mexico or Caribbean Cruise",
    field: "destination",
    required: true,
  },
  {
    id: "name",
    question: "What should we call this package?",
    placeholder: "e.g., Luxury Cancun All-Inclusive Escape",
    field: "name",
    required: true,
  },
  {
    id: "duration",
    question: "How long is the trip?",
    placeholder: "e.g., 7 Days / 6 Nights",
    field: "duration",
    required: true,
  },
  {
    id: "price",
    question: "What's the price?",
    placeholder: "e.g., From $2,499 per person",
    field: "price_display",
    required: true,
  },
  {
    id: "category",
    question: "What category best describes this trip?",
    field: "category",
    type: "select",
    options: categories,
    required: true,
  },
  {
    id: "description",
    question: "Give a short description for the package card (1-2 sentences)",
    placeholder: "e.g., Experience the ultimate beach getaway with all-inclusive dining, pristine beaches, and world-class amenities.",
    field: "short_description",
    type: "textarea",
    required: true,
  },
  {
    id: "highlights",
    question: "What are the main highlights? (one per line)",
    placeholder: "All-inclusive meals & drinks\nBeachfront resort\nDaily activities\nAirport transfers included",
    field: "highlights",
    type: "textarea",
    required: false,
  },
  {
    id: "image",
    question: "Do you have an image URL for this package?",
    placeholder: "https://example.com/image.jpg (or leave blank for placeholder)",
    field: "image_url",
    required: false,
  },
  {
    id: "booking_url",
    question: "Where should the 'Book Now' button link to?",
    placeholder: "https://booking-site.com/package-123",
    field: "booking_url",
    required: false,
  },
  {
    id: "supplier",
    question: "Who is the tour operator or supplier?",
    placeholder: "e.g., Sandals Resorts, Royal Caribbean, etc.",
    field: "supplier",
    required: false,
  },
]

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
      // Process answers and create package data
      const packageData: any = {}
      for (const q of interviewQuestions) {
        const value = newAnswers[q.field]
        if (q.field === "highlights" && value) {
          packageData.highlights = value.split("\n").filter((h: string) => h.trim())
        } else if (value) {
          packageData[q.field] = value
        }
      }
      // Extract numeric price value
      const priceMatch = packageData.price_display?.match(/[\d,]+/)
      if (priceMatch) {
        packageData.price_value = parseFloat(priceMatch[0].replace(/,/g, ""))
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
          Answer a few questions and we'll set up your package. Step {currentStep + 1} of {interviewQuestions.length}
        </CardDescription>
        {/* Progress bar */}
        <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <Label className="text-lg font-medium">{question.question}</Label>
          
          {question.type === "select" ? (
            <Select value={currentAnswer} onValueChange={setCurrentAnswer}>
              <SelectTrigger>
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                {question.options?.map((opt) => (
                  <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : question.type === "textarea" ? (
            <Textarea
              value={currentAnswer}
              onChange={(e) => setCurrentAnswer(e.target.value)}
              placeholder={question.placeholder}
              rows={4}
              className="resize-none"
            />
          ) : (
            <Input
              value={currentAnswer}
              onChange={(e) => setCurrentAnswer(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={question.placeholder}
              autoFocus
            />
          )}
        </div>

        <div className="flex items-center justify-between pt-4">
          <div className="flex gap-2">
            {currentStep > 0 && (
              <Button variant="outline" onClick={handleBack}>
                Back
              </Button>
            )}
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
          <Button onClick={handleNext} disabled={question.required && !currentAnswer.trim()}>
            {isLastQuestion ? (
              <>
                <Check className="mr-1 h-4 w-4" />
                Create Package
              </>
            ) : (
              <>
                Next
                <ChevronRight className="ml-1 h-4 w-4" />
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Package List Component ─────────────────────────────────────────
function PackageList({
  packages,
  onEdit,
  onDelete,
  onToggleStatus,
  loading,
}: {
  packages: DbPackage[]
  onEdit: (pkg: DbPackage) => void
  onDelete: (id: string) => void
  onToggleStatus: (pkg: DbPackage) => void
  loading: boolean
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (packages.length === 0) {
    return (
      <Card className="py-12 text-center">
        <CardContent>
          <p className="text-muted-foreground">No packages yet. Create your first one!</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {packages.map((pkg) => (
        <Card key={pkg.id} className="overflow-hidden">
          <div className="flex items-center gap-4 p-4">
            {/* Image */}
            <div className="h-16 w-24 flex-shrink-0 overflow-hidden rounded-md bg-muted">
              {pkg.image_url ? (
                <img src={pkg.image_url} alt={pkg.name} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  No image
                </div>
              )}
            </div>

            {/* Info */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="truncate font-medium">{pkg.name}</h3>
                <Badge variant={pkg.status === "published" ? "default" : "secondary"}>
                  {pkg.status}
                </Badge>
                {pkg.featured && (
                  <Badge variant="outline" className="border-yellow-500 text-yellow-600">
                    <Star className="mr-1 h-3 w-3" />
                    Featured
                  </Badge>
                )}
              </div>
              <p className="mt-1 truncate text-sm text-muted-foreground">
                {pkg.destination} · {pkg.duration} · {pkg.price_display}
              </p>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onToggleStatus(pkg)}
                title={pkg.status === "published" ? "Unpublish" : "Publish"}
              >
                {pkg.status === "published" ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
              <Button variant="ghost" size="icon" onClick={() => onEdit(pkg)}>
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onDelete(pkg.id)}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  )
}

// ─── Main Packages Admin Page ───────────────────────────────────────
export default function PackagesAdminPage() {
  const router = useRouter()
  const [packages, setPackages] = useState<DbPackage[]>([])
  const [loading, setLoading] = useState(true)
  const [showInterview, setShowInterview] = useState(false)
  const [saving, setSaving] = useState(false)

  async function fetchPackages() {
    const token = localStorage.getItem("adminToken")
    if (!token) {
      router.push("/admin")
      return
    }

    try {
      const res = await fetch("/api/admin/packages", {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      setPackages(data.packages || [])
    } catch (error) {
      console.error("Failed to fetch packages:", error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPackages()
  }, [])

  async function handleCreatePackage(data: any) {
    setSaving(true)
    const token = localStorage.getItem("adminToken")

    try {
      const res = await fetch("/api/admin/packages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...data,
          status: "draft",
        }),
      })

      if (res.ok) {
        setShowInterview(false)
        fetchPackages()
      }
    } catch (error) {
      console.error("Failed to create package:", error)
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
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: newStatus }),
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
      await fetch(`/api/admin/packages/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      })
      fetchPackages()
    } catch (error) {
      console.error("Failed to delete package:", error)
    }
  }

  function handleEdit(pkg: DbPackage) {
    // TODO: Implement edit modal/page
    alert("Edit functionality coming soon!")
  }

  if (showInterview) {
    return (
      <div className="min-h-screen bg-background p-6">
        <AIInterview
          onComplete={handleCreatePackage}
          onCancel={() => setShowInterview(false)}
        />
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
          <Button onClick={() => setShowInterview(true)}>
            <Plus className="mr-1 h-4 w-4" />
            Add Package
          </Button>
        </div>
      </header>

      {/* Content */}
      <main className="container mx-auto px-4 py-6">
        <div className="mb-6">
          <p className="text-muted-foreground">
            Manage your travel packages. Published packages appear on the website.
          </p>
        </div>

        <PackageList
          packages={packages}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onToggleStatus={handleToggleStatus}
          loading={loading}
        />
      </main>
    </div>
  )
}
