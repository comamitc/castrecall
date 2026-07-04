# CastRecall

Turn podcast listening into retrievable memory.

CastRecall is an open-source [OpenClaw](https://openclaw.ai) plugin that watches what you listen to, finds or generates the episode transcript, and ingests it as private, provenance-bearing source material. Useful excerpts and ideas are surfaced as review candidates — nothing is promoted into durable memory without your approval.

The first question it answers: **"What have I been absorbing lately, and how is it shaping my thinking?"**

## How it works

1. **Detect listens** — starts with Pocket Casts listen history (MVP).
2. **Resolve the episode** — canonical RSS feed item metadata and audio URL.
3. **Find the transcript**, cheapest first:
   - `<podcast:transcript>` RSS tag (open standard)
   - transcript-aware podcast APIs (e.g. Taddy)
   - speech-to-text from audio as the expensive fallback
4. **Store privately** — raw transcript with provenance: platform, episode URL, listen date, privacy class.
5. **Review, then remember** — approval-gated promotion of excerpts and insights into curated memory. Full transcripts are never treated as memory.

## Status

Early development — not yet usable. Pocket Casts-only MVP in progress.

## License

MIT
