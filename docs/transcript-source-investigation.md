# Investigation: platform-caption sources (Apple / Pocket Casts) — issue #13

Spike to determine whether Apple Podcasts' or Pocket Casts' in-app episode
transcripts are reachable as a distinct, legally-acceptable rung of the
[transcript ladder](../README.md#the-transcript-ladder), beyond what rung 1
(RSS `<podcast:transcript>`) already fetches. This is a desk investigation —
no live requests were made against either platform's API; findings are based
on public documentation, official blog posts, and the two known
community reverse-engineering projects that this codebase's
`src/pocketcasts/client.ts` already draws on (essoen/PocketCasts-mcp,
alansmodic/pocketcasts-mcp).

## Question 1: is Pocket Casts' in-app transcript just the RSS `<podcast:transcript>` link rung 1 already fetches?

**No, not always** — Pocket Casts has two distinct transcript sources:

1. **Creator-supplied, RSS-declared transcripts** — the standard
   `<podcast:transcript>` element from the [podcast namespace](https://podcastindex.org/namespace/1.0/tag/transcript),
   in VTT, SRT, PodcastIndex JSON, or HTML. This is exactly rung 1
   (`src/transcripts/rss.ts`). Available to all users, free.
2. **Pocket Casts–generated transcripts** (shipped April 2025, app v7.85+) —
   Pocket Casts transcribes select popular podcasts' episodes on its own
   servers and serves them from a source separate from the podcast's RSS
   feed, used as a fallback when a show has no creator-supplied transcript.
   ([Pocket Casts blog](https://blog.pocketcasts.com/2025/04/29/generated-transcripts-are-here/),
   [support article](https://support.pocketcasts.com/knowledge-base/episode-transcripts/))

So the answer is genuinely source-dependent: for a show with its own
`<podcast:transcript>` feed entry, rung 1 already gets the same text Pocket
Casts displays. For a show without one, Pocket Casts may still show a
transcript in-app that rung 1 cannot — a real second source, distinct from
RSS.

## Question 2: is that generated-transcript source reachable through a stable, read-only API path?

**No — not through anything documented or known to exist today.**

- Pocket Casts generated transcripts are gated to **Plus/Patron
  subscribers only**, for a curated subset of "most-followed" podcasts, and
  only for episodes under 2 hours. This is a paid-tier product feature, not
  open data.
- The feature ships in the **mobile apps** (iOS/Android). Pocket Casts'
  own blog confirms synced/highlighted transcript playback is
  mobile-only; the web player (`play.pocketcasts.com`, the surface
  `client.ts` mirrors) can read and search transcripts but the post makes no
  mention of a documented endpoint backing it.
- Neither of the two community reverse-engineering projects this codebase
  already leans on for `api.pocketcasts.com` endpoints
  (essoen/PocketCasts-mcp, alansmodic/pocketcasts-mcp) exposes a Pocket
  Casts–native transcript endpoint. Both instead fall back to **their own
  AssemblyAI transcription** when no RSS transcript exists — i.e. the
  community that has already reverse-engineered `api.pocketcasts.com`'s
  history/login/episode endpoints has not found (or has not published) a
  working endpoint for the generated-transcript feature either.
- No `api.pocketcasts.com` transcript-specific endpoint appears in any
  public reverse-engineering write-up found (Mike Street's PHP client, the
  `furgoose/Pocket-Casts` and `pocketcasts-api` PyPI projects, the 2022 HN
  thread on the `/user/history` endpoint). All of them predate or omit the
  generated-transcript feature.

Discovering such an endpoint from scratch would require live traffic
capture from an authenticated Plus/Patron mobile session — a materially
different and heavier undertaking than replicating the already-published,
already-reverse-engineered read endpoints `client.ts` uses today, and one
this investigation has no tooling or test account to perform safely.

## Apple Podcasts

**No-go, unambiguous.** Apple auto-generates transcripts server-side and
serves them to the Apple Podcasts app via
`https://amp-api.podcasts.apple.com/v1/catalog/us/podcast-episodes/{id}/transcripts`,
gated behind a bearer token minted by
`https://sf-api-token-service.itunes.apple.com/apiToken`. Minting that
token requires an `X-Apple-ActionSignature` header — a cryptographic
signature Apple computes client-side, reverse-engineered (not published)
by the one write-up found describing this flow
([blog.alexbeals.com](https://blog.alexbeals.com/posts/downloading-arbitrary-apple-podcast-episode-transcripts)).
There is no Apple-documented public API for this at all; the official
creator-facing docs
([podcasters.apple.com](https://podcasters.apple.com/support/5316-transcripts-on-apple-podcasts))
describe only in-app listener access and Podcasts Connect creator
management, with no third-party access path.

## Gate evaluation

A rung ships only if **all three** hold. Neither candidate clears the gate:

| Criterion | Pocket Casts generated transcripts | Apple Podcasts transcripts |
|---|---|---|
| 1. Distinct from RSS rung 1 | **Yes** — separate server-side source | **Yes** — separate server-side source |
| 2. Stable, read-only, non-scraping path | **No** — no known/published endpoint; would require fresh live reverse-engineering of a paid mobile feature | **No** — requires reverse-engineered cryptographic request signing; no documented API |
| 3. Legally/ToS acceptable | **Doubtful** — undocumented access to a paid subscription feature | **No** — explicitly unsanctioned reverse-engineering per the only known write-up |

## Decision: **no-go**

No rung ships. Runtime code is unchanged: the ladder still has exactly four
rungs (`rss`, `taddy`, `local-whisper`, `stt`). This is a desk-research
no-go, not a "we tried and it 404'd" no-go — revisit if either platform
publishes a documented transcript API, or if a community reverse-engineering
project surfaces a stable Pocket Casts generated-transcript endpoint that
clears criterion 2 above.

## Sources

- [Pocket Casts: Generated Transcripts Are Here](https://blog.pocketcasts.com/2025/04/29/generated-transcripts-are-here/)
- [Pocket Casts support: Episode Transcripts](https://support.pocketcasts.com/knowledge-base/episode-transcripts/)
- [Pocket Casts: Web Player Is Now Available to All](https://blog.pocketcasts.com/2025/03/11/webplayer/)
- [essoen/PocketCasts-mcp](https://github.com/essoen/PocketCasts-mcp)
- [alansmodic/pocketcasts-mcp](https://github.com/alansmodic/pocketcasts-mcp)
- [Mike Street: Get your Pocket Casts data using the unofficial API and PHP](https://www.mikestreety.co.uk/blog/get-your-pocket-casts-data-using-the-unofficial-api-and-php/)
- [Apple Podcasts for Creators: Transcripts on Apple Podcasts](https://podcasters.apple.com/support/5316-transcripts-on-apple-podcasts)
- [blog.alexbeals.com: Downloading arbitrary Apple Podcast episode transcripts](https://blog.alexbeals.com/posts/downloading-arbitrary-apple-podcast-episode-transcripts)
