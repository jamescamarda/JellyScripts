#!/usr/bin/env -S deno run -A
/** Plan, split or match a CUE album, then tag and publish its tracks. */
import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  ByteVector,
  File,
  Id3v2FrameIdentifiers,
  Id3v2Tag,
  Mpeg4AppleTag,
  StringType,
  TagTypes,
  XiphComment,
} from "node-taglib-sharp";

export const audioExtensions = new Set([
  ".flac",
  ".mp3",
  ".m4a",
  ".wav",
  ".ogg",
  ".opus",
]);
const imageExtensions = new Set([".flac", ".ape", ".wav", ".wv"]);
const extension = (path: string) => extname(path).toLowerCase();
const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
};
const lexists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
};
const number = (value: number) => String(value).padStart(2, "0");
type Fields = Record<string, string>;
export interface Track {
  number: number;
  file: string;
  fields: Fields;
  startFrames?: number;
  duration?: number;
}
export interface Options {
  mode: "auto" | "split" | "match";
  tagOnly: boolean;
  rename: boolean;
  stripTags: boolean;
  tolerance: number;
  encoding?: string;
  trashOriginal: boolean;
  dryRun: boolean;
}
export const defaults: Options = {
  mode: "auto",
  tagOnly: false,
  rename: false,
  stripTags: false,
  tolerance: .5,
  trashOriginal: true,
  dryRun: false,
};
export interface Plan {
  cue: string;
  text: string;
  encoding: string;
  album: Fields;
  tracks: Track[];
  inputs?: string[];
  source?: string;
  destinations: string[];
}

export function run(command: string, args: string[]) {
  const result = new Deno.Command(command, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (!result.success) {
    throw new Error(
      `${command} failed (${result.code}): ${
        new TextDecoder().decode(result.stderr).trim()
      }`,
    );
  }
  return result.stdout;
}

export function readCue(path: string, encoding?: string) {
  const bytes = readFileSync(path);
  if (encoding) {
    return {
      text: new TextDecoder(encoding, { fatal: true }).decode(bytes),
      encoding,
    };
  }
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "UTF-8",
    };
  } catch {
    return {
      text: new TextDecoder("windows-1251", { fatal: true }).decode(bytes),
      encoding: "CP1251 (override with --encoding if needed)",
    };
  }
}

export function parseCue(text: string) {
  const album: Fields = {}, tracks: Track[] = [], files: string[] = [];
  let current = album;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let match = /^FILE\s+(?:"(.*)"|(\S+))\s+\S+$/i.exec(line);
    if (match) {
      files.push(match[1] ?? match[2]);
      continue;
    }
    match = /^TRACK\s+(\d+)\s+(\S+)$/i.exec(line);
    if (match) {
      if (match[2].toUpperCase() !== "AUDIO" || !files.length) {
        throw new Error("Every CUE track must be AUDIO and follow FILE");
      }
      current = {};
      tracks.push({
        number: Number(match[1]),
        file: files.at(-1)!,
        fields: current,
      });
      continue;
    }
    match = /^INDEX\s+01\s+(\d+):(\d+):(\d+)$/i.exec(line);
    if (match) {
      const [minutes, seconds, frames] = match.slice(1).map(Number),
        track = tracks.at(-1);
      if (
        !track || seconds >= 60 || frames >= 75 ||
        track.startFrames !== undefined
      ) throw new Error("Invalid or duplicate INDEX 01 timestamp");
      track.startFrames = (minutes * 60 + seconds) * 75 + frames;
      continue;
    }
    match = /^(TITLE|PERFORMER|SONGWRITER|ISRC)\s+(.+)$/i.exec(line) ??
      /^REM\s+(DATE|GENRE|DISCNUMBER|TOTALDISCS)\s+(.+)$/i.exec(line);
    if (match) {
      const value = match[2].replace(/^"(.*)"$/, "$1");
      if ([...value].some((c) => c.charCodeAt(0) < 32)) {
        throw new Error("Control characters in CUE metadata");
      }
      current[match[1].toUpperCase()] = value;
    }
  }
  if (!tracks.length || tracks.some((t, i) => t.number !== i + 1)) {
    throw new Error("CUE must contain consecutive audio tracks starting at 01");
  }
  if (tracks.some((t) => t.startFrames === undefined)) {
    throw new Error("Every CUE track needs INDEX 01");
  }
  for (let i = 1; i < tracks.length; i++) {
    const left = tracks[i - 1], right = tracks[i];
    if (left.file === right.file) {
      const delta = right.startFrames! - left.startFrames!;
      if (delta <= 0) {
        throw new Error("INDEX 01 timestamps must increase within each file");
      }
      left.duration = delta / 75;
    }
  }
  for (const key of ["DISCNUMBER", "TOTALDISCS"]) {
    if (album[key] && !/^[1-9]\d*$/.test(album[key])) {
      throw new Error(`${key} must be a positive integer`);
    }
  }
  return { album, tracks, files };
}

