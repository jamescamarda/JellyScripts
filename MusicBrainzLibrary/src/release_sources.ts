import {
  type Finding,
  type Findings,
  type Release,
  releaseSources,
  sourceUrlKey,
} from "./policy.ts";

export const RELEASE_SOURCES_VERSION = 1;
export type ReleaseSourceState = {
  version: number;
  status:
    | "none"
    | "planned"
    | "submitting"
    | "verified"
    | "pending"
    | "uncertain"
    | "rejected";
  selected: Finding[];
  confirmed?: Finding[];
  result?: unknown;
  error?: string;
};
export type ReleaseSourcePorts = {
  refresh(): Promise<Release>;
  submit(selected: Finding[]): Promise<unknown>;
  checkpoint(state: ReleaseSourceState): Promise<void>;
};

export function confirmedSources(
  release: Release,
  selected: Finding[],
): Finding[] {
  return selected.filter((finding) =>
    release.relations?.some((relation) =>
      !relation.ended && relation.url?.resource &&
      sourceUrlKey(relation.url.resource) === sourceUrlKey(finding.url!)
    )
  );
}

/** PC/Falcon delivery has its own journal; never repeat an uncertain handoff. */
export async function enrichReleaseSources(
  release: Release,
  findings: Findings,
  apply: boolean,
  ports: ReleaseSourcePorts,
  previous?: ReleaseSourceState,
): Promise<ReleaseSourceState> {
  let current = release;
  let recovered: ReleaseSourceState | undefined;
  if (
    previous && ["submitting", "pending", "uncertain"].includes(previous.status)
  ) {
    current = await ports.refresh();
    const confirmed = confirmedSources(current, previous.selected);
    if (confirmed.length !== previous.selected.length) {
      const state = { ...previous, status: "pending" as const, confirmed };
      await ports.checkpoint(state);
      return state;
    }
    const settled = { ...previous, status: "verified" as const, confirmed };
    await ports.checkpoint(settled);
    recovered = settled;
  }
  const selected = releaseSources(current, findings);
  if (!selected.length && recovered) return recovered;
  if (
    !selected.length && previous?.status === "verified" &&
    previous.selected.length &&
    confirmedSources(current, previous.selected).length ===
      previous.selected.length
  ) return previous;
  let state: ReleaseSourceState = {
    version: RELEASE_SOURCES_VERSION,
    status: selected.length ? "planned" : "none",
    selected,
  };
  await ports.checkpoint(state);
  if (!apply || !selected.length) return state;
  // Recheck edition and existing URLs immediately before handing work to PC.
  current = await ports.refresh();
  state.selected = releaseSources(current, findings);
  if (!state.selected.length) {
    state.status = "none";
    await ports.checkpoint(state);
    return state;
  }
  state.status = "submitting";
  await ports.checkpoint(state);
  try {
    state.result = await ports.submit(state.selected);
    const result = state.result as
      | { notSubmitted?: boolean; note?: string }
      | null;
    if (result?.notSubmitted) {
      state.status = "rejected";
      state.error = result.note ?? "PC did not submit any release links";
      await ports.checkpoint(state);
      return state;
    }
    current = await ports.refresh();
    state.confirmed = confirmedSources(current, state.selected);
    state.status = state.confirmed.length === state.selected.length
      ? "verified"
      : "pending";
  } catch (error) {
    state = { ...state, status: "uncertain", error: String(error) };
  }
  await ports.checkpoint(state);
  return state;
}
