import { parseArgs } from "jsr:@std/cli/parse-args";
import { parseFile as parseAudioFile } from "npm:music-metadata";
import NodeID3 from "npm:node-id3";
import MetaFlac from "npm:metaflac-js";
import * as path from "node:path";

interface CueTrack {
  number: number;
  title: string;
  performer?: string;
  duration?: number;
}

interface AudioFileInfo {
  filePath: string;
  fileName: string;
  duration: number;
}

/**
 * Reads a text file attempting Windows-1251 decoding (common for Russian CUE files)
 * falling back to UTF-8.
 */
async function readCueFileText(filePath: string): Promise<string> {
  const bytes = await Deno.readFile(filePath);

  try {
    const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
    const text = utf8Decoder.decode(bytes);
    if (!text.includes("\uFFFD")) return text;
  } catch {
    // Decoding failed, fallback to Windows-1251
  }

  const win1251Decoder = new TextDecoder("windows-1251");
  return win1251Decoder.decode(bytes);
}

/**
 * Parses CUE sheet track listings, artists, and calculates track durations from INDEX timestamps.
 */
async function parseCueTracks(cueFilePath: string): Promise<CueTrack[]> {
  const cueContent = await readCueFileText(cueFilePath);
  const lines = cueContent.split(/\r?\n/);

  let albumPerformer = "";
  const tracks: CueTrack[] = [];
  let currentTrack: Partial<CueTrack> | null = null;
  let index01Sec: number | null = null;
  const rawIndexMap: number[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Album-level PERFORMER
    const perfMatch = trimmed.match(/^PERFORMER\s+"?(.*?)"?$/i);
    if (perfMatch && !currentTrack) {
      albumPerformer = perfMatch[1];
      continue;
    }

    // TRACK 01 AUDIO
    const trackMatch = trimmed.match(/^TRACK\s+(\d+)\s+AUDIO/i);
    if (trackMatch) {
      if (currentTrack && index01Sec !== null) {
        rawIndexMap.push(index01Sec);
        tracks.push(currentTrack as CueTrack);
      }
      currentTrack = {
        number: parseInt(trackMatch[1], 10),
        title: "",
        performer: albumPerformer,
      };
      index01Sec = null;
      continue;
    }

    if (currentTrack) {
      // TITLE
      const titleMatch = trimmed.match(/^TITLE\s+"?(.*?)"?$/i);
      if (titleMatch && !currentTrack.title) {
        currentTrack.title = titleMatch[1];
      }

      // PERFORMER
      if (perfMatch) {
        currentTrack.performer = perfMatch[1];
      }

      // INDEX 01 00:00:00 (mm:ss:ff where ff is 1/75th sec)
      const indexMatch = trimmed.match(/^INDEX\s+01\s+(\d+):(\d+):(\d+)/i);
      if (indexMatch) {
        const mm = parseInt(indexMatch[1], 10);
        const ss = parseInt(indexMatch[2], 10);
        const ff = parseInt(indexMatch[3], 10);
        index01Sec = mm * 60 + ss + ff / 75.0;
      }
    }
  }

  if (currentTrack && index01Sec !== null) {
    rawIndexMap.push(index01Sec);
    tracks.push(currentTrack as CueTrack);
  }

  // Calculate duration between index markers
  for (let i = 0; i < tracks.length; i++) {
    if (i < tracks.length - 1) {
      tracks[i].duration = rawIndexMap[i + 1] - rawIndexMap[i];
    } else {
      tracks[i].duration = undefined;
    }
  }

  return tracks;
}

/**
 * Scans directory and reads durations for all supported audio files.
 */
async function getAudioFilesInfo(folderPath: string): Promise<AudioFileInfo[]> {
  const supportedExtensions = new Set([".mp3", ".flac", ".m4a", ".wav", ".ogg"]);
  const audioFiles: AudioFileInfo[] = [];

  for await (const entry of Deno.readDir(folderPath)) {
    if (!entry.isFile) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!supportedExtensions.has(ext)) continue;

    const fullPath = path.join(folderPath, entry.name);
    try {
      const metadata = await parseAudioFile(fullPath);
      const duration = metadata.format.duration || 0;
      audioFiles.push({
        filePath: fullPath,
        fileName: entry.name,
        duration,
      });
    } catch (err) {
      console.error(`Failed to read metadata for: ${entry.name}`, err);
    }
  }

  return audioFiles.sort((a, b) =>
    a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: "base" })
  );
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, "").trim();
}

/**
 * Strips existing tags (including embedded artwork), applies fresh CUE metadata, and renames the file on disk.
 */
