"use client"

import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { useForm, Controller } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { Loader2, CheckCircle2 } from "lucide-react"
import { contactFormSchema, type ContactFormValues } from "@/lib/schemas/contact"
import { samplePackages } from "@/content/packages"
import type { Language } from "@/lib/preferences"
import { translate } from "@/lib/i18n"

interface ContactFormProps {
  preselectedPackage?: string
  packageOptions?: string[]
  language: Language
}

const travelerOptions = [
  { value: "1", label: "1 Person" },
  { value: "2", label: "2 People" },
  { value: "3-4", label: "3-4 People" },
  { value: "5-8", label: "5-8 People" },
  { value: "9+", label: "9+ People" },
]

export function ContactForm({ preselectedPackage, packageOptions, language }: ContactFormProps) {
  const { toast } = useToast()
  const searchParams = useSearchParams()
  const [isSuccess, setIsSuccess] = useState(false)

  const fallbackPackageOptions = useMemo(
    () => Array.from(new Set(samplePackages.map((pkg) => pkg.name))),
    [],
  )

  const availablePackages = useMemo(() => {
    const source = packageOptions?.length ? packageOptions : fallbackPackageOptions
    const unique = new Set(source.filter(Boolean))
    unique.add("Custom Package")
    return Array.from(unique)
  }, [packageOptions, fallbackPackageOptions])

  const packageFromQuery = searchParams?.get("package") || undefined

  const baseDefaultValues = useMemo<ContactFormValues>(
    () => ({
      name: "",
      email: "",
      phone: "",
      package: packageFromQuery || preselectedPackage || "",
      travelDate: "",
      travelers: "",
      message: "",
    }),
    [packageFromQuery, preselectedPackage],
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
    try {
      const response = await fetch("/api/submit-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, submittedAt: new Date().toISOString() }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || translate('Something went wrong. Please try again.', language))
      }

      setIsSuccess(true)
      toast({
        title: translate('Success!', language),
        description: translate("We've received your inquiry and will contact you soon.", language),
      })
      reset(baseDefaultValues)
    } catch (error) {
      toast({
        title: translate('Error', language),
        description:
          error instanceof Error ? error.message : translate('Something went wrong. Please try again.', language),
        variant: "destructive",
      })
    }
  }

  if (isSuccess) {
    return (
      <Card className="mx-auto max-w-2xl">
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <CheckCircle2 className="mb-4 h-16 w-16 text-green-600" />
          <h3 className="mb-2 text-2xl font-bold text-foreground">{translate('Thank You!', language)}</h3>
          <p className="text-muted-foreground">
            {translate(
              "We've received your travel inquiry. Our team will contact you within 24 hours to discuss your perfect trip.",
              language,
            )}
          </p>
          <Button onClick={() => setIsSuccess(false)} variant="outline" className="mt-6">
            {translate('Submit Another Inquiry', language)}
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="mx-auto max-w-2xl">
      <CardHeader>
        <CardTitle className="text-2xl">{translate('Plan Your Perfect Trip', language)}</CardTitle>
        <CardDescription>{translate('Fill out the form below and our travel experts will contact you shortly.', language)}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">
                {translate('Full Name', language)} <span className="text-destructive">*</span>
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
                {translate('Email', language)} <span className="text-destructive">*</span>
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
              <Label htmlFor="phone">{translate('Phone Number', language)}</Label>
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
                {translate('Interested Package', language)} <span className="text-destructive">*</span>
              </Label>
              <Controller
                control={control}
                name="package"
                render={({ field }) => (
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger id="package" aria-invalid={!!errors.package}>
                      <SelectValue placeholder={translate('Select a package', language)} />
                    </SelectTrigger>
                    <SelectContent>
                      {availablePackages.map((option) => (
                        <SelectItem key={option} value={option}>
                          {translate(option, language)}
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
              <Label htmlFor="travelDate">{translate('Preferred Travel Date', language)}</Label>
              <Input id="travelDate" type="date" {...register("travelDate")} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="travelers">{translate('Number of Travelers', language)}</Label>
              <Controller
                control={control}
                name="travelers"
                render={({ field }) => (
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger id="travelers">
                      <SelectValue placeholder={translate('Select number', language)} />
                    </SelectTrigger>
                    <SelectContent>
                      {travelerOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {translate(option.label, language)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="message">{translate('Additional Information', language)}</Label>
            <Textarea
              id="message"
              placeholder={translate('Tell us about your travel preferences, special requirements, or any questions you have...', language)}
              rows={5}
              {...register("message")}
            />
          </div>

          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting ? translate('Submitting...', language) : translate('Submit Inquiry', language)}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            {translate('By submitting this form, you agree to our privacy policy and terms of service.', language)}
          </p>
        </form>
      </CardContent>
    </Card>
  )
}