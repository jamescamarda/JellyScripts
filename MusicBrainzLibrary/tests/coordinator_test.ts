import { lovedInput } from "../src/input.ts";
import { checkpointArchive } from "../src/checkpoints.ts";
import { runReleases } from "../src/workflow.ts";
import type { Action, BrowserPort, Store } from "../src/ports.ts";
import type { AuditRow } from "../src/policy.ts";

const rid = "a64a6c92-431d-4bd7-8341-e90c5a4080ce";
const release = "3f2244ee-7163-45be-89c9-4a4fb16c25c0";
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
Deno.test("account import keeps only Loved IDs and checks them live regardless of cached streams", () => {
  const result = lovedInput({
    formatVersion: 9,
    loves: [{ recordingMbid: rid }, { recordingMbid: rid }],
    profile: { secret: "discard" },
    playlists: [{ recordingMbid: release }],
  });
  assert(result.items.length === 1 && result.items[0].recordingMbid === rid);
  assert(!JSON.stringify(result).includes("secret"));
  const snapshot = lovedInput({
    scope: "Loved only",
    done: true,
    items: [{
      recordingMbid: rid,
      providerLinks: [{ service: "spotify", linkType: "audio" }],
    }],
  });
  assert(!snapshot.items[0].providerLinks);
});
Deno.test("incomplete, unscoped and invalid Loved imports are rejected", () => {
  for (
    const value of [
      { items: [] },
      { scope: "Loved only", done: false, items: [] },
      { scope: "Loved only", done: true, errors: ["failed"], items: [] },
      { formatVersion: 9, loves: [{ recordingMbid: "bad" }] },
    ]
  ) {
    let rejected = false;
    try {
      lovedInput(value);
    } catch {
      rejected = true;
    }
    assert(rejected);
  }
});
Deno.test("checkpoint archive cannot restore browser commands or arbitrary paths", () => {
  const entries = {
    "loved/input.json": lovedInput({ formatVersion: 9, loves: [] }),
  };
  checkpointArchive({
    format: "sorsee-loved-checkpoints",
    version: 1,
    entries,
  });
  for (
    const key of [
      "../input.json",
      "sorsee-loved:active-run",
      "loved/command:fake",
    ]
  ) {
    let rejected = false;
    try {
      checkpointArchive({
        format: "sorsee-loved-checkpoints",
        version: 1,
        entries: { ...entries, [key]: {} },
      });
    } catch {
      rejected = true;
    }
    assert(rejected);
  }
});
function fixture(previous?: unknown) {
  const data = new Map<string, unknown>();
  const calls: string[] = [];
  if (previous) data.set(`loved/releases/${release}.json`, previous);
  const store: Store = {
    load: <T>(key: string) => Promise.resolve(data.get(key) as T | undefined),
    save: (key, value) => {
      data.set(key, structuredClone(value));
      return Promise.resolve();
    },
  };
  const browser: BrowserPort = {
    openRelease: (id) => {
      calls.push("open");
      return Promise.resolve(id);
    },
    openEditor: () => {
      throw Error("Unexpected editor");
    },
    closeTab: () => Promise.resolve(),
    targets: () => Promise.resolve([]),
    evaluate: <T>(_target: string, action: Action) => {
      calls.push(action);
      if (action === "releaseData") {
        return Promise.resolve({
          id: release,
          title: "Album",
          barcode: "192650050563",
          media: [{
            format: "Digital Media",
            "track-count": 1,
            tracks: [{ title: "One", recording: { id: rid, relations: [] } }],
          }],
          relations: [],
        } as T);
      }
      if (action === "probe") {
        return Promise.resolve({ results: [{ id: "pc", findings: [] }] } as T);
      }
      throw Error(`Unexpected ${action}`);
    },
  };
  const audit = {
    results: [{
      id: rid,
      status: "needs-release-review",
      releases: [{
        id: release,
        title: "Album",
        barcode: "192650050563",
        media: [{ format: "Digital Media", "track-count": 1 }],
      }],
    }] as AuditRow[],
  };
  const input = lovedInput({
    formatVersion: 9,
    loves: [{ recordingMbid: rid }],
  });
  return { data, calls, store, browser, audit, input };
}
Deno.test("portable workflow plans without editing and stops at release boundaries", async () => {
  const f = fixture();
  await runReleases({
    ...f,
    apply: false,
    stopped: () => true,
    report: () => {},
  });
  assert(!f.calls.length);
  await runReleases({ ...f, apply: false, report: () => {} });
  assert(f.calls.includes("probe"));
  assert(!f.calls.includes("applyReleaseSources"));
  const checkpoint = f.data.get(`loved/releases/${release}.json`) as {
    status: string;
  };
  assert(checkpoint.status === "needs-verified-album");
});
Deno.test("pending recording writes remain blocked even when source status masks the global status", async () => {
  const f = fixture({
    release,
    status: "release-sources-pending",
    recordingPending: true,
    selected: [{ track: rid, url: "https://open.spotify.com/track/example" }],
  });
  await runReleases({ ...f, apply: true, report: () => {} });
  assert(
    !f.calls.includes("probe"),
    "Must reconcile pending writes before any new probe/apply",
  );
  const checkpoint = f.data.get(`loved/releases/${release}.json`) as {
    status: string;
    recordingPending: boolean;
  };
  assert(
    checkpoint.status === "submission-uncertain" && checkpoint.recordingPending,
  );
});

