## CUE splitting, matching and tagging

`split_cue.sh` combines the former splitter and `matchAndTag.ts` into one
TypeScript implementation (`cue_audio.ts`). Install Deno and the audio tools:

```sh
cd CueAudio
brew install deno shntool flac
```

APE and WavPack images also need the appropriate shntool decoder. Deno fetches
the pinned TypeScript tagging dependency automatically on first use; dependency
versions and integrity hashes are recorded in `deno.lock`.

```sh
# Preview the combined workflow before changing files.
./split_cue.sh --dry-run /path/to/music/root
./split_cue.sh /path/to/music/root

# Match loose tracks by duration, tag, and rename NN - Artist - Title.
./split_cue.sh --mode match --rename /path/to/album.cue

# Tag existing tracks without splitting or changing filenames.
./split_cue.sh --tag-only /path/to/album.cue

# The old Deno entry point delegates to the same implementation.
deno run --allow-read --allow-write --allow-run --allow-env matchAndTag.ts /path/to/album --cue album.cue
```

The default `auto` mode recursively finds CUE sheets. It uses exact multi-file
CUE references or a complete numbered track set first, otherwise splits an
available single image, or matches loose tracks by duration. Splitting accepts
FLAC, WAV, APE and WV images and produces `NN - Title.flac`. Existing tracks
support FLAC, MP3, M4A, WAV, Ogg Vorbis and Opus. Use `--rename` for
artist/title filenames, or `--mode split` to explicitly request splitting. If a
CUE title already begins with the same `Artist -` prefix, `--rename` does not
add it again. CUE titles and embedded title tags remain as supplied.

Duration matching requires exactly one file per track and a unique complete
assignment within `--tolerance` seconds (default `0.5`). The last track of each
CUE FILE has no duration boundary and is assigned only when the remaining
constraints uniquely identify it. Ambiguous matches, partial numbered sets,
colliding filenames and multiple CUEs in one folder are rejected. Select an
individual CUE explicitly when an album folder contains several.

UTF-8 and CP1251 CUEs are supported automatically. Use `--encoding cp1252` (or
another TextDecoder encoding label) for other legacy encodings. Tags include
available title, artist/album artist, album, track totals, date, genre,
composer, ISRC and disc-number fields. Retagging preserves artwork, MusicBrainz
IDs and unrelated metadata by default; `--strip-tags` explicitly removes
existing tags and artwork first. Split outputs receive CUE metadata; artwork
from the source image is not copied.

The CUE is retained. On macOS, the source album image is moved to Finder Trash
by default after splitting, tagging, FLAC validation and publication succeed.
Use `--keep-original` to retain the image (required on other platforms);
`--trash-original` remains an explicit alias for the default cleanup. For albums
already split into FLAC tracks, cleanup first verifies that their combined
decoded audio (including any initial pregap) matches the source FLAC checksum
exactly. A missing or mismatched checksum retains the image and reports an
error. Cleanup of previously split non-FLAC images requires `--keep-original`.
Initial audio before the first track is retained as `00 - Pregap.flac`. Split
outputs never overwrite existing files. Retagging intentionally replaces the
selected tracks after staging the whole album. Publication failures attempt to
restore originals; an incomplete rollback retains originals and `recovery.json`
in a reported `.cue-work-*` directory. Publication across multiple files is not
atomic against process termination. Failures return a nonzero exit status;
`--dry-run` changes no files.

Run parser, matching, rollback and real-audio integration tests with:

```sh
brew install ffmpeg
deno task test
deno task check
```

FFmpeg is needed only for the integration tests. Runtime splitting uses shntool
and FLAC; tagging and duration matching run in TypeScript. You can also run the
combined command directly with `deno task start --dry-run /path/to/album.cue`.
