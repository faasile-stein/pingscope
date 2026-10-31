#!/usr/bin/env bash
# Optional Docker integration check: use harmless canaries, never real env files.
set -euo pipefail

pingscope_root=$(cd "$(dirname "$0")/.." && pwd)
pingscope_scratch=$(mktemp -d /tmp/pingscope-context-test.XXXXXX)
trap 'rm -rf "$pingscope_scratch"' EXIT
mkdir -p "$pingscope_scratch/context/agent" "$pingscope_scratch/context/nested/deeper"
cp "$pingscope_root/.dockerignore" "$pingscope_scratch/context/.dockerignore"
cp "$pingscope_root/history-reader.js" "$pingscope_root/history-worker.js" "$pingscope_scratch/context/"
printf 'ordinary configuration\n' > "$pingscope_scratch/context/keep.txt"
pingscope_env_files=(.env .env.local .env.production agent/.env agent/.env.production nested/deeper/.env.local)
for pingscope_file in "${pingscope_env_files[@]}"; do
  printf 'PINGSCOPE_HARMLESS_CANARY=fixture\n' > "$pingscope_scratch/context/$pingscope_file"
done

if ! docker build --network=none --output "type=local,dest=$pingscope_scratch/output" \
  -f - "$pingscope_scratch/context" > "$pingscope_scratch/build.log" 2>&1 <<'DOCKERFILE'
FROM scratch
COPY . /app/
DOCKERFILE
then
  cat "$pingscope_scratch/build.log"
  exit 1
fi

pingscope_leaked=0
for pingscope_file in "${pingscope_env_files[@]}"; do
  if [ -e "$pingscope_scratch/output/app/$pingscope_file" ]; then
    printf 'Environment file reached image: %s\n' "$pingscope_file" >&2
    pingscope_leaked=1
  fi
done
test "$pingscope_leaked" -eq 0
cmp "$pingscope_scratch/context/keep.txt" "$pingscope_scratch/output/app/keep.txt"
cmp "$pingscope_root/history-reader.js" "$pingscope_scratch/output/app/history-reader.js"
cmp "$pingscope_root/history-worker.js" "$pingscope_scratch/output/app/history-worker.js"
printf 'Docker context excludes all six environment canaries and preserves runtime modules/control.\n'
