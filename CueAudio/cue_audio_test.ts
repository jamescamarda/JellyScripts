import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ByteVector, File, Picture, PictureType } from "node-taglib-sharp";
import {
  defaults,
  fingerprint,
  main,
  makePlan,
  matchDurations,
  parseCue,
  processAlbum,
  publish,
  readCue,
  RecoveryRequired,
  referencedTracks,
  run,
  tagFile,
  type Track,
  verifyFlacReconstruction,
} from "./cue_audio.ts";

const root = dirname(fileURLToPath(import.meta.url));
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);
function withAlbum(fn: (directory: string) => void) {
  const directory = realpathSync(
    Deno.makeTempDirSync({ prefix: "cue-audio-test-" }),
  );
  try {
    fn(directory);
  } finally {
    rmSync(directory, { recursive: true });
  }
}
function cueText(file = "image.wav", starts = ["00:00:00", "00:01:00"]) {
  return `PERFORMER "Артист"\nTITLE "Album"\nREM DATE 2001-02-03\nREM GENRE "Test"\nREM DISCNUMBER 1\nREM TOTALDISCS 2\nFILE "${file}" WAVE\n` +
    starts.map((start, i) =>
      `  TRACK ${String(i + 1).padStart(2, "0")} AUDIO\n    TITLE "Song ${
        i + 1
      }"\n    INDEX 01 ${start}\n`
    ).join("");
}
function writeCue(directory: string, file?: string, starts?: string[]) {
  const path = join(directory, "album.cue");
  writeFileSync(path, cueText(file, starts));
  return path;
}
function generate(path: string, seconds: number) {
  const ext = path.split(".").at(-1)!;
  const codecs: Record<string, string> = {
    flac: "flac",
    mp3: "libmp3lame",
    m4a: "aac",
    wav: "pcm_s16le",
    ogg: "vorbis",
    opus: "libopus",
  };
  run("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:sample_rate=44100:duration=${seconds}`,
    "-ac",
    "2",
    "-strict",
    "-2",
    "-c:a",
    codecs[ext],
    path,
  ]);
}
function samples(path: string) {
  return run("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-i",
    path,
    "-map",
    "0:a:0",
    "-ar",
    "44100",
    "-f",
    "s16le",
    "-",
  ]);
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const audioDigest = (path: string) => digest(samples(path));
function concatSamples(paths: string[]) {
  return digest(Buffer.concat(paths.map(samples)));
}
function addMetadata(path: string) {
  const file = File.createFromPath(path);
  try {
    file.tag.musicBrainzReleaseId = "retained-id";
    file.tag.comment = "Unrelated comment";
    file.tag.pictures = [
      Picture.fromFullData(
        ByteVector.fromByteArray(png),
        PictureType.FrontCover,
        "image/png",
        "cover",
      ),
    ];
    file.save();
  } finally {
    file.dispose();
  }
}
function metadata(path: string) {
  const file = File.createFromPath(path);
  try {
    const tag = file.tag;
    return {
      title: tag.title,
      artist: tag.performers,
      album: tag.album,
      track: tag.track,
      total: tag.trackCount,
      disc: tag.disc,
      discs: tag.discCount,
      id: tag.musicBrainzReleaseId,
      comment: tag.comment,
      pictures: tag.pictures.map((p) => digest(p.data.toByteArray())),
    };
  } finally {
    file.dispose();
  }
}
const snapshot = (directory: string) =>
  Object.fromEntries(
    readdirSync(directory).sort().map(
      (n) => [n, digest(readFileSync(join(directory, n)))],
    ),
  );
const tracks = (durations: (number | undefined)[]): Track[] =>
  durations.map((duration, i) => ({
    number: i + 1,
    file: "",
    fields: {},
    duration,
  }));

Deno.test("parser: precise frames, album fields and UTF-8/CP1251", () =>
  withAlbum((dir) => {
    const cue = writeCue(dir, undefined, ["00:00:00", "00:01:37"]);
    const parsed = parseCue(readCue(cue).text);
    assert.equal(parsed.album.PERFORMER, "Артист");
    assert.equal(parsed.tracks[0].duration, 1 + 37 / 75);
    assert.equal(parsed.tracks[1].duration, undefined);
    // CP1251 bytes for Артист; ASCII surrounding text needs no conversion.
    writeFileSync(
      cue,
      Buffer.concat([
        Buffer.from('PERFORMER "'),
        Buffer.from([0xc0, 0xf0, 0xf2, 0xe8, 0xf1, 0xf2]),
        Buffer.from('"\n' + cueText().split("\n").slice(1).join("\n")),
      ]),
    );
    assert.match(readCue(cue).encoding, /CP1251/);
    assert.equal(parseCue(readCue(cue).text).album.PERFORMER, "Артист");
  }));