async function processFile(filePath: string, track: CueTrack, totalTracks: number): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  const dir = path.dirname(filePath);
  const trackStr = String(track.number).padStart(2, "0");

  console.log(`\n────────────────────────────────────────`);
  console.log(`Original File: ${path.basename(filePath)}`);
  console.log(`New Metadata : #${trackStr} | Artist: "${track.performer || "VA"}" | Title: "${track.title}"`);

  // 1. Strip all old tags (including APIC/PICTURE cover art blocks) & write new tags
  try {
    if (ext === ".mp3") {
      // Remove all ID3v1 and ID3v2 tags (including embedded APIC images)
      NodeID3.removeTags(filePath);

      const tags = {
        title: track.title,
        artist: track.performer,
        trackNumber: `${track.number}/${totalTracks}`,
      };
      NodeID3.write(tags, filePath);
    } else if (ext === ".flac") {
      const flac = new MetaFlac(filePath);

      // Remove all Vorbis text comments and picture blocks
      flac.removeAllTags();
      flac.removePictures();

      flac.setTag(`TITLE=${track.title}`);
      if (track.performer) flac.setTag(`ARTIST=${track.performer}`);
      flac.setTag(`TRACKNUMBER=${track.number}`);
      flac.setTag(`TRACKTOTAL=${totalTracks}`);
      flac.save();
    }
  } catch (err) {
    console.error(`⚠️ Error setting tags for ${path.basename(filePath)}:`, err);
  }

  // 2. Rename file on disk
  const cleanArtist = sanitizeFilename(track.performer || "");
  const cleanTitle = sanitizeFilename(track.title || "Track");

  const newFileName = cleanArtist
    ? `${trackStr} - ${cleanArtist} - ${cleanTitle}${ext}`
    : `${trackStr} - ${cleanTitle}${ext}`;

  const newFilePath = path.join(dir, newFileName);

  if (filePath !== newFilePath) {
    await Deno.rename(filePath, newFilePath);
    console.log(`Renamed To   : ${newFileName}`);
  } else {
    console.log(`Filename unchanged.`);
  }
}

async function matchAndTag(
  folderPath: string,
  cueFileName?: string,
  exactToleranceSec = 0.5
): Promise<void> {
  const absoluteFolder = path.resolve(folderPath);

  let targetCuePath: string;
  if (cueFileName) {
    targetCuePath = path.join(absoluteFolder, cueFileName);
  } else {
    let foundCue: string | undefined;
    for await (const entry of Deno.readDir(absoluteFolder)) {
      if (entry.isFile && entry.name.toLowerCase().endsWith(".cue")) {
        foundCue = entry.name;
        break;
      }
    }
    if (!foundCue) {
      console.error(`❌ No .cue file found in directory: ${absoluteFolder}`);
      Deno.exit(1);
    }
    targetCuePath = path.join(absoluteFolder, foundCue);
  }

  console.log(`📂 Directory: ${absoluteFolder}`);
  console.log(`📄 CUE File : ${path.basename(targetCuePath)}`);

  const cueTracks = await parseCueTracks(targetCuePath);
  console.log(`Parsed ${cueTracks.length} tracks from CUE sheet.`);

  const audioFiles = await getAudioFilesInfo(absoluteFolder);
  console.log(`Found ${audioFiles.length} audio files in directory.`);

  if (audioFiles.length === 0) {
    console.error("❌ No supported audio files found.");
    return;
  }

  const remainingFiles = [...audioFiles];
  const totalTracks = cueTracks.length;

  for (const track of cueTracks) {
    if (remainingFiles.length === 0) {
      console.warn(`\n⚠️ No remaining audio files available for Track #${track.number}`);
      break;
    }

    // Last track handling where CUE duration cannot be derived
    if (track.duration === undefined) {
      if (remainingFiles.length === 1) {
        const matchedFile = remainingFiles.pop()!;
        await processFile(matchedFile.filePath, track, totalTracks);
      } else {
        console.warn(
          `\n⚠️ Final Track #${track.number} ("${track.title}") skipped: multiple remaining files exist and duration cannot be computed from CUE.`
        );
      }
      continue;
    }

    // Match file by precise duration
    let matchedIndex = -1;
    let smallestDiff = Infinity;

    for (let i = 0; i < remainingFiles.length; i++) {
      const diff = Math.abs(remainingFiles[i].duration - track.duration);
      if (diff < smallestDiff) {
        smallestDiff = diff;
        matchedIndex = i;
      }
    }

    if (matchedIndex !== -1 && smallestDiff <= exactToleranceSec) {
      const matchedFile = remainingFiles.splice(matchedIndex, 1)[0];
      await processFile(matchedFile.filePath, track, totalTracks);
    } else {
      console.error(
        `\n❌ MISMATCH Track #${track.number} ("${track.title}"): ` +
        `Expected ~${track.duration.toFixed(2)}s, best candidate off by ${smallestDiff.toFixed(2)}s. Skipping.`
      );
    }
  }

  if (remainingFiles.length > 0) {
    console.warn(`\n⚠️ Unmatched files remaining in folder:`);
    for (const file of remainingFiles) {
      console.warn(`  - ${file.fileName} (${file.duration.toFixed(2)}s)`);
    }
  }
}

const args = parseArgs(Deno.args, {
  string: ["dir", "cue"],
  alias: { d: "dir", c: "cue" },
});

const targetDir = args.dir || args._[0]?.toString();

if (!targetDir) {
  console.log(`Usage: deno run --allow-read --allow-write matchAndTag.ts [DIRECTORY]`);
  Deno.exit(0);
}

matchAndTag(targetDir, args.cue).catch(console.error);