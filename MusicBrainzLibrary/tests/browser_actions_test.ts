import {
  applyReleaseSources,
  editionDuplicates,
  editorState,
  finishEditor,
} from "../src/browser_actions.js";
import type { EditorSnapshot } from "../src/import_edition.ts";

function execute(fn: () => unknown, context: Record<string, unknown>): unknown {
  return new Function(...Object.keys(context), `return (${fn.toString()})()`)(
    ...Object.values(context),
  );
}

Deno.test("PC source handoff waits for the tagged Falcon completion, not merely its acknowledgement", async () => {
  const document = new EventTarget();
  const candidate = {
    key: "spotify",
    state: "new",
    url: "https://open.spotify.com/album/example",
    barcode: "192650050563",
    tracks: 2,
  };
  let applies = 0, completed = false;
  document.addEventListener("mc:probe", (event) => {
    const request = JSON.parse((event as CustomEvent).detail);
    document.dispatchEvent(
      new CustomEvent("mc:findings", {
        detail: JSON.stringify({
          id: "pc",
          run: request.run,
          findings: [candidate],
        }),
      }),
    );
  });
  document.addEventListener("mc:apply", (event) => {
    const request = JSON.parse((event as CustomEvent).detail);
    applies++;
    document.dispatchEvent(
      new CustomEvent("mc:applied", {
        detail: JSON.stringify({
          id: "pc",
          run: request.run,
          ok: true,
          sent: 1,
          tag: `mc:pc:${request.run}`,
        }),
      }),
    );
    document.dispatchEvent(
      new CustomEvent("falcon:status", {
        detail: JSON.stringify({
          tag: "unrelated",
          running: false,
          items: [{ status: "done" }],
        }),
      }),
    );
    setTimeout(() => {
      completed = true;
      document.dispatchEvent(
        new CustomEvent("falcon:status", {
          detail: JSON.stringify({
            tag: `mc:pc:${request.run}`,
            running: false,
            items: [{ status: "done" }],
          }),
        }),
      );
    }, 15);
  });
  const run = new Function(
    "document",
    "location",
    "selected",
    `return (${applyReleaseSources.toString()})({id:'release',selected})`,
  );
  const result = await run(document, {
    origin: "https://musicbrainz.org",
    pathname: "/release/release",
  }, [candidate]);
  if (!completed || applies !== 1 || !result.falcon) {
    throw new Error("Falcon acknowledgement was mistaken for completion");
  }
});

Deno.test("a PC source becoming withheld before dispatch is never forced through", async () => {
  const document = new EventTarget();
  const candidate = {
    key: "spotify",
    state: "new",
    url: "https://open.spotify.com/album/example",
    barcode: "192650050563",
    tracks: 2,
  };
  let applies = 0;
  document.addEventListener("mc:probe", (event) => {
    const request = JSON.parse((event as CustomEvent).detail);
    document.dispatchEvent(
      new CustomEvent("mc:findings", {
        detail: JSON.stringify({
          id: "pc",
          run: request.run,
          findings: [{ ...candidate, state: "withheld" }],
        }),
      }),
    );
  });
  document.addEventListener("mc:apply", () => {
    applies++;
  });
  const run = new Function(
    "document",
    "location",
    "selected",
    `return (${applyReleaseSources.toString()})({id:'release',selected})`,
  );
  const result = await run(document, {
    origin: "https://musicbrainz.org",
    pathname: "/release/release",
  }, [candidate]);
  if (!result.notSubmitted || applies) {
    throw new Error("Withheld source was submitted");
  }
});

