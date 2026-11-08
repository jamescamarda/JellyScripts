import type { LovedInput, Store } from "./ports.ts";
/** Read-only, resumable live check before using String Theory to fill Library gaps. */
export type Relation = {
  type?: string;
  ended?: boolean;
  url?: { resource?: string };
};
export type RecordingRow = {
  recordingMbid?: string;
  providerLinks?: { service: string; linkType: string }[];
  [key: string]: unknown;
};

export function hasSupportedStream(row: RecordingRow): boolean {
  return (row.providerLinks ?? []).some((link) =>
    ["youtube", "spotify", "soundcloud"].includes(link.service) &&
    ["audio", "music_video"].includes(link.linkType)
  );
}

export function supportedLiveStreams(relations: Relation[]): Relation[] {
  return relations.filter((relation) => {
    if (
      relation.ended || ![
        "free streaming",
        "stream for free",
        "stream video for free",
      ].includes(relation.type ?? "")
    ) return false;
    try {
      const url = new URL(relation.url?.resource ?? "");
      const host = url.hostname.replace(/^www\./, "");
      if (!["http:", "https:"].includes(url.protocol)) return false;
      if (host === "open.spotify.com") {
        return /^\/(?:intl-[a-z]+\/)?track\/[A-Za-z0-9]{22}\/?$/.test(
          url.pathname,
        );
      }
      if (host === "soundcloud.com") {
        return /^\/[^/]+\/[^/]+\/?$/.test(url.pathname) &&
          !/^\/(?:discover|charts|search)\//.test(url.pathname) &&
          !/\/(?:sets|likes|tracks|albums|reposts|popular-tracks)\/?$/.test(
            url.pathname,
          );
      }
      if (host === "youtu.be") return /^\/[\w-]{11}\/?$/.test(url.pathname);
      if (
        host === "youtube.com" || host === "music.youtube.com" ||
        host === "m.youtube.com"
      ) {
        return (url.pathname === "/watch" &&
          /^[\w-]{11}$/.test(url.searchParams.get("v") ?? "")) ||
          /^\/(?:shorts|embed|live)\/[\w-]{11}\/?$/.test(url.pathname);
      }
    } catch { /* Invalid URLs never establish coverage. */ }
    return false;
  });
}

/** GTIN leading zero padding is equivalent; missing or invalid barcodes never match. */
export function barcodeKey(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^(?:\d{8}|\d{12,14})$/.test(raw.trim())) {
    return null;
  }
  if (!/[1-9]/.test(raw)) return null;
  const digits = raw.trim().padStart(14, "0");
  const sum = [...digits.slice(0, -1)].reduce(
    (sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 3 : 1),
    0,
  );
  return (10 - sum % 10) % 10 === Number(digits.at(-1)) ? digits : null;
}

export function releaseLinkAllowed(
  release: {
    barcode?: unknown;
    media?: { format?: string | null; "track-count"?: number }[];
  },
  provider: { barcode?: unknown; tracks?: number; digital?: boolean },
): boolean {
  const key = barcodeKey(release.barcode);
  return key !== null && key === barcodeKey(provider.barcode) &&
    !!release.media?.length &&
    release.media.every((medium) => medium.format === "Digital Media") &&
    release.media.every((medium) =>
      Number.isInteger(medium["track-count"]) && medium["track-count"]! > 0
    ) &&
    provider.digital === true && Number.isInteger(provider.tracks) &&
    provider.tracks! > 0 &&
    release.media.reduce(
        (sum, medium) => sum + (medium["track-count"] ?? 0),
        0,
      ) === provider.tracks;
}