Deno.test("parser rejects missing/duplicate/out-of-order indexes and data tracks", () => {
  const text = cueText();
  for (
    const invalid of [
      text.replace("00:01:00", "00:00:00"),
      text.replace("00:01:00", "00:01:75"),
      text.replace("    INDEX 01 00:01:00\n", ""),
      text.replace("TRACK 02", "TRACK 03"),
      text.replace("TRACK 01 AUDIO", "TRACK 01 MODE1/2352"),
      text + "INDEX 01 00:03:00\n",
    ]
  ) assert.throws(() => parseCue(invalid));
});
Deno.test("duration matching avoids greedy dead ends and rejects ambiguity/no match", () => {
  assert.deepEqual(
    matchDurations(tracks([1, 1.4, undefined]), ["a", "b", "c"], .31, [
      1.1,
      .8,
      4,
    ]),
    ["b", "a", "c"],
  );
  assert.throws(
    () => matchDurations(tracks([1, undefined]), ["a", "b"], .31, [1.1, .8]),
    /Ambiguous/,
  );
  assert.throws(
    () =>
      matchDurations(tracks([1, 1.4, undefined]), ["a", "b", "c"], .01, [
        1.1,
        .8,
        4,
      ]),
    /complete duration/,
  );
  assert.throws(() => matchDurations(tracks([1]), [], .1, []), /exactly/);
});
Deno.test("multi-file CUE uses exact files and rejects reused paths/symlinks", () =>
  withAlbum((dir) => {
    const a = join(dir, "first.flac"), b = join(dir, "second.flac");
    writeFileSync(a, "");
    writeFileSync(b, "");
    const ts = tracks([undefined, undefined]);
    ts[0].file = a;
    ts[1].file = b;
    assert.deepEqual(referencedTracks(dir, ts, [a, b]), [a, b]);
    ts[1].file = "./first.flac";
    assert.throws(() => referencedTracks(dir, ts, [a, b]), /reuses/);
    const symlink = join(dir, "symlink.flac");
    Deno.symlinkSync(a, symlink);
    ts[1].file = symlink;
    assert.throws(() => referencedTracks(dir, ts, [a, b]), /symlinks/);
  }));
Deno.test("partial numbered sets and split output collisions fail before writing", () =>
  withAlbum((dir) => {
    const cue = writeCue(dir),
      image = join(dir, "image.wav"),
      partial = join(dir, "01 - partial.flac");
    writeFileSync(image, "");
    writeFileSync(partial, "");
    assert.throws(() => makePlan(cue, defaults), /Partial/);
    rmSync(partial);
    writeFileSync(join(dir, "01 - Song 1.flac"), "");
    assert.throws(
      () => makePlan(cue, { ...defaults, mode: "split" }),
      /already exists/,
    );
  }));
Deno.test("changed input is rejected before publication", () =>
  withAlbum((dir) => {
    const original = join(dir, "old.flac"),
      stage = join(dir, "stage"),
      output = join(stage, "new.flac");
    mkdirSync(stage);
    writeFileSync(original, "original");
    writeFileSync(output, "new");
    const fingerprints = new Map([[original, fingerprint(original)]]);
    writeFileSync(original, "changed externally");
    assert.throws(
      () => publish([output], [original], [original], stage, fingerprints),
      /input changed/,
    );
    assert.equal(readFileSync(original, "utf8"), "changed externally");
  }));
Deno.test("publication failure restores originals during a rename cycle", () =>
  withAlbum((dir) => {
    const originals = [join(dir, "02.flac"), join(dir, "01.flac")],
      stage = join(dir, "stage");
    mkdirSync(stage);
    const outputs = [join(stage, "1.flac"), join(stage, "2.flac")];
    originals.forEach((p, i) => writeFileSync(p, `original ${i}`));
    outputs.forEach((p) => writeFileSync(p, "new"));
    const fingerprints = new Map(originals.map((p) => [p, fingerprint(p)]));
    assert.throws(
      () =>
        publish(
          outputs,
          [...originals].reverse(),
          originals,
          stage,
          fingerprints,
          (source, target) => {
            if (source === outputs[1]) {
              throw new Error("simulated disk failure");
            }
            linkSync(source, target);
          },
        ),
      /simulated/,
    );
    originals.forEach((p, i) =>
      assert.equal(readFileSync(p, "utf8"), `original ${i}`)
    );
  }));
