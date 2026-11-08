/// <reference lib="dom" />
/// <reference path="./userscript_globals.d.ts" />
import * as actions from "./browser_actions.js";
import type { Action, BrowserPort } from "./ports.ts";

export const PREFIX = "sorsee-loved:";
export const RUN_LOCK = "sorsee-loved-run";
const ACTION_LOCK = "sorsee-loved-action";
const workerKey = (id: string) => `${PREFIX}worker:${id}`;
const commandKey = (id: string) => `${PREFIX}command:${id}`;
type Command = { id: string; run: string; action: Action; argument?: unknown };
type Reply = { id: string; value?: unknown; error?: string };
type Worker = { url: string; closed?: boolean };

export async function activateRun(run: string) {
  // Wait for any already accepted command before revoking the old controller.
  await navigator.locks.request(ACTION_LOCK, async () => {
    await GM.setValue(`${PREFIX}active-run`, run);
    // Old controllers have been revoked, and no operation is executing here.
    for (const key of await GM.listValues()) {
      if (
        ["command:", "claimed:", "reply:"].some((kind) =>
          key.startsWith(PREFIX + kind)
        )
      ) await GM.deleteValue(key);
    }
  });
}

/** Each worker executes only named, bundled operations; never imported code. */
export async function startWorker(): Promise<boolean> {
  const hash = new URLSearchParams(location.hash.slice(1));
  const requested = hash.get("sorsee-worker");
  if (requested && /^[\da-f-]{36}$/.test(requested)) {
    sessionStorage.setItem(`${PREFIX}target`, requested);
  }
  const id = sessionStorage.getItem(`${PREFIX}target`);
  if (!id || !await GM.getValue(`${PREFIX}owned:${id}`)) return false;
  await GM.setValue(workerKey(id), { url: location.href });
  const execute = async () => {
    await navigator.locks.request(ACTION_LOCK, async () => {
      const command = await GM.getValue<Command>(commandKey(id));
      if (
        !command || command.run !== await GM.getValue(`${PREFIX}active-run`)
      ) return;
      if (await GM.getValue(`${PREFIX}claimed:${command.id}`)) return;
      // This marker deliberately survives navigation/crashes. Never replay a write.
      await GM.setValue(`${PREFIX}claimed:${command.id}`, true);
      let reply: Reply;
      try {
        if (
          !Object.hasOwn(actions, command.action)
        ) throw new Error("Unknown worker operation");
        const action = actions[command.action] as (
          argument?: unknown,
        ) => unknown;
        const value = await action(command.argument);
        reply = { id: command.id, value };
      } catch (error) {
        reply = { id: command.id, error: String(error) };
      }
      await GM.setValue(`${PREFIX}reply:${command.id}`, reply);
    });
  };
  GM_addValueChangeListener(commandKey(id), () => {
    void execute().catch(console.error);
  });
  // Navigation may have interrupted a seed/save response; publish the new URL,
  // but the claimed marker prevents replaying the old operation.
  void execute().catch(console.error);
  return true;
}

