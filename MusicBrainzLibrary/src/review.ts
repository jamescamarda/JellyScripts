/** One classification feeds the visible list, its counts and the downloadable report. */
export type ReviewRecord = {
  release: string;
  title?: string;
  status: string;
  note?: string;
  error?: string;
  confirmed?: unknown[];
  mapping?: { rejected?: { recording?: string; reason: string }[] };
  currentMapping?: { rejected?: { recording?: string; reason: string }[] };
  scoutIncomplete?: boolean;
  releaseSources?: { status?: string; error?: string; confirmed?: unknown[] };
  edition?: {
    status?: string;
    problems?: string[];
    plan?: { reasons?: string[]; unresolved?: string[] };
  };
  releaseData?: {
    media?: {
      tracks?: { title?: string; recording?: { id: string; title?: string } }[];
    }[];
  };
};
export type ReviewItem = {
  type: "release" | "recording";
  id: string;
  title: string;
  url: string;
  reasons: string[];
  recordings: { id: string; title: string; url: string; reason: string }[];
};
export type ReviewSummary = {
  withoutRelease?: string[];
  auditFailures?: { id: string; title?: string; error?: string }[];
};
const active = new Set([
  "probing",
  "submitting",
  "seeding-digital-edition",
  "creating-digital-edition",
]);
const clean = new Set([
  "verified",
  "planned",
  "existing-digital-edition",
  "digital-edition-created",
  "digital-edition-planned",
]);
const reasonsByStatus: Record<string, string> = {
  "no-digital-candidate":
    "No digital candidate was found by the enabled providers; check for a suitable digital edition manually.",
  "no-verified-new-links":
    "No suitable new supported recording links were found; check the missing recordings manually.",
  "provider-check-failed":
    "Provider checks failed; check availability before retrying.",
  "needs-verified-album":
    "The provider album could not be matched safely to the MusicBrainz edition.",
  "digital-edition-review":
    "The digital edition could not be created safely; resolve the editor or identity issues below.",
  "digital-edition-uncertain":
    "Check the release and pending edits before retrying digital-edition creation.",
  "submission-uncertain":
    "Check live relationships and pending edits before retrying; the submission outcome is uncertain.",
  "submitted-pending":
    "The recording submission is awaiting verification; check pending edits before retrying.",
  "release-sources-pending":
    "Album links need verification; check live relationships and pending edits before retrying.",
  partial:
    "Only part of the recording submission completed; verify pending edits before retrying.",
  "temporarily-unavailable":
    "The connection was interrupted; resume when connectivity returns.",
};
const unique = (
  values: (string | undefined)[],
) => [...new Set(values.filter((s): s is string => !!s?.trim()))];
const urlFor = (type: ReviewItem["type"], id: string) =>
  `https://musicbrainz.org/${type}/${encodeURIComponent(id)}`;

export function compileReview(
  records: ReviewRecord[],
  summary: ReviewSummary = {},
  titles: { id: string; title?: string }[] = [],
): ReviewItem[] {
  const items = new Map<string, ReviewItem>();
  for (const record of records) {
    if (active.has(record.status)) continue;
    const rejected = (record.currentMapping ?? record.mapping)?.rejected ?? [];
    const sourceIssue = ["rejected", "pending", "uncertain", "submitting"]
      .includes(record.releaseSources?.status ?? "");
    const editionIssue = [
      "digital-edition-review",
      "digital-edition-uncertain",
      "creating-digital-edition",
    ].includes(record.edition?.status ?? "");
    if (
      clean.has(record.status) && !rejected.length && !record.scoutIncomplete &&
      !sourceIssue && !editionIssue
    ) continue;
    const reasons = unique([
      reasonsByStatus[record.status],
      record.error,
      record.note,
      ...rejected.map((row) => row.reason),
      record.scoutIncomplete
        ? "Some provider results were incomplete; inspect sources that were not verified."
        : undefined,
      sourceIssue
        ? record.releaseSources?.error ||
          "Album link submission requires verification before retrying."
        : undefined,
      ...editionIssue
        ? [
          ...record.edition?.problems ?? [],
          ...record.edition?.plan?.reasons ?? [],
          ...record.edition?.plan?.unresolved ?? [],
        ]
        : [],
    ]);
    if (!reasons.length) {
      reasons.push(
        record.status === "verified-with-review"
          ? "Some recordings or provider results still need review."
          : "This release requires manual inspection.",
      );
    }
    const tracks = record.releaseData?.media?.flatMap((m) => m.tracks ?? []) ??
      [];
    const recordings = rejected.filter((row) => !!row.recording).map((row) => {
      const track = tracks.find((track) =>
        track.recording?.id === row.recording
      );
      return {
        id: row.recording!,
        title: track?.title || track?.recording?.title || row.recording!,
        url: urlFor("recording", row.recording!),
        reason: row.reason,
      };
    });
    items.set(`release:${record.release}`, {
      type: "release",
      id: record.release,
      title: record.title || record.release,
      url: urlFor("release", record.release),
      reasons,
      recordings,
    });
  }
  const recording = (id: string, title?: string) => {
    const key = `recording:${id}`;
    if (!items.has(key)) {
      items.set(key, {
        type: "recording",
        id,
        title: title || titles.find((row) => row.id === id)?.title || id,
        url: urlFor("recording", id),
        reasons: [],
        recordings: [],
      });
    }
    const item = items.get(key)!;
    if (title) item.title = title;
    return item;
  };
  for (const id of summary.withoutRelease ?? []) {
    recording(id).reasons.push(
      "No associated release was found; identify the appropriate edition manually.",
    );
  }
  for (const failure of summary.auditFailures ?? []) {
    recording(failure.id, failure.title).reasons.push(
      failure.error ||
        "The live recording lookup failed; inspect it before retrying.",
    );
  }
  return [...items.values()].map((item) => ({
    ...item,
    reasons: unique(item.reasons),
  })).sort((a, b) =>
    a.type.localeCompare(b.type) || a.title.localeCompare(b.title) ||
    a.id.localeCompare(b.id)
  );
}

export function reviewText(items: ReviewItem[]): string {
  const releases = items.filter((item) => item.type === "release").length;
  return [
    "MusicBrainz manual intervention",
    `${releases} releases; ${items.length - releases} recordings`,
    "",
    ...items.flatMap((
      item,
      index,
    ) => [
      `${index + 1}. ${item.title}`,
      item.url,
      ...item.reasons.map((reason) => `   - ${reason}`),
      ...item.recordings.map((row) =>
        `   - ${row.title}: ${row.reason}\n     ${row.url}`
      ),
      "",
    ]),
  ].join("\n");
}
