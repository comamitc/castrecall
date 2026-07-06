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

**Yes, technically — but only by bypassing the paywall that gates the feature.**

- alansmodic/pocketcasts-mcp's `pocketcasts.ts` (source inspected directly)
  calls `GET https://podcast-api.pocketcasts.com/show_notes/full/{podcastUuid}`
  with only a `User-Agent`/`Referer` header — **no bearer token, no login,
  no account required**. The response's `podcast.episodes[]` entries carry
  two transcript fields, and the client explicitly prefers the Pocket
  Casts-generated one over the RSS-sourced one:
  ```ts
  if (episode.pocket_casts_transcripts?.length) return episode.pocket_casts_transcripts;
  if (episode.transcripts?.length) return episode.transcripts;
  ```
  This corrects an earlier draft of this investigation, which claimed no
  community project exposes a Pocket Casts-native transcript endpoint — this
  one does, and it's a distinct domain (`podcast-api.pocketcasts.com`) from
  the `api.pocketcasts.com/user/*` login/history endpoints this codebase's
  `client.ts` already uses.
- That the endpoint needs **no authentication at all** is the disqualifying
  fact, not a mitigating one. Pocket Casts gates generated transcripts to
  Plus/Patron subscribers inside the app, but `show_notes/full` serves the
  same `pocket_casts_transcripts` data to any anonymous caller who knows the
  podcast UUID. A rung built on it would mean CastRecall systematically
  circumventing a paid-feature gate for every user — a materially different
  (and worse) situation than rung 1 (RSS) or this codebase's existing Pocket
  Casts history integration, both of which only ever return data the
  querying account already has legitimate access to.
- The feature ships in the **mobile apps** (iOS/Android). Pocket Casts'
  own blog confirms synced/highlighted transcript playback is
  mobile-only, with no mention of a documented endpoint backing it —
  consistent with `show_notes/full` being an internal implementation detail
  never intended for external, subscription-free consumption.
- No official Pocket Casts documentation describes this endpoint or the
  `pocket_casts_transcripts` field; nor does any of the older public
  reverse-engineering write-ups (Mike Street's PHP client, the
  `furgoose/Pocket-Casts` and `pocketcasts-api` PyPI projects, the 2022 HN
  thread on the `/user/history` endpoint) — all of those predate or omit the
  generated-transcript feature. It is known only through alansmodic's
  since-published client.

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

A rung ships only if **all three** hold. Neither candidate clears the gate
in full — Pocket Casts now clears criterion 2 but still fails criterion 3:

| Criterion | Pocket Casts generated transcripts | Apple Podcasts transcripts |
|---|---|---|
| 1. Distinct from RSS rung 1 | **Yes** — separate server-side source | **Yes** — separate server-side source |
| 2. Stable, read-only, non-scraping path | **Yes, technically** — `podcast-api.pocketcasts.com/show_notes/full/{podcastUuid}` is unauthenticated and already reverse-engineered by an independent open-source project (alansmodic/pocketcasts-mcp) | **No** — requires reverse-engineered cryptographic request signing; no documented API |
| 3. Legally/ToS acceptable | **No** — the endpoint serves a Plus/Patron-gated feature to unauthenticated callers; consuming it means bypassing Pocket Casts' subscription paywall, a clearer ToS problem than plain "undocumented access" | **No** — explicitly unsanctioned reverse-engineering per the only known write-up |

## Decision: **no-go**

No rung ships. Runtime code is unchanged: the ladder still has exactly four
rungs (`rss`, `taddy`, `local-whisper`, `stt`). Apple remains no-go on
technical grounds (no documented API, requires reverse-engineered request
signing). Pocket Casts now clears criterion 2 — a stable, unauthenticated,
reverse-engineered endpoint does exist — but fails criterion 3: it returns a
Plus/Patron-gated feature to anonymous callers, so building on it means
circumventing Pocket Casts' subscription paywall rather than merely
depending on an unofficial API. That is a worse legal/ToS position than "no
known endpoint," not a better one. Revisit if Pocket Casts publishes a
documented transcript API or adds an auth/entitlement check to
`show_notes/full`, or if Apple publishes a documented transcript API.

## Sources

- [Pocket Casts: Generated Transcripts Are Here](https://blog.pocketcasts.com/2025/04/29/generated-transcripts-are-here/)
- [Pocket Casts support: Episode Transcripts](https://support.pocketcasts.com/knowledge-base/episode-transcripts/)
- [Pocket Casts: Web Player Is Now Available to All](https://blog.pocketcasts.com/2025/03/11/webplayer/)
- [essoen/PocketCasts-mcp](https://github.com/essoen/PocketCasts-mcp)
- [alansmodic/pocketcasts-mcp](https://github.com/alansmodic/pocketcasts-mcp) — see
  `pocketcasts.ts`'s `getPodcastTranscript` for the unauthenticated
  `show_notes/full/{podcastUuid}` call and `pocket_casts_transcripts` field
- [Mike Street: Get your Pocket Casts data using the unofficial API and PHP](https://www.mikestreety.co.uk/blog/get-your-pocket-casts-data-using-the-unofficial-api-and-php/)
- [Apple Podcasts for Creators: Transcripts on Apple Podcasts](https://podcasters.apple.com/support/5316-transcripts-on-apple-podcasts)
- [blog.alexbeals.com: Downloading arbitrary Apple Podcast episode transcripts](https://blog.alexbeals.com/posts/downloading-arbitrary-apple-podcast-episode-transcripts)