export class UserscriptBrowser implements BrowserPort {
  private tabs = new Map<string, ReturnType<typeof GM_openInTab>>();
  constructor(
    private run: string,
    private report: (message: string) => void = () => {},
  ) {}
  async evaluate<T>(
    target: string,
    action: Action,
    argument?: unknown,
  ): Promise<T> {
    if (!this.tabs.has(target)) {
      throw new Error("Worker does not belong to this run");
    }
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    const detail = argument as { only?: string[]; dry?: boolean } | undefined;
    const activity = action === "probe"
      ? detail?.only?.includes("pc")
        ? "Platform Check: finding album sources"
        : "ISRC Scout: finding recording links"
      : action === "readAlbum"
      ? `Reading album metadata: ${new URL(String(argument)).hostname}`
      : action === "applyReleaseSources"
      ? "Submitting verified album links through Platform Check/Falcon"
      : action === "applyLinks"
      ? detail?.dry
        ? "Checking recording-link submission (dry run)"
        : "Submitting recording links through ISRC Scout"
      : action === "identityAliases"
      ? "Resolving MusicBrainz names and transliterations"
      : action === "releaseData"
      ? "Reading live MusicBrainz release data"
      : action === "releaseReady"
      ? "Waiting for String Theory on the release page"
      : action === "submitEdition"
      ? "Saving the verified digital release"
      : action === "seedEdition"
      ? "Preparing the digital release editor"
      : "Checking the MusicBrainz release editor";
    this.report(activity);
    const replyKey = `${PREFIX}reply:${id}`;
    const start = await GM.getValue<Worker>(workerKey(target));
    const tab = this.tabs.get(target)!;
    const timeout =
      ["probe", "applyLinks", "applyReleaseSources"].includes(action)
        ? 660000
        : 240000;
    try {
      return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const previousClose = tab.onclose;
        const cleanup = () => {
          clearTimeout(timer);
          clearInterval(progress);
          GM_removeValueChangeListener(replyListener);
          GM_removeValueChangeListener(navigationListener);
          tab.onclose = previousClose;
        };
        const finish = (error?: Error, value?: T) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve(value as T);
        };
        const receive = (reply: Reply | undefined) => {
          if (reply?.id !== id) return;
          finish(
            reply.error ? new Error(reply.error) : undefined,
            reply.value as T,
          );
        };
        // Listen before dispatch, including replies delivered during GM.setValue.
        const replyListener = GM_addValueChangeListener(
          replyKey,
          (_key, _old, value) => receive(value as Reply),
        );
        const navigationListener = GM_addValueChangeListener(
          workerKey(target),
          (_key, _old, value) => {
            const page = value as Worker | undefined;
            if (
              ["seedEdition", "submitEdition"].includes(action) &&
              page?.url !== start?.url
            ) {
              finish(new Error("context destroyed by navigation"));
            }
          },
        );
        const timer = setTimeout(
          () =>
            finish(
              new Error(
                `${action} timed out; reconcile any pending submission`,
              ),
            ),
          timeout,
        );
        // Display-only timer: no command dispatch or completion depends on it.
        const progress = setInterval(
          () =>
            this.report(
              `${activity} (${Math.floor((Date.now() - startedAt) / 1000)}s)`,
            ),
          1000,
        );
        tab.onclose = () =>
          finish(
            new Error("Worker tab closed; reconcile any pending submission"),
          );
        void (async () => {
          try {
            if (tab.closed) {
              throw new Error("Worker tab closed before dispatch");
            }
            await GM.setValue(commandKey(target), {
              id,
              run: this.run,
              action,
              argument,
            });
            receive(await GM.getValue<Reply>(replyKey));
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      });
    } finally {
      await GM.deleteValue(replyKey);
    }
  }
  private async open(url: string, ready: Action, argument?: unknown) {
    const target = crypto.randomUUID();
    await GM.setValue(`${PREFIX}owned:${target}`, true);
    const parsed = new URL(url);
    parsed.hash += `${parsed.hash ? "&" : ""}sorsee-worker=${target}`;
    const tab = GM_openInTab(parsed.href, { active: false, insert: true });
    this.tabs.set(target, tab);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          GM_removeValueChangeListener(listener);
          tab.onclose = undefined;
          if (error) reject(error);
          else resolve();
        };
        const listener = GM_addValueChangeListener(
          workerKey(target),
          (_key, _old, value) => {
            if (value) finish();
          },
        );
        const timer = setTimeout(
          () =>
            finish(
              new Error(
                "Worker did not register; check the userscript installation",
              ),
            ),
          60000,
        );
        tab.onclose = () =>
          finish(new Error("Worker tab closed before becoming ready"));
        void (async () => {
          try {
            if (await GM.getValue(workerKey(target))) finish();
          } catch (error) {
            finish(new Error(String(error)));
          }
        })();
      });
      if (!await this.evaluate<boolean>(target, ready, argument)) {
        throw new Error(
          "String Theory did not become ready; check installation and sign-in",
        );
      }
      return target;
    } catch (error) {
      await this.closeTab(target);
      throw error;
    }
  }

  openRelease(id: string) {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) {
      throw new Error("Invalid release ID");
    }
    return this.open(
      `https://musicbrainz.org/release/${id}`,
      "releaseReady",
      id,
    );
  }
  openEditor() {
    return this.open(
      `https://musicbrainz.org/release/add#mc=sorsee${
        crypto.randomUUID().replaceAll("-", "")
      }`,
      "editorReady",
    );
  }
  async closeTab(id: string) {
    this.tabs.get(id)?.close();
    this.tabs.delete(id);
    await GM.deleteValue(workerKey(id));
    await GM.deleteValue(commandKey(id));
    await GM.deleteValue(`${PREFIX}owned:${id}`);
  }
  async targets() {
    const pages: { targetId: string; url: string }[] = [];
    for (const [id, tab] of this.tabs) {
      const page = await GM.getValue<Worker>(workerKey(id));
      if (page && !tab.closed) pages.push({ targetId: id, url: page.url });
    }
    return pages;
  }
}
