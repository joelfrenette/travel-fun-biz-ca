import { videoEmbed } from "@/lib/video"

export function TripVideo({ url, title }: { url: string; title: string }) {
  const embed = videoEmbed(url)

  return (
    <div className="aspect-video w-full overflow-hidden rounded-xl border bg-muted">
      {embed ? (
        <iframe
          src={embed.embedUrl}
          title={title}
          className="h-full w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      ) : (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video src={url} controls className="h-full w-full" />
      )}
    </div>
  )
}