export function duration(path: string) {
  const file = File.createFromPath(path);
  try {
    const length = file.properties.durationMilliseconds / 1000;
    if (!Number.isFinite(length) || length <= 0) {
      throw new Error(`Cannot read audio duration: ${path}`);
    }
    return length;
  } finally {
    file.dispose();
  }
}

/** Require a unique perfect assignment; nearest-first matching can reach dead ends. */
export function matchDurations(
  tracks: Track[],
  candidates: string[],
  tolerance: number,
  lengths?: number[],
) {
  if (candidates.length !== tracks.length) {
    throw new Error(
      `Expected exactly ${tracks.length} tracks, found ${candidates.length}; no files changed`,
    );
  }
  lengths ??= candidates.map(duration);
  const choices = tracks.map((t) =>
    lengths!.flatMap((length, i) =>
      t.duration === undefined || Math.abs(t.duration - length) <= tolerance
        ? [i]
        : []
    )
  );
  function assignment(skipTrack = -1, skipFile = -1) {
    const owners = new Map<number, number>();
    function place(track: number, visited: Set<number>): boolean {
      for (const file of choices[track]) {
        if ((track === skipTrack && file === skipFile) || visited.has(file)) {
          continue;
        }
        visited.add(file);
        if (!owners.has(file) || place(owners.get(file)!, visited)) {
          owners.set(file, track);
          return true;
        }
      }
      return false;
    }
    for (
      const track of tracks.map((_, i) => i).sort((a, b) =>
        choices[a].length - choices[b].length
      )
    ) if (!place(track, new Set())) return undefined;
    return new Map([...owners].map(([file, track]) => [track, file]));
  }
  const matched = assignment();
  if (!matched) {
    throw new Error(
      `No complete duration match within ${tolerance}s; no files changed`,
    );
  }
  for (const [track, file] of matched) {
    if (assignment(track, file)) {
      throw new Error(
        "Ambiguous duration match; use exact FILE references or numbered tracks with --tag-only",
      );
    }
  }
  return tracks.map((_, i) => candidates[matched.get(i)!]);
}

function imagePath(directory: string, files: string[]) {
  if (files.length !== 1) return undefined;
  const reference = resolve(directory, files[0]);
  if (isFile(reference)) return realpathSync(reference);
  const stem = basename(files[0], extname(files[0])).toLowerCase();
  const matches = readdirSync(directory).map((name) => join(directory, name))
    .filter((p) =>
      isFile(p) && imageExtensions.has(extension(p)) &&
      basename(p, extname(p)).toLowerCase() === stem
    );
  if (matches.length > 1) {
    throw new Error(`Multiple possible images for ${files[0]}`);
  }
  return matches[0] && realpathSync(matches[0]);
}

export function referencedTracks(
  directory: string,
  tracks: Track[],
  files: string[],
) {
  if (files.length <= 1) return undefined;
  const paths = tracks.map((t) => resolve(directory, t.file));
  for (const p of paths) {
    if (
      !isFile(p) || lstatSync(p).isSymbolicLink() ||
      !audioExtensions.has(extension(p))
    ) {
      throw new Error(
        "Multi-file CUE must reference one existing supported audio file per track, without symlinks",
      );
    }
  }
  const canonical = paths.map((p) => realpathSync(p));
  if (new Set(canonical).size !== tracks.length) {
    throw new Error("Multi-file CUE reuses a track file");
  }
  return canonical;
}

