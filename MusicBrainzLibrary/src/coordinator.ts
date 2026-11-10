/// <reference lib="dom" />
/// <reference path="./userscript_globals.d.ts" />
import { auditSnapshot } from "./audit.ts";
import { checkpointArchive, validCheckpointKey } from "./checkpoints.ts";
import { lovedInput } from "./input.ts";
import type { AuditRow } from "./policy.ts";
import type { LovedInput, Store } from "./ports.ts";
import {
  activateRun,
  PREFIX,
  RUN_LOCK,
  startWorker,
  UserscriptBrowser,
} from "./userscript_browser.ts";
import { runReleases } from "./workflow.ts";
import {
  compileReview,
  type ReviewItem,
  type ReviewRecord,
  type ReviewSummary,
  reviewText,
} from "./review.ts";

const store: Store = {
  load: (key) => GM.getValue(`${PREFIX}data:${key}`),
  save: (key, value) => GM.setValue(`${PREFIX}data:${key}`, value),
};
const home = "https://musicbrainz.org/?sorsee-loved=1";
GM_registerMenuCommand("Sorsee Loved enrichment", () => {
  GM_openInTab(home, { active: true });
});

async function mount() {
  if (await startWorker()) return;
  if (!new URL(location.href).searchParams.has("sorsee-loved")) return;
  const panel = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = "Sorsee Loved enrichment";
  const description = document.createElement("p");
  description.textContent =
    "Import Sorsee’s account-data export. Only Loved recording IDs are retained. Run enrichment processes the remaining queue, adds verified links and digital releases, and collects unresolved cases for review. Keep this coordinator tab open; it resumes from checkpoints.";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const progress = document.createElement("progress");
  progress.setAttribute("aria-label", "Enrichment progress");
  progress.hidden = true;
  const elapsed = document.createElement("span");
  elapsed.style.marginInlineStart = "0.5rem";
  const manualHeading = document.createElement("h3");
  manualHeading.textContent = "Manual intervention (0)";
  const manualStatus = document.createElement("p");
  const manualList = document.createElement("ul");
  manualList.id = "sorsee-manual-review";
  const exportReview = document.createElement("button");
  exportReview.type = "button";
  exportReview.style.minBlockSize = "24px";
  exportReview.textContent = "Download manual-intervention list";
  exportReview.disabled = true;
  let reviewItems: ReviewItem[] = [];
  exportReview.addEventListener("click", () => {
    const url = URL.createObjectURL(
      new Blob([reviewText(reviewItems)], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "musicbrainz-manual-intervention.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  const allResults = document.createElement("details");
  const allResultsTitle = document.createElement("summary");
  allResultsTitle.textContent = "All release outcomes";
  const resultList = document.createElement("ul");
  allResults.append(allResultsTitle, resultList);
  const totals = document.createElement("p");
  const diagnostics = document.createElement("details");
  const diagnosticTitle = document.createElement("summary");
  diagnosticTitle.textContent = "Diagnostic evidence";
  diagnostics.append(diagnosticTitle);
  const detail = document.createElement("pre");
  detail.style.whiteSpace = "pre-wrap";
  const outcomeNames: Record<string, string> = {
    verified: "Verified",
    "verified-with-review": "Verified; some recordings need review",
    planned: "Ready to submit",
    "needs-review": "Needs review",
    "temporarily-unavailable": "Connection unavailable; ready to resume",
    "needs-verified-album": "Album identity needs review",
    "digital-edition-review": "Digital edition needs review",
    "no-digital-candidate": "No digital candidate",
    "provider-check-failed": "Provider unavailable",
    "no-verified-new-links": "No suitable new links",
    "release-sources-pending": "Album links awaiting verification",
    "submission-uncertain": "Submission needs verification",
    "submitted-pending": "Submitted; awaiting verification",
    "opening-release": "Opening release",
    "read-album": "Reading provider metadata",
  };
  let activeRelease: string | undefined;
  const report = (message: string) => {
    detail.textContent = message;
    try {
      const event = JSON.parse(message);
      if (typeof event.checked === "number") {
        status.textContent =
          `Checking Loved recordings: ${event.checked} of ${event.candidates}`;
        progress.hidden = false;
        progress.max = Math.max(1, event.candidates);
        progress.value = event.checked;
        progress.setAttribute("aria-label", "Loved recording audit progress");
      } else if (event.title) {
        status.textContent = `${event.title}: ${
          outcomeNames[event.status || event.stage] || event.status ||
          event.stage
        }`;
        if (event.release && event.stage === "opening-release") {
          activeRelease = event.release;
        }
        if (event.release && event.status && activeRelease === event.release) {
          activeRelease = undefined;
        }
        if (
          event.release && (event.status || event.stage === "opening-release")
        ) void refreshOutcomes().catch(console.error);
        if (typeof event.completed === "number") {
          progress.hidden = false;
          progress.max = Math.max(1, event.total);
          progress.value = event.completed;
          progress.setAttribute("aria-label", "Release enrichment progress");
        }
      }
    } catch {
      const activity = message.replace(/ \(\d+s\)$/, "");
      if (status.textContent !== activity) status.textContent = activity;
      elapsed.textContent = message.match(/\((\d+s)\)$/)?.[1] ?? "";
    }
  };
  const evidence = document.createElement("pre");
  evidence.style.whiteSpace = "pre-wrap";
  const evidenceLabel = document.createElement("label");
  evidenceLabel.textContent = "Inspect saved release evidence ";
  const outcomes = document.createElement("select");
  evidenceLabel.append(outcomes);
  let refreshGeneration = 0;
  async function refreshOutcomes() {
    const generation = ++refreshGeneration;
    const records: { key: string; record: ReviewRecord }[] = [];
    for (const key of await GM.listValues()) {
      if (!key.startsWith(`${PREFIX}data:loved/releases/`)) continue;
      const record = await GM.getValue<ReviewRecord>(key);
      if (record) records.push({ key, record });
    }
    const summary = await store.load<ReviewSummary>("loved/summary.json");
    const audit = await store.load<
      { results: { id: string; title?: string }[] }
    >("loved/audit/audit.json");
    if (generation !== refreshGeneration) return;
    // Commit the list and count from the same snapshot; older refreshes cannot overwrite it.
    reviewItems = compileReview(
      records.map((row) =>
        row.record.release === activeRelease
          ? { ...row.record, status: "probing" }
          : row.record
      ),
      summary,
      audit?.results,
    );
    const releases =
      reviewItems.filter((item) => item.type === "release").length;
    const recordings = reviewItems.length - releases;
    manualHeading.textContent = `Manual intervention (${reviewItems.length})`;
    manualStatus.textContent = reviewItems.length
      ? `${releases} releases and ${recordings} recordings need attention.`
      : "No manual intervention currently recorded. Pending work is not included.";
    exportReview.disabled = !reviewItems.length;
    const focusedLink = document.activeElement instanceof HTMLAnchorElement &&
        manualList.contains(document.activeElement)
      ? document.activeElement.href
      : undefined;
    manualList.replaceChildren();
    for (const item of reviewItems) {
      const row = document.createElement("li"),
        link = document.createElement("a");
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = item.title;
      const reasons = document.createElement("ul");
      for (const reason of item.reasons) {
        const entry = document.createElement("li");
        entry.textContent = reason;
        reasons.append(entry);
      }
      for (const recording of item.recordings) {
        const entry = document.createElement("li"),
          recordingLink = document.createElement("a");
        recordingLink.href = recording.url;
        recordingLink.target = "_blank";
        recordingLink.rel = "noopener";
        recordingLink.textContent = recording.title;
        entry.append(recordingLink, ` — ${recording.reason}`);
        reasons.append(entry);
      }
      row.append(link, reasons);
      manualList.append(row);
    }
    if (focusedLink) {
      [...manualList.querySelectorAll("a")].find((link) =>
        link.href === focusedLink
      )?.focus({ preventScroll: true });
    }
    const selected = outcomes.value;
    outcomes.replaceChildren(new Option("Choose a release", ""));
    resultList.replaceChildren();
    let verifiedRecordingLinks = 0, verifiedAlbumLinks = 0;
    for (const { key, record } of records) {
      verifiedRecordingLinks += record.confirmed?.length ?? 0;
      verifiedAlbumLinks += record.releaseSources?.confirmed?.length ?? 0;
      const row = document.createElement("li"),
        link = document.createElement("a");
      link.href = `https://musicbrainz.org/release/${
        encodeURIComponent(record.release)
      }`;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = record.title || record.release;
      row.append(link, ` — ${outcomeNames[record.status] || record.status}`);
      resultList.append(row);
      outcomes.append(
        new Option(`${record.title || record.release}: ${record.status}`, key),
      );
    }
    if ([...outcomes.options].some((option) => option.value === selected)) {
      outcomes.value = selected;
    }
    allResultsTitle.textContent = `All release outcomes (${records.length})`;
    totals.textContent =
      `${records.length} release outcomes · ${verifiedRecordingLinks} recording links verified · ${verifiedAlbumLinks} album links verified · ${reviewItems.length} need manual intervention`;
  }
  outcomes.addEventListener("change", async () => {
    try {
      evidence.textContent = outcomes.value
        ? JSON.stringify(await GM.getValue(outcomes.value), null, 2)
        : "";
    } catch (error) {
      status.textContent = String(error);
    }
  });
  const label = document.createElement("label");
  label.textContent =
    "Import account export, Loved snapshot or checkpoint backup ";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = ".json,application/json";
  label.append(file);
  const limitLabel = document.createElement("label");
  limitLabel.textContent = "Maximum releases this run ";
  const limit = document.createElement("input");
  limit.type = "number";
  limit.min = "1";
  limit.step = "1";
  limit.value = "";
  limit.placeholder = "All remaining releases";
  limitLabel.append(limit);
  const retryLabel = document.createElement("label");
  const retry = document.createElement("input");
  retry.type = "checkbox";
  retryLabel.append(retry, " Recheck releases already reviewed");
  const hint = document.createElement("p");
  hint.textContent =
    "Runs the whole remaining queue by default. Unresolved matches are collected below while processing continues. Preview is optional. Stop finishes the current release before saving progress.";
  const controls = document.createElement("div");
  const buttons: HTMLButtonElement[] = [];
  function button(text: string, action: () => Promise<void> | void) {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = text;
    node.style.margin = "0.25rem";
    node.addEventListener("click", async () => {
      try {
        await action();
      } catch (error) {
        status.textContent = String(error);
      }
    });
    controls.append(node);
    buttons.push(node);
    return node;
  }
  let stopped = false;
  async function exclusive(action: () => Promise<void>) {
    await navigator.locks.request(
      RUN_LOCK,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) {
          throw new Error(
            "Another coordinator is running; stop it first",
          );
        }
        file.disabled = true;
        limit.disabled = true;
        retry.disabled = true;
        buttons.forEach((b) => b.disabled = true);
        stop.disabled = false;
        try {
          await action();
        } finally {
          file.disabled = false;
          limit.disabled = false;
          retry.disabled = false;
          buttons.forEach((b) => b.disabled = false);
          stop.disabled = true;
        }
      },
    );
  }
  async function run(apply: boolean) {
    await exclusive(async () => {
      if (await GM.getValue(`${PREFIX}restore`)) {
        throw new Error(
          "Checkpoint restore was interrupted. Reimport the same backup before running.",
        );
      }
      const input = await store.load<LovedInput>("loved/input.json");
      if (!input) throw new Error("Import your Loved data first");
      const maximum = limit.value.trim() ? Number(limit.value) : Infinity;
      if (
        maximum !== Infinity && (!Number.isSafeInteger(maximum) || maximum < 1)
      ) throw new Error("Maximum releases must be a positive integer or empty");
      stopped = false;
      const runId = crypto.randomUUID();
      status.textContent = "Waiting for any previous operation to finish…";
      await activateRun(runId);
      status.textContent = `${
        apply ? "Apply" : "Plan"
      }: checking ${input.items.length} Loved recordings against live MusicBrainz`;
      await auditSnapshot(input, "loved/audit", store, () => stopped, report);
      if (!stopped) {
        const audit = await store.load<{ done: boolean; results: AuditRow[] }>(
          "loved/audit/audit.json",
        );
        if (!audit?.done) {
          throw new Error("Live audit incomplete; resume before applying");
        }
        await runReleases({
          browser: new UserscriptBrowser(runId, report),
          store,
          input,
          audit,
          apply,
          limit: maximum,
          retryReviewed: retry.checked,
          stopped: () => stopped,
          report,
        });
      }
      await refreshOutcomes();
      const summary = await store.load<
        {
          counts: Record<string, number>;
          remainingUnprocessed: string[];
          pausedForVerification?: boolean;
          pausedForConnection?: boolean;
        }
      >("loved/summary.json");
      if (summary) detail.textContent = JSON.stringify(summary, null, 2);
      status.textContent = stopped
        ? "Stopped. Checkpoints saved; Plan or Apply resumes."
        : summary?.pausedForVerification
        ? "Paused: a submission outcome needs verification before more edits can run. Progress is saved; inspect the listed case."
        : summary?.pausedForConnection
        ? "Connection interrupted. Progress is saved; Run enrichment resumes this release when the connection returns."
        : summary?.remainingUnprocessed.length
        ? `Run finished with ${summary.remainingUnprocessed.length} releases remaining. See the results and resume when ready.`
        : "Queue finished. Verified additions and cases needing review are listed below.";
      elapsed.textContent = "";
    });
  }
  button("Preview without edits", () => run(false));
  button("Run enrichment", () => run(true));
  const stop = button("Stop after current release", () => {
    stopped = true;
    status.textContent =
      "Stop requested; allowing the current operation to finish and save its outcome.";
  });
  stop.disabled = true;
  button("Export checkpoints", async () => {
    await exclusive(async () => {
      if (await GM.getValue(`${PREFIX}restore`)) {
        throw new Error("Finish restoring the backup before exporting.");
      }
      const entries: Record<string, unknown> = {};
      for (const key of await GM.listValues()) {
        if (key.startsWith(`${PREFIX}data:`)) {
          entries[key.slice(`${PREFIX}data:`.length)] = await GM.getValue(key);
        }
      }
      if (!entries["loved/input.json"]) {
        throw new Error("Nothing to export yet");
      }
      const url = URL.createObjectURL(
        new Blob([
          JSON.stringify(
            { format: "sorsee-loved-checkpoints", version: 1, entries },
            null,
            2,
          ),
        ], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "sorsee-loved-checkpoints.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      status.textContent = "Checkpoint backup downloaded.";
    });
  });
  file.addEventListener("change", () => {
    void exclusive(async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      const text = await chosen.text();
      const value = JSON.parse(text);
      const restoring = await GM.getValue<string>(`${PREFIX}restore`);
      if (value?.format === "sorsee-loved-checkpoints") {
        const archive = checkpointArchive(value);
        const digest = [
          ...new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(text),
            ),
          ),
        ].map((b) => b.toString(16).padStart(2, "0")).join("");
        if (restoring && restoring !== digest) {
          throw new Error(
            "Reimport the same backup to finish the interrupted restore",
          );
        }
        // A restore must never erase a newer write-ahead journal.
        const existing = (await GM.listValues()).some((k) =>
          k.startsWith(`${PREFIX}data:`)
        );
        if (existing && !restoring) {
          throw new Error(
            "Checkpoint restore requires empty coordinator storage. Export existing progress first; do not overwrite pending work.",
          );
        }
        await GM.setValue(`${PREFIX}restore`, digest);
        for (const [key, entry] of Object.entries(archive.entries)) {
          if (validCheckpointKey(key)) await store.save(key, entry);
        }
        await GM.deleteValue(`${PREFIX}restore`);
        status.textContent =
          "Checkpoints restored. Plan or Apply reconciles previous work.";
      } else {
        if (restoring) {
          throw new Error("Finish restoring the same checkpoint backup first");
        }
        const input = lovedInput(value);
        await store.save("loved/input.json", input);
        status.textContent =
          `Imported ${input.items.length} Loved recordings. Existing edit checkpoints retained.`;
      }
    }).catch((error) => {
      status.textContent = String(error);
    });
  });
  panel.append(
    heading,
    description,
    label,
    document.createElement("hr"),
    limitLabel,
    retryLabel,
    hint,
    controls,
    status,
    progress,
    elapsed,
    totals,
    manualHeading,
    manualStatus,
    exportReview,
    manualList,
    allResults,
    diagnostics,
  );
  diagnostics.append(detail, evidenceLabel, evidence);
  panel.style.cssText =
    "padding:1rem;border:1px solid currentColor;margin:1rem 0;max-width:65rem";
  (document.querySelector("#content") ?? document.body).prepend(panel);
  const input = await store.load<LovedInput>("loved/input.json");
  status.textContent = input
    ? `${input.items.length} Loved recordings saved. Ready to resume.`
    : "Import your Sorsee export to start.";
  const summary = await store.load("loved/summary.json");
  if (summary) detail.textContent = JSON.stringify(summary, null, 2);
  await refreshOutcomes();
}
void mount().catch((error) => {
  console.error(error);
  alert(`Sorsee Loved: ${error}`);
});
