function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

(globalThis as { __sorseeTidalImporterTesting?: boolean })
  .__sorseeTidalImporterTesting = true;
await import(
  "./tidal-track-links-to-musicbrainz.user.js"
);
const importer = (globalThis as unknown as {
  __sorseeTidalImporter: {
    recordingEditUrl(
      mbid: string,
      links: unknown[],
      source: string,
      title: string,
    ): string;
    recordingSearchUrl(artist: string, track: string): string;
    syncMetadataFields(
      metadata: Record<string, string>,
      fields: Record<string, { value: string }>,
      edited: Set<string>,
    ): void;
    trackMetadata(
      root: {
        querySelectorAll(selector: string): Array<{ textContent: string }>;
      },
    ): { artist: string; track: string };
    searchRecordings(
      artist: string,
      track: string,
    ): Promise<Array<{ id: string }>>;
    canonicalTrackLink(
      raw: string,
    ): { service: string; url: string; type: string } | null;
    collectTrackLinks(
      root: { querySelectorAll(selector: string): Array<{ href: string }> },
      url: string,
    ): Array<{ url: string; type: string }>;
    importedPayload(
      hash: string,
    ): { mbid: string; links: Array<{ url: string; type: string }> } | null;
    draftRelationships(payload: unknown, mb: unknown): number;
  };
}).__sorseeTidalImporter;
const mbid = "03b7999b-3ef5-4d3a-b278-9089690ce47d";
const paid = "b5f3058a-666c-406f-aafb-f9249fc7b122";
const free = "7e41ef12-a124-4324-afdb-fdbae687a89c";

Deno.test("TIDAL /u page links map to recording track destinations only", () => {
  const urls = [
    "https://tidal.com/track/21027485",
    "https://open.spotify.com/track/0DhDj1l6JKChp7cVACXcbP",
    "https://geo.music.apple.com/au/album/song/601968756?i=601968757&app=music&ls=1",
    "https://music.youtube.com/watch?v=AbokzhDl_tE",
    "https://feature.fm/?utm_source=tidal",
    "https://open.spotify.com/album/0DhDj1l6JKChp7cVACXcbP",
  ];
  const links = importer.collectTrackLinks({
    querySelectorAll: () => urls.map((href) => ({ href })),
  }, "https://tidal.com/track/21027485/u");
  assertEquals(links.length, 4);
  assertEquals(links.map((x) => x.type), [paid, free, paid, free]);
  assertEquals(
    links[2].url,
    "https://music.apple.com/au/album/song/601968756?i=601968757",
  );

});

Deno.test("MusicBrainz payload rejects non-recording destinations and wrong MBIDs", () => {
  const links = [
    importer.canonicalTrackLink("https://tidal.com/track/21027485"),
  ];
  const payload = { version: 1, mbid, links };
  const valid = importer.importedPayload(
    "#" +
      new URLSearchParams({ "sorsee-tidal-links-v1": JSON.stringify(payload) }),
  );
  assertEquals(valid?.links.length, 1);
  assertEquals(
    importer.importedPayload(
      "#" +
        new URLSearchParams({
          "sorsee-tidal-links-v1": JSON.stringify({ ...payload, mbid: "bad" }),
        }),
    ),
    null,
  );
  assertEquals(
    importer.canonicalTrackLink("https://tidal.com/album/21027485"),
    null,
  );
});

Deno.test("MusicBrainz draft skips existing links and targets the chosen recording", () => {
  const links = [
    "https://tidal.com/track/21027485",
    "https://open.spotify.com/track/0DhDj1l6JKChp7cVACXcbP",
  ].map((url) => importer.canonicalTrackLink(url));
  const actions: Array<Record<string, unknown>> = [];
  const entity = {
    entityType: "recording",
    gid: mbid,
    relationships: [{
      target_type: "url",
      target: { href_url: links[0]?.url },
    }],
  };
  const mb = {
    relationshipEditor: {
      state: { entity, editNoteField: { value: "" } },
      getRelationshipStateId: () => 99,
      dispatch: (action: Record<string, unknown>) => actions.push(action),
    },
    linkedEntities: {
      link_type: {
        [free]: { type0: "recording", type1: "url", id: 268 },
        [paid]: { type0: "recording", type1: "url", id: 268 },
      },
    },
  };
  const payload = { mbid, links, source: "https://tidal.com/track/21027485" };
  assertEquals(importer.draftRelationships(payload, mb), 1);
  assertEquals(actions[0].type, "update-relationship-state");
  assertEquals(
    (actions[0].newRelationshipState as { entity0: unknown }).entity0,
    entity,
  );
  assertEquals(
    (actions[0].newRelationshipState as { entity1: { name: string } }).entity1
      .name,
    links[1]?.url,
  );
  assert(actions.some((action) => action.type === "update-edit-note"));
  let mismatchRejected = false;
  try {
    importer.draftRelationships({
      ...payload,
      mbid: "00000000-0000-4000-8000-000000000000",
    }, mb);
  } catch {
    mismatchRejected = true;
  }
  assert(mismatchRejected);
});