Deno.test("failed rollback retains original backups and recovery manifest", () =>
  withAlbum((dir) => {
    const original = join(dir, "old.flac"),
      stage = join(dir, "stage"),
      output = join(stage, "new.flac");
    mkdirSync(stage);
    writeFileSync(original, "original");
    writeFileSync(output, "new");
    assert.throws(
      () =>
        publish(
          [output],
          [join(dir, "new.flac")],
          [original],
          stage,
          new Map([[original, fingerprint(original)]]),
          () => {
            throw new Error("disk unavailable");
          },
        ),
      RecoveryRequired,
    );
    assert.equal(
      readFileSync(join(stage, "original-0.flac"), "utf8"),
      "original",
    );
    assert.ok(existsSync(join(stage, "recovery.json")));
  }));
Deno.test("multiple CUE sheets and invalid CLI arguments return failure without changes", () =>
  withAlbum((dir) => {
    writeCue(dir);
    writeFileSync(join(dir, "another.cue"), cueText());
    const before = snapshot(dir);
    assert.equal(main(["--dry-run", dir]), 1);
    for (
      const args of [
        ["--tolerance", "NaN"],
        ["--mode", "split", "--tag-only"],
        ["--bogus"],
        ["--mode", "wrong"],
      ]
    ) assert.equal(main(args), 2);
    assert.deepEqual(snapshot(dir), before);
  }));

for (const ext of ["flac", "mp3", "m4a", "wav", "ogg", "opus"]) {
  Deno.test(`${ext}: match/tag/rename/strip preserve decoded audio, IDs and artwork`, () =>
    withAlbum((dir) => {
      const first = join(dir, `omega.${ext}`),
        second = join(dir, `alpha.${ext}`);
      generate(first, 1);
      generate(second, 3);
      addMetadata(first);
      addMetadata(second);
      const before = [audioDigest(first), audioDigest(second)],
        picture = metadata(first).pictures;
      const cue = writeCue(dir),
        options = {
          ...defaults,
          mode: "match" as const,
          rename: true,
          tolerance: .1,
        };
      const plan = makePlan(cue, options);
      assert.deepEqual(plan.inputs, [first, second]);
      processAlbum(plan, options);
      assert.deepEqual(plan.destinations.map(audioDigest), before);
      assert.ok(!existsSync(first));
      const tags = metadata(plan.destinations[0]);
      assert.deepEqual({
        title: tags.title,
        artist: tags.artist,
        album: tags.album,
        track: tags.track,
        total: tags.total,
        disc: tags.disc,
        discs: tags.discs,
      }, {
        title: "Song 1",
        artist: ["Артист"],
        album: "Album",
        track: 1,
        total: 2,
        disc: 1,
        discs: 2,
      });
      assert.equal(tags.id, "retained-id");
      assert.equal(tags.comment, "Unrelated comment");
      assert.deepEqual(tags.pictures, picture);
      assert.equal(picture.length, 1);
      // Independent parser verifies persisted date/title (not just library read-back).
      const probe = JSON.parse(
        new TextDecoder().decode(
          run("ffprobe", [
            "-v",
            "error",
            "-show_entries",
            "format_tags:stream_tags",
            "-of",
            "json",
            plan.destinations[0],
          ]),
        ),
      );
      const persisted = Object.fromEntries(
        Object.entries({ ...probe.streams?.[0]?.tags, ...probe.format.tags })
          .map(([k, v]) => [k.toLowerCase(), v]),
      );
      assert.equal(persisted.title, "Song 1");
      assert.equal(persisted.date, "2001-02-03");
      const strip = { ...defaults, tagOnly: true, stripTags: true };
      processAlbum(makePlan(cue, strip), strip);
      const stripped = metadata(plan.destinations[0]);
      assert.ok(!stripped.id);
      assert.ok(!stripped.comment);
      assert.deepEqual(stripped.pictures, []);
      assert.deepEqual(plan.destinations.map(audioDigest), before);
    }));
}
Deno.test("splitting preserves the source, every sample, and CUE tags", () =>
  withAlbum((dir) => {
    const source = join(dir, "image.wav");
    generate(source, 4);
    const before = digest(readFileSync(source));
    const cue = writeCue(dir), plan = makePlan(cue, defaults);
    processAlbum(plan, { ...defaults, trashOriginal: false });
    assert.equal(digest(readFileSync(source)), before);
    assert.equal(concatSamples(plan.destinations), audioDigest(source));
    assert.equal(metadata(plan.destinations[0]).title, "Song 1");
    assert.ok(makePlan(cue, defaults).inputs);
    assert.ok(!readdirSync(dir).some((n) => n.startsWith(".cue-work-")));
  }));
