import {
  artistCreditsMatch,
  crossScript,
  IDENTITY_VERSION,
  normalizedIsrc,
  sameName,
} from "./policy.ts";

/** Retry read-only requests after transient network/rate-limit failures. */
async function musicBrainzRead(path) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
    try {
      const response = await fetch(path, {
        cache: "no-store",
        signal: AbortSignal.timeout(20000),
      });
      if (response.ok) return await response.json();
      const transient = [429, 500, 502, 503, 504].includes(response.status);
      await response.body?.cancel();
      lastError = Error(`MusicBrainz lookup failed: HTTP ${response.status}`);
      if (!transient) throw lastError;
    } catch (error) {
      lastError = error;
      if (/HTTP (?:400|401|403|404)/.test(String(error))) throw error;
    }
  }
  throw lastError;
}

// Fixed operations executed in owned MusicBrainz worker tabs.
// Provider access and edits remain owned by String Theory.

export async function releaseData(id) {
  if (
    location.origin !== "https://musicbrainz.org" ||
    location.pathname !== `/release/${id}`
  ) throw Error("Unexpected MusicBrainz page");
  const release = await musicBrainzRead(
    `/ws/2/release/${id}?inc=recordings+recording-level-rels+url-rels+isrcs+artist-credits+release-groups+labels&fmt=json`,
  );
  if (release.id !== id) {
    throw Error("Release identity changed; rebuild its plan");
  }
  return release;
}

export async function probe({ id, only, links = [], isrcs = [] }) {
  const run = `sorsee-${crypto.randomUUID()}`;
  const providers = [];
  const hello = (event) => {
    try {
      providers.push(JSON.parse(event.detail));
    } catch { /* unrelated event */ }
  };
  document.addEventListener("mc:provider", hello);
  document.dispatchEvent(new CustomEvent("mc:discover"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  document.removeEventListener("mc:provider", hello);
  if (
    only.some((id) =>
      !providers.some((provider) =>
        provider.id === id && provider.capabilities.includes("probe")
      )
    )
  ) throw Error("Required String Theory adapters are unavailable");
  for (
    const [key, value] of [
      ["mb-respect-barcode", true],
      ["mb-barcode-mode", "strict"],
      ["mb-respect-format", true],
      ["mb-format-mode", "strict"],
    ]
  ) {
    const input = document.getElementById(key);
    if (!input) throw Error(`Missing Platform Check setting: ${key}`);
    if (input.type === "checkbox") input.checked = value;
    else input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return await new Promise((resolve, reject) => {
    const results = [], progress = [];
    const cleanup = () => {
      clearTimeout(timer);
      document.removeEventListener("mc:findings", receive);
      document.removeEventListener("mc:progress", status);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Error(`String Theory probe timed out: ${only.join(", ")}`));
    }, 600000);
    const status = (event) => {
      const value = JSON.parse(event.detail);
      if (value.run === run) progress.push(value);
    };
    const receive = (event) => {
      const value = JSON.parse(event.detail);
      if (value.run !== run || !only.includes(value.id)) return;
      results.push(value);
      if (only.every((id) => results.some((value) => value.id === id))) {
        cleanup();
        resolve({ providers, results, progress });
      }
    };
    document.addEventListener("mc:findings", receive);
    document.addEventListener("mc:progress", status);
    document.dispatchEvent(
      new CustomEvent("mc:probe", {
        detail: JSON.stringify({ run, release: id, only, links, isrcs }),
      }),
    );
  });
}

export async function readAlbum(url) {
  const run = `sorsee-read-${crypto.randomUUID()}`;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      document.removeEventListener("mc:read-result", receive);
      reject(Error(`First Contact read timed out: ${url}`));
    }, 95000);
    const receive = (event) => {
      const value = JSON.parse(event.detail);
      if (value.run !== run) return;
      clearTimeout(timer);
      document.removeEventListener("mc:read-result", receive);
      resolve(value);
    };
    document.addEventListener("mc:read-result", receive);
    document.dispatchEvent(
      new CustomEvent("mc:read", { detail: JSON.stringify({ run, url }) }),
    );
  });
}

export async function applyLinks({ id, keys, dry, provider = "is" }) {
  const run = `sorsee-apply-${crypto.randomUUID()}`;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      document.removeEventListener("mc:applied", receive);
      reject(
        Error(
          "Submission outcome uncertain; reconcile live relationships and pending edits before retrying",
        ),
      );
    }, 600000);
    const receive = (event) => {
      const value = JSON.parse(event.detail);
      if (value.run !== run || value.id !== provider) return;
      clearTimeout(timer);
      document.removeEventListener("mc:applied", receive);
      resolve(value);
    };
    document.addEventListener("mc:applied", receive);
    document.dispatchEvent(
      new CustomEvent("mc:apply", {
        detail: JSON.stringify({
          id: provider,
          run,
          release: id,
          keys,
          dry,
        }),
      }),
    );
  });
}

