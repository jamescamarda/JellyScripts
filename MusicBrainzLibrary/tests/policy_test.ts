import {
  type Album,
  albumMatches,
  type Findings,
  matchingRecordings,
  recordingLinks,
  type Release,
  releaseJobs,
} from "../src/policy.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}
function fixtures(): { release: Release; album: Album; findings: Findings } {
  return {
    release: {
      id: "3f2244ee-7163-45be-89c9-4a4fb16c25c0",
      title: "Album",
      barcode: "192650050563",
      "artist-credit": [{ name: "Artist", artist: { name: "Artist" } }],
      media: [{
        format: "Digital Media",
        "track-count": 2,
        tracks: [
          {
            title: "One (extended mix)",
            length: 300000,
            recording: {
              id: "one",
              title: "One (extended mix)",
              isrcs: ["DEZ650907023"],
              relations: [],
            },
          },
          {
            title: "Two",
            length: 200000,
            recording: { id: "two", title: "Two", relations: [] },
          },
        ],
      }],
    },
    album: {
      title: "Album",
      barcode: "0192650050563",
      url: "https://www.deezer.com/album/123",
      credit: [{ name: "Artist" }],
      mediums: [{
        format: "Digital Media",
        tracks: [
          {
            title: "One (extended mix)",
            lengthMs: 301000,
            isrc: "DEZ650907023",
            credit: [{ name: "Artist" }],
          },
          {
            title: "Two",
            lengthMs: 200000,
            isrc: "DEZ650907024",
            credit: [{ name: "Artist" }],
          },
        ],
      }],
    },
    findings: {
      id: "is",
      findings: [
        {
          key: "link:one:yt",
          kind: "link",
          name: "YouTube Music",
          track: "one",
          url: "https://music.youtube.com/watch?v=YNOGk_jnIQU",
          state: "new",
        },
        {
          key: "link:two:spotify",
          kind: "link",
          name: "Spotify",
          track: "two",
          url: "https://open.spotify.com/track/2km9fP2b21EhdNTzgGABZ3",
          state: "new",
        },
      ],
    },
  };
}

Deno.test("edition verification uses actual barcode and complete digital product", () => {
  const { release, album } = fixtures();
  equal(albumMatches(release, album), true);
  equal(albumMatches({ ...release, barcode: null }, album), false);
  equal(albumMatches({ ...release, title: "Album (Deluxe)" }, album), false);
  equal(
    albumMatches(
      { ...release, media: [{ ...release.media[0], format: "CD" }] },
      album,
    ),
    false,
  );
  equal(
    albumMatches(release, {
      ...album,
      mediums: [{
        format: "Digital Media",
        tracks: [album.mediums[0].tracks[0]],
      }],
    }),
    false,
  );
});

Deno.test("same barcode does not excuse the wrong mix, artist or length", () => {
  for (const change of ["title", "artist", "length", "isrc"]) {
    const { release, album } = fixtures();
    const track = album.mediums[0].tracks[0];
    if (change === "title") track.title = "One (radio edit)";
    if (change === "artist") track.credit = [{ name: "Another Artist" }];
    if (change === "length") track.lengthMs = 303001;
    if (change === "isrc") track.isrc = "DEZ650907999";
    const result = matchingRecordings(release, album);
    equal(result.valid, ["two"]);
    equal(result.rejected.length, 1);
  }
});

Deno.test("an ISRC repeated across distinct recordings blocks their mappings", () => {
  const { release, album } = fixtures();
  album.mediums[0].tracks[1].isrc = album.mediums[0].tracks[0].isrc;
  equal(matchingRecordings(release, album).valid, []);
});

Deno.test("existing, ambiguous and out-of-release recording links are excluded", () => {
  const { release, findings } = fixtures();
  release.media[0].tracks![0].recording.relations = [{
    url: { resource: findings.findings[0].url! },
  }];
  findings.findings.push({
    key: "two",
    name: "Two",
    track: "two",
    state: "unsure",
  });
  findings.findings.push({
    key: "foreign",
    name: "YouTube",
    kind: "link",
    track: "foreign",
    url: "https://youtu.be/YNOGk_jnIQU",
    state: "new",
  });
  equal(recordingLinks(release, findings, ["one", "two", "foreign"]), []);
});

Deno.test("recording links cover the entire validated release and deduplicate submissions", () => {
  const { release, album, findings } = fixtures();
  findings.findings.push(findings.findings[0]);
  const valid = matchingRecordings(release, album).valid;
  equal(recordingLinks(release, findings, valid).map((link) => link.track), [
    "one",
    "two",
  ]);
});

