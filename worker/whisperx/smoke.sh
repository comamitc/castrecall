#!/usr/bin/env bash
# Minimal smoke test against a running castrecall-whisperx-worker: submits one
# public audio URL, polls until it completes, and prints the transcript.
#
# Usage:
#   WORKER_TOKEN=... ./smoke.sh <public-audio-url> [worker-base-url]
#
# Example (base URL defaults to http://127.0.0.1:8000):
#   WORKER_TOKEN=my-token ./smoke.sh https://example.com/episode.mp3
set -euo pipefail

AUDIO_URL="${1:?usage: WORKER_TOKEN=... ./smoke.sh <public-audio-url> [worker-base-url]}"
BASE_URL="${2:-http://127.0.0.1:8000}"
: "${WORKER_TOKEN:?set WORKER_TOKEN to the configured bearer token}"

if ! command -v jq >/dev/null 2>&1; then
  echo "This script needs 'jq' to parse JSON responses. Install it and re-run." >&2
  exit 1
fi

auth=(-H "Authorization: Bearer ${WORKER_TOKEN}")

echo "== Health check: ${BASE_URL}/health"
curl -fsS "${auth[@]}" "${BASE_URL}/health" | jq .

echo "== Submitting ${AUDIO_URL}"
submit_response=$(curl -fsS "${auth[@]}" -H "Content-Type: application/json" \
  -d "{\"audio_url\": \"${AUDIO_URL}\"}" "${BASE_URL}/transcribe")
echo "${submit_response}" | jq .

job_id=$(echo "${submit_response}" | jq -r '.job_id // empty')
if [ -z "${job_id}" ]; then
  # A sync (non-job) response already carries the normalized result.
  echo "== Synchronous result"
  echo "${submit_response}" | jq .
  exit 0
fi

echo "== Polling job ${job_id}"
for _ in $(seq 1 180); do
  poll_response=$(curl -fsS "${auth[@]}" "${BASE_URL}/jobs/${job_id}")
  status=$(echo "${poll_response}" | jq -r '.status')
  echo "  status=${status}"
  if [ "${status}" = "completed" ]; then
    echo "== Transcript result"
    echo "${poll_response}" | jq '.result'
    exit 0
  fi
  if [ "${status}" = "failed" ]; then
    echo "Job failed:" >&2
    echo "${poll_response}" | jq . >&2
    exit 1
  fi
  sleep 5
done

echo "Timed out waiting for job ${job_id} to complete." >&2
exit 1