Deno.test("legacy source-pending checkpoints also preserve unconfirmed recording edits", async () => {
  const f = fixture({
    release,
    status: "release-sources-pending",
    result: { ok: true, sent: 1 },
    selected: [{ track: rid, url: "https://open.spotify.com/track/example" }],
    confirmed: [],
  });
  await runReleases({ ...f, apply: true, report: () => {} });
  assert(!f.calls.includes("probe"));
  assert(
    (f.data.get(`loved/releases/${release}.json`) as { status: string })
      .status === "submission-uncertain",
  );
});
Deno.test("inconclusive edition reconciliation retains its no-resubmit marker across resumes", async () => {
  const f = fixture({
    release,
    status: "digital-edition-uncertain",
    edition: { status: "creating-digital-edition" },
    source: {
      ok: true,
      provider: { id: "tidal", name: "Tidal" },
      rel: {
        title: "Album",
        barcode: "192650050563",
        url: "https://tidal.com/album/1",
        credit: [{ name: "Artist" }],
        urls: [{ url: "https://tidal.com/album/1", linkType: 980 }],
        mediums: [{
          format: "Digital Media",
          tracks: [{ title: "One", lengthMs: 300000 }],
        }],
      },
    },
  });
  // The missing release group means reconciliation cannot establish a safe match.
  for (let attempt = 0; attempt < 2; attempt++) {
    await runReleases({ ...f, apply: true, report: () => {} });
    const state = f.data.get(`loved/releases/${release}.json`) as {
      edition: { status: string };
    };
    assert(state.edition.status === "digital-edition-uncertain");
  }
  assert(!f.calls.includes("probe"));
});

Deno.test("bounded runs advance past reviewed releases, while Apply can process a Plan review", async () => {
  const f = fixture();
  await runReleases({ ...f, apply: false, limit: 1, report: () => {} });
  const before = f.calls.length;
  await runReleases({ ...f, apply: false, limit: 1, report: () => {} });
  assert(
    f.calls.length === before,
    "Repeated Plan must not reopen the same reviewed release",
  );
  await runReleases({ ...f, apply: true, limit: 1, report: () => {} });
  assert(
    f.calls.length > before,
    "Apply must be able to submit release links from a Plan review",
  );
  const applied = f.calls.length;
  await runReleases({ ...f, apply: true, limit: 1, report: () => {} });
  assert(
    f.calls.length === applied,
    "Repeated Apply must advance past a completed review",
  );
  await runReleases({
    ...f,
    apply: true,
    limit: 1,
    retryReviewed: true,
    report: () => {},
  });
  assert(
    f.calls.length > applied,
    "Explicit recheck must revisit reviewed releases",
  );
});

Deno.test("Apply saves verified album sources even when translated titles block recording enrichment", async () => {
  const f = fixture();
  let submitted = false;
  const candidate = {
    key: "tidal",
    name: "Tidal",
    state: "new",
    url: "https://tidal.com/album/1",
    barcode: "192650050563",
    tracks: 1,
  };
  f.browser.evaluate = <T>(
    _target: string,
    action: Action,
    argument?: unknown,
  ) => {
    if (action === "identityAliases") {
      return Promise.resolve((argument as { release: unknown }).release as T);
    }
    if (action === "releaseData") {
      return Promise.resolve({
        id: release,
        title: "原題",
        barcode: "192650050563",
        media: [{
          format: "Digital Media",
          "track-count": 1,
          tracks: [{ title: "曲", recording: { id: rid, relations: [] } }],
        }],
        relations: submitted
          ? [{ type: "streaming", url: { resource: candidate.url } }]
          : [],
      } as T);
    }
    if (action === "probe") {
      return Promise.resolve(
        { results: [{ id: "pc", findings: [candidate] }] } as T,
      );
    }
    if (action === "applyReleaseSources") {
      const state = f.data.get(`loved/releases/${release}.json`) as {
        releaseSources: { status: string };
      };
      assert(
        state.releaseSources.status === "submitting",
        "Write intent must precede submission",
      );
      submitted = true;
      return Promise.resolve({ ok: true, sent: 1 } as T);
    }
    if (action === "readAlbum") {
      return Promise.resolve({
        ok: true,
        provider: { id: "tidal" },
        rel: {
          title: "Translated title",
          barcode: candidate.barcode,
          url: candidate.url,
          mediums: [{
            format: "Digital Media",
            tracks: [{ title: "Translated recording" }],
          }],
        },
      } as T);
    }
    throw Error(`Unexpected ${action}`);
  };
  await runReleases({ ...f, apply: false, limit: 1, report: () => {} });
  assert(!submitted, "Plan must not submit");
  await runReleases({ ...f, apply: true, limit: 1, report: () => {} });
  const state = f.data.get(`loved/releases/${release}.json`) as {
    releaseSources: { status: string };
    status: string;
    note: string;
  };
  assert(submitted && state.releaseSources.status === "verified");
  assert(
    state.status === "needs-verified-album" &&
      state.note.includes("title differs"),
  );
});

