import { cn } from '@/lib/utils'

interface SectionHeadingProps {
  title: string
  subtitle?: string
  eyebrow?: string
  align?: 'left' | 'center'
  className?: string
}

export function SectionHeading({ title, subtitle, eyebrow, align = 'center', className }: SectionHeadingProps) {
  const alignment = align === 'center' ? 'text-center mx-auto' : 'text-left'

  return (
    <div className={cn('max-w-2xl', alignment, className)}>
      {eyebrow && <p className="text-sm font-semibold uppercase tracking-wide text-primary">{eyebrow}</p>}
      <h2 className="text-balance text-3xl font-bold tracking-tight text-foreground sm:text-4xl md:text-5xl">{title}</h2>
      {subtitle && <p className="mt-4 text-pretty text-lg leading-relaxed text-muted-foreground">{subtitle}</p>}
    </div>
  )
}