Deno.test("release planning prefers digital editions over older physical editions", () => {
  const { release } = fixtures();
  const physical = {
    ...release,
    id: "00000000-0000-0000-0000-000000000000",
    media: [{ format: "CD", "track-count": 2 }],
  };
  const plan = releaseJobs([
    {
      id: "loved",
      title: "One",
      status: "needs-release-review",
      releases: [physical, release],
    },
    {
      id: "already",
      title: "Two",
      status: "already-linked-live",
      releases: [release],
    },
    {
      id: "missing",
      title: "Unknown",
      status: "needs-release-review",
      releases: [],
    },
    {
      id: "failed",
      title: "Failed read",
      status: "check-failed",
      releases: [],
    },
  ]);
  equal(plan.jobs.map((job) => job.id), [release.id]);
  equal(plan.jobs[0].loved, ["loved"]);
  equal(plan.withoutRelease, ["missing"]);
});

Deno.test("cross-script album and recording names use existing ISRCs, artist aliases and durations", () => {
  const { release, album } = fixtures();
  release.title = "魚図鑑";
  album.title = "Sakana Zukan";
  release["artist-credit"] = [{
    name: "サカナクション",
    artist: {
      id: "artist",
      name: "サカナクション",
      aliases: [{ name: "Sakanaction", type: "Artist name" }],
    },
  }];
  album.credit = [{ name: "Sakanaction" }];
  release.media[0].tracks!.forEach((track, i) => {
    track.title = ["新宝島", "夜の踊り子"][i];
    track.recording.title = track.title;
    track.recording.isrcs = [album.mediums[0].tracks[i].isrc!];
    const source = album.mediums[0].tracks[i];
    source.title = ["Shin Takara Jima", "Yoru No Odoriko"][i];
    source.credit = [{ name: "Sakanaction" }];
  });
  equal(albumMatches(release, album), true);
  equal(matchingRecordings(release, album).valid, ["one", "two"]);
  album.mediums[0].tracks[0].lengthMs = 310000;
  equal(matchingRecordings(release, album).valid, []); // Too little independent evidence for this two-recording edition.
});

Deno.test("stored release and recording aliases allow transliterations without inventing ISRC matches", () => {
  const { release, album } = fixtures();
  release.title = "Пример";
  release.aliases = [{ name: "Primer", type: "Release name" }];
  album.title = "Primer";
  const track = release.media[0].tracks![0];
  track.title = "Песня";
  track.recording.title = "Песня";
  track.recording.aliases = [{ name: "Pesnya", type: "Recording name" }];
  album.mediums[0].tracks[0].title = "Pesnya";
  equal(albumMatches(release, album), true);
  equal(matchingRecordings(release, album).valid, ["one", "two"]);
  track.recording.aliases = [{ name: "Pesnya", type: "Search hint" }];
  track.recording.isrcs = [];
  equal(matchingRecordings(release, album).valid, ["two"]);
});

Deno.test("transliteration cannot override conflicting ISRCs, versions, artists or duplicate identifiers", () => {
  for (const change of ["isrc", "version", "artist", "duplicate"]) {
    const { release, album } = fixtures();
    release.title = "Пример";
    release.aliases = [{ name: "Primer" }];
    album.title = "Primer";
    const track = release.media[0].tracks![0],
      source = album.mediums[0].tracks[0];
    track.title = "Песня";
    track.recording.title = track.title;
    source.title = "Pesnya";
    if (change === "isrc") source.isrc = "DEZ650907999";
    if (change === "version") source.title = "Pesnya (live)";
    if (change === "artist") source.credit = [{ name: "Other Artist" }];
    if (change === "duplicate") album.mediums[0].tracks[1].isrc = source.isrc;
    equal(matchingRecordings(release, album).valid.includes("one"), false);
  }
});

Deno.test("Latin accent folding preserves meaningful Japanese voicing marks", () => {
  const { release, album } = fixtures();
  release.title = "Café";
  album.title = "Cafe";
  equal(albumMatches(release, album), true);
  release.title = "ガ";
  album.title = "カ";
  equal(albumMatches(release, album), false);
});

Deno.test("English version qualifiers do not hide a transliterated Japanese base title", () => {
  const { release, album } = fixtures();
  const track = release.media[0].tracks![0],
    source = album.mediums[0].tracks[0];
  track.title = "陽炎 -movie version-";
  track.recording.title = track.title;
  source.title = "Kagero -movie version-";
  equal(matchingRecordings(release, album).valid, ["one", "two"]);
  source.title = "Kagero (live)";
  equal(matchingRecordings(release, album).valid, ["two"]);
});

Deno.test("long shared English subtitles do not mask transliterated album names", () => {
  const { release, album } = fixtures();
  release.title = "月の波形 ~Coupling & Unreleased works~";
  album.title = "Tsuki no Hakei ~Coupling & Unreleased works~";
  release.media[0].tracks!.forEach((track, i) => {
    track.recording.isrcs = [album.mediums[0].tracks[i].isrc!];
  });
  equal(albumMatches(release, album), true);
});
