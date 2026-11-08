import { barcodeKey } from "./audit.ts";
import type { BrowserPort, LovedInput, Store } from "./ports.ts";
import { digitalEditionPlan } from "./digital_editions.ts";
import { type EditionOutcome, importDigitalEdition } from "./import_edition.ts";
import {
  enrichReleaseSources,
  RELEASE_SOURCES_VERSION,
  type ReleaseSourceState,
} from "./release_sources.ts";

import {
  type Album,
  albumMatches,
  artistCreditsMatch,
  type AuditRow,
  crossScript,
  digital,
  type Finding,
  type Findings,
  IDENTITY_VERSION,
  matchingRecordings,
  normalized,
  PROVIDER_PRIORITY,
  recordingLinks,
  type Release,
  type ReleaseJob,
  releaseJobs,
} from "./policy.ts";

type Probe = { providers: unknown[]; results: Findings[]; progress: unknown[] };
type AlbumRead = {
  ok: boolean;
  rel?: Album;
  provider?: { id: string; name: string };
  error?: string;
};
type State = {
  status: string;
  release: string;
  title?: string;
  updatedAt: string;
  selected?: Finding[];
  releaseSources?: ReleaseSourceState;
  [key: string]: unknown;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runReleases(options: {
  browser: BrowserPort;
  store: Store;
  input: LovedInput;
  audit: { results: AuditRow[] };
  apply: boolean;
  limit?: number;
  refresh?: boolean;
  retryReviewed?: boolean;
  release?: string;
  stopped?: () => boolean;
  report?: (message: string) => void;
}) {
  const { browser, input, audit, apply } = options;
  const { load, save } = options.store;
  const output = "loved";
  const limit = options.limit ?? Infinity;
  const stopped = options.stopped ?? (() => false);
  const report = options.report ?? console.log;
  const args = new Map<string, string>();
  if (options.refresh) args.set("--refresh", "true");
  if (options.release) args.set("--release", options.release);
  const plan = releaseJobs(audit.results);
  // A fresh recording audit can stop reporting a gap after its streams were
  // added. Retain that job while its separate PC-source work needs reconciliation.
  const priorPlan = await load<{ jobs: ReleaseJob[] }>(`${output}/plan.json`);
  const lovedIds = new Set(input.items.map((item) => item.recordingMbid));
  for (const job of priorPlan?.jobs ?? []) {
    if (plan.jobs.some((current) => current.id === job.id)) continue;
    const loved = job.loved.filter((id) => lovedIds.has(id));
    if (!loved.length) continue;
    const checkpoint = await load<State>(`${output}/releases/${job.id}.json`);
    if (!checkpoint) continue;
    const sourcesComplete =
      checkpoint.releaseSources?.version === RELEASE_SOURCES_VERSION &&
      ["none", "verified"].includes(checkpoint.releaseSources.status);
    if (
      checkpoint.status !== "verified" || !sourcesComplete ||
      args.has("--refresh") || args.get("--release") === job.id
    ) plan.jobs.push({ ...job, loved });
  }
  if (
    args.has("--release") &&
    !plan.jobs.some((job) => job.id === args.get("--release"))
  ) {
    const rows = audit.results.filter((row) =>
      row.status === "needs-release-review" &&
      row.releases?.some((release) => release.id === args.get("--release"))
    );
    const release = rows.flatMap((row) => row.releases ?? []).find((release) =>
      release.id === args.get("--release")
    );
    if (release) {
      plan.jobs.push({
        id: release.id,
        title: release.title,
        loved: rows.map((row) => row.id),
        digital: digital(release) && !!barcodeKey(release.barcode),
      });
    }
  }
  await save(`${output}/plan.json`, {
    scope: "Loved only",
    createdAt: new Date().toISOString(),
    ...plan,
  });
  const jobs = plan.jobs.filter((job) =>
    !args.has("--release") || job.id === args.get("--release")
  );
  if (args.has("--release") && !jobs.length) {
    throw new Error("Requested release is not in the Loved gap plan");
  }
  let processed = 0;
  let pausedForVerification = false;
  let pausedForConnection = false;
  for (const [jobIndex, job] of jobs.entries()) {
    if (
      processed >= limit || stopped() || pausedForVerification ||
      pausedForConnection
    ) break;
    const file = `${output}/releases/${job.id}.json`;
    const previous = await load<State>(file);
    if (
      previous?.status === "verified" &&
      previous.identityVersion === IDENTITY_VERSION &&
      previous.releaseSources?.version === RELEASE_SOURCES_VERSION &&
      ["none", "verified"].includes(previous.releaseSources.status) &&
      !args.has("--refresh")
    ) continue;
    // A completed review must not pin every bounded run to the same release.
    // Applying a previously planned review remains eligible once; retry is explicit.
    const reviewed = [
      "needs-review",
      "verified-with-review",
      "no-digital-candidate",
      "needs-verified-album",
      "digital-edition-review",
      "provider-check-failed",
      "no-verified-new-links",
    ].includes(previous?.status ?? "");
    const pendingWrite = previous?.recordingPending === true ||
      ["creating-digital-edition", "digital-edition-uncertain"].includes(
        (previous?.edition as EditionOutcome | undefined)?.status ?? "",
      ) ||
      (previous?.result &&
        (previous.selected?.length ?? 0) >
          ((previous.confirmed as unknown[] | undefined)?.length ?? 0)) ||
      (previous?.releaseSources &&
        ["submitting", "pending", "uncertain"].includes(
          previous.releaseSources.status,
        ));
    if (
      reviewed &&
      !/Failed to fetch|NetworkError|network request|timed out|timeout|HTTP (?:429|5\d\d)/i
        .test(String(previous?.error ?? "")) &&
      !pendingWrite && !options.refresh && !options.retryReviewed &&
      !options.release &&
      previous?.identityVersion === IDENTITY_VERSION &&
      (previous?.mode === "apply" ||
        previous?.mode === (apply ? "apply" : "plan"))
    ) continue;
    if (
      previous?.status === "planned" &&
      previous.releaseSources?.version === RELEASE_SOURCES_VERSION && !apply &&
      !args.has("--refresh")
    ) {
      continue;
    }
    processed++;
    let target: string | undefined;
    let state: State = {
      ...previous,
      status: "probing",
      mode: apply ? "apply" : "plan",
      error: undefined,
      identityVersion: IDENTITY_VERSION,
      release: job.id,
      title: job.title,
      updatedAt: new Date().toISOString(),
      loved: job.loved,
    };
    let submissionStarted = false;
    let activeId = typeof previous?.activeRelease === "string"
      ? previous.activeRelease
      : job.id;
    try {
      report(
        JSON.stringify({
          release: job.id,
          title: job.title,
          stage: "opening-release",
          completed: jobIndex,
          total: jobs.length,
        }),
      );
      target = await browser.openRelease(activeId);
      let release = await browser.evaluate<Release>(
        target,
        "releaseData",
        activeId,
      );
      const previousEdition = previous?.edition as EditionOutcome | undefined;
      if (
        previous && previousEdition &&
        ["creating-digital-edition", "digital-edition-uncertain"].includes(
          previousEdition.status,
        )
      ) {
        const originalSource = previous.source as AlbumRead | undefined;
        if (!originalSource?.rel || !originalSource.provider) {
          throw new Error(
            "Cannot reconcile digital edition without its provider source",
          );
        }
        const reconciled = await importDigitalEdition({
          browser,
          target,
          physical: release,
          album: originalSource.rel,
          platform: originalSource.provider,
          apply: false,
          checkpoint: async () => {},
        });
        if (!reconciled.releaseId) {
          state = {
            ...previous,
            status: "digital-edition-uncertain",
            edition: {
              ...previousEdition,
              status: "digital-edition-uncertain",
              reconciliation: reconciled,
            },
            note: "Inspect pending edits before retrying release creation",
            updatedAt: new Date().toISOString(),
          };
          await save(file, state);
          continue;
        }
        activeId = reconciled.releaseId;
        state.activeRelease = activeId;
        await browser.closeTab(target);
        target = await browser.openRelease(activeId);
        release = await browser.evaluate<Release>(
          target,
          "releaseData",
          activeId,
        );
      }
      if (
        previous &&
        (previous.recordingPending === true ||
          (previous.result && (previous.selected?.length ?? 0) >
              ((previous.confirmed as unknown[] | undefined)?.length ?? 0)) ||
          ["submitting", "submission-uncertain", "submitted-pending", "partial"]
            .includes(previous.status))
      ) {
        const selected = previous.selected ?? [];
        const now = new Map(
          release.media.flatMap((m) => m.tracks ?? []).map((
            t,
          ) => [t.recording.id, t.recording]),
        );
        const visible = selected.every((link) =>
          now.get(link.track!)?.relations?.some((relation) =>
            !relation.ended && relation.url?.resource === link.url
          )
        );
        state = {
          ...previous,
          status: selected.length && visible
            ? previous.releaseSources &&
                ["submitting", "pending", "uncertain", "rejected"].includes(
                  previous.releaseSources.status,
                )
              ? "release-sources-pending"
              : "verified"
            : "submission-uncertain",
          recordingPending: !visible,
          updatedAt: new Date().toISOString(),
          note: visible
            ? "Confirmed from live relationships"
            : "Inspect pending edits; no automatic resubmission",
        };
        await save(file, state);
        continue;
      }
      let pc = await browser.evaluate<Probe>(target, "probe", {
        id: activeId,
        only: ["pc"],
      });
      state = { ...state, releaseData: release, platformCheck: pc };
      await save(file, state);
      let platform = pc.results.find((result) => result.id === "pc");
      if (!platform) throw new Error("Platform Check did not answer");
      const runSourceStage = async () => {
        const report = await enrichReleaseSources(release, platform!, apply, {
          refresh: async () => {
            await sleep(1100);
            return await browser.evaluate<Release>(
              target!,
              "releaseData",
              activeId,
            );
          },
          submit: async (selected) =>
            await browser.evaluate(target!, "applyReleaseSources", {
              id: activeId,
              selected,
            }),
          checkpoint: async (report) => {
            state.releaseSources = report;
            state.browserTarget = target;
            await save(file, state);
          },
        }, previous?.releaseSources);
        state.releaseSources = report;
      };
      if (digital(release)) await runSourceStage();
      const order = PROVIDER_PRIORITY;
      const albums = platform.findings.filter((finding) =>
        finding.url && !finding.kind && !finding.entity &&
        ["new", "linked"].includes(finding.state) && order.includes(finding.key)
      )
        .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
      if (!digital(release) && !albums.length) {
        state.status = "no-digital-candidate";
        state.note =
          "No album candidate was returned by the enabled providers; no edition was invented";
        await save(file, state);
        continue;
      }
      const resolveIdentity = async (candidate: Album) => {
        const tracks = release.media.flatMap((m) => m.tracks ?? []);
        const sourceTracks = candidate.mediums.flatMap((m) => m.tracks);
        if (
          crossScript(release.title, candidate.title) ||
          tracks.some((track, i) =>
            sourceTracks[i] &&
            (crossScript(track.title, sourceTracks[i].title) ||
              !artistCreditsMatch(release, track, candidate, sourceTracks[i]))
          )
        ) {
          release = await browser.evaluate<Release>(
            target!,
            "identityAliases",
            { release, album: candidate },
          );
        }
      };
      const reads: AlbumRead[] = [];
      let source: AlbumRead | undefined;
      let creationSource: AlbumRead | undefined;
      for (const finding of albums) {
        report(
          JSON.stringify({
            release: job.id,
            stage: "read-album",
            provider: finding.key,
          }),
        );
        const read: AlbumRead = await browser.evaluate<AlbumRead>(
          target,
          "readAlbum",
          finding.url,
        ).catch((error) => ({ ok: false, error: String(error) }));
        reads.push(read);
        if (read.ok && read.rel) await resolveIdentity(read.rel);
        if (read.ok && read.rel && albumMatches(release, read.rel)) {
          source = read;
          break;
        }
        if (
          !digital(release) && read.ok && read.rel && read.provider &&
          !digitalEditionPlan(release, read.rel).reasons.length
        ) {
          creationSource = read;
          break;
        }
      }
      state = { ...state, albumReads: reads };
      if (!source?.rel && creationSource?.rel && creationSource.provider) {
        state.source = creationSource;
        const edition = await importDigitalEdition({
          browser,
          target,
          physical: release,
          album: creationSource.rel,
          platform: creationSource.provider,
          apply,
          checkpoint: async (edition) => {
            state.edition = edition;
            state.status = edition.status;
            if (
              edition.status === "creating-digital-edition"
            ) submissionStarted = true;
            await save(file, state);
          },
        });
        state.edition = edition;
        state.status = edition.status;
        await save(file, state);
        if (!edition.releaseId) continue;
        activeId = edition.releaseId;
        state.activeRelease = activeId;
        await browser.closeTab(target);
        target = await browser.openRelease(activeId);
        release = await browser.evaluate<Release>(
          target,
          "releaseData",
          activeId,
        );
        await resolveIdentity(creationSource.rel);
        if (!albumMatches(release, creationSource.rel)) {
          throw new Error(
            "Digital edition changed after import or duplicate check",
          );
        }
        source = creationSource;
        submissionStarted = false;
        pc = await browser.evaluate<Probe>(target, "probe", {
          id: activeId,
          only: ["pc"],
        });
        platform = pc.results.find((result) => result.id === "pc");
        if (!platform) {
          throw new Error(
            "Platform Check did not answer for the digital edition",
          );
        }
        state.digitalPlatformCheck = pc;
        await runSourceStage();
      }
      if (!source?.rel) {
        // A physical edition is never relabelled. Save actual digital products
        // for duplicate checks and First Contact/Apollo import, rather than
        // manufacturing their tracklists from a CD or a mismatched product.
        const proposals = reads.filter((read) =>
          read.ok && read.rel && barcodeKey(read.rel.barcode) &&
          read.rel.mediums?.length && read.rel.mediums.every((m) =>
            m.format === "Digital Media"
          )
        );
        state.status = !digital(release) && proposals.length
          ? "digital-edition-review"
          : reads.length && reads.every((read) => !read.ok)
          ? "provider-check-failed"
          : "needs-verified-album";
        state.digitalCandidates = proposals;
        state.releaseGroup = release["release-group"]?.id ?? null;
        const translated = reads.some((read) =>
          read.rel &&
          barcodeKey(read.rel.barcode) === barcodeKey(release.barcode) &&
          normalized(read.rel.title) !== normalized(release.title)
        );
        state.note = digital(release)
          ? translated
            ? "Provider barcode matches, but the album title differs (possibly a translation). Recording-link matching needs review; verified release links are handled separately."
            : "No complete provider album matched this edition's barcode and title"
          : "Streaming links cannot be added to this physical edition";
        await save(file, state);
        continue;
      }
      const mapping = matchingRecordings(release, source.rel);
      const is = await browser.evaluate<Probe>(target, "probe", {
        id: activeId,
        only: ["is"],
        links: [
          ...new Set([
            source.rel.url,
            ...(state.releaseSources?.selected.map((finding) => finding.url!) ??
              []),
          ]),
        ],
        isrcs: source.rel.mediums.flatMap((medium) => medium.tracks).map((
          track,
        ) => track.isrc ?? null),
      });
      const findings = is.results.find((result) => result.id === "is");
      if (!findings || !Array.isArray(findings.findings)) {
        throw new Error("ISRC Scout did not return recording findings");
      }
      // A failed provider must not discard independently verified links from others.
      state.scoutIncomplete = !!findings.more ||
        !!findings.note?.includes("failed");
      await sleep(1100);
      release = await browser.evaluate<Release>(
        target,
        "releaseData",
        activeId,
      );
      await resolveIdentity(source.rel);
      if (!albumMatches(release, source.rel)) {
        throw new Error("Release identity changed after provider verification");
      }
      const currentMapping = matchingRecordings(release, source.rel);
      const selected = recordingLinks(release, findings, currentMapping.valid);
      if (currentMapping.rejected.length) {
        state.note =
          `${currentMapping.valid.length} recordings verified; ${currentMapping.rejected.length} need review: ${
            [...new Set(currentMapping.rejected.map((row) => row.reason))].join(
              "; ",
            )
          }`;
      } else state.note = undefined;
      if (state.scoutIncomplete) {
        state.note = [
          state.note,
          "Some provider results were incomplete; only independently verified links are eligible.",
        ].filter(Boolean).join(" ");
      }
      state = {
        ...state,
        source,
        mapping,
        currentMapping,
        isrcScout: is,
        selected,
        status: selected.length || state.releaseSources?.status === "planned"
          ? "planned"
          : state.releaseSources &&
              ["pending", "uncertain", "submitting", "rejected"].includes(
                state.releaseSources.status,
              )
          ? "release-sources-pending"
          : currentMapping.rejected.length || state.scoutIncomplete
          ? "verified-with-review"
          : state.releaseSources?.status === "verified" ||
              previous?.status === "verified"
          ? "verified"
          : "no-verified-new-links",
      };
      await save(file, state);
      if (!selected.length) continue;
      if (!apply) {
        state.dryRun = await browser.evaluate(target, "applyLinks", {
          id: activeId,
          keys: selected.map((link) => link.key),
          dry: true,
        });
        await save(file, state);
        continue;
      }
      // The write-ahead record survives a lost browser connection or response.
      state.recordingPending = true;
      state.status = "submitting";
      state.updatedAt = new Date().toISOString();
      await save(file, state);
      submissionStarted = true;
      const result = await browser.evaluate<
        { ok: boolean; sent: number; doneKeys?: string[]; note?: string }
      >(target, "applyLinks", {
        id: activeId,
        keys: selected.map((link) => link.key),
        dry: false,
      });
      state.result = result;
      state.status = result.ok ? "submitted-pending" : "partial";
      await save(file, state);
      await sleep(1500);
      const after = await browser.evaluate<Release>(
        target,
        "releaseData",
        activeId,
      );
      const recordings = new Map(
        after.media.flatMap((m) => m.tracks ?? []).map((
          t,
        ) => [t.recording.id, t.recording]),
      );
      state.confirmed = selected.filter((link) =>
        recordings.get(link.track!)?.relations?.some((relation) =>
          !relation.ended && relation.url?.resource === link.url
        )
      );
      if ((state.confirmed as Finding[]).length === selected.length) {
        state.status = currentMapping.rejected.length || state.scoutIncomplete
          ? "verified-with-review"
          : "verified";
        state.recordingPending = false;
      }
      if (
        state.releaseSources &&
        ["pending", "uncertain", "submitting", "rejected"].includes(
          state.releaseSources.status,
        )
      ) state.status = "release-sources-pending";
      await save(file, state);
    } catch (error) {
      state.status = submissionStarted
        ? "submission-uncertain"
        : "needs-review";
      state.error = String(error);
      if (
        !submissionStarted &&
        /Failed to fetch|NetworkError|network request|timed out|timeout|HTTP (?:429|5\d\d)/i
          .test(String(error))
      ) {
        state.status = "temporarily-unavailable";
        pausedForConnection = true;
      }
      await save(file, state);
    } finally {
      report(
        JSON.stringify({
          release: job.id,
          title: job.title,
          status: state.status,
          completed: jobIndex + 1,
          total: jobs.length,
          note: state.note,
          error: state.error,
          links: state.selected?.length ?? 0,
          releaseSources: state.releaseSources?.selected.length ?? 0,
          releaseSourceStatus: state.releaseSources?.status,
        }),
      );
      const falcon = (state.releaseSources?.result as
        | { falcon?: { running: boolean } }
        | undefined)?.falcon;
      const unresolvedSource = !!state.releaseSources &&
        ["pending", "uncertain", "submitting"].includes(
          state.releaseSources.status,
        ) && !falcon;
      const unresolvedRecording = state.status === "submission-uncertain";
      const unresolvedEdition =
        (state.edition as EditionOutcome | undefined)?.status ===
          "digital-edition-uncertain";
      pausedForVerification = unresolvedSource || unresolvedRecording ||
        unresolvedEdition;
      if (target && !unresolvedSource && !unresolvedRecording) {
        await browser.closeTab(target);
      }
      await sleep(1100);
    }
  }
  const outcomes: State[] = [];
  for (const job of plan.jobs) {
    const state = await load<State>(`${output}/releases/${job.id}.json`);
    if (state) outcomes.push(state);
  }
  const counts: Record<string, number> = {};
  const releaseSourceCounts: Record<string, number> = {};
  for (const state of outcomes) {
    counts[state.status] = (counts[state.status] ?? 0) + 1;
    if (state.releaseSources) {
      releaseSourceCounts[state.releaseSources.status] =
        (releaseSourceCounts[state.releaseSources.status] ?? 0) + 1;
    }
  }
  await save(`${output}/summary.json`, {
    scope: "Loved only",
    mode: apply ? "apply" : "plan",
    updatedAt: new Date().toISOString(),
    loved: input.items.length,
    plannedReleases: plan.jobs.length,
    processedReleases: outcomes.length,
    pausedForVerification,
    pausedForConnection,
    withoutRelease: plan.withoutRelease,
    auditFailures: audit.results.filter((row) => row.status === "check-failed")
      .map((row) => ({ id: row.id, title: row.title, error: row.error })),
    counts,
    releaseSourceCounts,
    remainingUnprocessed: plan.jobs.filter((job) =>
      !outcomes.some((state) => state.release === job.id)
    ).map((job) => job.id),
  });
  report(
    JSON.stringify({
      mode: apply ? "apply" : "plan",
      counts,
      totalPlannedReleases: plan.jobs.length,
      processedReleases: outcomes.length,
    }),
  );
}
