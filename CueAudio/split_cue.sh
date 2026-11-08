#!/bin/bash
# Convenience launcher; splitting, matching and tagging live in TypeScript.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec deno run --allow-read --allow-write --allow-run --allow-env "$script_dir/cue_audio.ts" "$@"
