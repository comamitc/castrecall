# CastRecall

Turn podcast listening into retrievable memory.

CastRecall is an open-source [OpenClaw](https://openclaw.ai) tool plugin that watches what you listen to, finds or generates the episode transcript, and stores it as **private, provenance-bearing source material**. Useful excerpts are surfaced as **approval-gated review candidates** — nothing is ever silently promoted into durable memory.

The first question it answers: **"What have I been absorbing lately, and how is it shaping my thinking?"**

## MVP scope

v0 is **Pocket Casts only** and **read-only**:

- Syncs your Pocket Casts listening history (never mutates playback state — no play/pause/star/seek tools exist).
- Resolves each listen to its canonical RSS feed item.
- Walks a cost-aware transcript ladder (see below).
- Stores full transcripts privately with a provenance sidecar.
- Generates markdown review candidates for human approval.

## ⚠️ The Pocket Casts caveat

**Pocket Casts has no official public API.** CastRecall uses the same reverse-engineered web-player endpoints as community tools such as [essoen/PocketCasts-mcp](https://github.com/essoen/PocketCasts-mcp) (prior art for this plugin). That means:

- It can break or be blocked by Pocket Casts at any time, without notice.
- It needs your account email and password (read-only requests only) — stored in the OS keychain when available, or env vars as a portable fallback. Accounts created via *Sign in with Google/Apple* have no password and won't work.
- If Pocket Casts ever ships an official API or export, CastRecall will move to it.

Use it with those expectations.

## Privacy model

- **Full transcripts are source material, not memory.** They live under CastRecall's private data dir with a `provenance.json` sidecar (`privacyClass: "private-source"`).
- **CastRecall never writes to durable OpenClaw memory.** It generates review candidates in `review/pending/`; a human decides what graduates — ideally rephrased in your own words.
- **Credentials are keychain-preferred, env-var fallback**: CastRecall reads Pocket Casts email/password from the OS keychain (macOS Keychain / libsecret) when a backend is available and entries exist, otherwise from `POCKETCASTS_EMAIL`/`POCKETCASTS_PASSWORD`. Either way, credentials never pass through plugin config and are never logged or echoed in errors. The Pocket Casts session token is cached (in memory, and in the keychain when available) and reused across syncs instead of re-sending the password every time; `CASTRECALL_DISABLE_KEYCHAIN=1` disables the durable keychain sink only (the in-memory, process-lifetime token cache always applies).
- Transcripts of published podcasts can still be copyrighted material — keeping them as private source data (rather than republishing or promoting them wholesale) is the intended use.

## CastRecall in the brain ecosystem

CastRecall is a **raw-source pipeline**, not a knowledge base of its own. It produces two lanes: immutable, provenance-bearing transcripts (the source layer) and approval-gated review candidates (curation input for a human to promote or discard). Neither lane is meant to be queried directly as "memory" — they're inputs to whatever markdown-based knowledge system you curate on top.

This mirrors [gbrain](https://github.com/garrytan/gbrain)'s own architecture exactly: an immutable `sources/` tree feeding agent-compiled brain pages. The same split applies just as well to Obsidian vaults, Karpathy-style personal wikis, or any other custom markdown corpus — CastRecall doesn't assume gbrain, it just happens to line up with it.

### Using CastRecall with gbrain

Once corpus-export mode is enabled, CastRecall's exported pages can reach a gbrain instance in one of two ways: dropped into gbrain's **watched inbox** for automatic pickup, or written directly into a brain's **`sources/` tree**, where each show's slug becomes its own two-segment prefix — which gbrain's LSD/brainstorm far-set selection treats as an automatic domain-bank bucket. See [Corpus export (gbrain & other markdown brains)](#corpus-export-gbrain--other-markdown-brains) below for the exact `CASTRECALL_EXPORT_DIR` setup and layout.

## Install

```bash
# from GitHub (current public install path)
openclaw plugins install git:github.com/comamitc/castrecall@main

# or from a local clone (for development)
git clone https://github.com/comamitc/castrecall
cd castrecall && npm install && npm run plugin:build
openclaw plugins install --link .
```

Then enable it if needed with `openclaw plugins enable castrecall`.

OpenClaw's current installer does not accept bare HTTPS GitHub URLs such as
`https://github.com/comamitc/castrecall`; use the `git:github.com/...@ref`
form above. That GitHub form is the current primary install path. Once
CastRecall clears ClawHub's publish review, the install target will be
`openclaw plugins install clawhub:@comamitc/castrecall` (pending publish —
not yet live).

## First-run setup

Ask your agent to run `castrecall_setup` — it walks through everything below instead of you hand-editing config or JSON:

1. **Pocket Casts credentials** — explains what to set (`POCKETCASTS_EMAIL` / `POCKETCASTS_PASSWORD`), the unofficial-API caveat, and the Google/Apple-SSO limitation (those accounts have no password and can't be used). When an OS keychain backend is detected (macOS Keychain / libsecret), it also shows the exact `security`/`secret-tool` command to store credentials there instead — the safer option, with env vars remaining a fallback. Once configured, run `castrecall_setup({ verify: true })` to make one read-only Pocket Casts call confirming they actually work — the result reports success/failure and, on success, how many history entries are visible, never the credential values.
2. **Storage location** — where transcripts and review candidates live (`CASTRECALL_DATA_DIR`, default `~/.openclaw/castrecall`).
3. **Privacy defaults** — confirms transcripts are private source material, nothing is ever promoted into durable memory, and corpus export is off unless you opt in.
4. **Optional providers** — Taddy, local Whisper, and cloud STT, each with what's detected and how to enable it.
5. **Export directory** — off by default; if a gbrain install is detected (`~/.gbrain/`, or `CASTRECALL_GBRAIN_INSTALLED=1` set by an agent-driven wrapper that has confirmed the plugin via OpenClaw's own plugin inventory), `castrecall_setup` suggests its inbox as `CASTRECALL_EXPORT_DIR`.

`castrecall_setup` **never** modifies `openclaw.json` and **never** writes secrets to disk — it only tells you which environment variables to set and where (see `.env.example` for every variable). Re-run `castrecall_setup_status` any time afterward for a compact health report of the same state.

## Tools

| Tool | What it does |
| --- | --- |
| `castrecall_setup_status` | Setup/health report: configured providers, ladder availability, counts. Run first. |
| `castrecall_setup` | Guided first-run setup: walks through credentials (keychain-preferred, env-var fallback), storage, privacy defaults, optional providers, and export directory. `{ verify: true }` makes a read-only Pocket Casts test call. Never edits config or writes secrets itself. |
| `castrecall_sync_history` | Read-only Pocket Casts history sync; records new listens idempotently. Only episodes that pass the "meaningfully listened" filter are stored — see below. Keychain-preferred credentials with an env-var fallback; reuses the cached session token instead of logging in every sync. |
| `castrecall_recent` | Lists synced listens with transcript status and episode UUIDs. |
| `castrecall_fetch_transcript` | Runs the transcript ladder for one episode; stores transcript + provenance. Also exports markdown pages when `CASTRECALL_EXPORT_DIR` is set. |
| `castrecall_generate_review` | Writes approval-gated review candidates for stored transcripts. |
| `castrecall_run_pipeline` | Chains sync → fetch transcripts (new listens only) → generate reviews (episodes newly stored this run) → corpus export. The tool a scheduler recipe should call — see "Scheduled / periodic sync" below. |

## Screenshots

CastRecall is a tool plugin with no GUI of its own, so the most honest
"screenshot" of the review flow is its actual output. `castrecall_generate_review`
writes one markdown file per episode to `review/pending/<episodeUuid>.md`:

```
$ castrecall_generate_review
{ "generated": 1, "skipped": 0 }
```

```markdown
---
status: pending-review
privacy: private-source
episode_uuid: 3f9c1e2a-...
podcast: "Some Great Podcast"
episode: "Episode 42: The One About Memory"
listened: 2026-07-04T18:12:00.000Z
transcript_source: rss
transcript_format: text
generated_at: 2026-07-06T03:00:00.000Z
---

# Review: Episode 42: The One About Memory

From **Some Great Podcast** by Jane Host.

> This is a review candidate generated from a privately stored transcript.
> Nothing below is in durable memory. Promote only what is worth keeping,
> in your own words where possible, and discard the rest.

## Provenance

- Platform: Pocket Casts (listen history)
- Feed: https://example.com/feed.xml
- Transcript: rss
- Fetched: 2026-07-04T18:20:00.000Z
- Full transcript (4,213 words): ~/.openclaw/castrecall/sources/3f9c1e2a-.../transcript.txt

## Excerpt candidates

1. The most substantial paragraph the heuristic picked, verbatim from the transcript...

## Reviewer notes

- [ ] Worth keeping? What is the one durable idea?
- [ ] Anything here change what I'm working on or thinking about?
```

You (or your agent) read the candidate, keep one durable idea in your own
words, and delete the rest — nothing here is ever auto-promoted.

## The transcript ladder

Cheapest and most open first; every rung reports why it hit, missed, or was skipped:

1. **RSS `<podcast:transcript>`** (always on, free) — the open [podcast namespace](https://podcastindex.org/namespace/1.0) standard. Supports plain text, HTML, VTT, SRT, and JSON transcripts, normalized to clean text with speaker labels where available.
2. **Taddy** (optional) — set `TADDY_API_KEY` + `TADDY_USER_ID` ([free signup](https://taddy.org/developers); podcast-provided transcripts may be available to free accounts, while generated/on-demand transcripts use Taddy plan credits).
3. **Podchaser** (optional) — set `PODCHASER_API_KEY` to a **bearer access token** minted once via Podchaser's `requestAccessToken` mutation ([auth docs](https://api-docs.podchaser.com/docs/authorization/); tokens last about a year), not a raw client secret. Looks up the episode by GUID (falling back to an exact title match), then fetches whichever declared transcript reference it prefers.
4. **Local Whisper** (free, fully private, auto-detected) — if a Whisper CLI is installed, CastRecall transcribes the audio on your machine at no cost. Detected binaries, in order: `whisper-cli`/`whisper-cpp` ([whisper.cpp](https://github.com/ggerganov/whisper.cpp), e.g. `brew install whisper-cpp`, needs a ggml model via `CASTRECALL_WHISPER_MODEL` and ffmpeg for non-WAV audio), `mlx_whisper` (Apple Silicon, `pip install mlx-whisper`), `whisper-ctranslate2`, `whisper` (openai-whisper). Or supply any command via `CASTRECALL_WHISPER_COMMAND="your-tool {input}"` (transcript on stdout). Nothing is bundled — when no CLI is found the rung is skipped with install hints.
5. **Cloud speech-to-text** (optional, **costs money**, disabled by default) — enable explicitly with `CASTRECALL_ENABLE_STT=true`. Providers: **AssemblyAI** (default; transcribes straight from the audio URL), **OpenAI** (`gpt-4o-transcribe`; requires downloading and uploading the audio, 25 MB API limit), or **Deepgram** (`nova-3`; also transcribes straight from the audio URL, with diarized speaker labels).

If no rung produces a transcript, the episode is marked `failed` with the per-rung reasons — no fake output, ever. Two exceptions stay `none` instead of failing outright, because the transcript may simply not exist *yet*: Taddy reporting the episode is actively transcribing, and an RSS feed item that currently declares no `<podcast:transcript>` links. Those episodes are automatically re-checked on later scheduled runs — see "Scheduled / periodic sync" below.

## Listened-episode filter

Pocket Casts' `/user/history` endpoint returns everything you've opened, including episodes you only sampled or skipped through. `castrecall_sync_history` applies a "meaningfully listened" filter to that history **at ingestion time**, before an episode is ever recorded into CastRecall state:

1. `playingStatus == 3` (Pocket Casts marked it fully played) — always accepted.
2. Otherwise, if `duration` is known: accepted only if `playedUpTo / duration >= CASTRECALL_MIN_LISTEN_RATIO` (default `0.8`). A long episode with a low ratio is never rescued by the seconds floor below.
3. Otherwise (duration missing or unusable): accepted if `playedUpTo >= CASTRECALL_MIN_LISTEN_SECONDS` (default `300`).
4. If neither `duration`, `playedUpTo`, nor `playingStatus` is usable, the episode is skipped by default; set `CASTRECALL_RECORD_UNKNOWN_LISTENS=true` to record it anyway.

`castrecall_sync_history` reports `fetched`, `eligible`, and `skippedAsNotListened` counts so you can see how many history entries were filtered out. This filter only affects **newly ingested** episodes — it never deletes or re-evaluates episodes, transcripts, or review candidates already stored from a prior sync.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `POCKETCASTS_EMAIL` / `POCKETCASTS_PASSWORD` | for sync, unless in the keychain | Read-only history access (unofficial API). Fallback when no OS keychain entry is found — see "Credential storage" below. |
| `CASTRECALL_DISABLE_KEYCHAIN` | no | `1` to disable the durable OS keychain sink (credential reads and token persistence). The in-memory, process-lifetime token cache still applies. |
| `CASTRECALL_SECRET_SERVICE` | no | Service name under which OS keychain entries are stored (default `castrecall`). |
| `CASTRECALL_DATA_DIR` | no | Data dir (default `~/.openclaw/castrecall`). |
| `CASTRECALL_HISTORY_LIMIT` | no | Max entries per sync (default 100). |
| `CASTRECALL_MIN_LISTEN_RATIO` | no | Minimum `playedUpTo`/`duration` ratio to accept a partial listen (default `0.8`). See "Listened-episode filter" above. |
| `CASTRECALL_MIN_LISTEN_SECONDS` | no | Minimum `playedUpTo` seconds to accept a listen when duration is missing (default `300`). |
| `CASTRECALL_RECORD_UNKNOWN_LISTENS` | no | `true` to record episodes with no usable duration/playedUpTo/playingStatus (default off — skipped). |
| `CASTRECALL_EXPORT_DIR` | no | Enables corpus export (markdown pages) to this directory. Off by default — see "Corpus export" below. |
| `TADDY_API_KEY` / `TADDY_USER_ID` | no | Enables the Taddy ladder rung. |
| `PODCHASER_API_KEY` | no | Enables the Podchaser ladder rung. A bearer access token minted via Podchaser's `requestAccessToken` mutation — not a raw client secret. |
| `CASTRECALL_WHISPER_MODEL` | for whisper.cpp | ggml model path (whisper.cpp) or model name (other Whisper CLIs). |
| `CASTRECALL_WHISPER_COMMAND` | no | Custom local transcription command with an `{input}` placeholder; stdout = transcript. |
| `CASTRECALL_DISABLE_LOCAL_WHISPER` | no | `true` to skip the local Whisper rung even when a CLI is installed. |
| `CASTRECALL_ENABLE_STT` | no | `true` to allow paid STT fallback. |
| `CASTRECALL_STT_PROVIDER` | no | `assemblyai` (default), `openai`, or `deepgram`. |
| `ASSEMBLYAI_API_KEY` | with STT | AssemblyAI transcription. |
| `OPENAI_API_KEY` | with STT | OpenAI transcription. |
| `CASTRECALL_OPENAI_STT_MODEL` | no | Default `gpt-4o-transcribe`. |
| `DEEPGRAM_API_KEY` | with STT | Deepgram transcription. |
| `CASTRECALL_DEEPGRAM_STT_MODEL` | no | Default `nova-3`. |

Non-secret settings (`dataDir`, `historyLimit`, `sttEnabled`, `sttProvider`, `exportDir`) can also be set via the plugin's config schema; env vars win when both are set.

## Credential storage

Pocket Casts credentials are resolved with **OS keychain precedence over env vars**:

1. **OS keychain** (macOS Keychain via `security`, or libsecret via `secret-tool` on Linux) — used when a backend is detected on `PATH` and both entries exist, under service `castrecall` (or `CASTRECALL_SECRET_SERVICE`), accounts `pocketcasts-email` / `pocketcasts-password`. `castrecall_setup` shows the exact command:

   ```bash
   # macOS
   security add-generic-password -U -s castrecall -a pocketcasts-email -w <email>
   security add-generic-password -U -s castrecall -a pocketcasts-password -w <password>

   # Linux (libsecret)
   secret-tool store --label "CastRecall pocketcasts-email" service castrecall account pocketcasts-email
   secret-tool store --label "CastRecall pocketcasts-password" service castrecall account pocketcasts-password
   ```

2. **`POCKETCASTS_EMAIL` / `POCKETCASTS_PASSWORD`** — the portable fallback when no keychain entry is found, or on hosts with no supported backend.

The Pocket Casts session token itself is cached and reused across syncs (skipping the login call) instead of re-sending the password every time, and is invalidated and refreshed automatically on a `401`. When a keychain backend is available, the token is also persisted there so it survives a process restart; otherwise it lives only in memory for the process's lifetime and is never written to disk. Set `CASTRECALL_DISABLE_KEYCHAIN=1` to disable the durable keychain sink entirely (no keychain credential reads, no keychain token persistence) — the in-memory cache still applies. A keychain read/write failure never blocks a sync; it degrades to the env-var fallback or a fresh login.

**Note (macOS):** writing the token to Keychain briefly exposes it in the process argument list (`security add-generic-password -w <value>`) — accepted for the short-lived session token; the Linux/libsecret path passes values via stdin instead, never argv. CastRecall never writes your email/password to the keychain itself — you do that yourself via the commands above.

## Corpus export (gbrain & other markdown brains)

CastRecall's primary intended downstream consumer is markdown-native idea-generation
tooling like [garrytan/gbrain](https://github.com/garrytan/gbrain)'s `lsd` /
`brainstorm` modes. Corpus export is an **opt-in** projection that, after a
transcript is stored, also writes it out as section-split, frontmattered
markdown pages — separate from (and never replacing) the private data dir.

Enable it by setting `CASTRECALL_EXPORT_DIR` (or the `exportDir` plugin
setting) to a directory. It is off by default; nothing is written unless one
of these is set.

**Layout:**

```
<export-dir>/podcasts/<show-slug>/<episode-slug>/
├── 01-<section-slug>.md   # ~1-2k words each, verbatim transcript text
├── 02-<section-slug>.md
├── ...
└── index.md                # episode index, links to every section
```

Each page's frontmatter: `title`, `show`, `episode`, `episode_url`, `audio_url`,
`listen_date`, `transcript_source`, `content_hash`, and `generated: false`
(this is verbatim transcript, not model output) — vendor-neutral fields that
also line up with gbrain's `media`/source conventions.

Export is idempotent: an episode whose transcript content hash hasn't changed
re-exports nothing. It only ever reads a stored transcript + its provenance
sidecar — review candidates and `state.json` are never exported.

**Two ways to point gbrain at it:**

- **Watched inbox** — point `CASTRECALL_EXPORT_DIR` at `~/.gbrain/inbox/`;
  gbrain's watched-inbox ingestion picks the pages up automatically.
- **Domain-bank bucket** — point it at a brain's `sources/` root
  (e.g. `~/.gbrain/sources`), *not* `sources/podcasts` — the exporter already
  adds its own `podcasts/<show-slug>/` prefix under whatever directory you
  point it at, so pointing at `sources/` yields `sources/podcasts/<show-slug>/`.
  Each show then gets its own two-segment prefix, which gbrain's
  LSD/brainstorm far-set selection treats as an automatic domain-bank bucket
  (it samples one far page per two-segment prefix; LSD adds stale-bias on
  top) — no gbrain-side registration needed.

## Data layout

```
~/.openclaw/castrecall/
├── state.json                    # sync state: seen listens, transcript status, schemaVersion
├── sources/<episodeUuid>/        # private source material
│   ├── raw.<ext>                 # transcript exactly as fetched/generated
│   ├── transcript.txt            # normalized plain text
│   └── provenance.json           # platform, feed, URLs, timestamps, source, privacy class,
│                                  # contentHash, schemaVersion
├── review/pending/<episodeUuid>.md   # approval-gated review candidates
└── .staging/                     # reserved scratch for atomic writes — ignore it
```

`state.json` and `provenance.json` are a versioned, machine-readable
interface — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#data-dir-versioned-machine-readable-interface)
for the full field list and stability guarantees (episode/podcast UUIDs never
change; sidecars are write-once).

## Example workflow

> **You:** "Sync my podcast listens and prep reviews for anything new."
>
> **Agent:** runs `castrecall_sync_history` → 3 new listens. Runs `castrecall_fetch_transcript` for each (2 via RSS transcripts, 1 has none and STT is off). Runs `castrecall_generate_review` → 2 candidates in `review/pending/`.
>
> **You:** read the candidates, keep one durable idea in your own words, delete the rest.

## Scheduled / periodic sync

v0 sync is on-demand only unless you wire up a scheduler. `castrecall_run_pipeline` is the one
tool a scheduler recipe should call: it chains sync → fetch transcripts (new listens only) →
generate review candidates (episodes newly stored this run) → corpus export (when
`CASTRECALL_EXPORT_DIR` is set), with no human input, and is safe to invoke on an interval:

- **Concurrency-safe.** Overlapping runs use a lock (`.staging/pipeline.lock` under the data
  dir); a run that can't acquire it is a cheap no-op (`{ skipped: "locked" }`).
- **No API hammering.** Failures (missing/rejected credentials, the unofficial API being down)
  are recorded with a capped exponential backoff cooldown. A scheduled run inside the cooldown
  window is a cheap no-op (`{ skipped: "cooldown" }`) that makes **zero** Pocket Casts calls.
  Check `castrecall_setup_status`'s `sync` block for the current failure/cooldown state.
- **Cheap no-op when nothing's new.** A run that finds no new listens does no
  transcript/review/export work.
- **Availability re-check, not a webhook.** CastRecall is an OpenClaw tool plugin with no
  reachable inbound endpoint, so it cannot subscribe to Taddy's webhooks (the ideal, purely
  event-driven design). Instead, an episode whose only misses are "Taddy is actively
  transcribing this episode" or "the RSS feed currently declares no `<podcast:transcript>`
  links" stays `transcriptStatus: "none"` (not `failed`) and is automatically retried on a
  capped exponential backoff (hours, doubling up to a day) by every scheduled
  `castrecall_run_pipeline` run — no re-sync or manual `castrecall_fetch_transcript` call
  needed. After ~14 days with nothing appearing, the episode is marked terminally `failed`
  so a scheduler doesn't poll forever. **Trade-off:** an old RSS item that will never declare
  a transcript link stays `none` (not `failed`) for that entire 14-day horizon before
  converging — a deliberate choice to avoid missing episodes whose transcript link is added
  a few days after publish, at the cost of a stale `none` for those that truly never will.

### OpenClaw cron recipe

If your OpenClaw host supports scheduled/cron tool invocations, point it at
`castrecall_run_pipeline` with no arguments, e.g. every 30 minutes:

```yaml
# openclaw cron/heartbeat config (host-specific — adapt to your runtime)
- schedule: "*/30 * * * *"
  tool: castrecall_run_pipeline
  params: {}
```

### OS cron recipe

If your OpenClaw runtime doesn't own scheduling in your setup, drive it from OS cron via
whatever CLI/script can invoke a tool against your running agent:

```cron
# crontab -e — runs every 30 minutes
*/30 * * * * /path/to/your/openclaw-agent-invoker castrecall_run_pipeline >> /var/log/castrecall-pipeline.log 2>&1
```

**Never pass `force: true` from a scheduler recipe.** `force` bypasses the failure-cooldown gate
that exists specifically to avoid hammering the unofficial Pocket Casts API — it's for a one-off
*manual recovery run* only, invoked by a human who has just fixed the underlying problem (e.g.
rotated credentials).

**Crashed-run recovery is explicit, never automatic.** The run lock is heartbeat-renewed, so it
only ever looks stale after a hard kill (SIGKILL, power loss — normal failures release it). A
scheduled run that encounters a stale lock reports `skipped: "stale-lock"` with the lock's age
and does nothing — CastRecall never breaks a lock automatically, because no filesystem primitive
can do that without a window where two runs could both proceed. After confirming no run is
alive, recover with a one-off `castrecall_run_pipeline` call passing `breakStaleLock: true`
(refuses live locks; never set it in a scheduler recipe).

## Troubleshooting

- **"Pocket Casts credentials are not configured"** — set `POCKETCASTS_EMAIL` / `POCKETCASTS_PASSWORD` in the environment OpenClaw runs in (not just your shell), or store them in the OS keychain (see "Credential storage" above).
- **"Pocket Casts rejected the configured credentials"** — check them; Google/Apple-SSO accounts cannot be used (no password exists).
- **Login worked before but fails now** — the unofficial API may have changed or rate-limited you; wait and retry, and check the repo's issues.
- **"no-transcript" with all rungs missed/skipped** — the feed declares no transcript and no optional provider is configured. Install a local Whisper CLI (free), configure Taddy or Podchaser, or enable cloud STT.
- **Local Whisper skipped despite being installed** — the binary must be on the `PATH` of the environment OpenClaw runs in; check `castrecall_setup_status`, or point `CASTRECALL_WHISPER_COMMAND` at it directly.
- **"whisper.cpp needs a ggml model file"** — set `CASTRECALL_WHISPER_MODEL=/path/to/ggml-base.en.bin` (download via whisper.cpp's `models/download-ggml-model.sh` or Hugging Face `ggerganov/whisper.cpp`).
- **"whisper.cpp needs 16 kHz WAV input"** — install ffmpeg (`brew install ffmpeg`) so CastRecall can convert the episode audio, or use `mlx_whisper`/openai-whisper which decode audio themselves.
- **STT skipped even with a key set** — cloud STT must be explicitly enabled (`CASTRECALL_ENABLE_STT=true`); it costs money per episode.
- **OpenAI STT fails on long episodes** — the 25 MB upload limit; use `CASTRECALL_STT_PROVIDER=assemblyai` or `CASTRECALL_STT_PROVIDER=deepgram` (both transcribe straight from the audio URL, no upload limit here).
- **Want diarized speaker labels without polling** — `CASTRECALL_STT_PROVIDER=deepgram` transcribes straight from the audio URL and responds synchronously; very long episodes may still time out on Deepgram's side.
- **Where did my data go?** — `castrecall_setup_status` prints the data dir.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (195 tests: parsing, normalization, storage idempotency, corpus export, credential storage/session handling, periodic-sync pipeline, error paths)
npm run plugin:build     # tsc + openclaw plugins build (regenerates openclaw.plugin.json)
npm run plugin:validate  # openclaw plugins validate
```

Architecture notes live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

[MIT](LICENSE)