export async function auditSnapshot(
  source: LovedInput,
  output: string,
  store: Store,
  stopped: () => boolean = () => false,
  report: (message: string) => void = console.log,
): Promise<void> {
  const rows: RecordingRow[] = source.items;
  if (!Array.isArray(rows) || source.done !== true || source.errors?.length) {
    throw new Error(
      "A complete Library snapshot without failed batches is required",
    );
  }
  const unique = new Map<string, RecordingRow>();
  for (const row of rows) {
    if (
      !row.recordingMbid ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(row.recordingMbid)
    ) {
      throw new Error("Every row must have a valid Recording MBID");
    }
    unique.set(row.recordingMbid.toLowerCase(), row);
  }
  const pending = [...unique.entries()].filter(([, row]) =>
    !hasSupportedStream(row)
  );
  const results: unknown[] = [];
  const runStartedAt = Date.now();
  let previousRequest = 0;
  const atomic = store.save;
  for (const [id, row] of pending) {
    if (stopped()) return;
    const file = `${output}/recordings/${id}.json`;
    let checked: {
      checkedAt: string;
      requestedId?: string;
      recording: {
        id: string;
        title: string;
        relations?: Relation[];
        releases?: unknown[];
        isrcs?: string[];
      };
    } | undefined;
    try {
      const saved = await store.load<typeof checked>(file);
      const age = Date.now() - Date.parse(saved?.checkedAt ?? "");
      if (
        (saved?.recording?.id === id || saved?.requestedId === id) &&
        age >= 0 &&
        age < 24 * 60 * 60 * 1000
      ) {
        checked = saved;
      }
    } catch (error) {
      if (
        !(error instanceof SyntaxError)
      ) throw error;
    }
    if (!checked) {
      let lastError = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, previousRequest + 1100 - Date.now()))
        );
        previousRequest = Date.now();
        try {
          const response = await fetch(
            `https://musicbrainz.org/ws/2/recording/${id}?inc=url-rels+isrcs+releases+release-groups+media+artist-credits&fmt=json`,
            {
              headers: {
                "User-Agent":
                  "SorseeLibraryEnrichment/0.1 (https://github.com/jamescamarda/sorsee-client)",
              },
              signal: AbortSignal.timeout(30000),
            },
          );
          if (!response.ok) {
            lastError = `HTTP ${response.status}`;
            if (![429, 500, 502, 503, 504].includes(response.status)) break;
            const retry = Number(response.headers.get("retry-after"));
            await response.body?.cancel();
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                Math.max(
                  3000 * (attempt + 1),
                  Number.isFinite(retry) ? retry * 1000 : 0,
                ),
              )
            );
            continue;
          }
          const recording = await response.json();
          if (
            !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(
              recording.id ?? "",
            ) ||
            typeof recording.title !== "string" ||
            !Array.isArray(recording.relations)
          ) {
            throw new Error("Invalid recording response");
          }
          checked = {
            checkedAt: new Date().toISOString(),
            requestedId: id,
            recording,
          };
          await atomic(file, checked);
          break;
        } catch (error) {
          lastError = String(error);
        }
      }
      if (!checked) {
        results.push({
          id,
          title: row.title ?? row.track,
          status: "check-failed",
          error: lastError,
        });
      }
    }
    if (checked) {
      const streams = supportedLiveStreams(checked.recording.relations ?? []);
      results.push({
        id,
        canonicalId: checked.recording.id,
        title: checked.recording.title,
        checkedAt: checked.checkedAt,
        status: streams.length ? "already-linked-live" : "needs-release-review",
        streams,
        releases: checked.recording.releases ?? [],
        isrcs: checked.recording.isrcs ?? [],
        libraryRelease: row.releaseMbid ?? null,
      });
    }
    const summary = {
      totalUnique: unique.size,
      candidates: pending.length,
      checked: results.length,
      done: results.length === pending.length,
      startedAt: new Date(runStartedAt).toISOString(),
      updatedAt: new Date().toISOString(),
      results,
    };
    if (results.length % 20 === 0 || summary.done) {
      await atomic(`${output}/audit.json`, summary);
    }
    if (results.length % 20 === 0 || summary.done) {
      report(
        JSON.stringify({
          checked: results.length,
          candidates: pending.length,
          alreadyLinked: results.filter((r) =>
            (r as { status: string }).status === "already-linked-live"
          ).length,
          failed: results.filter((r) =>
            (r as { status: string }).status === "check-failed"
          ).length,
        }),
      );
    }
  }
  if (!pending.length) {
    await atomic(`${output}/audit.json`, {
      totalUnique: unique.size,
      candidates: 0,
      checked: 0,
      done: true,
      results: [],
    });
  }
}