function numberedTracks(directory: string, tracks: Track[], source?: string) {
  const byNumber = new Map<number, string[]>();
  for (const name of readdirSync(directory)) {
    const path = join(directory, name),
      n = Number(/^(\d+)(?:\D|$)/.exec(basename(name, extname(name)))?.[1]);
    if (
      !isFile(path) || !audioExtensions.has(extension(path)) ||
      realpathSync(path) === source || n < 1 || n > tracks.length ||
      !Number.isInteger(n)
    ) continue;
    byNumber.set(n, [...(byNumber.get(n) ?? []), path]);
  }
  if (!byNumber.size) return undefined;
  if (tracks.some((t) => byNumber.get(t.number)?.length !== 1)) {
    throw new Error(
      "Partial or ambiguous numbered track set; no files changed",
    );
  }
  return tracks.map((t) => byNumber.get(t.number)![0]);
}

function trackName(track: Track, album: Fields, ext: string, artist: boolean) {
  const parts = [number(track.number)];
  const performer = track.fields.PERFORMER ?? album.PERFORMER;
  const title = track.fields.TITLE || `Track ${track.number}`;
  // Some CUEs already include "Artist - " in TITLE. Preserve the supplied
  // title while avoiding another artist prefix in the filename.
  const includesArtist = performer && title.normalize("NFC").toLowerCase()
    .startsWith(`${performer} - `.normalize("NFC").toLowerCase());
  if (artist && performer && !includesArtist) parts.push(performer);
  parts.push(title);
  let stem = parts.join(" - ").replace(/[\\/:*?"<>|]/g, "_").trim()
    .replace(/\.+$/, "");
  while (new TextEncoder().encode(stem).length > 240) {
    stem = [...stem].slice(0, -1).join("");
  }
  return stem + ext;
}

export function validateDestinations(destinations: string[], inputs: string[]) {
  if (
    new Set(destinations.map((p) => p.toLowerCase())).size !==
      destinations.length
  ) throw new Error("Output filenames collide");
  for (const path of destinations) {
    if (lexists(path) && !inputs.includes(path)) {
      throw new Error(`Output already exists: ${path}`);
    }
  }
}

export function makePlan(cue: string, options: Options): Plan {
  cue = realpathSync(cue);
  const { text, encoding } = readCue(cue, options.encoding),
    { album, tracks, files } = parseCue(text),
    directory = dirname(cue);
  const source = imagePath(directory, files);
  let inputs = referencedTracks(directory, tracks, files);
  if (options.mode === "split") {
    if (files.length !== 1 || !source) {
      throw new Error("Splitting requires one existing CUE audio image");
    }
    inputs = undefined;
  } else if (!inputs) {
    if (options.mode !== "match") {
      inputs = numberedTracks(directory, tracks, source);
    }
    if (!inputs && (options.mode === "match" || options.tagOnly || !source)) {
      const candidates = readdirSync(directory).map((n) => join(directory, n))
        .filter((p) =>
          isFile(p) && audioExtensions.has(extension(p)) &&
          !/^00(?:\D|$)/.test(basename(p)) &&
          (tracks.length === 1 || realpathSync(p) !== source)
        ).sort();
      inputs = matchDurations(tracks, candidates, options.tolerance);
    }
  }
  if (!inputs && (!source || options.tagOnly)) {
    throw new Error("No audio image or complete existing track set found");
  }
  if (!inputs && !imageExtensions.has(extension(source!))) {
    throw new Error(
      "Splitting supports FLAC, WAV, APE and WV images; use --mode match for existing tracks",
    );
  }
  if (inputs?.some((p) => lstatSync(p).isSymbolicLink())) {
    throw new Error("Refusing to replace symbolic-link tracks");
  }
  const destinations = inputs
    ? tracks.map((t, i) =>
      options.rename
        ? join(directory, trackName(t, album, extension(inputs![i]), true))
        : inputs![i]
    )
    : tracks.map((t) =>
      join(directory, trackName(t, album, ".flac", options.rename))
    );
  validateDestinations(destinations, inputs ?? []);
  return {
    cue,
    text,
    encoding,
    album,
    tracks,
    inputs,
    source: source && !inputs?.some((p) => realpathSync(p) === source)
      ? source
      : undefined,
    destinations,
  };
}

export function tagFile(
  path: string,
  album: Fields,
  track: Track,
  total: number,
  strip: boolean,
) {
  const before = duration(path), file = File.createFromPath(path);
  try {
    if (strip) file.removeTags(TagTypes.AllTags);
    // Recreate the native writable tag after removal (Ogg cannot remove its container).
    const native = extension(path) === ".m4a"
      ? TagTypes.Apple
      : [".flac", ".ogg", ".opus"].includes(extension(path))
      ? TagTypes.Xiph
      : TagTypes.Id3v2;
    file.getTag(native, true);
    const tag = file.tag, fields = { ...album, ...track.fields };
    if (track.fields.TITLE) tag.title = track.fields.TITLE;
    if (album.TITLE) tag.album = album.TITLE;
    if (fields.PERFORMER) tag.performers = [fields.PERFORMER];
    if (album.PERFORMER) tag.albumArtists = [album.PERFORMER];
    if (fields.SONGWRITER) tag.composers = [fields.SONGWRITER];
    if (track.fields.ISRC) tag.isrc = track.fields.ISRC;
    if (fields.GENRE) tag.genres = [fields.GENRE];
    tag.track = track.number;
    tag.trackCount = total;
    if (album.DISCNUMBER) tag.disc = Number(album.DISCNUMBER);
    if (album.TOTALDISCS) tag.discCount = Number(album.TOTALDISCS);
    if (fields.DATE) {
      const nativeTag = file.getTag(native, true);
      if (nativeTag instanceof XiphComment) {
        nativeTag.setFieldAsStrings("DATE", fields.DATE);
      } else if (nativeTag instanceof Id3v2Tag) {
        nativeTag.setTextFrame(Id3v2FrameIdentifiers.TDRC, fields.DATE);
      } else if (nativeTag instanceof Mpeg4AppleTag) {
        nativeTag.setQuickTimeString(
          ByteVector.fromString("©day", StringType.Latin1),
          fields.DATE,
        );
      }
    }
    file.save();
  } finally {
    file.dispose();
  }
  if (Math.abs(duration(path) - before) > .05) {
    throw new Error(`Audio duration changed while tagging ${path}`);
  }
}

export function fingerprint(path: string) {
  const s = statSync(path, { bigint: true });
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
}
export class RecoveryRequired extends Error {}

/** Preserve originals until every staged output has been published; restore on failure. */
export function publish(
  outputs: string[],
  destinations: string[],
  inputs: string[],
  stage: string,
  fingerprints: Map<string, string>,
  link = linkSync,
) {
  validateDestinations(destinations, inputs);
  if (inputs.some((p) => fingerprint(p) !== fingerprints.get(p))) {
    throw new Error("An input changed while processing; no files published");
  }
  writeFileSync(
    join(stage, "recovery.json"),
    JSON.stringify({ inputs, destinations }, null, 2),
  );
  const backups = new Map<string, string>(),
    published: { path: string; inode: number }[] = [];
  try {
    inputs.forEach((path, i) => {
      const backup = join(stage, `original-${i}${extname(path)}`);
      renameSync(path, backup);
      backups.set(path, backup);
    });
    outputs.forEach((output, i) => {
      link(output, destinations[i]);
      published.push({ path: destinations[i], inode: statSync(output).ino });
    });
  } catch (error) {
    const failures: string[] = [];
    for (const { path, inode } of published.reverse()) {
      try {
        if (statSync(path).ino !== inode) {
          throw new Error("Published file replaced by another process");
        }
        unlinkSync(path);
      } catch (e) {
        failures.push(String(e));
      }
    }
    for (const [path, backup] of backups) {
      try {
        link(backup, path);
      } catch (e) {
        failures.push(String(e));
      }
    }
    if (failures.length) {
      throw new RecoveryRequired(
        `Rollback incomplete; originals retained in ${stage}: ${
          failures.join("; ")
        }`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Verify existing splits reproduce the source PCM before removing an old image. */
export function verifyFlacReconstruction(source: string, tracks: string[]) {
  if (
    extension(source) !== ".flac" ||
    tracks.some((p) => extension(p) !== ".flac")
  ) {
    throw new Error(
      "Cannot verify existing splits for image cleanup: only FLAC is supported; use --keep-original",
    );
  }
  const expected = new TextDecoder().decode(
    run("metaflac", ["--show-md5sum", source]),
  ).trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(expected) || /^0+$/.test(expected)) {
    throw new Error(
      "Source FLAC has no audio checksum; image retained (use --keep-original)",
    );
  }
  const format = (path: string) =>
    new TextDecoder().decode(
      run("metaflac", [
        "--show-sample-rate",
        "--show-channels",
        "--show-bps",
        path,
      ]),
    ).trim();
  const sourceFormat = format(source);
  const hash = createHash("md5");
  for (const track of tracks) {
    if (format(track) !== sourceFormat) {
      throw new Error(
        "Track sample format differs from the source; image retained",
      );
    }
    hash.update(
      run("flac", [
        "--silent",
        "--decode",
        "--stdout",
        "--force-raw-format",
        "--endian=little",
        "--sign=signed",
        track,
      ]),
    );
  }
  if (hash.digest("hex") !== expected) {
    throw new Error(
      "Existing tracks do not reconstruct the source audio exactly; image retained",
    );
  }
}

export function trashImage(path: string) {
  if (Deno.build.os !== "darwin") {
    throw new Error(
      "Automatic image cleanup requires macOS Finder Trash; use --keep-original",
    );
  }
  run("osascript", [
    "-e",
    'on run argv\nset targetFile to (POSIX file (item 1 of argv)) as alias\ntell application "Finder" to delete targetFile\nend run',
    path,
  ]);
}

export function processAlbum(
  plan: Plan,
  options: Options,
  tag = tagFile,
  trash = trashImage,
) {
  console.log(
    `${plan.cue}\n  ${plan.encoding}; ${
      plan.inputs ? "match/tag" : "split/tag"
    } ${plan.tracks.length} tracks`,
  );
  plan.destinations.forEach((target, i) =>
    console.log(
      `  ${number(i + 1)}: ${basename(plan.inputs?.[i] ?? plan.source!)} -> ${
        basename(target)
      }`,
    )
  );
  if (plan.source && options.trashOriginal) {
    console.log("  Move album image to Trash after validation.");
  }
  if (options.dryRun) return;
  if (plan.source && options.trashOriginal && Deno.build.os !== "darwin") {
    throw new Error(
      "Automatic image cleanup requires macOS Finder Trash; use --keep-original",
    );
  }
  const stage = mkdtempSync(join(dirname(plan.cue), ".cue-work-"));
  let keepStage = false;
  try {
    const sourceFingerprint = plan.source
      ? fingerprint(plan.source)
      : undefined;
    const fingerprints = new Map(
      (plan.inputs ?? []).map((p) => [p, fingerprint(p)]),
    );
    const destinations = [...plan.destinations];
    let outputs: string[];
    if (plan.inputs) {
      outputs = plan.inputs.map((src, i) => {
        const dst = join(stage, `track${number(i + 1)}${extension(src)}`);
        copyFileSync(src, dst);
        return dst;
      });
    } else {
      const normalized = join(stage, "album.cue");
      writeFileSync(normalized, plan.text);
      run("shnsplit", [
        "-f",
        normalized,
        "-o",
        "wav",
        "-a",
        "track",
        "-n",
        "%02d",
        "-O",
        "never",
        "-d",
        stage,
        plan.source!,
      ]);
      const expected = plan.tracks.map((t) => `track${number(t.number)}.wav`);
      const actual = readdirSync(stage).filter((n) =>
        /^track.*\.wav$/.test(n) && n !== "track00.wav"
      ).sort();
      if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
        throw new Error(`Split output does not match CUE: ${actual}`);
      }
      outputs = expected.map((name) => {
        const wav = join(stage, name);
        run("flac", ["--silent", "--compression-level-8", wav]);
        unlinkSync(wav);
        return wav.replace(/\.wav$/, ".flac");
      });
    }
    outputs.forEach((output, i) =>
      tag(
        output,
        plan.album,
        plan.tracks[i],
        plan.tracks.length,
        options.stripTags,
      )
    );
    const pregap = join(stage, "track00.wav");
    if (existsSync(pregap)) {
      const target = join(dirname(plan.cue), "00 - Pregap.flac");
      validateDestinations([...destinations, target], plan.inputs ?? []);
      run("flac", ["--silent", "--compression-level-8", pregap]);
      outputs.push(pregap.replace(/\.wav$/, ".flac"));
      destinations.push(target);
    }
    for (const output of outputs) {
      if (extension(output) === ".flac") {
        run("flac", ["--silent", "--test", output]);
      }
    }
    if (plan.inputs && plan.source && options.trashOriginal) {
      const audio = [...outputs];
      if (plan.tracks[0].startFrames! > 0) {
        const pregap = join(dirname(plan.cue), "00 - Pregap.flac");
        if (!isFile(pregap)) {
          throw new Error("Initial pregap is missing; image retained");
        }
        audio.unshift(pregap);
      }
      verifyFlacReconstruction(plan.source, audio);
    }
    try {
      publish(outputs, destinations, plan.inputs ?? [], stage, fingerprints);
    } catch (e) {
      keepStage = e instanceof RecoveryRequired;
      throw e;
    }
    if (plan.source && options.trashOriginal) {
      if (fingerprint(plan.source) !== sourceFingerprint) {
        throw new Error(
          "Source image changed during processing; image retained",
        );
      }
      trash(plan.source);
      console.log("  Album image moved to Trash.");
    }
  } finally {
    if (!keepStage) rmSync(stage, { recursive: true });
  }
  console.log("  Done.");
}

const help =
  `CUE Audio: split images or match existing tracks, then tag and optionally rename.
Usage: ./split_cue.sh [options] [CUE file or directory (default .)]
  --mode auto|split|match   Default auto: exact/numbered tracks, image, then durations
  --tag-only               Use existing tracks, never split
  --rename                 NN - Artist - Title filenames
  --strip-tags             Remove existing tags and artwork first
  --tolerance SECONDS      Maximum duration difference (default 0.5)
  --encoding ENCODING      Override UTF-8 / CP1251 detection
  --keep-original          Retain the album image (default: move to macOS Trash)
  --trash-original         Explicitly request the default image cleanup
  --dry-run                Plan without changing files
  --dir, -d DIRECTORY      Legacy album directory
  --cue, -c FILE           Select one CUE in the directory
  --help, -h               Show help`;

function discover(path: string): string[] {
  if (isFile(path)) return extension(path) === ".cue" ? [path] : [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() && !entry.name.startsWith(".cue-work-")
      ? discover(join(path, entry.name))
      : entry.isFile() && extension(entry.name) === ".cue"
      ? [join(path, entry.name)]
      : []
  ).sort();
}

export function main(args = Deno.args) {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        mode: { type: "string" },
        "tag-only": { type: "boolean" },
        rename: { type: "boolean" },
        "strip-tags": { type: "boolean" },
        tolerance: { type: "string" },
        encoding: { type: "string" },
        "trash-original": { type: "boolean" },
        "keep-original": { type: "boolean" },
        "dry-run": { type: "boolean" },
        dir: { type: "string", short: "d" },
        cue: { type: "string", short: "c" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      console.log(help);
      return 0;
    }
    if (positionals.length > 1) {
      throw new Error("Expected one CUE file or directory");
    }
    if (values["keep-original"] && values["trash-original"]) {
      throw new Error(
        "--keep-original cannot be combined with --trash-original",
      );
    }
    const mode = values.mode ?? defaults.mode;
    if (!["auto", "split", "match"].includes(mode)) {
      throw new Error("--mode must be auto, split or match");
    }
    const options: Options = {
      mode: mode as Options["mode"],
      tagOnly: !!values["tag-only"],
      rename: !!values.rename,
      stripTags: !!values["strip-tags"],
      tolerance: Number(values.tolerance ?? defaults.tolerance),
      encoding: values.encoding,
      trashOriginal: !values["keep-original"],
      dryRun: !!values["dry-run"],
    };
    if (!Number.isFinite(options.tolerance) || options.tolerance < 0) {
      throw new Error("--tolerance must be finite and nonnegative");
    }
    if (mode === "split" && options.tagOnly) {
      throw new Error("--tag-only cannot be combined with --mode split");
    }
    const expandHome = (p: string) =>
      p === "~"
        ? homedir()
        : p.startsWith("~/")
        ? join(homedir(), p.slice(2))
        : p;
    let root = resolve(expandHome(values.dir ?? positionals[0] ?? "."));
    if (values.cue) root = resolve(root, expandHome(values.cue));
    root = realpathSync(root);
    const cues = discover(root);
    if (!cues.length) throw new Error("No CUE files found");
    const counts = new Map<string, number>();
    for (const cue of cues) {
      counts.set(dirname(cue), (counts.get(dirname(cue)) ?? 0) + 1);
    }
    let failures = 0;
    for (const cue of cues) {
      try {
        if (!isFile(root) && counts.get(dirname(cue))! > 1) {
          throw new Error(
            "Multiple CUE sheets in this folder; select the intended CUE explicitly",
          );
        }
        processAlbum(makePlan(cue, options), options);
      } catch (e) {
        failures++;
        console.error(`${cue}: ERROR: ${(e as Error).message}`);
      }
    }
    return failures ? 1 : 0;
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) Deno.exit(main());
