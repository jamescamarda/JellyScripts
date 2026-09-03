#!/bin/bash
# tag_from_cue.sh — tag split FLAC files from CUE metadata (encoding-safe)
# Usage: bash tag_from_cue.sh /path/to/music/root
# Requires: brew install cuetools

ROOT="${1:-.}"

find "$ROOT" -type f -iname "*.cue" | while IFS= read -r cuefile; do
    dir="$(dirname "$cuefile")"

    flaccount=$(ls "$dir"/[0-9]*.flac 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$flaccount" -eq 0 ]]; then
        echo "  ⚠️  No split FLAC files found in $dir — skipping."
        continue
    fi

    echo ""
    echo "══════════════════════════════════════════"
    echo "📁 $dir"
    echo "  📋 CUE: $(basename "$cuefile")"

    # Detect encoding and convert to UTF-8 temp file using Python
    tmpfile="$(mktemp /tmp/cuetag_XXXXXX.cue)"
    detected=$(python3 - "$cuefile" "$tmpfile" << 'PYEOF'
import sys

src  = sys.argv[1]
dst  = sys.argv[2]

raw = open(src, 'rb').read()

# Try encodings in order of likelihood
encodings = [
    ('utf-8-sig', 'UTF-8 BOM'),
    ('utf-8',     'UTF-8'),
    ('cp1251',    'CP1251 (Cyrillic)'),
    ('cp1252',    'CP1252 (Western European)'),
    ('latin-1',   'Latin-1'),
]

for enc, label in encodings:
    try:
        text = raw.decode(enc)
        # Extra check: if decoded as latin-1/cp1252, verify no Cyrillic replacement chars
        if enc in ('latin-1', 'cp1252'):
            # Try cp1251 first if there are high bytes
            high_bytes = sum(1 for b in raw if b > 127)
            if high_bytes > 0:
                try:
                    text = raw.decode('cp1251')
                    label = 'CP1251 (Cyrillic)'
                except:
                    pass
        open(dst, 'w', encoding='utf-8').write(text)
        print(label)
        break
    except (UnicodeDecodeError, LookupError):
        continue
PYEOF
)

    echo "  🔤 Encoding: $detected"
    echo "  ⏳ Tagging $flaccount FLAC files..."
    cuetag.sh "$tmpfile" "$dir"/[0-9]*.flac
    rm "$tmpfile"

    echo "  ✅ Done."
done

echo ""
echo "All directories processed."