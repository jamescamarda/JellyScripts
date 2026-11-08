import { lovedInput } from "./input.ts";

export type CheckpointArchive = {
  format: "sorsee-loved-checkpoints";
  version: 1;
  entries: Record<string, unknown>;
};
export function validCheckpointKey(key: string) {
  return /^loved\/(?:input|plan|summary)\.json$/.test(key) ||
    /^loved\/audit\/audit\.json$/.test(key) ||
    /^loved\/(?:releases|audit\/recordings)\/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.json$/i
      .test(key);
}
export function checkpointArchive(value: unknown): CheckpointArchive {
  const archive = value as CheckpointArchive;
  if (
    archive?.format !== "sorsee-loved-checkpoints" || archive.version !== 1 ||
    !archive.entries || typeof archive.entries !== "object" ||
    Array.isArray(archive.entries)
  ) throw new Error("Invalid checkpoint archive");
  lovedInput(archive.entries["loved/input.json"]);
  for (const [key, entry] of Object.entries(archive.entries)) {
    if (!validCheckpointKey(key) || !entry || typeof entry !== "object") {
      throw new Error(`Invalid checkpoint: ${key}`);
    }
  }
  return archive;
}
