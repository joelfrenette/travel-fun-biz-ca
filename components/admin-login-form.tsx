"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { z } from "zod"
import { zodResolver } from "@hookform/resolvers/zod"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"

const schema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(8, "Password is required"),
})

type FormValues = z.infer<typeof schema>

interface AdminLoginFormProps {
  redirectPath?: string
}

export function AdminLoginForm({ redirectPath = "/admin" }: AdminLoginFormProps) {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  })

  async function onSubmit(values: FormValues) {
    setLoading(true)
    setError(null)

    try {
      // Submit as a traditional form so the browser handles Set-Cookie and redirects reliably
      const form = document.createElement('form')
      form.method = 'POST'
      form.action = '/api/admin/login'

      const emailInput = document.createElement('input')
      emailInput.type = 'hidden'
      emailInput.name = 'email'
      emailInput.value = values.email
      form.appendChild(emailInput)

      const passInput = document.createElement('input')
      passInput.type = 'hidden'
      passInput.name = 'password'
      passInput.value = values.password
      form.appendChild(passInput)

      const redirectInput = document.createElement('input')
      redirectInput.type = 'hidden'
      redirectInput.name = 'redirect'
      redirectInput.value = redirectPath
      form.appendChild(redirectInput)

      document.body.appendChild(form)
      form.submit()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to login")
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" autoComplete="username" {...register("email")} />
        {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" autoComplete="current-password" {...register("password")} />
        {errors.password && <p className="text-sm text-destructive">{errors.password.message}</p>}
      </div>

      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Signing in..." : "Sign In"}
      </Button>
    </form>
  )
}