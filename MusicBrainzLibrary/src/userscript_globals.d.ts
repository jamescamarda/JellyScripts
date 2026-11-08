interface GMApi {
  getValue<T = unknown>(key: string): Promise<T | undefined>;
  setValue(key: string, value: unknown): Promise<void>;
  deleteValue(key: string): Promise<void>;
  listValues(): Promise<string[]>;
}
declare const GM: GMApi;
declare function GM_openInTab(
  url: string,
  options?: { active?: boolean; insert?: boolean },
): { close(): void; closed: boolean; onclose?: () => void };
declare function GM_registerMenuCommand(
  name: string,
  callback: () => void,
): void;
declare function GM_addValueChangeListener(
  key: string,
  callback: (
    key: string,
    previous: unknown,
    value: unknown,
    remote: boolean,
  ) => void,
): string;
declare function GM_removeValueChangeListener(id: string): void;
