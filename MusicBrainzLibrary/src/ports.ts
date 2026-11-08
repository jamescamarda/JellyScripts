import type * as actions from "./browser_actions.js";
export type Action = keyof typeof actions;
export interface BrowserPort {
  evaluate<T>(target: string, action: Action, argument?: unknown): Promise<T>;
  openRelease(id: string): Promise<string>;
  openEditor(): Promise<string>;
  closeTab(target: string): Promise<void>;
  targets(): Promise<{ targetId: string; url: string }[]>;
}
export interface Store {
  load<T>(key: string): Promise<T | undefined>;
  save(key: string, value: unknown): Promise<void>;
}
export type LovedInput = {
  scope: "Loved only";
  done: true;
  items: import("./audit.ts").RecordingRow[];
  errors?: unknown[];
};
