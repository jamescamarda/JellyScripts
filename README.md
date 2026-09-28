# JellyScripts

A small collection of music utilities and Violentmonkey userscripts.

## CUE splitting and tagging

Install dependencies with `brew install shntool flac` (plus the appropriate
shntool decoder for APE or WavPack input).

```sh
./split_cue.sh /path/to/music/root
./split_cue.sh --tag-only /path/to/album.cue
./split_cue.sh --dry-run /path/to/music/root
```

`split_cue.sh` replaces the separate splitting and `cue_tag.sh` steps. It
recursively finds CUE sheets, splits single-image albums to numbered FLACs,
and applies CUE metadata. A complete existing numbered FLAC set is tagged
without splitting again. Multi-file CUEs must reference one existing FLAC
per track. Partial or ambiguous numbered sets are rejected.

UTF-8 and CP1251 CUEs are supported automatically. Use `--encoding cp1252`
(or another Python encoding name) for other legacy encodings; these cannot
be detected reliably. Tags include titles, artist/album artist, album, track
numbers, and available date, genre, composer, ISRC and disc-number fields.
Existing MusicBrainz IDs, artwork and unrelated tags are preserved.

The original image and CUE are retained. On macOS, `--trash-original` moves
the audio image to Finder Trash only after splitting, tagging and FLAC
validation succeed. Existing output files are never overwritten by a split.
Tagging intentionally updates existing tracks. Temporary output is isolated
and cleaned up; failures produce a nonzero exit status.

## Scripts

- [MusicBangz](MusicBangz/README.md) — search Discogs release and track metadata on configurable music services.
- [YandexTabLock](YandexTabLock/README.md) — keep normal Yandex result clicks in the current tab.
- [TIDAL to MusicBrainz](TidalToMusicBrainz/README.md) — prepare track streaming links on a MusicBrainz recording.

Install the [Violentmonkey](https://violentmonkey.github.io/) browser extension, then open a script file from this repository to install it.
