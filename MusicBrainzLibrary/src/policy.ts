import {
  barcodeKey,
  type Relation,
  releaseLinkAllowed,
  supportedLiveStreams,
} from "./audit.ts";

export const PROVIDER_PRIORITY = [
  "tidal",
  "qobuz",
  "deezer",
  "apple",
  "bandcamp",
  "beatport",
  "ytmusic",
  "soundcloud",
  "audiomack",
];

export type Alias = { name: string; type?: string | null };
export type Recording = {
  id: string;
  title: string;
  length?: number | null;
  isrcs?: string[];
  relations?: Relation[];
  aliases?: Alias[];
};
export type Credit = {
  name: string;
  artist?: { id?: string; name?: string; aliases?: Alias[] };
  joinphrase?: string;
};
export type Track = {
  title: string;
  length?: number | null;
  recording: Recording;
  "artist-credit"?: Credit[];
};
export type Release = {
  id: string;
  title: string;
  barcode?: string | null;
  "artist-credit"?: Credit[];
  "release-group"?: { id: string; title?: string; aliases?: Alias[] };
  aliases?: Alias[];
  identityVersion?: number;
  "label-info"?: { label?: { id: string; name: string } }[];
  media: { format?: string | null; "track-count"?: number; tracks?: Track[] }[];
  relations?: Relation[];
};
export type Album = {
  title: string;
  barcode?: string | null;
  url: string;
  credit?: { name: string; artistName?: string }[];
  mediums: {
    format: string;
    tracks: {
      title: string;
      lengthMs?: number;
      isrc?: string;
      url?: string;
      credit?: { name: string; artistName?: string }[];
    }[];
  }[];
  [key: string]: unknown;
};
export type Finding = {
  key: string;
  state: string;
  name: string;
  kind?: string;
  entity?: unknown;
  url?: string | null;
  barcode?: string | null;
  tracks?: number;
  format?: string | null;
  track?: string;
  isrc?: string;
  why?: string;
};
export type Findings = {
  id: string;
  findings: Finding[];
  source?: string | null;
  more?: boolean;
  note?: string;
};
export type AuditRow = {
  id: string;
  canonicalId?: string;
  error?: string;
  title: string;
  status: string;
  releases?: Release[];
};
export type ReleaseJob = {
  id: string;
  title: string;
  loved: string[];
  digital: boolean;
};

export const normalized = (value: string) =>
  value.normalize("NFKC").replace(
    /\p{Script=Latin}[\p{M}]*/gu,
    (part) => part.normalize("NFD").replace(/\p{M}/gu, ""),
  )
    .toLocaleLowerCase("en").replace(
      /[^\p{L}\p{N}]+/gu,
      " ",
    ).trim();
export const digital = (release: Release) =>
  release.media.length > 0 &&
  release.media.every((m) => m.format === "Digital Media");

/** Prefer a verified-format candidate covering more Loved gaps; dates do not rank editions. */
export function releaseJobs(
  rows: AuditRow[],
): { jobs: ReleaseJob[]; withoutRelease: string[] } {
  const candidates = new Map<string, ReleaseJob>();
  const withoutRelease: string[] = [];
  for (const row of rows.filter((r) => r.status === "needs-release-review")) {
    if (!row.releases?.length) {
      withoutRelease.push(row.id);
      continue;
    }
    for (const release of row.releases) {
      const current = candidates.get(release.id) ??
        {
          id: release.id,
          title: release.title,
          loved: [],
          digital: digital(release) && !!barcodeKey(release.barcode),
        };
      if (!current.loved.includes(row.id)) current.loved.push(row.id);
      candidates.set(release.id, current);
    }
  }
  const covered = new Set<string>(), jobs: ReleaseJob[] = [];
  while (candidates.size) {
    const ranked = [...candidates.values()].map((job) => ({
      ...job,
      loved: job.loved.filter((id) => !covered.has(id)),
    }))
      .filter((job) => job.loved.length).sort((a, b) =>
        Number(b.digital) - Number(a.digital) ||
        b.loved.length - a.loved.length || a.id.localeCompare(b.id)
      );
    if (!ranked.length) break;
    const next = ranked[0];
    jobs.push(next);
    next.loved.forEach((id) => covered.add(id));
    candidates.delete(next.id);
  }
  return { jobs, withoutRelease };
}

