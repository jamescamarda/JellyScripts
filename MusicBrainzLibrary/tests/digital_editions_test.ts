import {
  digitalEditionPlan,
  matchingDigitalEditions,
} from "../src/digital_editions.ts";
import { editorProblems, type EditorSnapshot } from "../src/import_edition.ts";
import { type Album, PROVIDER_PRIORITY, type Release } from "../src/policy.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}
const artist = "15c0a967-3e17-4fe2-8c14-c250b7500efb";
const recording = "a64a6c92-431d-4bd7-8341-e90c5a4080ce";
const group = "3d180b5d-49df-450a-97be-7a87b98d1d35";
function fixtures(): { physical: Release; album: Album } {
  return {
    physical: {
      id: "3f2244ee-7163-45be-89c9-4a4fb16c25c0",
      title: "Album",
      barcode: "012345678905",
      "release-group": { id: group },
      "artist-credit": [{
        name: "Artist",
        artist: { id: artist, name: "Artist" },
      }],
      media: [{
        format: "CD",
        "track-count": 1,
        tracks: [{
          title: "Song",
          length: 240000,
          recording: { id: recording, title: "Song", isrcs: ["DEZ650907023"] },
        }],
      }],
    },
    album: {
      title: "Album",
      barcode: "192650050563",
      url: "https://tidal.com/album/123",
      credit: [{ name: "Artist" }],
      status: "official",
      date: { year: 2020, month: 4, day: 2 },
      urls: [{ url: "https://tidal.com/album/123", linkType: 980 }],
      mediums: [{
        format: "Digital Media",
        tracks: [{
          title: "Song",
          lengthMs: 241000,
          isrc: "DEZ650907023",
          credit: [{ name: "Artist" }],
        }],
      }],
    },
  };
}

Deno.test("Tidal is the preferred metadata source", () =>
  equal(PROVIDER_PRIORITY[0], "tidal"));
Deno.test("new digital edition uses provider barcode and date, original group and existing recordings", () => {
  const { physical, album } = fixtures();
  const plan = digitalEditionPlan(physical, album);
  const fields = Object.fromEntries(plan.parameters);
  equal(plan.reasons, []);
  equal(plan.unresolved, []);
  equal(fields.barcode, album.barcode);
  equal(fields["events.0.date.year"], "2020");
  equal(fields.release_group, group);
  equal(fields["mediums.0.format"], "Digital Media");
  equal(fields["mediums.0.track.0.recording"], recording);
  equal(fields["mediums.0.track.0.artist_credit.names.0.mbid"], artist);
  equal(physical.media[0].format, "CD");
});
Deno.test("missing barcode, missing tracks, wrong album or unknown group prevents import", () => {
  for (const kind of ["barcode", "tracks", "title", "group"]) {
    const { physical, album } = fixtures();
    if (kind === "barcode") album.barcode = null;
    if (kind === "tracks") album.missing = { count: 1 };
    if (kind === "title") album.title = "Different Album";
    if (kind === "group") delete physical["release-group"];
    equal(digitalEditionPlan(physical, album).reasons.length > 0, true);
  }
});
Deno.test("ISRC conflict or wrong version never seeds the original recording", () => {
  for (const kind of ["isrc", "title", "length"]) {
    const { physical, album } = fixtures();
    const track = album.mediums[0].tracks[0];
    if (kind === "isrc") track.isrc = "DEZ650907999";
    if (kind === "title") track.title = "Song (radio edit)";
    if (kind === "length") track.lengthMs = 260000;
    const plan = digitalEditionPlan(physical, album);
    equal(plan.recordings, [""]);
    equal(plan.unresolved.length > 0, true);
  }
});
Deno.test("same barcode on a physical product is not a duplicate digital edition", () => {
  const { physical, album } = fixtures();
  physical.barcode = album.barcode;
  const existing = {
    ...physical,
    id: "existing",
    media: [{ format: "Digital Media", "track-count": 1 }],
  };
  equal(matchingDigitalEditions([physical, existing], album).map((r) => r.id), [
    "existing",
  ]);
});
Deno.test("native editor must preserve verified identity before its submit button can be used", () => {
  const { physical, album } = fixtures();
  const plan = digitalEditionPlan(physical, album);
  const state: EditorSnapshot = {
    ready: true,
    path: "/release/add",
    title: album.title,
    barcode: album.barcode!,
    group,
    credit: [{ name: "Artist", id: artist }],
    mediums: [{
      format: "Digital Media",
      tracks: [{
        title: "Song",
        length: 241000,
        recording,
        credit: [{ name: "Artist", id: artist }],
      }],
    }],
    allowsSubmission: true,
    errors: [],
  };
  equal(editorProblems(state, plan), []);
  equal(editorProblems({ ...state, group: "other" }, plan).length > 0, true);
  equal(
    editorProblems({ ...state, allowsSubmission: false }, plan).length > 0,
    true,
  );
  state.mediums![0].tracks[0].recording =
    "00000000-0000-0000-0000-000000000001";
  equal(
    editorProblems(state, plan).some((error) =>
      error.includes("verified recording")
    ),
    true,
  );
});

Deno.test("digital import preserves recording and artist MBIDs across verified transliterations", () => {
  const { physical, album } = fixtures();
  physical.title = "Пример";
  album.title = "Primer";
  physical["artist-credit"] = [{
    name: "Артист",
    artist: {
      id: artist,
      name: "Артист",
      aliases: [{ name: "Artist", type: "Artist name" }],
    },
  }];
  const track = physical.media[0].tracks![0];
  track.title = "Песня";
  track.recording.title = track.title;
  album.mediums[0].tracks[0].title = "Pesnya";
  const plan = digitalEditionPlan(physical, album);
  equal(plan.reasons, []);
  equal(plan.recordings, [recording]);
  equal(plan.unresolved, []);
  const fields = Object.fromEntries(plan.parameters);
  equal(fields["artist_credit.names.0.mbid"], artist);
  equal(fields["mediums.0.track.0.recording"], recording);
});
