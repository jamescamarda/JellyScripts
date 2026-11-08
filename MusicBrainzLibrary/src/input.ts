import type { LovedInput } from "./ports.ts";

/** Keep only Loved identities; never retain profile, contacts or other export data. */
export function lovedInput(value: unknown): LovedInput {
  if (!value || typeof value !== "object") {
    throw new Error("Expected a Sorsee export");
  }
  const data = value as Record<string, unknown>;
  let rows: unknown;
  if (data.formatVersion === 9 && Array.isArray(data.loves)) rows = data.loves;
  else if (
    data.scope === "Loved only" && data.done === true &&
    Array.isArray(data.items) && !(data.errors as unknown[] | undefined)?.length
  ) rows = data.items;
  else {throw new Error(
      "Import Sorsee's account export (version 9) or a complete Loved snapshot",
    );}
  const ids = new Set<string>();
  for (const row of rows as unknown[]) {
    const id = (row as { recordingMbid?: unknown })?.recordingMbid;
    if (
      typeof id !== "string" ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)
    ) throw new Error("Invalid Loved recording ID");
    ids.add(id.toLowerCase());
  }
  // No cached provider links: check every imported Loved identity against live MB.
  return {
    scope: "Loved only",
    done: true,
    items: [...ids].map((recordingMbid) => ({ recordingMbid })),
  };
}