export async function applyReleaseSources({ id, selected }) {
  const run = `sorsee-pc-${crypto.randomUUID()}`;
  const tag = `mc:pc:${run}`;
  if (
    location.origin !== "https://musicbrainz.org" ||
    location.pathname !== `/release/${id}`
  ) throw Error("Unexpected release page");
  return await new Promise((resolve, reject) => {
    let accepted, settled;
    const cleanup = () => {
      clearTimeout(timer);
      document.removeEventListener("mc:findings", findings);
      document.removeEventListener("mc:applied", applied);
      document.removeEventListener("falcon:status", status);
    };
    const finish = () => {
      if (!accepted) return;
      if (!accepted.ok || accepted.sent === 0) {
        cleanup();
        resolve({ ...accepted, notSubmitted: accepted.sent === 0 });
        return;
      }
      if (!settled) return;
      cleanup();
      resolve({ ...accepted, falcon: settled });
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        Error(
          "PC/Falcon outcome uncertain; reconcile live release relationships before retrying",
        ),
      );
    }, 600000);
    const findings = (event) => {
      const value = JSON.parse(event.detail);
      if (value.run !== run || value.id !== "pc") return;
      const pad = (value) => String(value ?? "").trim().padStart(14, "0");
      const unchanged = selected.every((expected) =>
        value.findings.some((found) =>
          found.key === expected.key && found.state === "new" &&
          found.url === expected.url &&
          pad(found.barcode) === pad(expected.barcode) &&
          found.tracks === expected.tracks &&
          (found.format ?? null) === (expected.format ?? null) && !found.kind &&
          !found.entity
        )
      );
      if (!unchanged) {
        cleanup();
        resolve({
          ok: false,
          sent: 0,
          notSubmitted: true,
          note:
            "PC sources changed after validation; no release links submitted",
        });
        return;
      }
      document.removeEventListener("mc:findings", findings);
      document.dispatchEvent(
        new CustomEvent("mc:apply", {
          detail: JSON.stringify({
            id: "pc",
            run,
            release: id,
            keys: selected.map((finding) => finding.key),
            dry: false,
          }),
        }),
      );
    };
    const applied = (event) => {
      const value = JSON.parse(event.detail);
      if (value.run !== run || value.id !== "pc") return;
      accepted = value;
      finish();
    };
    const status = (event) => {
      const value = JSON.parse(event.detail);
      if (
        value.tag !== tag || value.running || !value.items?.length ||
        value.items.some((item) => ["queued", "active"].includes(item.status))
      ) return;
      settled = value;
      finish();
    };
    document.addEventListener("mc:findings", findings);
    document.addEventListener("mc:applied", applied);
    document.addEventListener("falcon:status", status);
    document.dispatchEvent(
      new CustomEvent("mc:probe", {
        detail: JSON.stringify({ run, release: id, only: ["pc"] }),
      }),
    );
  });
}

export async function editionDuplicates({ group, urls }) {
  if (location.origin !== "https://musicbrainz.org") {
    throw Error("Unexpected origin");
  }
  const releases = [], linked = new Set(), seen = new Set();
  const request = async (path, allowMissing = false) => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const response = await fetch(path, { cache: "no-store" });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) {
      throw Error(`Digital-edition duplicate check failed: ${response.status}`);
    }
    return await response.json();
  };
  const resources = new URLSearchParams({ fmt: "json", inc: "release-rels" });
  for (const url of urls) resources.append("resource", url);
  const result = await request(`/ws/2/url?${resources}`, true);
  for (const url of result?.urls ?? (result?.id ? [result] : [])) {
    for (const relation of url.relations ?? []) {
      if (relation.release?.id) linked.add(relation.release.id);
    }
  }
  let expected;
  for (let offset = 0;; offset += 100) {
    const page = await request(
      `/ws/2/release?release-group=${
        encodeURIComponent(group)
      }&inc=media+artist-credits&limit=100&offset=${offset}&fmt=json`,
    );
    if (
      !Number.isInteger(page["release-count"]) || !Array.isArray(page.releases)
    ) throw Error("Incomplete release-group duplicate check");
    if (expected !== undefined && expected !== page["release-count"]) {
      throw Error(
        "Release group changed during duplicate check; retry planning",
      );
    }
    expected = page["release-count"];
    for (const release of page.releases) {
      if (seen.has(release.id)) {
        throw Error("Duplicate release while paging release group");
      }
      seen.add(release.id);
      releases.push(release);
    }
    if (releases.length >= expected) break;
    if (!page.releases.length) {
      throw Error("Truncated release-group duplicate check");
    }
  }
  for (const id of linked) {
    if (!seen.has(id)) {
      releases.push(
        await request(
          `/ws/2/release/${id}?inc=media+artist-credits+release-groups&fmt=json`,
        ),
      );
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    group,
    releases,
    groupIds: [...seen],
    linked: [...linked],
  };
}