Deno.test("initial pregap samples are retained", () =>
  withAlbum((dir) => {
    const source = join(dir, "image.wav");
    generate(source, 5);
    const cue = writeCue(dir, undefined, ["00:01:00", "00:02:00"]),
      plan = makePlan(cue, defaults);
    processAlbum(plan, { ...defaults, trashOriginal: false });
    const pregap = join(dir, "00 - Pregap.flac");
    assert.ok(existsSync(pregap));
    assert.equal(
      concatSamples([pregap, ...plan.destinations]),
      audioDigest(source),
    );
  }));
Deno.test("tagging failure leaves originals untouched and cleans staging", () =>
  withAlbum((dir) => {
    const files = [join(dir, "01.flac"), join(dir, "02.flac")];
    files.forEach((p) => generate(p, 1));
    const cue = writeCue(dir), before = snapshot(dir);
    let calls = 0;
    assert.throws(
      () =>
        processAlbum(makePlan(cue, defaults), defaults, (...args) => {
          if (++calls === 2) throw new Error("simulated tag failure");
          tagFile(...args);
        }),
      /simulated/,
    );
    assert.deepEqual(snapshot(dir), before);
  }));
Deno.test("shell and legacy Deno launchers dry-run from outside tool directory", () =>
  withAlbum((dir) => {
    generate(join(dir, "x.flac"), 1);
    generate(join(dir, "y.flac"), 3);
    const cue = writeCue(dir), before = snapshot(dir);
    const launch = (command: string, args: string[]) => {
      const result = new Deno.Command(command, {
        args,
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).outputSync();
      assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    };
    launch("bash", [
      join(root, "split_cue.sh"),
      "--mode",
      "match",
      "--rename",
      "--dry-run",
      cue,
    ]);
    launch(Deno.execPath(), [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      join(root, "matchAndTag.ts"),
      "--dir",
      dir,
      "--cue",
      "album.cue",
      "--dry-run",
    ]);
    assert.deepEqual(snapshot(dir), before);
  }));

Deno.test("new splits trash the image by default only after validated outputs exist", () =>
  withAlbum((dir) => {
    const source = join(dir, "image.flac");
    generate(source, 4);
    const cue = writeCue(dir, "image.flac"), before = audioDigest(source);
    const plan = makePlan(cue, defaults);
    let calls = 0;
    processAlbum(plan, defaults, tagFile, (path) => {
      assert.equal(path, source);
      assert.equal(concatSamples(plan.destinations), before);
      for (const output of plan.destinations) {
        run("flac", ["--silent", "--test", output]);
      }
      calls++;
      rmSync(path);
    });
    assert.equal(calls, 1);
    assert.ok(!existsSync(source));
    assert.ok(existsSync(cue));
  }));

Deno.test("reruns verify existing FLAC splits before trashing a leftover image", () =>
  withAlbum((dir) => {
    const source = join(dir, "image.flac");
    generate(source, 4);
    const cue = writeCue(dir, "image.flac"),
      keep = { ...defaults, trashOriginal: false };
    processAlbum(makePlan(cue, keep), keep);
    const plan = makePlan(cue, defaults);
    assert.ok(plan.inputs);
    assert.equal(plan.source, source);
    let calls = 0;
    processAlbum(plan, defaults, tagFile, (path) => {
      calls++;
      rmSync(path);
    });
    assert.equal(calls, 1);
    assert.ok(!existsSync(source));
  }));

Deno.test("mismatched existing splits retain the image and all original tracks", () =>
  withAlbum((dir) => {
    const source = join(dir, "image.flac");
    generate(source, 4);
    const cue = writeCue(dir, "image.flac"),
      keep = { ...defaults, trashOriginal: false };
    const split = makePlan(cue, keep);
    processAlbum(split, keep);
    rmSync(split.destinations[0]);
    generate(split.destinations[0], 2);
    const before = snapshot(dir);
    let calls = 0;
    assert.throws(
      () =>
        processAlbum(makePlan(cue, defaults), defaults, tagFile, () => {
          calls++;
        }),
      /do not reconstruct/,
    );
    assert.equal(calls, 0);
    assert.deepEqual(snapshot(dir), before);
  }));

Deno.test("existing FLAC verification includes the initial pregap", () =>
  withAlbum((dir) => {
    const source = join(dir, "image.flac");
    generate(source, 5);
    const cue = writeCue(dir, "image.flac", ["00:01:00", "00:02:00"]),
      keep = { ...defaults, trashOriginal: false };
    processAlbum(makePlan(cue, keep), keep);
    const pregap = join(dir, "00 - Pregap.flac");
    rmSync(pregap);
    assert.throws(
      () =>
        processAlbum(
          makePlan(cue, defaults),
          defaults,
          tagFile,
          () => assert.fail("Must retain image"),
        ),
      /pregap is missing/,
    );
    assert.ok(existsSync(source));
    // Missing audio must fail the checksum even if a pregap file is supplied.
    generate(pregap, .5);
    assert.throws(
      () =>
        verifyFlacReconstruction(source, [
          pregap,
          ...makePlan(cue, defaults).inputs!,
        ]),
      /do not reconstruct/,
    );
  }));

Deno.test("split/tag failure and dry runs never trash images", () =>
  withAlbum((dir) => {
    const source = join(dir, "image.flac");
    generate(source, 4);
    const cue = writeCue(dir, "image.flac"),
      plan = makePlan(cue, defaults),
      before = snapshot(dir);
    const trash = () => assert.fail("Must retain image");
    processAlbum(plan, { ...defaults, dryRun: true }, tagFile, trash);
    assert.deepEqual(snapshot(dir), before);
    assert.throws(() =>
      processAlbum(plan, defaults, () => {
        throw new Error("simulated tagging failure");
      }, trash), /simulated tagging failure/);
    assert.deepEqual(snapshot(dir), before);
  }));

Deno.test("a single referenced track is never treated as a disposable album image", () =>
  withAlbum((dir) => {
    const source = join(dir, "image.flac");
    generate(source, 1);
    const cue = writeCue(dir, "image.flac", ["00:00:00"]);
    const plan = makePlan(cue, { ...defaults, mode: "match" });
    assert.deepEqual(plan.inputs, [source]);
    assert.equal(plan.source, undefined);
    processAlbum(
      plan,
      defaults,
      tagFile,
      () => assert.fail("Must retain track"),
    );
    assert.ok(existsSync(source));
  }));

Deno.test("renaming avoids an artist already included in the CUE title without changing metadata", () =>
  withAlbum((dir) => {
    for (
      const [artist, title, expected] of [
        [
          "Браво",
          "Браво - Дорога в облака",
          "01 - Браво - Дорога в облака.flac",
        ],
        [
          "Браво",
          "браво - Дорога в облака",
          "01 - браво - Дорога в облака.flac",
        ],
        ["Браво", "Дорога в облака", "01 - Браво - Дорога в облака.flac"],
        ["Браво", "Браво", "01 - Браво - Браво.flac"],
        [
          "Браво",
          "Браво - Дорога - в облака",
          "01 - Браво - Дорога - в облака.flac",
        ],
      ]
    ) {
      const cue = writeCue(dir);
      writeFileSync(
        cue,
        cueText().replace(
          'TITLE "Song 1"',
          `PERFORMER "${artist}"\n    TITLE "${title}"`,
        ),
      );
      writeFileSync(join(dir, "01.flac"), "untouched");
      writeFileSync(join(dir, "02.flac"), "untouched");
      const before = snapshot(dir),
        plan = makePlan(cue, { ...defaults, rename: true });
      assert.equal(basename(plan.destinations[0]), expected);
      assert.equal(plan.tracks[0].fields.TITLE, title);
      assert.deepEqual(snapshot(dir), before);
    }
  }));
