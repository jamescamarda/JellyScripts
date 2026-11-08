import { barcodeKey } from "./audit.ts";
import type { BrowserPort } from "./ports.ts";

import {
  digitalEditionPlan,
  type EditionPlan,
  matchingDigitalEditions,
} from "./digital_editions.ts";
import { type Album, digital, normalized, type Release } from "./policy.ts";

export type EditorSnapshot = {
  ready: boolean;
  path: string;
  title?: string;
  barcode?: string;
  group?: string;
  credit?: { name?: string; artist?: string; id?: string }[];
  mediums?: {
    format: string;
    tracks: {
      title: string;
      length: number;
      recording?: string;
      credit: { name?: string; artist?: string; id?: string }[];
    }[];
  }[];
  allowsSubmission?: boolean;
  errors?: string[];
  requirements?: string[];
};
const uuid = (id: string | undefined) =>
  /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id ?? "");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function editorProblems(
  snapshot: EditorSnapshot,
  plan: EditionPlan,
): string[] {
  if (!snapshot.ready) return ["Native editor is not ready"];
  const problems = [
    ...snapshot.errors ?? [],
    ...(snapshot.requirements ?? []).map((key) => `Native validation: ${key}`),
  ];
  if (snapshot.group !== plan.group) {
    problems.push("Editor would use a different release group");
  }
  if (barcodeKey(snapshot.barcode) !== plan.barcode) {
    problems.push("Editor barcode differs from the provider");
  }
  if (normalized(snapshot.title ?? "") !== normalized(plan.source.title)) {
    problems.push("Editor release title differs");
  }
  if (
    !snapshot.mediums?.length ||
    !snapshot.mediums.every((m) => m.format === "Digital Media")
  ) problems.push("Editor is not creating Digital Media");
  const tracks = snapshot.mediums?.flatMap((m) => m.tracks) ?? [];
  const source = plan.source.mediums.flatMap((m) => m.tracks);
  if (tracks.length !== source.length) {
    problems.push("Editor track count differs");
  }
  const creditNames = (credit: { name?: string; artist?: string }[]) =>
    [...new Set(credit.map((c) => normalized(c.name || c.artist || "")))].sort()
      .join("|");
  const main = snapshot.credit ?? [];
  if (!main.length || main.some((c) => !uuid(c.id))) {
    problems.push("Apollo has not resolved every release artist");
  }
  if (creditNames(main) !== creditNames(plan.source.credit ?? [])) {
    problems.push("Editor release artist credit differs");
  }
  tracks.forEach((track, index) => {
    const other = source[index];
    if (
      !other || normalized(track.title) !== normalized(other.title) ||
      track.length !== other.lengthMs
    ) problems.push(`Editor track ${index + 1} differs from provider data`);
    if (!uuid(track.recording)) {
      problems.push(
        `Apollo has not resolved recording ${
          index + 1
        }; no automatic creation of duplicate recordings`,
      );
    }
    if (plan.recordings[index] && track.recording !== plan.recordings[index]) {
      problems.push(
        `Editor changed the verified recording at position ${index + 1}`,
      );
    }
    if (!track.credit.length || track.credit.some((c) => !uuid(c.id))) {
      problems.push(
        `Apollo has not resolved every artist on track ${index + 1}`,
      );
    }
    if (
      other &&
      creditNames(track.credit) !==
        creditNames(
          other.credit?.length ? other.credit : plan.source.credit ?? [],
        )
    ) problems.push(`Editor artist credit differs on track ${index + 1}`);
  });
  if (!snapshot.allowsSubmission) {
    problems.push("MusicBrainz validation does not allow submission");
  }
  return [...new Set(problems)];
}

export type DuplicateCheck = {
  checkedAt: string;
  group: string;
  groupIds: string[];
  releases: Release[];
  linked: string[];
};
export type EditionOutcome = {
  status: string;
  releaseId?: string;
  plan: EditionPlan;
  duplicateCheck?: DuplicateCheck;
  editorTarget?: string;
  problems?: string[];
  [key: string]: unknown;
};

