"use client"

import type React from "react"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { Loader2, CheckCircle2 } from "lucide-react"

interface ContactFormProps {
  preselectedPackage?: string
}

export function ContactForm({ preselectedPackage }: ContactFormProps) {
  const { toast } = useToast()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setIsSubmitting(true)

    const formData = new FormData(e.currentTarget)
    const data = {
      name: formData.get("name"),
      email: formData.get("email"),
      phone: formData.get("phone"),
      package: formData.get("package"),
      travelDate: formData.get("travelDate"),
      travelers: formData.get("travelers"),
      message: formData.get("message"),
      submittedAt: new Date().toISOString(),
    }

    try {
      const response = await fetch("/api/submit-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        throw new Error("Failed to submit form")
      }

      setIsSuccess(true)
      toast({
        title: "Success!",
        description: "We've received your inquiry and will contact you soon.",
      })

      // Reset form
      e.currentTarget.reset()
    } catch (error) {
      toast({
        title: "Error",
        description: "Something went wrong. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  if (isSuccess) {
    return (
      <Card className="mx-auto max-w-2xl">
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <CheckCircle2 className="mb-4 h-16 w-16 text-green-600" />
          <h3 className="mb-2 text-2xl font-bold text-foreground">Thank You!</h3>
          <p className="text-muted-foreground">
            We've received your travel inquiry. Our team will contact you within 24 hours to discuss your perfect trip.
          </p>
          <Button onClick={() => setIsSuccess(false)} variant="outline" className="mt-6">
            Submit Another Inquiry
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="mx-auto max-w-2xl">
      <CardHeader>
        <CardTitle className="text-2xl">Plan Your Perfect Trip</CardTitle>
        <CardDescription>Fill out the form below and our travel experts will contact you shortly.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">
                Full Name <span className="text-destructive">*</span>
              </Label>
              <Input id="name" name="name" placeholder="John Doe" required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">
                Email <span className="text-destructive">*</span>
              </Label>
              <Input id="email" name="email" type="email" placeholder="john@example.com" required />
            </div>
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="phone">Phone Number</Label>
              <Input id="phone" name="phone" type="tel" placeholder="+1 (555) 000-0000" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="package">
                Interested Package <span className="text-destructive">*</span>
              </Label>
              <Select name="package" defaultValue={preselectedPackage} required>
                <SelectTrigger id="package">
                  <SelectValue placeholder="Select a package" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Tropical Paradise Escape">Tropical Paradise Escape</SelectItem>
                  <SelectItem value="European Heritage Tour">European Heritage Tour</SelectItem>
                  <SelectItem value="Mountain Adventure Trek">Mountain Adventure Trek</SelectItem>
                  <SelectItem value="Safari Wildlife Experience">Safari Wildlife Experience</SelectItem>
                  <SelectItem value="Island Hopping Adventure">Island Hopping Adventure</SelectItem>
                  <SelectItem value="Amazon Rainforest Expedition">Amazon Rainforest Expedition</SelectItem>
                  <SelectItem value="Custom Package">Custom Package</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="travelDate">Preferred Travel Date</Label>
              <Input id="travelDate" name="travelDate" type="date" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="travelers">Number of Travelers</Label>
              <Select name="travelers">
                <SelectTrigger id="travelers">
                  <SelectValue placeholder="Select number" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 Person</SelectItem>
                  <SelectItem value="2">2 People</SelectItem>
                  <SelectItem value="3-4">3-4 People</SelectItem>
                  <SelectItem value="5-8">5-8 People</SelectItem>
                  <SelectItem value="9+">9+ People</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="message">Additional Information</Label>
            <Textarea
              id="message"
              name="message"
              placeholder="Tell us about your travel preferences, special requirements, or any questions you have..."
              rows={5}
            />
          </div>

          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Submitting...
              </>
            ) : (
              "Submit Inquiry"
            )}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            By submitting this form, you agree to our privacy policy and terms of service.
          </p>
        </form>
      </CardContent>
    </Card>
  )
}