export async function seedEdition({ album, platform, parameters }) {
  if (
    location.origin !== "https://musicbrainz.org" ||
    location.pathname !== "/release/add"
  ) throw Error("Unexpected release editor");
  const run = `sorsee-seed-${crypto.randomUUID()}`;
  // First Contact owns its handoff to Apollo (provider artist URLs and ISRCs).
  // Its dry seed stores that handoff without navigating or submitting edits.
  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      document.removeEventListener("fc:seeded", receive);
      reject(Error("First Contact seed handoff timed out"));
    }, 10000);
    const receive = (event) => {
      const value = JSON.parse(event.detail);
      if (value.run === run) {
        clearTimeout(timer);
        document.removeEventListener("fc:seeded", receive);
        resolve(value.token);
      }
    };
    document.addEventListener("fc:seeded", receive);
    document.dispatchEvent(
      new CustomEvent("fc:seed", {
        detail: JSON.stringify({ run, rel: album, platform, dry: true }),
      }),
    );
  });
  const form = document.createElement("form");
  form.method = "POST";
  form.action = `/release/add?first_contact=${
    encodeURIComponent(token)
  }&skip_confirmation=1`;
  for (const [name, value] of parameters) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  const root = (typeof unsafeWindow === "undefined" ? globalThis : unsafeWindow)
    .MB?.releaseEditor?.rootField;
  if (root) root.redirecting = true;
  form.requestSubmit();
  return { seeded: true, token };
}

export function editorState() {
  const read = (value) => typeof value === "function" ? value() : value;
  const editor =
    (typeof unsafeWindow === "undefined" ? globalThis : unsafeWindow).MB
      ?.releaseEditor;
  const release = editor && read(editor.rootField?.release);
  if (!release) return { ready: false, path: location.pathname };
  const credits = (value) =>
    (read(read(value)?.names) ?? []).map((name) => {
      const artist = read(name.artist);
      return {
        name: read(name.name),
        artist: read(artist?.name),
        id: read(artist?.gid),
      };
    });
  const formats = [...document.querySelectorAll("select option")].filter((
    option,
  ) => option.textContent.trim() === "Digital Media").map((option) =>
    option.value
  );
  const mediums = (read(release.mediums) ?? []).map((medium) => {
    const format = read(medium.formatID ?? medium.format);
    return {
      format: format === "Digital Media" || formats.includes(String(format))
        ? "Digital Media"
        : String(format),
      tracks: (read(medium.tracks) ?? []).map((track) => ({
        title: read(track.name),
        length: Number(read(track.length)),
        recording: read(read(track.recording)?.gid),
        credit: credits(track.artistCredit),
      })),
    };
  });
  return {
    ready: true,
    path: location.pathname,
    title: read(release.name),
    barcode: typeof read(release.barcode) === "object"
      ? read(read(release.barcode).value)
      : read(release.barcode),
    group: read(read(release.releaseGroup)?.gid),
    credit: credits(release.artistCredit),
    mediums,
    allowsSubmission: typeof editor.allowsSubmission === "function" &&
      !!editor.allowsSubmission(),
    requirements: [
      "needsName",
      "needsArtistCredit",
      "needsLabels",
      "needsReleaseGroup",
      "needsRecordings",
      "hasInvalidFormats",
      "hasInvalidDates",
      "hasUnconfirmedVariousArtists",
    ].filter((key) => read(release[key]) === true),
    errors: [
      ...document.querySelectorAll(".error, .error-message, .field-error"),
    ].filter((element) => element.getClientRects().length).map((element) =>
      element.textContent.trim()
    ).filter(Boolean),
  };
}