// Versioned so old name-only review outcomes are reconsidered once after upgrade.
export const IDENTITY_VERSION = 2;
export function aliasNames(aliases: Alias[] = []): string[] {
  return aliases.filter((alias) => alias.type?.toLowerCase() !== "search hint")
    .map((alias) => alias.name);
}
export function sameName(
  left: string,
  right: string,
  aliases: Alias[] = [],
): boolean {
  const expected = normalized(right);
  return !!expected &&
    [left, ...aliasNames(aliases)].some((name) =>
      normalized(name) === expected
    );
}
export function crossScript(left: string, right: string): boolean {
  const scripts = (value: string) => {
    const patterns = [
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
      /\p{Script=Cyrillic}/u,
      /\p{Script=Greek}/u,
      /\p{Script=Hangul}/u,
      /\p{Script=Arabic}/u,
      /\p{Script=Hebrew}/u,
      /\p{Script=Devanagari}/u,
      /\p{Script=Thai}/u,
    ];
    return patterns.map((pattern, index) => pattern.test(value) ? index : -1)
      .filter((index) => index >= 0);
  };
  const a = scripts(left), b = scripts(right);
  // Shared English subtitles or version qualifiers must not hide a native-script name.
  if (a.length && !b.length) return /\p{Script=Latin}/u.test(right);
  if (b.length && !a.length) return /\p{Script=Latin}/u.test(left);
  return !!a.length && !!b.length && !a.some((script) => b.includes(script));
}

export const normalizedIsrc = (code: string = "") =>
  code.toUpperCase().replace(/[^A-Z0-9]/g, "");