export async function importDigitalEdition(options: {
  browser: BrowserPort;
  target: string;
  physical: Release;
  album: Album;
  platform: { id: string; name: string };
  apply: boolean;
  checkpoint(value: EditionOutcome): Promise<void>;
}): Promise<EditionOutcome> {
  const { browser, target, physical, album, platform, apply, checkpoint } =
    options;
  const plan = digitalEditionPlan(physical, album);
  const outcome: EditionOutcome = { status: "digital-edition-review", plan };
  if (plan.reasons.length) return { ...outcome, problems: plan.reasons };
  const check = async () =>
    await browser.evaluate<DuplicateCheck>(
      target,
      "editionDuplicates",
      {
        group: plan.group,
        urls: [
          ...new Set([
            album.url,
            ...(album.urls as { url: string }[] ?? []).map((u) => u.url),
          ]),
        ],
      },
    );
  let duplicates = await check();
  outcome.duplicateCheck = duplicates;
  const matches = matchingDigitalEditions(duplicates.releases, album);
  if (matches.length > 1) {
    return {
      ...outcome,
      problems: [
        "Several matching digital editions already exist; resolve the duplicate rather than creating another",
      ],
    };
  }
  if (matches.length === 1) {
    if (!duplicates.groupIds.includes(matches[0].id)) {
      return {
        ...outcome,
        problems: [
          "The digital product is already linked in a different release group",
        ],
      };
    }
    return {
      ...outcome,
      status: "existing-digital-edition",
      releaseId: matches[0].id,
    };
  }
  if (
    duplicates.releases.some((release) =>
      digital(release) &&
      (barcodeKey(release.barcode) === plan.barcode ||
        duplicates.linked.includes(release.id))
    )
  ) {
    return {
      ...outcome,
      problems: [
        "Existing digital product has conflicting or incomplete edition metadata",
      ],
    };
  }
  if (!apply) return { ...outcome, status: "digital-edition-planned" };
  const editorTarget = await browser.openEditor();
  let preserveEditor = false;
  try {
    outcome.editorTarget = editorTarget;
    outcome.status = "seeding-digital-edition";
    await checkpoint(outcome);
    await browser.evaluate(editorTarget, "seedEdition", {
      album,
      platform,
      parameters: plan.parameters,
    }).catch((error) => {
      if (!/context.*destroyed|Cannot find context/i.test(String(error))) {
        throw error;
      }
    });
    let snapshot: EditorSnapshot = { ready: false, path: "" };
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      snapshot = await browser.evaluate<EditorSnapshot>(
        editorTarget,
        "editorState",
      ).catch(() => ({ ready: false, path: "" }));
      if (
        snapshot.ready && snapshot.barcode &&
        barcodeKey(snapshot.barcode) === plan.barcode
      ) {
        await browser.evaluate(editorTarget, "finishEditor");
        snapshot = await browser.evaluate<EditorSnapshot>(
          editorTarget,
          "editorState",
        );
        if (!editorProblems(snapshot, plan).length) break;
      }
      await sleep(1000);
    }
    outcome.editorSnapshot = snapshot;
    const problems = editorProblems(snapshot, plan);
    // Until unseeded Apollo matches can be independently verified, require the
    // exact known recording identities from the physical edition for every row.
    if (plan.recordings.some((id) => !id)) {
      problems.push(
        "Some Apollo recording choices need independent verification",
      );
    }
    if (problems.length) {
      outcome.problems = problems;
      outcome.status = "digital-edition-review";
      await checkpoint(outcome);
      return outcome;
    }
    // Repeat direct URL and complete release-group checks immediately before saving.
    duplicates = await check();
    outcome.duplicateCheck = duplicates;
    const appeared = matchingDigitalEditions(duplicates.releases, album);
    if (appeared.length) {
      await browser.closeTab(editorTarget);
      if (
        appeared.length !== 1 || !duplicates.groupIds.includes(appeared[0].id)
      ) {
        return {
          ...outcome,
          status: "digital-edition-review",
          problems: [
            "Matching product appeared in multiple editions or another release group",
          ],
        };
      }
      return {
        ...outcome,
        status: "existing-digital-edition",
        releaseId: appeared.length === 1 ? appeared[0].id : undefined,
        problems: appeared.length > 1
          ? ["Several matching editions appeared during preparation"]
          : undefined,
      };
    }
    if (
      duplicates.releases.some((release) =>
        digital(release) &&
        (barcodeKey(release.barcode) === plan.barcode ||
          duplicates.linked.includes(release.id))
      )
    ) {
      return {
        ...outcome,
        status: "digital-edition-review",
        problems: ["A conflicting digital product appeared during preparation"],
      };
    }
    const finalSnapshot = await browser.evaluate<EditorSnapshot>(
      editorTarget,
      "editorState",
    );
    const finalProblems = editorProblems(finalSnapshot, plan);
    if (finalProblems.length) {
      return {
        ...outcome,
        status: "digital-edition-review",
        problems: finalProblems,
      };
    }
    outcome.status = "creating-digital-edition";
    await checkpoint(outcome);
    preserveEditor = true;
    await browser.evaluate(editorTarget, "submitEdition").catch(
      (error) => {
        if (!/context.*destroyed|Cannot find context/i.test(String(error))) {
          throw error;
        }
      },
    );
    const savedDeadline = Date.now() + 90000;
    while (Date.now() < savedDeadline) {
      const page = (await browser.targets()).find((page) =>
        page.targetId === editorTarget
      );
      const id = page?.url.match(
        /^https:\/\/musicbrainz\.org\/release\/([\da-f-]{36})\/?(?:[?#]|$)/i,
      )?.[1];
      if (id) {
        const confirmed = await check();
        if (
          matchingDigitalEditions(confirmed.releases, album).some((release) =>
            release.id === id
          )
        ) {
          outcome.status = "digital-edition-created";
          outcome.releaseId = id;
          outcome.duplicateCheck = confirmed;
          await checkpoint(outcome);
          await browser.closeTab(editorTarget);
          return outcome;
        }
      }
      await sleep(2000);
    }
    outcome.status = "digital-edition-uncertain";
    outcome.problems = [
      "Save outcome is uncertain; inspect the editor and pending edits before retrying",
    ];
    await checkpoint(outcome);
    return outcome;
  } finally {
    if (!preserveEditor) await browser.closeTab(editorTarget);
  }
}