Deno.test("native model adapter preserves controller binding and unwraps compound barcode and string lengths", () => {
  const barcode: { value(): string; original?: unknown } = {
    value: () => "192650050563",
  };
  barcode.original = barcode;
  const artist = {
    name: "Artist",
    gid: "15c0a967-3e17-4fe2-8c14-c250b7500efb",
  };
  const credit = () => ({ names: [{ name: "Artist", artist }] });
  const editor = {
    rootField: {
      release: () => ({
        name: () => "Album",
        barcode,
        releaseGroup: () => ({ gid: "group" }),
        artistCredit: credit,
        mediums: () => [{
          formatID: () => 12,
          tracks: () => [{
            name: () => "Song",
            length: () => "508000",
            artistCredit: credit,
            recording: () => ({ gid: "recording" }),
          }],
        }],
      }),
    },
    allowsSubmission() {
      if (this !== editor) throw new Error("Lost controller binding");
      return true;
    },
  };
  const result = execute(editorState, {
    globalThis: { MB: { releaseEditor: editor } },
    location: { pathname: "/release/add" },
    document: {
      querySelectorAll: (selector: string) =>
        selector === "select option"
          ? [{ textContent: "Digital Media", value: "12" }]
          : [],
    },
  }) as EditorSnapshot;
  if (
    result.barcode !== "192650050563" ||
    result.mediums?.[0].tracks[0].length !== 508000 ||
    !result.allowsSubmission || result.mediums[0].format !== "Digital Media"
  ) throw new Error("Native fields were not normalized");
  JSON.stringify(result); // Returning native cyclic field objects would fail CDP serialization.
});

Deno.test("native tab traversal visits required sections without submitting", async () => {
  const visited: number[] = [];
  let finished = false;
  const result = execute(finishEditor, {
    globalThis: {
      MB: {
        releaseEditor: {
          tabCount: 4,
          uiTabs: {
            options: { disabled: [1] },
            _setOption: (_key: string, index: number) => visited.push(index),
          },
          lastTab: () => {
            finished = true;
          },
        },
      },
    },
  });
  await result;
  if (JSON.stringify(visited) !== "[0,2,3]" || !finished) {
    throw new Error("Required native tab visits were skipped");
  }
});

Deno.test("duplicate check pages the entire live group and resolves provider URLs", async () => {
  const requested: string[] = [];
  const fetch = (path: string) => {
    requested.push(path);
    if (path.startsWith("/ws/2/url?")) {
      return Promise.resolve(
        Response.json({
          urls: [{ relations: [{ release: { id: "outside" } }] }],
        }),
      );
    }
    if (path.includes("offset=0")) {
      return Promise.resolve(
        Response.json({ "release-count": 2, releases: [{ id: "first" }] }),
      );
    }
    if (path.includes("offset=100")) {
      return Promise.resolve(
        Response.json({ "release-count": 2, releases: [{ id: "second" }] }),
      );
    }
    if (path.startsWith("/ws/2/release/outside?")) {
      return Promise.resolve(Response.json({ id: "outside" }));
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const run = new Function(
    "fetch",
    "location",
    "setTimeout",
    `return (${editionDuplicates.toString()})({group:'group',urls:['https://tidal.com/album/123']})`,
  );
  const result = await run(
    fetch,
    { origin: "https://musicbrainz.org" },
    (callback: () => void) => setTimeout(callback, 0),
  );
  if (
    JSON.stringify(result.groupIds) !== '["first","second"]' ||
    result.releases.length !== 3 || requested.length !== 4
  ) throw new Error("Incomplete live duplicate check");
});

Deno.test("failed or truncated duplicate lookups never establish that a release is absent", async () => {
  for (const failure of ["url", "group", "truncated"]) {
    const fetch = (path: string) => {
      if (path.startsWith("/ws/2/url?")) {
        return Promise.resolve(
          new Response(null, { status: failure === "url" ? 503 : 404 }),
        );
      }
      if (failure === "group") {
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      return Promise.resolve(
        Response.json({ "release-count": 1, releases: [] }),
      );
    };
    const run = new Function(
      "fetch",
      "location",
      "setTimeout",
      `return (${editionDuplicates.toString()})({group:'group',urls:['https://tidal.com/album/123']})`,
    );
    let rejected = false;
    try {
      await run(
        fetch,
        { origin: "https://musicbrainz.org" },
        (callback: () => void) => setTimeout(callback, 0),
      );
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error(`Incorrect absence conclusion after ${failure} failure`);
    }
  }
});