function commonIsrc(
  track: Track,
  other: Album["mediums"][number]["tracks"][number],
): boolean {
  const code = normalizedIsrc(other.isrc);
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(code) &&
    (track.recording.isrcs ?? []).some((existing) =>
      normalizedIsrc(existing) === code
    );
}
export function artistCreditsMatch(
  release: Release,
  track: Track | undefined,
  album: Album,
  other?: Album["mediums"][number]["tracks"][number],
): boolean {
  const credits = track?.["artist-credit"] ?? release["artist-credit"] ?? [];
  const source = other?.credit?.length ? other.credit : album.credit ?? [];
  if (!credits.length || credits.length !== source.length) return false;
  const used = new Set<number>();
  return source.every((credit) => {
    const index = credits.findIndex((known, i) =>
      !used.has(i) &&
      (sameName(
        known.name,
        credit.artistName ?? credit.name,
        known.artist?.aliases,
      ) ||
        sameName(
          known.artist?.name ?? "",
          credit.artistName ?? credit.name,
          known.artist?.aliases,
        ))
    );
    if (index < 0) return false;
    used.add(index);
    return true;
  });
}
function versionTags(title: string): string {
  return [
    ...new Set(
      normalized(title).match(
        /\b(?:live|remix|mix|radio|extended|instrumental|acoustic|demo|remaster(?:ed)?|mono|stereo|edit|version|movie)\b/g,
      ) ?? [],
    ),
  ].sort().join("|");
}
export function recordingIdentity(
  release: Release,
  track: Track,
  album: Album,
  other: Album["mediums"][number]["tracks"][number] | undefined,
): { basis?: string; reason?: string } {
  if (!other) return { reason: "Provider recording is missing" };
  const length = track.length ?? track.recording.length;
  if (!length || !other.lengthMs || Math.abs(length - other.lengthMs) > 2000) {
    return { reason: "Duration differs by over two seconds or is unknown" };
  }
  const isrc = normalizedIsrc(other.isrc);
  if (isrc && track.recording.isrcs?.length && !commonIsrc(track, other)) {
    return { reason: "Provider ISRC conflicts with existing ISRCs" };
  }
  if (!artistCreditsMatch(release, track, album, other)) {
    return { reason: "Artist credit differs or is unknown" };
  }
  if (
    sameName(track.title, other.title, track.recording.aliases) ||
    sameName(track.recording.title, other.title, track.recording.aliases)
  ) return { basis: "name or MusicBrainz alias, artist and duration" };
  if (
    crossScript(track.title, other.title) && commonIsrc(track, other) &&
    versionTags(track.title) === versionTags(other.title)
  ) {
    return { basis: "cross-script name, existing ISRC, artist and duration" };
  }
  return {
    reason:
      "Recording title/version differs without a verified alias or cross-script ISRC match",
  };
}
export function albumTitleMatches(
  release: Release,
  album: Album,
  positional = true,
): boolean {
  if (
    sameName(release.title, album.title, [
      ...release.aliases ?? [],
      ...release["release-group"]?.aliases ?? [],
    ])
  ) return true;
  if (
    !crossScript(release.title, album.title) ||
    versionTags(release.title) !== versionTags(album.title)
  ) return false;
  const mb = release.media.flatMap((medium) => medium.tracks ?? []);
  const source = album.mediums.flatMap((medium) => medium.tracks);
  const seen = new Set<string>();
  const strong = source.filter((other, i) => {
    const candidates = (positional ? mb.slice(i, i + 1) : mb).filter((track) =>
      commonIsrc(track, other) &&
      !recordingIdentity(release, track, album, other).reason
    );
    const ids = [...new Set(candidates.map((track) => track.recording.id))];
    if (ids.length !== 1 || seen.has(ids[0])) return false;
    // A shared/reused ISRC cannot establish a translated album's identity.
    if (
      new Set(
        mb.filter((track) => commonIsrc(track, other)).map((track) =>
          track.recording.id
        ),
      ).size !== 1
    ) return false;
    seen.add(ids[0]);
    return true;
  });
  return source.length > 0 &&
    strong.length >=
      Math.max(Math.min(3, source.length), Math.ceil(source.length * 0.75));
}
export function albumMatches(release: Release, album: Album): boolean {
  const tracks = album.mediums.flatMap((medium) => medium.tracks);
  return !(album.missing as { count?: number } | undefined)?.count &&
    album.mediums.length > 0 &&
    album.mediums.every((medium) => medium.format === "Digital Media") &&
    releaseLinkAllowed(release, {
      barcode: album.barcode,
      tracks: tracks.length,
      digital: true,
    }) &&
    tracks.every((track) => !!track.title.trim()) &&
    albumTitleMatches(release, album);
}

/** Check each recording independently; album identity never overrides conflicts. */
export function matchingRecordings(release: Release, album: Album): {
  valid: string[];
  rejected: { recording: string; reason: string }[];
  matches?: { recording: string; basis: string }[];
} {
  if (!albumMatches(release, album)) {
    return {
      valid: [],
      rejected: [{
        recording: "",
        reason:
          "Digital edition, album identity, barcode or complete track count does not match",
      }],
    };
  }
  const mb = release.media.flatMap((medium) => medium.tracks ?? []);
  const source = album.mediums.flatMap((medium) => medium.tracks);
  const isrcs = new Map<string, Set<string>>();
  mb.forEach((track, i) => {
    for (const raw of [...track.recording.isrcs ?? [], source[i]?.isrc ?? ""]) {
      const code = normalizedIsrc(raw);
      if (!code) continue;
      const ids = isrcs.get(code) ?? new Set<string>();
      ids.add(track.recording.id);
      isrcs.set(code, ids);
    }
  });
  const matches: { recording: string; basis: string }[] = [],
    rejected: { recording: string; reason: string }[] = [];
  mb.forEach((track, i) => {
    const result = recordingIdentity(release, track, album, source[i]);
    const code = normalizedIsrc(source[i]?.isrc);
    const reason = code && (isrcs.get(code)?.size ?? 0) > 1
      ? "ISRC belongs to multiple recordings on this release"
      : result.reason;
    if (reason) rejected.push({ recording: track.recording.id, reason });
    else matches.push({ recording: track.recording.id, basis: result.basis! });
  });
  return {
    valid: [...new Set(matches.map((row) => row.recording))].filter((id) =>
      !rejected.some((row) => row.recording === id)
    ),
    rejected,
    matches,
  };
}