Deno.test("recording search quotes artist and track independently and escapes phrase syntax", () => {
  const url = new URL(
    importer.recordingSearchUrl(
      " Via «Slivki» ",
      "Vyshe Oblakov (Romantic Version)",
    ),
  );
  assertEquals(
    url.origin + url.pathname,
    "https://musicbrainz.org/ws/2/recording/",
  );
  assertEquals(
    url.searchParams.get("query"),
    'artist:"Via «Slivki»" AND recording:"Vyshe Oblakov (Romantic Version)"',
  );
  assertEquals(url.searchParams.get("fmt"), "json");
  assertEquals(url.searchParams.get("limit"), "25");
  const escaped = new URL(importer.recordingSearchUrl('An "Artist"', "A\\B"));
  assertEquals(
    escaped.searchParams.get("query"),
    String.raw`artist:"An \"Artist\"" AND recording:"A\\B"`,
  );
  let failed = false;
  try {
    importer.recordingSearchUrl(" ", "Track");
  } catch {
    failed = true;
  }
  assert(failed, "empty artist should not issue a broad query");
});

Deno.test("TIDAL structured track metadata prefills search without splitting names on punctuation", () => {
  const data = {
    "@graph": [{
      "@type": "MusicRecording",
      name: "Song - Remix",
      byArtist: [{ name: "Artist - Name" }],
    }],
  };
  assertEquals(
    importer.trackMetadata({
      querySelectorAll: () => [{ textContent: "{bad json" }, {
        textContent: JSON.stringify(data),
      }],
    }),
    { track: "Song - Remix", artist: "Artist - Name" },
  );
});

Deno.test("MusicBrainz search handles results and service errors", async () => {
  const target = globalThis as unknown as {
    GM_xmlhttpRequest?: (options: any) => void;
  };
  const prior = target.GM_xmlhttpRequest;
  try {
    target.GM_xmlhttpRequest = (options) => {
      assertEquals(new URL(options.url).hostname, "musicbrainz.org");
      assertEquals(options.anonymous, true);
      options.onload({
        status: 200,
        responseText: JSON.stringify({
          recordings: [{ id: mbid }, { id: "invalid" }],
        }),
      });
    };
    assertEquals(await importer.searchRecordings("Artist", "Track"), [{
      id: mbid,
    }]);
    target.GM_xmlhttpRequest = (options) => options.onload({ status: 503 });
    let message = "";
    try {
      await importer.searchRecordings("Artist", "Track");
    } catch (error) {
      message = String(error);
    }
    assert(message.includes("busy"), "server failure should be retryable");
  } finally {
    if (prior) target.GM_xmlhttpRequest = prior;
    else delete target.GM_xmlhttpRequest;
  }
});

Deno.test("import opens the recording edit form with native external-link seeds", () => {
  const links = [
    importer.canonicalTrackLink("https://tidal.com/track/21027485/u"),
    importer.canonicalTrackLink(
      "https://music.youtube.com/watch?v=AbokzhDl_tE",
    ),
  ];
  const url = new URL(
    importer.recordingEditUrl(
      mbid,
      links,
      "https://tidal.com/track/21027485",
      "Artist & Song",
    ),
  );
  assertEquals(url.pathname, `/recording/${mbid}/edit`);
  assertEquals(url.hash, "");
  assertEquals(
    url.searchParams.get("edit-recording.url.0.text"),
    "https://tidal.com/track/21027485",
  );
  assertEquals(
    url.searchParams.get("edit-recording.url.0.link_type_id"),
    "979",
  );
  assertEquals(
    url.searchParams.get("edit-recording.url.1.link_type_id"),
    "268",
  );
  assert(
    url.searchParams.get("edit-recording.edit_note")?.includes("Artist & Song"),
  );
});

Deno.test("late metadata fills untouched fields without overwriting user input", () => {
  const fields = { artist: { value: "My artist" }, track: { value: "" } };
  importer.syncMetadataFields(
    { artist: "TIDAL artist", track: "Track" },
    fields,
    new Set(["artist"]),
  );
  assertEquals(fields, {
    artist: { value: "My artist" },
    track: { value: "Track" },
  });
});

Deno.test("TIDAL Open Graph fallback preserves artist punctuation", () => {
  const metadata = {
    "og:title": "Artist - Name - Track (Mix)",
    "og:description":
      "Listen to Track (Mix) on TIDAL in exceptional sound quality",
  };
  const root = {
    querySelectorAll: () => [],
    querySelector: (selector: string) => ({
      getAttribute: () =>
        selector.includes("og:title")
          ? metadata["og:title"]
          : metadata["og:description"],
    }),
  };
  assertEquals(importer.trackMetadata(root), {
    artist: "Artist - Name",
    track: "Track (Mix)",
  });
});
