// Local browser fixture only: no MusicBrainz requests or edits are permitted.
import { chromium } from "playwright";
import {
  compileReview,
  type ReviewRecord,
  type ReviewSummary,
  reviewText,
} from "../src/review.ts";
const bundle = await Deno.readTextFile(
  new URL("../SorseeLoved.user.js", import.meta.url),
);
const base = "sorsee-loved:data:";
const missing = "11111111-1111-4111-8111-111111111111";
const clean = "22222222-2222-4222-8222-222222222222";
const failed = "33333333-3333-4333-8333-333333333333";
const partial = "44444444-4444-4444-8444-444444444444";
const active = "55555555-5555-4555-8555-555555555555";
const orphan = "66666666-6666-4666-8666-666666666666";
const failedRecording = "77777777-7777-4777-8777-777777777777";
const records: ReviewRecord[] = [
  {
    release: missing,
    title: "Missing <img src=x onerror=alert(1)>",
    status: "no-digital-candidate",
  },
  {
    release: clean,
    title: "Clean success",
    status: "verified",
    mapping: { rejected: [{ reason: "Obsolete conflict" }] },
    currentMapping: { rejected: [] },
  },
  {
    release: failed,
    title: "Provider failure",
    status: "provider-check-failed",
    error: "Provider unavailable",
  },
  {
    release: partial,
    title: "Partial success",
    status: "verified",
    currentMapping: {
      rejected: [{ recording: orphan, reason: "Conflicting ISRC" }],
    },
  },
  {
    release: active,
    title: "Currently processing",
    status: "probing",
    mapping: { rejected: [{ reason: "Old error" }] },
  },
];
const summary: ReviewSummary = {
  withoutRelease: [orphan, orphan],
  auditFailures: [
    { id: orphan, title: "Orphan recording", error: "HTTP 503" },
    { id: failedRecording, title: "Failed recording", error: "HTTP 404" },
  ],
};
const values: Record<string, unknown> = {
  [`${base}loved/summary.json`]: summary,
  ...Object.fromEntries(
    records.map(
      (record) => [`${base}loved/releases/${record.release}.json`, record],
    ),
  ),
};
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route(
    "**/*",
    (route) =>
      route.request().url() === "https://musicbrainz.org/?sorsee-loved=1"
        ? route.fulfill({
          contentType: "text/html",
          body:
            '<!doctype html><html lang="en"><title>Local review fixture</title><main id="content"></main></html>',
        })
        : route.abort(),
  );
  const mount = async (data: Record<string, unknown>) => {
    await page.goto("https://musicbrainz.org/?sorsee-loved=1");
    await page.evaluate((data) => {
      const globals = globalThis as unknown as Record<string, unknown>;
      globals.GM = {
        getValue: (key: string) => Promise.resolve(data[key]),
        listValues: () => Promise.resolve(Object.keys(data)),
      };
      globals.GM_registerMenuCommand = () => {};
      globals.GM_openInTab = () => {
        throw Error("Unexpected worker opened by review UI");
      };
    }, data);
    await page.addScriptTag({ content: bundle });
  };
  await mount(values);
  await page.getByRole("heading", {
    name: "Manual intervention (5)",
    exact: true,
  }).waitFor();
  const list = page.locator("#sorsee-manual-review");
  if (await list.locator(":scope > li").count() !== 5) {
    throw Error("List count differs from heading");
  }
  if (
    (await list.innerText()).includes("Clean success") ||
    (await list.innerText()).includes("Currently processing")
  ) throw Error("Success or active work leaked into manual list");
  if (await list.locator("img").count()) {
    throw Error("Title was interpreted as markup");
  }
  if (
    await list.locator(`a[href="https://musicbrainz.org/release/${missing}"]`)
      .count() !== 1
  ) throw Error("No-candidate release is not actionable");
  const all = page.locator("details").filter({
    has: page.locator("summary", { hasText: "All release outcomes (5)" }),
  });
  if (await all.getAttribute("open") !== null) {
    throw Error("All outcomes should be collapsed initially");
  }
  const exportButton = page.getByRole("button", {
    name: "Download manual-intervention list",
    exact: true,
  });
  await exportButton.focus();
  const downloading = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const download = await downloading;
  const path = await download.path();
  if (!path) throw Error("Review list was not downloaded");
  if (
    await Deno.readTextFile(path) !==
      reviewText(compileReview(records, summary))
  ) {
    throw Error(
      "Downloaded review list differs from the displayed classification",
    );
  }
  console.log(
    "PASS: complete manual count, no-candidate inclusion, linked reasons, safe titles, collapsed full results and keyboard export",
  );
  await mount({
    [`${base}loved/releases/${clean}.json`]: {
      release: clean,
      title: "Clean success",
      status: "verified",
    },
  });
  await page.getByRole("heading", {
    name: "Manual intervention (0)",
    exact: true,
  }).waitFor();
  if (
    !await page.getByRole("button", {
      name: "Download manual-intervention list",
      exact: true,
    }).isDisabled()
  ) throw Error("Empty list should not be exportable");
  if (await page.locator("#sorsee-manual-review > li").count()) {
    throw Error("Resolved issues remain in list");
  }
  console.log(
    "PASS: resolved and successful outcomes leave no stale manual entries or counts",
  );
} finally {
  await browser.close();
}