export async function finishEditor() {
  if (globalThis.__sorseeVisitedEditor) return true;
  const editor =
    (typeof unsafeWindow === "undefined" ? globalThis : unsafeWindow).MB
      ?.releaseEditor;
  if (!editor?.uiTabs || typeof editor.lastTab !== "function") {
    throw Error("Native release editor tab controller is unavailable");
  }
  for (let index = 0; index < editor.tabCount; index++) {
    if (editor.uiTabs.options.disabled?.includes?.(index)) continue;
    editor.uiTabs._setOption("active", index);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  editor.lastTab();
  globalThis.__sorseeVisitedEditor = true;
  return true;
}

export function submitEdition() {
  const editor =
    (typeof unsafeWindow === "undefined" ? globalThis : unsafeWindow).MB
      ?.releaseEditor;
  if (
    !editor || typeof editor.allowsSubmission !== "function" ||
    !editor.allowsSubmission()
  ) throw Error("Native release editor refuses submission");
  const buttons = [...document.querySelectorAll('[data-click="submitEdits"]')]
    .filter((button) => !button.disabled);
  if (!buttons.length) throw Error("Native Enter edit button is unavailable");
  buttons[0].click();
  return { submitted: true };
}

export async function releaseReady(id) {
  const ready = () =>
    location.pathname === `/release/${id}` &&
    !!document.querySelector("#ii-dock");
  if (ready()) return true;
  return await new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (ready()) finish(true);
    });
    const timer = setTimeout(() => finish(false), 60000);
    const finish = (value) => {
      clearTimeout(timer);
      observer.disconnect();
      resolve(value);
    };
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    if (ready()) finish(true);
  });
}
export async function editorReady() {
  const ready = () =>
    !!document.documentElement.dataset.fcConsolidate &&
    !!(typeof unsafeWindow === "undefined" ? globalThis : unsafeWindow).MB
      ?.releaseEditor?.rootField;
  if (ready()) return true;
  return await new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(timer);
      clearInterval(check);
      observer.disconnect();
      resolve(value);
    };
    const observer = new MutationObserver(() => {
      if (ready()) finish(true);
    });
    const timer = setTimeout(() => finish(false), 60000);
    const check = setInterval(() => {
      if (ready()) finish(true);
    }, 500);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  });
}

/** Resolve actual database aliases only where provider names need them. */
export async function identityAliases({ release, album }) {
  if (location.origin !== "https://musicbrainz.org") {
    throw Error("Unexpected identity lookup origin");
  }
  const read = async (type, id) => {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id ?? "")) {
      return [];
    }
    const key = `sorsee-loved:alias-cache:${type}:${id}`;
    const cached = await GM.getValue(key);
    const age = Date.now() - Date.parse(cached?.checkedAt ?? "");
    if (cached && age >= 0 && age < 86400000) return cached.aliases;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const value = await musicBrainzRead(
      `/ws/2/${type}/${id}?inc=aliases&fmt=json`,
    );
    if (value.id !== id || !Array.isArray(value.aliases)) {
      throw Error("Unexpected alias lookup response");
    }
    const aliases = value.aliases.map((alias) => ({
      name: alias.name,
      type: alias.type,
    }));
    await GM.setValue(key, { checkedAt: new Date().toISOString(), aliases });
    return aliases;
  };
  if (
    !sameName(release.title, album.title, [
      ...release.aliases ?? [],
      ...release["release-group"]?.aliases ?? [],
    ])
  ) {
    release.aliases = await read("release", release.id);
    if (
      release["release-group"]?.id &&
      !sameName(release.title, album.title, release.aliases)
    ) {
      release["release-group"].aliases = await read(
        "release-group",
        release["release-group"].id,
      );
    }
  }
  const tracks = release.media.flatMap((m) => m.tracks ?? []);
  const source = album.mediums.flatMap((m) => m.tracks);
  const artists = new Map();
  for (const [index, track] of tracks.entries()) {
    if (artistCreditsMatch(release, track, album, source[index])) continue;
    for (
      const credit of track["artist-credit"] ?? release["artist-credit"] ?? []
    ) {
      const artist = credit.artist;
      if (!artist?.id) continue;
      if (!artists.has(artist.id)) {
        artists.set(artist.id, await read("artist", artist.id));
      }
      artist.aliases = artists.get(artist.id);
    }
  }
  // Release-level credits are separately used when matching physical editions.
  for (const credit of release["artist-credit"] ?? []) {
    if (artists.has(credit.artist?.id)) {
      credit.artist.aliases = artists.get(credit.artist.id);
    }
  }
  for (const [index, track] of tracks.entries()) {
    const other = source[index];
    if (!other || !crossScript(track.title, other.title)) continue;
    const code = normalizedIsrc(other.isrc);
    // Existing ISRC conflicts are final; aliases must never override them.
    if (code && track.recording.isrcs?.length) continue;
    if (sameName(track.title, other.title, track.recording.aliases)) continue;
    track.recording.aliases = await read("recording", track.recording.id);
  }
  release.identityVersion = IDENTITY_VERSION;
  return release;
}
