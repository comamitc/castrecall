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
- It needs your account email and password (env vars, read-only requests only). Accounts created via *Sign in with Google/Apple* have no password and won't work.
- If Pocket Casts ever ships an official API or export, CastRecall will move to it.

Use it with those expectations.

## Privacy model

- **Full transcripts are source material, not memory.** They live under CastRecall's private data dir with a `provenance.json` sidecar (`privacyClass: "private-source"`).
- **CastRecall never writes to durable OpenClaw memory.** It generates review candidates in `review/pending/`; a human decides what graduates — ideally rephrased in your own words.
- **Credentials are env-only** and never logged, stored, echoed in errors, or passed through plugin config.
- Transcripts of published podcasts can still be copyrighted material — keeping them as private source data (rather than republishing or promoting them wholesale) is the intended use.

## Install

```bash
# from GitHub
openclaw plugins install https://github.com/comamitc/castrecall

# or from a local clone (for development)
git clone https://github.com/comamitc/castrecall
cd castrecall && npm install && npm run plugin:build
openclaw plugins install --link .
```

Then enable it if needed with `openclaw plugins enable castrecall`.

## First-run setup

1. Set your Pocket Casts credentials in the environment OpenClaw runs in:
   ```bash
   export POCKETCASTS_EMAIL="you@example.com"
   export POCKETCASTS_PASSWORD="..."
   ```
   (See `.env.example` for every variable.)
2. Optionally configure transcript providers (Taddy, STT — see below).
3. Ask your agent to run `castrecall_setup_status`. It reports what is and isn't configured — without ever printing secrets — plus data-dir location and counts.

## Tools

| Tool | What it does |
| --- | --- |
| `castrecall_setup_status` | Setup/health report: configured providers, ladder availability, counts. Run first. |
| `castrecall_sync_history` | Read-only Pocket Casts history sync; records new listens idempotently. |
| `castrecall_recent` | Lists synced listens with transcript status and episode UUIDs. |
| `castrecall_fetch_transcript` | Runs the transcript ladder for one episode; stores transcript + provenance. |
| `castrecall_generate_review` | Writes approval-gated review candidates for stored transcripts. |

## The transcript ladder

Cheapest and most open first; every rung reports why it hit, missed, or was skipped:

1. **RSS `<podcast:transcript>`** (always on, free) — the open [podcast namespace](https://podcastindex.org/namespace/1.0) standard. Supports plain text, HTML, VTT, SRT, and JSON transcripts, normalized to clean text with speaker labels where available.
2. **Taddy** (optional) — set `TADDY_API_KEY` + `TADDY_USER_ID` ([free signup](https://taddy.org/developers); transcript access needs a paid Taddy plan).
3. **Speech-to-text** (optional, **costs money**, disabled by default) — enable explicitly with `CASTRECALL_ENABLE_STT=true`. Providers: **AssemblyAI** (default; transcribes straight from the audio URL) or **OpenAI** (`gpt-4o-transcribe`; requires downloading and uploading the audio, 25 MB API limit).

If no rung produces a transcript, the episode is marked `failed` with the per-rung reasons — no fake output, ever.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `POCKETCASTS_EMAIL` / `POCKETCASTS_PASSWORD` | for sync | Read-only history access (unofficial API). |
| `CASTRECALL_DATA_DIR` | no | Data dir (default `~/.openclaw/castrecall`). |
| `CASTRECALL_HISTORY_LIMIT` | no | Max entries per sync (default 100). |
| `TADDY_API_KEY` / `TADDY_USER_ID` | no | Enables the Taddy ladder rung. |
| `CASTRECALL_ENABLE_STT` | no | `true` to allow paid STT fallback. |
| `CASTRECALL_STT_PROVIDER` | no | `assemblyai` (default) or `openai`. |
| `ASSEMBLYAI_API_KEY` | with STT | AssemblyAI transcription. |
| `OPENAI_API_KEY` | with STT | OpenAI transcription. |
| `CASTRECALL_OPENAI_STT_MODEL` | no | Default `gpt-4o-transcribe`. |

Non-secret settings (`dataDir`, `historyLimit`, `sttEnabled`, `sttProvider`) can also be set via the plugin's config schema; env vars win when both are set.

## Data layout

```
~/.openclaw/castrecall/
├── state.json                    # sync state: seen listens, transcript status
├── sources/<episodeUuid>/        # private source material
│   ├── raw.<ext>                 # transcript exactly as fetched/generated
│   ├── transcript.txt            # normalized plain text
│   └── provenance.json           # platform, feed, URLs, timestamps, source, privacy class
└── review/pending/<episodeUuid>.md   # approval-gated review candidates
```

## Example workflow

> **You:** "Sync my podcast listens and prep reviews for anything new."
>
> **Agent:** runs `castrecall_sync_history` → 3 new listens. Runs `castrecall_fetch_transcript` for each (2 via RSS transcripts, 1 has none and STT is off). Runs `castrecall_generate_review` → 2 candidates in `review/pending/`.
>
> **You:** read the candidates, keep one durable idea in your own words, delete the rest.

## Troubleshooting

- **"Pocket Casts credentials are not configured"** — set `POCKETCASTS_EMAIL` / `POCKETCASTS_PASSWORD` in the environment OpenClaw runs in (not just your shell).
- **"Pocket Casts rejected the configured credentials"** — check them; Google/Apple-SSO accounts cannot be used (no password exists).
- **Login worked before but fails now** — the unofficial API may have changed or rate-limited you; wait and retry, and check the repo's issues.
- **"no-transcript" with all rungs missed/skipped** — the feed declares no transcript and no optional provider is configured. Configure Taddy, or enable STT for that episode's fetch.
- **STT skipped even with a key set** — STT must be explicitly enabled (`CASTRECALL_ENABLE_STT=true`); it costs money per episode.
- **OpenAI STT fails on long episodes** — the 25 MB upload limit; use `CASTRECALL_STT_PROVIDER=assemblyai`.
- **Where did my data go?** — `castrecall_setup_status` prints the data dir.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (35 tests: parsing, normalization, storage idempotency, error paths)
npm run plugin:build     # tsc + openclaw plugins build (regenerates openclaw.plugin.json)
npm run plugin:validate  # openclaw plugins validate
```

Architecture notes live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

[MIT](LICENSE)
