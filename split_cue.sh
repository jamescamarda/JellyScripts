#!/bin/bash
# Split and tag CUE albums. Python handles paths and metadata without shell expansion.
exec python3 - "$@" <<'PY'
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def read_cue(path, encoding):
    raw = path.read_bytes()
    if encoding:
        return raw.decode(encoding), encoding
    try:
        return raw.decode('utf-8-sig'), 'UTF-8'
    except UnicodeDecodeError:
        # Preserve the old scripts' Cyrillic default. Other legacy encodings
        # cannot be detected reliably; --encoding makes that choice explicit.
        return raw.decode('cp1251'), 'CP1251 (use --encoding for other legacy encodings)'


def value(text):
    text = text.strip()
    return text[1:-1] if text.startswith('"') and text.endswith('"') else text


def parse_cue(text):
    album, tracks, files = {}, [], []
    current = album
    for line in text.splitlines():
        line = line.strip()
        match = re.fullmatch(r'FILE\s+(?:"(.*)"|(\S+))\s+\S+', line, re.I)
        if match:
            files.append(match[1] or match[2])
            continue
        match = re.fullmatch(r'TRACK\s+(\d+)\s+(\S+)', line, re.I)
        if match:
            if match[2].upper() != 'AUDIO':
                raise ValueError('Only audio CUE sheets are supported')
            current = {'number': int(match[1]), 'file': files[-1] if files else None}
            tracks.append(current)
            continue
        match = re.match(r'(TITLE|PERFORMER|SONGWRITER|ISRC)\s+(.+)$', line, re.I)
        if match:
            current[match[1].upper()] = value(match[2])
        match = re.match(r'REM\s+(DATE|GENRE|DISCNUMBER|TOTALDISCS)\s+(.+)$', line, re.I)
        if match:
            current[match[1].upper()] = value(match[2])
    if not tracks or [t['number'] for t in tracks] != list(range(1, len(tracks) + 1)):
        raise ValueError('CUE must contain consecutive audio tracks starting at 01')
    return album, tracks, files


def safe_title(title):
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', title).strip().rstrip('.')


def existing_tracks(directory, tracks, files):
    # A multi-file CUE already specifies the exact ordering.
    if len(files) > 1:
        paths = [(directory / t['file']).resolve() for t in tracks if t['file']]
        if (len(paths) != len(tracks) or len(set(paths)) != len(paths)
                or not all(p.is_file() and p.suffix.lower() == '.flac' for p in paths)):
            raise ValueError('Multi-file CUE must reference one existing FLAC per track')
        return paths
    by_number = {}
    for path in directory.iterdir():
        match = re.match(r'^(\d+)(?:\D|$)', path.stem)
        if path.is_file() and path.suffix.lower() == '.flac' and match:
            number = int(match[1])
            if 1 <= number <= len(tracks):
                by_number.setdefault(number, []).append(path)
    if not by_number:
        return None
    if any(len(by_number.get(t['number'], [])) != 1 for t in tracks):
        raise ValueError('Partial or ambiguous numbered FLAC set; no files changed')
    return [by_number[t['number']][0] for t in tracks]


def source_audio(directory, files):
    if len(files) != 1:
        raise ValueError('Splitting requires a single FILE entry in the CUE')
    reference = directory / files[0]
    if reference.is_file():
        return reference.resolve()
    # CUEs often name a WAV while the actual image is FLAC/APE/WV.
    matches = [p for p in directory.iterdir() if p.is_file()
               and p.stem.casefold() == Path(files[0]).stem.casefold()
               and p.suffix.lower() in ('.flac', '.ape', '.wav', '.wv')]
    if len(matches) != 1:
        raise ValueError(f'Cannot uniquely locate CUE audio image: {files[0]}')
    return matches[0].resolve()


def tag(path, album, track, total):
    tags = {'TRACKNUMBER': f"{track['number']:02d}", 'TRACKTOTAL': str(total)}
    for field, entry in [('TITLE', track.get('TITLE')), ('ALBUM', album.get('TITLE')),
                         ('ARTIST', track.get('PERFORMER', album.get('PERFORMER'))),
                         ('ALBUMARTIST', album.get('PERFORMER')),
                         ('COMPOSER', track.get('SONGWRITER', album.get('SONGWRITER'))),
                         ('ISRC', track.get('ISRC')), ('DATE', track.get('DATE', album.get('DATE'))),
                         ('GENRE', track.get('GENRE', album.get('GENRE'))),
                         ('DISCNUMBER', album.get('DISCNUMBER')), ('DISCTOTAL', album.get('TOTALDISCS'))]:
        if entry:
            tags[field] = entry
    # Update only CUE-owned fields. Keep MusicBrainz IDs, artwork and other tags.
    run('metaflac', *(f'--remove-tag={key}' for key in tags),
        '--import-tags-from=-', str(path),
        input=''.join(f'{key}={entry}\n' for key, entry in tags.items()).encode('utf-8'))