export function recordingLinks(
  release: Release,
  findings: Findings,
  valid: string[],
): Finding[] {
  const recordings = new Map(
    release.media.flatMap((m) => m.tracks ?? []).map((
      t,
    ) => [t.recording.id, t.recording]),
  );
  const blocked = new Set(
    findings.findings.filter((f) =>
      f.kind !== "link" && ["blocked", "unsure"].includes(f.state)
    ).map((f) => f.track),
  );
  const seen = new Set<string>();
  return findings.findings.filter((finding) => {
    if (
      finding.kind !== "link" || finding.state !== "new" || !finding.track ||
      !finding.url || blocked.has(finding.track) ||
      !valid.includes(finding.track)
    ) return false;
    if (
      !supportedLiveStreams([{
        type: "free streaming",
        url: { resource: finding.url },
      }]).length
    ) return false;
    const recording = recordings.get(finding.track);
    if (
      !recording ||
      recording.relations?.some((r) => r.url?.resource === finding.url)
    ) return false;
    const key = `${finding.track}\0${finding.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Only album sources PC confidently matched to this exact digital product. */
export function releaseSources(
  release: Release,
  findings: Findings,
): Finding[] {
  const digitalOnly = new Set([
    ...PROVIDER_PRIORITY.filter((key) => key !== "bandcamp"),
    "spotify",
    "amazonmusic",
    "volumo",
    "hdtracks",
    "sevendigital",
  ]);
  const seen = new Set<string>();
  return findings.findings.filter((finding) => {
    if (
      finding.state !== "new" || finding.kind || finding.entity || !finding.url
    ) return false;
    if (
      !digitalOnly.has(finding.key) &&
      !["bandcamp", "discogs"].includes(finding.key)
    ) return false;
    const format = finding.format?.trim().toLowerCase();
    const isDigital = format
      ? ["digital", "digital media"].includes(format)
      : digitalOnly.has(finding.key);
    if (
      !releaseLinkAllowed(release, {
        barcode: finding.barcode,
        tracks: finding.tracks,
        digital: isDigital,
      })
    ) return false;
    let url: URL;
    try {
      url = new URL(finding.url);
    } catch {
      return false;
    }
    if (
      !["http:", "https:"].includes(url.protocol) || url.username ||
      url.password
    ) return false;
    const key = sourceUrlKey(finding.url);
    // Ended relationships also stay excluded: this job must not resurrect them.
    if (
      seen.has(key) ||
      release.relations?.some((relation) =>
        relation.url?.resource && sourceUrlKey(relation.url.resource) === key
      )
    ) return false;
    seen.add(key);
    return true;
  });
}

export function sourceUrlKey(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    const album = url.pathname.match(/\/album\/(?:[^/]+\/)?([^/]+)\/?$/)?.[1];
    if (
      ["tidal.com", "listen.tidal.com"].includes(host) &&
      /^\d+$/.test(album ?? "")
    ) return `tidal:album:${album}`;
    if (host === "open.spotify.com" && /^[\da-zA-Z]{22}$/.test(album ?? "")) {
      return `spotify:album:${album}`;
    }
    if (
      host === "music.apple.com" && /^\d+$/.test(album ?? "") &&
      !url.searchParams.has("i")
    ) return `apple:album:${album}`;
    if (
      ["deezer.com", "www.deezer.com"].includes(host) &&
      /^\d+$/.test(album ?? "")
    ) return `deezer:album:${album}`;
    if (
      ["qobuz.com", "open.qobuz.com", "play.qobuz.com"].includes(host) && album
    ) return `qobuz:album:${album}`;
    if (
      ["youtube.com", "music.youtube.com"].includes(host) &&
      url.pathname === "/playlist" && url.searchParams.get("list")
    ) return `youtube:playlist:${url.searchParams.get("list")}`;
    url.hash = "";
    url.hostname = url.hostname.replace(/^www\./, "");
    url.protocol = "https:";
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    url.searchParams.sort();
    return url.href;
  } catch {
    return value;
  }
}
