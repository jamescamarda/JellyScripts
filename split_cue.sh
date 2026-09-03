#!/bin/bash
# split_cue_safe.sh — CUE splitter safe for Unicode/Cyrillic on macOS
# Usage: bash split_cue_safe.sh /path/to/music/root
# Requires: brew install shntool flac cuetools

ROOT="${1:-.}"

find "$ROOT" -type f -iname "*.cue" | while IFS= read -r cuefile; do
    dir="$(dirname "$cuefile")"
    echo ""
    echo "══════════════════════════════════════════"
    echo "📁 $dir"

    # Find the audio file
    audiofile=""
    for ext in flac ape wav wv; do
        match="$(find "$dir" -maxdepth 1 -iname "*.${ext}" | head -1)"
        if [[ -n "$match" ]]; then
            audiofile="$match"
            break
        fi
    done

    if [[ -z "$audiofile" ]]; then
        echo "  ⚠️  No audio file found — skipping."
        continue
    fi

    echo "  🎵 Audio: $(basename "$audiofile")"
    echo "  📋 CUE:   $(basename "$cuefile")"

    # ── Step 1: Split to WAV with plain numbered names (no Unicode involved) ──
    echo "  ⏳ Step 1: Splitting to WAV tracks..."
    cd "$dir" || continue

    shnsplit \
        -f "$cuefile" \
        -o wav \
        -a "track" \
        -n "%02d" \
        -O always \
        "$audiofile" 2>&1

    wavcount=$(ls "$dir"/track*.wav 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$wavcount" -eq 0 ]]; then
        echo "  ❌ Split failed — no WAV files created."
        continue
    fi
    echo "  ✅ Created $wavcount WAV tracks."

    # ── Step 2: Re-encode WAV → FLAC (skip pregap track00) ──
    echo "  ⏳ Step 2: Encoding to FLAC..."
    for wav in "$dir"/track*.wav; do
        basename_wav="$(basename "$wav")"
        if [[ "$basename_wav" == "track00.wav" ]]; then
            echo "  ⏭️  Skipping pregap: $basename_wav"
            rm "$wav"
            continue
        fi
        flac --silent --compression-level-8 "$wav" && rm "$wav"
    done
    echo "  ✅ FLAC encoding done."

    # ── Step 3: Rename from CUE metadata using Python (Unicode-safe) ──
    echo "  ⏳ Step 3: Renaming from CUE metadata..."
    python3 - "$dir" "$cuefile" << 'PYEOF'
import sys, os, re

outdir  = sys.argv[1]
cuefile = sys.argv[2]

# Read CUE with multiple encoding fallbacks
for enc in ('utf-8-sig', 'utf-8', 'cp1251', 'latin-1'):
    try:
        with open(cuefile, encoding=enc) as f:
            lines = f.readlines()
        break
    except (UnicodeDecodeError, LookupError):
        continue

tracks = {}
current_track = None
performer = ""
for line in lines:
    line = line.strip()
    m = re.match(r'TRACK\s+(\d+)\s+AUDIO', line, re.IGNORECASE)
    if m:
        current_track = int(m.group(1))
        tracks[current_track] = {"title": "", "performer": performer}
    m = re.match(r'TITLE\s+"?(.+?)"?\s*$', line, re.IGNORECASE)
    if m:
        if current_track is not None:
            tracks[current_track]["title"] = m.group(1)
    m = re.match(r'PERFORMER\s+"?(.+?)"?\s*$', line, re.IGNORECASE)
    if m:
        if current_track is None:
            performer = m.group(1)
        else:
            tracks[current_track]["performer"] = m.group(1)

def safe_name(s):
    return re.sub(r'[\\/:*?"<>|]', '_', s).strip()

renamed = 0
for tracknum, info in sorted(tracks.items()):
    if tracknum == 0:
        continue  # skip pregap
    src = os.path.join(outdir, f"track{tracknum:02d}.flac")
    if not os.path.exists(src):
        print(f"  ⚠️  Missing: track{tracknum:02d}.flac")
        continue
    title = safe_name(info["title"]) or f"Track {tracknum:02d}"
    newname = f"{tracknum:02d} - {title}.flac"
    dst = os.path.join(outdir, newname)
    os.rename(src, dst)
    print(f"  🎵 {tracknum:02d}: {newname}")
    renamed += 1

print(f"  ✅ Renamed {renamed}/{len(tracks)} tracks.")
PYEOF

    # ── Step 4: Move original audio to Trash (keep CUE) ──
    echo "  ⏳ Step 4: Moving original audio to Trash..."
    osascript -e "tell app \"Finder\" to delete POSIX file \"$audiofile\""
    echo "  🗑️  Trashed: $(basename "$audiofile")"

    echo "  🎉 Done: $dir"
done

echo ""
echo "All directories processed."