def process(cue, options):
    text, encoding = read_cue(cue, options.encoding)
    album, tracks, files = parse_cue(text)
    directory = cue.parent
    existing = existing_tracks(directory, tracks, files)
    source = None if existing else source_audio(directory, files)
    if options.tag_only and not existing:
        raise ValueError('No complete split FLAC set found for --tag-only')
    destinations = existing or [directory / f"{t['number']:02d} - {safe_title(t.get('TITLE', '')) or 'Track ' + str(t['number'])}.flac"
                                for t in tracks]
    if not existing and any(p.exists() for p in destinations):
        raise ValueError('Output already exists; refusing to overwrite it')
    print(f"{cue}\n  {encoding}; {'tag' if existing else 'split + tag'} {len(tracks)} tracks", flush=True)
    if options.dry_run:
        return
    # Never mix stale temporary tracks with this run. Stage on the destination
    # filesystem so completed files can be published with atomic file operations.
    with tempfile.TemporaryDirectory(prefix='.cue-work-', dir=directory) as work:
        stage = Path(work)
        if existing:
            outputs = [stage / f"track{t['number']:02d}.flac" for t in tracks]
            for src, dst in zip(existing, outputs):
                shutil.copy2(src, dst)
        else:
            normalized = stage / 'album.cue'
            normalized.write_text(text, encoding='utf-8')
            run('shnsplit', '-f', str(normalized), '-o', 'wav', '-a', 'track',
                '-n', '%02d', '-O', 'never', '-d', str(stage), str(source))
            expected = {f"track{t['number']:02d}.wav" for t in tracks}
            actual = {p.name for p in stage.glob('track*.wav')}
            if actual - {'track00.wav'} != expected:
                raise ValueError(f'Split output does not match CUE: {sorted(actual)}')
            outputs = []
            for track in tracks:
                wav = stage / f"track{track['number']:02d}.wav"
                run('flac', '--silent', '--compression-level-8', str(wav))
                outputs.append(wav.with_suffix('.flac'))
                wav.unlink()
            # Preserve any pregap emitted by shnsplit instead of discarding audio.
            pregap = stage / 'track00.wav'
            if pregap.exists():
                target = directory / '00 - Pregap.flac'
                if target.exists():
                    raise ValueError('Pregap output already exists')
                run('flac', '--silent', '--compression-level-8', str(pregap))
                outputs.append(pregap.with_suffix('.flac'))
                destinations.append(target)
        for output, track in zip(outputs, tracks):
            tag(output, album, track, len(tracks))
        for output in outputs:
            run('flac', '--silent', '--test', str(output))
        for output, destination in zip(outputs, destinations):
            if existing:
                os.replace(output, destination)
            else:
                os.link(output, destination)  # fails rather than overwriting
        if source and options.trash_original:
            # Pass the path as an argument, not interpolated AppleScript source.
            run('osascript', '-e', 'on run argv\ntell application "Finder" to delete POSIX file (item 1 of argv)\nend run', str(source))
    print('  Done.', flush=True)


def main():
    parser = argparse.ArgumentParser(prog='split_cue.sh', description='Split CUE audio images to tagged FLACs, or tag an existing split album.')
    parser.add_argument('root', nargs='?', default='.', help='CUE file or directory to search recursively')
    parser.add_argument('--tag-only', action='store_true', help='Only tag existing split FLAC files')
    parser.add_argument('--encoding', help='Explicit CUE encoding, e.g. cp1252; default UTF-8 then CP1251')
    parser.add_argument('--trash-original', action='store_true', help='Move the source image to macOS Trash after successful splitting, tagging and validation')
    parser.add_argument('--dry-run', action='store_true', help='Validate inputs and print the operation without changing files')
    options = parser.parse_args()
    root = Path(options.root).expanduser().resolve()
    if not root.exists():
        parser.error(f'Path does not exist: {root}')
    cues = [root] if root.is_file() and root.suffix.lower() == '.cue' else sorted(
        p for p in root.rglob('*') if p.is_file() and p.suffix.lower() == '.cue')
    if not cues:
        parser.error('No CUE files found')
    if not options.dry_run:
        for tool in ['metaflac', 'flac'] + ([] if options.tag_only else ['shnsplit']) + (['osascript'] if options.trash_original else []):
            if not shutil.which(tool):
                parser.error(f'Missing dependency: {tool}')
    failures = 0
    for cue in cues:
        try:
            if root.is_dir() and sum(other.parent == cue.parent for other in cues) > 1:
                raise ValueError('Multiple CUE sheets in this folder; pass the intended CUE file explicitly')
            process(cue, options)
        except (OSError, ValueError, UnicodeError, subprocess.CalledProcessError) as error:
            failures += 1
            print(f'{cue}: ERROR: {error}', file=sys.stderr, flush=True)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
PY
