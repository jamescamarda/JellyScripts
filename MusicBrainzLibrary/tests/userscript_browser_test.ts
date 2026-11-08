import {
  PREFIX,
  startWorker,
  UserscriptBrowser,
} from "../src/userscript_browser.ts";
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
Deno.test("worker executes only once across navigation and rejects a revoked controller", async () => {
  const target = "11111111-1111-4111-8111-111111111111";
  const memory = new Map<string, unknown>([[`${PREFIX}owned:${target}`, true], [
    `${PREFIX}active-run`,
    "run",
  ]]);
  const listeners: (() => void)[] = [];
  let reads = 0;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const replace = (key: string, value: unknown) => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  };
  replace("GM", {
    getValue: (key: string) => Promise.resolve(memory.get(key)),
    setValue: (key: string, value: unknown) => {
      memory.set(key, value);
      return Promise.resolve();
    },
    deleteValue: (key: string) => {
      memory.delete(key);
      return Promise.resolve();
    },
    listValues: () => Promise.resolve([...memory.keys()]),
  });
  replace("GM_addValueChangeListener", (_key: string, callback: () => void) => {
    listeners.push(callback);
    return String(listeners.length);
  });
  replace("location", {
    href: `https://musicbrainz.org/release/test#sorsee-worker=${target}`,
    hash: `#sorsee-worker=${target}`,
    pathname: "/release/test",
  });
  const session = new Map<string, string>();
  replace("sessionStorage", {
    getItem: (key: string) => session.get(key),
    setItem: (key: string, value: string) => session.set(key, value),
  });
  replace("document", {
    querySelector: () => {
      reads++;
      return {};
    },
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
  try {
    await startWorker();
    memory.set(`${PREFIX}command:${target}`, {
      id: "first",
      run: "run",
      action: "releaseReady",
      argument: "test",
    });
    listeners.forEach((fn) => fn());
    await flush();
    assert(reads === 1);
    assert((memory.get(`${PREFIX}reply:first`) as { value: boolean }).value);
    await startWorker();
    listeners.forEach((fn) => fn());
    await flush();
    assert(reads === 1, "Navigation must not replay accepted commands");
    memory.set(`${PREFIX}active-run`, "replacement");
    memory.set(`${PREFIX}command:${target}`, {
      id: "stale",
      run: "run",
      action: "releaseReady",
      argument: "test",
    });
    listeners.forEach((fn) => fn());
    await flush();
    assert(reads === 1, "Revoked controller cannot perform work");
    memory.set(`${PREFIX}command:${target}`, {
      id: "forbidden",
      run: "replacement",
      action: "unknownOperation",
    });
    listeners.forEach((fn) => fn());
    await flush();
    assert(
      (memory.get(`${PREFIX}reply:forbidden`) as { error: string }).error
        .includes("Unknown worker operation"),
    );
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

Deno.test("worker replies and tab closures settle requests even when timers never fire", async () => {
  const values = new Map<string, unknown>();
  const listeners = new Map<
    string,
    {
      key: string;
      callback: (
        key: string,
        old: unknown,
        value: unknown,
        remote: boolean,
      ) => void;
    }
  >();
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const replace = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  };
  const put = (key: string, value: unknown) => {
    const old = values.get(key);
    values.set(key, value);
    for (const entry of [...listeners.values()]) {
      if (entry.key === key) entry.callback(key, old, value, true);
    }
  };
  let hold = false;
  let tab: { closed: boolean; onclose?: () => void; close(): void };
  replace("GM", {
    getValue: (key: string) => Promise.resolve(values.get(key)),
    setValue: (key: string, value: unknown) => {
      put(key, value);
      if (key.includes(":command:")) {
        const command = value as { id: string; action: string };
        if (!hold) {
          put(`${PREFIX}reply:${command.id}`, {
            id: command.id,
            value: command.action === "releaseReady" ? true : { saved: true },
          });
        }
      }
      return Promise.resolve();
    },
    deleteValue: (key: string) => {
      values.delete(key);
      return Promise.resolve();
    },
  });
  replace(
    "GM_addValueChangeListener",
    (
      key: string,
      callback: (
        key: string,
        old: unknown,
        value: unknown,
        remote: boolean,
      ) => void,
    ) => {
      const id = crypto.randomUUID();
      listeners.set(id, { key, callback });
      return id;
    },
  );
  replace("GM_removeValueChangeListener", (id: string) => listeners.delete(id));
  replace("GM_openInTab", (url: string) => {
    const target = new URLSearchParams(new URL(url).hash.slice(1)).get(
      "sorsee-worker",
    );
    tab = {
      closed: false,
      close() {
        this.closed = true;
        this.onclose?.();
      },
    };
    queueMicrotask(() => put(`${PREFIX}worker:${target}`, { url }));
    return tab;
  });
  // Simulate a background page whose timers are indefinitely throttled.
  replace("setTimeout", () => 0);
  replace("setInterval", () => 0);
  try {
    const browser = new UserscriptBrowser("run");
    const target = await browser.openRelease(
      "11111111-1111-4111-8111-111111111111",
    );
    const result = await browser.evaluate<{ saved: boolean }>(
      target,
      "releaseData",
      "11111111-1111-4111-8111-111111111111",
    );
    assert(result.saved && listeners.size === 0);
    hold = true;
    const pending = browser.evaluate(target, "probe", { only: ["pc"] });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    tab!.close();
    let rejected = false;
    try {
      await pending;
    } catch (error) {
      rejected = String(error).includes("Worker tab closed");
    }
    assert(rejected && listeners.size === 0);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
