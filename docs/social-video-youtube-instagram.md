# Short video to YouTube Shorts and Instagram Reels

The autopilot's short video can also go to YouTube Shorts and Instagram Reels through Upload-Post. Both are off until you switch them on.

## Switches (Posting card in /admin, stored in app_settings)

| Setting | Values | Meaning |
| --- | --- | --- |
| `social_youtube_shorts_mode` | `off` (default), `log`, `on` | `log` records what would be sent and posts nothing |
| `social_instagram_reels_mode` | `off` (default), `log`, `on` | same |

Anything other than exactly `log` or `on` is treated as off. The log (last 20 videos) is `social_video_extra_log`; the Posting card shows the most recent entries.

## Before you switch either one to `on` (Joel-side)

1. In Upload-Post, connect your YouTube channel and your Instagram account to the same profile the site posts with.
2. Instagram must be a Business or Creator account (Instagram's API refuses personal accounts).
3. Tick YouTube and Instagram in "Where it posts" on the Posting card (they are in the same list as the other networks).
4. Start with `log`, check a logged entry, then move to `on`.

## What is sent

Fields are from Upload-Post's video upload reference (docs.upload-post.com/api/upload-video).

- YouTube: `youtube_title` (cut to 100 characters, ends with `#Shorts`), `youtube_description` (the caption plus `#Shorts`, cut to 5,000), `privacyStatus=public`, `selfDeclaredMadeForKids=false`. There is no Shorts flag in the API: YouTube makes a vertical video of 3 minutes or less a Short.
- Instagram: `instagram_title` (the Reel caption, cut to 2,200 characters and to the house hashtag cap), `media_type=REELS`, `share_to_feed=true`.

The link in the caption keeps the video's UTM tags (`utm_source=video`), the same as the other networks. A failed post to either network is handled like the others: it is not retried blindly, and the network re-check step (`network_recover`) resumes it once the account reports healthy.
