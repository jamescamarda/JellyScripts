import {
  type Finding,
  type Findings,
  type Release,
  releaseSources,
  sourceUrlKey,
} from "../src/policy.ts";
import {
  enrichReleaseSources,
  type ReleaseSourceState,
} from "../src/release_sources.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}
function fixture(): {
  release: Release;
  findings: Findings;
  candidate: Finding;
} {
  const candidate: Finding = {
    key: "spotify",
    name: "Spotify",
    state: "new",
    barcode: "0192650050563",
    tracks: 2,
    url: "https://open.spotify.com/album/2OVn269I43f22ENJ18qfm0",
  };
  return {
    release: {
      id: "release",
      title: "EP",
      barcode: "192650050563",
      media: [{ format: "Digital Media", "track-count": 2 }],
      relations: [],
    },
    findings: { id: "pc", findings: [candidate] },
    candidate,
  };
}

Deno.test("canonical provider URLs verify the same album after MusicBrainz cleanup", () => {
  equal(
    sourceUrlKey("https://listen.tidal.com/album/123"),
    sourceUrlKey("https://tidal.com/album/123/"),
  );
  equal(
    sourceUrlKey("https://music.apple.com/us/album/example/123"),
    sourceUrlKey("https://music.apple.com/gb/album/123"),
  );
  equal(
    sourceUrlKey(
      "https://open.spotify.com/intl-de/album/2OVn269I43f22ENJ18qfm0",
    ),
    sourceUrlKey("https://open.spotify.com/album/2OVn269I43f22ENJ18qfm0"),
  );
});

Deno.test("extra PC album sources include Spotify and providers outside metadata priority", () => {
  const { release, findings, candidate } = fixture();
  findings.findings.push({
    ...candidate,
    key: "amazonmusic",
    url: "https://music.amazon.com/albums/example",
  });
  equal(releaseSources(release, findings).map((f) => f.key), [
    "spotify",
    "amazonmusic",
  ]);
});

Deno.test("source selection excludes wrong or unknown barcodes, withheld links and metadata edits", () => {
  const { release, candidate } = fixture();
  for (
    const changed of [
      { barcode: null },
      { barcode: "012345678905" },
      { tracks: undefined },
      { tracks: 3 },
      { state: "withheld" },
      { state: "unsure" },
      { state: "linked" },
      { kind: "barcode" },
      { entity: { type: "artist" } },
      { key: "discogsmaster" },
      { key: "bandcamp", format: undefined },
      { key: "bandcamp", format: "Digital, CD" },
      { format: "CD" },
      { url: "javascript:alert(1)" },
    ]
  ) {
    equal(
      releaseSources(release, {
        id: "pc",
        findings: [{ ...candidate, ...changed }],
      }),
      [],
    );
  }
  equal(
    releaseSources(
      { ...release, media: [{ format: "CD", "track-count": 2 }] },
      { id: "pc", findings: [candidate] },
    ),
    [],
  );
});

Deno.test("existing and ended source URLs are not duplicated or resurrected", () => {
  const { release, candidate } = fixture();
  release.relations = [{ ended: true, url: { resource: candidate.url + "/" } }];
  equal(
    releaseSources(release, { id: "pc", findings: [candidate, candidate] }),
    [],
  );
  release.relations = [];
  equal(
    releaseSources(release, { id: "pc", findings: [candidate, candidate] })
      .length,
    1,
  );
});

Deno.test("planning extra sources has no submission or Falcon queue side effects", async () => {
  const { release, findings } = fixture();
  const state = await enrichReleaseSources(release, findings, false, {
    refresh: () => {
      throw new Error("Unexpected refresh");
    },
    submit: () => {
      throw new Error("Plan must not enqueue edits");
    },
    checkpoint: async () => {},
  });
  equal(state.status, "planned");
  equal(state.selected.length, 1);
});

