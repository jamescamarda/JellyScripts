import { barcodeKey } from "./audit.ts";
import {
  type Album,
  albumTitleMatches,
  aliasNames,
  digital,
  normalized,
  recordingIdentity,
  type Release,
} from "./policy.ts";

export type EditionPlan = {
  group: string;
  barcode: string;
  source: Album;
  recordings: string[];
  parameters: [string, string][];
  reasons: string[];
  unresolved: string[];
};
type SourceCredit = {
  name: string;
  artistName?: string;
  join?: string;
  mbid?: string;
};

/** Reuse recordings only when the provider's complete digital tracklist agrees. */
export function digitalEditionPlan(
  physical: Release,
  source: Album,
): EditionPlan {
  const group = physical["release-group"]?.id ?? "";
  const reasons: string[] = [],
    unresolved: string[] = [],
    parameters: [string, string][] = [],
    recordings: string[] = [];
  const barcode = barcodeKey(source.barcode);
  if (!group) reasons.push("No existing release group");
  if (!barcode) reasons.push("Provider barcode is missing or invalid");
  if (
    !source.mediums?.length ||
    !source.mediums.every((medium) =>
      medium.format === "Digital Media" && medium.tracks.length > 0
    )
  ) reasons.push("Provider is not a complete digital product");
  if (!albumTitleMatches(physical, source, false)) {
    reasons.push("Album title differs from the existing release group context");
  }
  if ((source.missing as { count?: number } | undefined)?.count) {
    reasons.push("Provider reports missing tracks");
  }
  const tracks = physical.media.flatMap((medium) => medium.tracks ?? []);
  const idsByName = new Map<string, Set<string>>();
  for (
    const credit of [
      physical["artist-credit"] ?? [],
      ...tracks.map((track) => track["artist-credit"] ?? []),
    ]
  ) {
    for (const item of credit) {
      if (item.artist?.id) {
        for (
          const name of [
            item.name,
            item.artist.name ?? "",
            ...aliasNames(item.artist.aliases),
          ].filter(Boolean)
        ) {
          const ids = idsByName.get(normalized(name)) ?? new Set<string>();
          ids.add(item.artist.id);
          idsByName.set(normalized(name), ids);
        }
      }
    }
  }
  const add = (key: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== "") {
      parameters.push([key, String(value)]);
    }
  };
  const credit = (prefix: string, entries: SourceCredit[]) => {
    if (!entries?.length) {
      reasons.push(`Missing artist credit: ${prefix || "release"}`);
      return;
    }
    entries.forEach((entry, index) => {
      const ids = idsByName.get(normalized(entry.artistName ?? entry.name));
      const id = ids?.size === 1 ? [...ids][0] : undefined;
      if (!id) {
        unresolved.push(`Artist is not unambiguously resolved: ${entry.name}`);
      }
      add(`${prefix}artist_credit.names.${index}.name`, entry.name);
      add(
        `${prefix}artist_credit.names.${index}.artist.name`,
        entry.artistName ?? entry.name,
      );
      add(`${prefix}artist_credit.names.${index}.mbid`, id);
      add(
        `${prefix}artist_credit.names.${index}.join_phrase`,
        entry.join ?? "",
      );
    });
  };
  add("name", source.title);
  add("release_group", group);
  add("barcode", source.barcode);
  add("status", source.status);
  add("packaging", source.packaging);
  add("script", source.script);
  const date = source.date as
    | { year?: number; month?: number; day?: number }
    | undefined;
  if (date) {
    for (const part of ["year", "month", "day"] as const) {
      add(`events.0.date.${part}`, date[part]);
    }
  }
  add("events.0.country", source.country);
  credit("", source.credit ?? []);
  const labels = source.labels as {
    name: string;
    mbid?: string;
    catno?: string;
  }[] | undefined;
  labels?.forEach((label, index) => {
    const matching = physical["label-info"]?.map((entry) =>
      entry.label
    ).filter((entry) =>
      entry && normalized(entry.name) === normalized(label.name)
    ) ?? [];
    const ids = [...new Set(matching.map((entry) => entry!.id))];
    add(`labels.${index}.name`, label.name);
    add(
      `labels.${index}.mbid`,
      label.mbid ?? (ids.length === 1 ? ids[0] : undefined),
    );
    add(`labels.${index}.catalog_number`, label.catno);
  });
  const urls = source.urls as { url: string; linkType: number }[] | undefined;
  if (!urls?.length || !urls.some((url) => url.url === source.url)) {
    reasons.push("Provider album link or relationship type is missing");
  }
  urls?.forEach((url, index) => {
    add(`urls.${index}.url`, url.url);
    add(`urls.${index}.link_type`, url.linkType);
  });
  source.mediums?.forEach((medium, mi) => {
    add(`mediums.${mi}.format`, "Digital Media");
    medium.tracks.forEach((track, ti) => {
      const prefix = `mediums.${mi}.track.${ti}.`;
      const sourceCredit = track.credit?.length
        ? track.credit
        : source.credit ?? [];
      let matches = tracks.filter((candidate) =>
        !recordingIdentity(physical, candidate, source, track).reason
      );
      if (
        track.isrc &&
        matches.some((candidate) =>
          candidate.recording.isrcs?.includes(track.isrc!)
        )
      ) {
        matches = matches.filter((candidate) =>
          candidate.recording.isrcs?.includes(track.isrc!)
        );
      }
      const ids = [
        ...new Set(matches.map((candidate) => candidate.recording.id)),
      ];
      const id = ids.length === 1 ? ids[0] : "";
      if (!id) {
        unresolved.push(
          `Recording is not unambiguously resolved: ${mi + 1}.${
            ti + 1
          } ${track.title}`,
        );
      }
      recordings.push(id);
      add(prefix + "name", track.title);
      add(prefix + "number", ti + 1);
      add(prefix + "length", track.lengthMs);
      add(prefix + "recording", id);
      credit(prefix, sourceCredit);
    });
  });
  add("annotation", source.annotation);
  return {
    group,
    barcode: barcode ?? "",
    source,
    recordings,
    parameters,
    reasons: [...new Set(reasons)],
    unresolved: [...new Set(unresolved)],
  };
}

export function matchingDigitalEditions(
  releases: Release[],
  source: Album,
): Release[] {
  const key = barcodeKey(source.barcode);
  const count = source.mediums.flatMap((medium) => medium.tracks).length;
  return key
    ? releases.filter((release) =>
      digital(release) && barcodeKey(release.barcode) === key &&
      release.media.reduce(
          (total, medium) => total + (medium["track-count"] ?? 0),
          0,
        ) === count
    )
    : [];
}
