"use client"

import { useEffect, useMemo, useRef } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useForm, Controller } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { Loader2 } from "lucide-react"
import { contactFormSchema, type ContactFormValues } from "@/lib/schemas/contact"
import { samplePackages } from "@/content/packages"
import { getAttribution } from "@/lib/attribution"
import { track } from "@/lib/analytics-client"
import { trackConversion } from "@/lib/conversion-events"
import { aboutLine, cleanTopic } from "@/lib/conversion"
import { formErrorMessage, submitPackage } from "@/lib/form-errors"
import type { Language } from "@/lib/preferences"
import { translate } from "@/lib/i18n"

interface ContactFormProps {
  preselectedPackage?: string
  packageOptions?: string[]
  language: Language
  /** The site phone (site.phone), shown in the rate-limit and network error messages. */
  phone?: string | null
  /** "callback": the lead is a request for a callback from a live agent. The note is added to the message; attribution is unchanged. */
  intent?: "callback"
}

const travelerOptions = [
  { value: "1", label: "1 Person" },
  { value: "2", label: "2 People" },
  { value: "3-4", label: "3-4 People" },
  { value: "5-8", label: "5-8 People" },
  { value: "9+", label: "9+ People" },
]

export function ContactForm({ preselectedPackage, packageOptions, language, phone, intent }: ContactFormProps) {
  const { toast } = useToast()
  const searchParams = useSearchParams()
  const router = useRouter()
  const started = useRef(false)

  const fallbackPackageOptions = useMemo(
    () => Array.from(new Set(samplePackages.map((pkg) => pkg.name))),
    [],
  )

  const packageFromQuery = searchParams?.get("package") || undefined
  // Conversion loop: a guide or blog post links here with ?package=...&about=... so the lead arrives with context.
  const aboutFromQuery = cleanTopic(searchParams?.get("about"))

  const availablePackages = useMemo(() => {
    const source = packageOptions?.length ? packageOptions : fallbackPackageOptions
    const unique = new Set(source.filter(Boolean))
    unique.add("Custom Package")
    // A trip named in the link must be a choice in the list, or the dropdown would show blank instead of it.
    if (packageFromQuery) unique.add(packageFromQuery)
    return Array.from(unique)
  }, [packageOptions, fallbackPackageOptions, packageFromQuery])

  const baseDefaultValues = useMemo<ContactFormValues>(
    () => ({
      name: "",
      email: "",
      phone: "",
      package: packageFromQuery || preselectedPackage || "",
      travelDate: "",
      travelers: "",
      message: aboutLine(aboutFromQuery),
      company_website: "",
    }),
    [packageFromQuery, preselectedPackage, aboutFromQuery],
  )

  const {
    control,
    handleSubmit,
    register,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ContactFormValues>({
    resolver: zodResolver(contactFormSchema),
    defaultValues: baseDefaultValues,
  })

  useEffect(() => {
    reset(baseDefaultValues)
  }, [baseDefaultValues, reset])

  async function onSubmit(values: ContactFormValues) {
    const packageName = submitPackage(values.package)
    let failureStatus: number | null = null
    try {
      const response = await fetch("/api/submit-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, ...(intent === "callback" ? { message: `[Callback requested] ${values.message ?? ""}`.trim() } : {}), package: packageName, submittedAt: new Date().toISOString(), attribution: getAttribution() }),
      })

      if (!response.ok) {
        failureStatus = response.status
        throw new Error("Failed to submit form")
      }

      track("generate_lead", { package_name: packageName, page_path: window.location.pathname, method: "contact_form" })
      trackConversion("form_submit", { form_id: "contact_form" })
      reset(baseDefaultValues)
      // One URL for every conversion, so GA4 and ad platforms can count it without custom events.
      router.push(`/thank-you?package=${encodeURIComponent(packageName)}`)
    } catch (error) {
      toast({
        title: translate(language, "Error"),
        description: formErrorMessage(failureStatus, phone),
        variant: "destructive",
      })
    }
  }

  return (
    <Card className="mx-auto max-w-2xl">
      <CardHeader>
        <CardTitle className="text-2xl">{translate(language, 'Plan Your Perfect Trip')}</CardTitle>
        <CardDescription>
          {translate(language, 'Fill out the form below and our travel experts will contact you shortly.')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit(onSubmit)}
          onFocusCapture={() => {
            if (started.current) return
            started.current = true
            trackConversion("form_start", { form_id: "contact_form" })
          }}
          className="space-y-6"
        >
          {/* Honeypot: invisible to a real visitor, filled in by form-filling bots. */}
          <div className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
            <Label htmlFor="company_website">Company Website</Label>
            <Input id="company_website" tabIndex={-1} autoComplete="off" {...register("company_website")} />
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">
                {translate(language, 'Full Name')} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="name"
                placeholder="John Doe"
                autoComplete="name"
                aria-invalid={!!errors.name}
                {...register("name")}
              />
              {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">
                {translate(language, 'Email Address')} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="john@example.com"
                autoComplete="email"
                aria-invalid={!!errors.email}
                {...register("email")}
              />
              {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
            </div>
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="phone">{translate(language, 'Phone Number')}</Label>
              <Input
                id="phone"
                type="tel"
                placeholder="+1 (555) 000-0000"
                autoComplete="tel"
                {...register("phone")}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="package">
                {translate(language, 'Interested Package')}
              </Label>
              <Controller
                control={control}
                name="package"
                render={({ field }) => (
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger id="package" aria-invalid={!!errors.package}>
                      <SelectValue placeholder={translate(language, 'Select a package')} />
                    </SelectTrigger>
                    <SelectContent>
                      {availablePackages.map((option) => (
                        <SelectItem key={option} value={option}>
                          {translate(language, option)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.package && <p className="text-sm text-destructive">{errors.package.message}</p>}
            </div>
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="travelDate">{translate(language, 'Preferred Travel Date')}</Label>
              <Input id="travelDate" type="date" {...register("travelDate")} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="travelers">{translate(language, 'Number of Travelers')}</Label>
              <Controller
                control={control}
                name="travelers"
                render={({ field }) => (
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger id="travelers">
                      <SelectValue placeholder={translate(language, 'Select number')} />
                    </SelectTrigger>
                    <SelectContent>
                      {travelerOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {translate(language, option.label)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="message">{translate(language, 'Additional Information')}</Label>
            <Textarea
              id="message"
              placeholder={translate(
                language,
                'Tell us about your travel preferences, special requirements, or any questions you have...',
              )}
              rows={5}
              {...register("message")}
            />
          </div>

          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting ? translate(language, 'Submitting...') : translate(language, 'Submit Inquiry')}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            {translate(language, 'By submitting this form, you agree to our privacy policy and terms of service.')}
          </p>
        </form>
      </CardContent>
    </Card>
  )
}