Deno.test("source submission checkpoints before dispatch and verifies actual live relationships", async () => {
  const { release, findings, candidate } = fixture();
  const journal: ReleaseSourceState[] = [];
  let submitted = false;
  const result = await enrichReleaseSources(release, findings, true, {
    refresh: () =>
      Promise.resolve(
        submitted
          ? { ...release, relations: [{ url: { resource: candidate.url! } }] }
          : release,
      ),
    submit: () => {
      equal(journal.at(-1)?.status, "submitting");
      submitted = true;
      return Promise.resolve({ ok: true, via: "falcon" });
    },
    checkpoint: (state) => {
      journal.push(structuredClone(state));
      return Promise.resolve();
    },
  });
  equal(result.status, "verified");
  equal(result.confirmed?.length, 1);
});

Deno.test("a queued but invisible source stays pending and is not submitted again", async () => {
  const { release, findings } = fixture();
  let submits = 0;
  const ports = {
    refresh: () => Promise.resolve(release),
    submit: () => {
      submits++;
      return Promise.resolve({ ok: true, via: "falcon" });
    },
    checkpoint: async () => {},
  };
  const first = await enrichReleaseSources(release, findings, true, ports);
  equal(first.status, "pending");
  const second = await enrichReleaseSources(
    release,
    findings,
    true,
    ports,
    first,
  );
  equal(second.status, "pending");
  equal(submits, 1);
});

Deno.test("a lost source response is reconciled instead of repeating an edit", async () => {
  const { release, findings, candidate } = fixture();
  let submits = 0;
  const first = await enrichReleaseSources(release, findings, true, {
    refresh: () => Promise.resolve(release),
    submit: () => {
      submits++;
      return Promise.reject(new Error("Lost response"));
    },
    checkpoint: async () => {},
  });
  equal(first.status, "uncertain");
  const fresh = {
    ...release,
    relations: [{ url: { resource: candidate.url! } }],
  };
  const recovered = await enrichReleaseSources(fresh, findings, true, {
    refresh: () => Promise.resolve(fresh),
    submit: () => {
      throw new Error("Must not resubmit");
    },
    checkpoint: async () => {},
  }, first);
  equal(recovered.status, "verified");
  equal(submits, 1);
});

Deno.test("a definite pre-submission rejection can be retried after a new probe", async () => {
  const { release, findings, candidate } = fixture();
  let submits = 0;
  const rejected = await enrichReleaseSources(release, findings, true, {
    refresh: () => Promise.resolve(release),
    submit: () => {
      submits++;
      return Promise.resolve({ notSubmitted: true, note: "No Falcon adapter" });
    },
    checkpoint: async () => {},
  });
  equal(rejected.status, "rejected");
  const recovered = await enrichReleaseSources(release, findings, true, {
    refresh: () =>
      Promise.resolve(
        submits > 1
          ? { ...release, relations: [{ url: { resource: candidate.url! } }] }
          : release,
      ),
    submit: () => {
      submits++;
      return Promise.resolve({ ok: true });
    },
    checkpoint: async () => {},
  }, rejected);
  equal(recovered.status, "verified");
  equal(submits, 2);
});

Deno.test("a source added concurrently or a changed edition is rechecked before writing", async () => {
  const { release, findings, candidate } = fixture();
  for (
    const fresh of [{ ...release, barcode: "012345678905" }, {
      ...release,
      relations: [{ url: { resource: candidate.url! } }],
    }]
  ) {
    const result = await enrichReleaseSources(release, findings, true, {
      refresh: () => Promise.resolve(fresh),
      submit: () => {
        throw new Error("Stale source plan must not be submitted");
      },
      checkpoint: async () => {},
    });
    equal(result.status, "none");
  }
});

Deno.test("a completed album-source journal stays visible on a later no-op run", async () => {
  const { release, candidate } = fixture();
  release.relations = [{ url: { resource: candidate.url! } }];
  const previous: ReleaseSourceState = {
    version: 1,
    status: "verified",
    selected: [candidate],
    confirmed: [candidate],
  };
  const result = await enrichReleaseSources(
    release,
    { id: "pc", findings: [] },
    true,
    {
      refresh: () => Promise.resolve(release),
      submit: () => {
        throw Error("Must not repeat a completed edit");
      },
      checkpoint: () => Promise.resolve(),
    },
    previous,
  );
  equal(result, previous);
});