Deno.test("an unattended run continues past an unresolved match to the next release", async () => {
  const f = fixture();
  const next = "00000000-0000-4000-8000-000000000001";
  f.audit.results[0].releases!.push({
    ...f.audit.results[0].releases![0],
    id: next,
  });
  // Separate Loved identity makes this a second queue job rather than another edition.
  const secondRid = "00000000-0000-4000-8000-000000000002";
  f.input.items.push({ recordingMbid: secondRid });
  f.audit.results.push({
    id: secondRid,
    title: "Second recording",
    status: "needs-release-review",
    releases: [{ ...f.audit.results[0].releases![0], id: next }],
  });
  // Keep the first recording's candidates separate so both jobs are required.
  f.audit.results[0].releases = f.audit.results[0].releases!.filter((r) =>
    r.id === release
  );
  await runReleases({ ...f, apply: true, report: () => {} });
  assert(
    f.data.has(`loved/releases/${release}.json`) &&
      f.data.has(`loved/releases/${next}.json`),
  );
  const summary = f.data.get("loved/summary.json") as {
    processedReleases: number;
    pausedForVerification: boolean;
  };
  assert(summary.processedReleases === 2 && !summary.pausedForVerification);
});

Deno.test("a read-side connection failure pauses the campaign and retries on resume", async () => {
  const f = fixture();
  let fail = true;
  const original = f.browser.evaluate;
  f.browser.evaluate = <T>(
    target: string,
    action: Action,
    argument?: unknown,
  ) => {
    if (fail && action === "releaseData") {
      throw Error("TypeError: Failed to fetch");
    }
    return original<T>(target, action, argument);
  };
  await runReleases({ ...f, apply: true, report: () => {} });
  const summary = f.data.get("loved/summary.json") as {
    pausedForConnection: boolean;
  };
  assert(summary.pausedForConnection);
  const state = f.data.get(`loved/releases/${release}.json`) as {
    status: string;
  };
  assert(state.status === "temporarily-unavailable");
  fail = false;
  await runReleases({ ...f, apply: true, report: () => {} });
  assert(
    (f.data.get(`loved/releases/${release}.json`) as { status: string })
      .status === "needs-verified-album",
  );
});

Deno.test("incomplete provider coverage retains independently verified recording links", async () => {
  const f = fixture();
  let saved = false;
  const url = "https://open.spotify.com/track/2km9fP2b21EhdNTzgGABZ3";
  f.browser.evaluate = <T>(
    _target: string,
    action: Action,
    argument?: unknown,
  ) => {
    if (action === "releaseData") {
      return Promise.resolve({
        id: release,
        title: "Album",
        barcode: "192650050563",
        "artist-credit": [{ name: "Artist", artist: { name: "Artist" } }],
        relations: [],
        media: [{
          format: "Digital Media",
          "track-count": 1,
          tracks: [{
            title: "Song",
            length: 240000,
            recording: {
              id: rid,
              title: "Song",
              isrcs: ["DEZ650907023"],
              relations: saved ? [{ url: { resource: url } }] : [],
            },
          }],
        }],
      } as T);
    }
    if (action === "probe") {
      return Promise.resolve({
        results: (argument as { only: string[] }).only.includes("pc")
          ? [{
            id: "pc",
            findings: [{
              key: "tidal",
              name: "Tidal",
              state: "linked",
              url: "https://tidal.com/album/1",
            }],
          }]
          : [{
            id: "is",
            more: true,
            note: "one provider failed",
            findings: [{
              key: "link:one",
              kind: "link",
              state: "new",
              name: "Spotify",
              track: rid,
              url,
            }],
          }],
      } as T);
    }
    if (action === "readAlbum") {
      return Promise.resolve({
        ok: true,
        provider: { id: "tidal" },
        rel: {
          title: "Album",
          barcode: "192650050563",
          url: "https://tidal.com/album/1",
          credit: [{ name: "Artist" }],
          mediums: [{
            format: "Digital Media",
            tracks: [{ title: "Song", lengthMs: 240000, isrc: "DEZ650907023" }],
          }],
        },
      } as T);
    }
    if (action === "applyLinks") {
      saved = true;
      return Promise.resolve({ ok: true, sent: 1 } as T);
    }
    throw Error(`Unexpected ${action}`);
  };
  await runReleases({ ...f, apply: true, limit: 1, report: () => {} });
  const state = f.data.get(`loved/releases/${release}.json`) as {
    status: string;
    confirmed: unknown[];
    note: string;
  };
  assert(
    saved && state.status === "verified-with-review" &&
      state.confirmed.length === 1 && state.note.includes("incomplete"),
  );
});
