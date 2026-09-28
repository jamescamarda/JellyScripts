// ==UserScript==
// @name         TIDAL track links → MusicBrainz recording
// @namespace    https://github.com/jamescamarda/sorsee
// @version      0.2.6
// @description  Prepare TIDAL share-page track links on a chosen MusicBrainz recording.
// @match        https://tidal.com/track/*
// @match        https://www.tidal.com/track/*
// @match        https://musicbrainz.org/recording/*/edit-relationships
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      musicbrainz.org
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const FREE_STREAMING = "7e41ef12-a124-4324-afdb-fdbae687a89c";
  const PAID_STREAMING = "b5f3058a-666c-406f-aafb-f9249fc7b122";
  const HASH_KEY = "sorsee-tidal-links-v1";
  const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function canonicalTrackLink(raw) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    const path = url.pathname;
    if (host === "tidal.com" || host === "www.tidal.com") {
      const id = path.match(/^\/(?:browse\/)?track\/(\d+)(?:\/u)?\/?$/)?.[1];
      return id
        ? {
          service: "TIDAL",
          url: `https://tidal.com/track/${id}`,
          type: PAID_STREAMING,
        }
        : null;
    }
    if (host === "open.spotify.com") {
      const id = path.match(
        /^\/(?:intl-[a-z]{2}\/)?track\/([a-zA-Z0-9]{22})\/?$/,
      )?.[1];
      return id
        ? {
          service: "Spotify",
          url: `https://open.spotify.com/track/${id}`,
          type: FREE_STREAMING,
        }
        : null;
    }
    if (host === "music.apple.com" || host === "geo.music.apple.com") {
      const album = path.match(/^\/([a-z]{2})\/album\/([^/]+)\/(\d+)\/?$/i);
      const song = url.searchParams.get("i");
      if (album && /^\d+$/.test(song ?? "")) {
        return {
          service: "Apple Music",
          url: `https://music.apple.com/${album[1].toLowerCase()}/album/${
            album[2]
          }/${album[3]}?i=${song}`,
          type: PAID_STREAMING,
        };
      }
      const direct = path.match(/^\/([a-z]{2})\/song\/([^/]+)\/(\d+)\/?$/i);
      return direct
        ? {
          service: "Apple Music",
          url: `https://music.apple.com/${direct[1].toLowerCase()}/song/${
            direct[2]
          }/${direct[3]}`,
          type: PAID_STREAMING,
        }
        : null;
    }
    if (host === "music.youtube.com") {
      const id = url.searchParams.get("v");
      return path === "/watch" && /^[\w-]{11}$/.test(id ?? "")
        ? {
          service: "YouTube Music",
          url: `https://music.youtube.com/watch?v=${id}`,
          type: FREE_STREAMING,
        }
        : null;
    }
    return null;
  }

  function tidalSharePageUrl(raw) {
    const track = canonicalTrackLink(raw);
    return track?.service === "TIDAL" ? `${track.url}/u` : null;
  }

  function collectTrackLinks(root, pageUrl) {
    const result = [];
    const seen = new Set();
    // The TIDAL /u page labels its actual service destinations this way.
    for (const anchor of root.querySelectorAll('a[data-test^="dsp-button-"]')) {
      const link = canonicalTrackLink(anchor.href);
      if (link && !seen.has(link.url)) {
        seen.add(link.url);
        result.push(link);
      }
    }
    const tidal = canonicalTrackLink(pageUrl);
    if (tidal && !seen.has(tidal.url)) result.unshift(tidal);
    return result;
  }

  function importedPayload(hash) {
    const encoded = new URLSearchParams(hash.replace(/^#/, "")).get(HASH_KEY);
    if (!encoded) return null;
    try {
      const value = JSON.parse(encoded);
      if (
        value.version !== 1 || !UUID.test(value.mbid) ||
        !Array.isArray(value.links) || value.links.length > 10
      ) return null;
      const links = value.links.filter((entry) => {
        const canonical = canonicalTrackLink(entry.url);
        return canonical && canonical.url === entry.url &&
          canonical.type === entry.type;
      });
      return { ...value, links };
    } catch {
      return null;
    }
  }

  function panel(title) {
    const box = document.createElement("section");
    box.style.cssText =
      "position:fixed;z-index:2147483647;top:16px;right:16px;width:min(390px,calc(100vw - 32px));max-height:85vh;overflow:auto;padding:16px;color:#f7f7f7;background:#171b22;border:1px solid #75839b;border-radius:12px;box-shadow:0 8px 28px #0009;font:14px/1.4 system-ui,sans-serif";
    const heading = document.createElement("strong");
    heading.textContent = title;
    heading.style.cssText = "display:block;font-size:16px;margin-bottom:10px";
    box.append(heading);
    document.body.append(box);
    return box;
  }

  function message(box, value) {
    const line = document.createElement("p");
    line.textContent = value;
    line.style.margin = "8px 0";
    box.append(line);
    return line;
  }

  function button(box, label, action) {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = label;
    control.style.cssText =
      "cursor:pointer;background:#c9d6fa;color:#151922;border:0;border-radius:6px;padding:7px 10px;margin:8px 8px 0 0;font:inherit";
    control.addEventListener("click", action);
    box.append(control);
    return control;
  }

  function recordingSearchUrl(artist, track) {
    const phrase = (value) =>
      '"' + value.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    if (!artist.trim() || !track.trim()) {
      throw new Error("Enter both artist and track name.");
    }
    const url = new URL("https://musicbrainz.org/ws/2/recording/");
    url.search = new URLSearchParams({
      query: `artist:${phrase(artist)} AND recording:${phrase(track)}`,
      fmt: "json",
      limit: "25",
    });
    return url.href;
  }

  function shareCardMetadata(root) {
    const shareCard = root.querySelector?.('[data-test="universal-share"]');
    if (!shareCard) return null;
    const track = shareCard.querySelector('[data-test="content-title"]')
      ?.textContent?.trim();
    const artists = [...shareCard.querySelectorAll('[data-test="artist-link"]')]
      .map((node) => node.textContent?.trim())
      .filter(Boolean);
    return track && artists.length
      ? { track, artist: artists.join(" & ") }
      : null;
  }

  function trackMetadata(root) {
    // Prefer TIDAL's rendered share card whenever it is available.
    const cardMetadata = shareCardMetadata(root);
    if (cardMetadata) return cardMetadata;
    for (
      const script of root.querySelectorAll(
        'script[type="application/ld+json"]',
      )
    ) {
      try {
        const pending = [JSON.parse(script.textContent)];
        while (pending.length) {
          const value = pending.shift();
          if (Array.isArray(value)) {
            pending.push(...value);
            continue;
          }
          if (!value || typeof value !== "object") continue;
          if (value["@graph"]) pending.push(value["@graph"]);
          if ([value["@type"]].flat().includes("MusicRecording")) {
            const artists = [value.byArtist].flat().filter(Boolean);
            const artist = artists.map((item) =>
              typeof item === "string" ? item : item.name
            ).filter(Boolean).join(" & ");
            if (value.name && artist) return { track: value.name, artist };
          }
        }
      } catch { /* Ignore unrelated or incomplete structured data. */ }
    }
    // The share page can expose Open Graph metadata without JSON-LD.
    const ogTitle = root.querySelector?.('meta[property="og:title"]')
      ?.getAttribute("content")?.trim();
    const description = root.querySelector?.('meta[property="og:description"]')
      ?.getAttribute("content")?.trim();
    // Use the track description to disambiguate artists containing " - ".
    const describedTrack = description?.match(/^Listen to (.+) on TIDAL(?: |$)/)
      ?.[1];
    if (ogTitle && describedTrack && ogTitle.endsWith(` - ${describedTrack}`)) {
      return {
        artist: ogTitle.slice(0, -(` - ${describedTrack}`).length),
        track: describedTrack,
      };
    }
    const separator = ogTitle?.indexOf(" - ") ?? -1;
    if (separator > 0) {
      return {
        artist: ogTitle.slice(0, separator),
        track: ogTitle.slice(separator + 3),
      };
    }
    const title = root.title?.match(/^(.+) by (.+) on TIDAL$/);
    if (title) return { artist: title[2], track: title[1] };
    return { artist: "", track: "" };
  }

  function syncMetadataFields(metadata, fields, edited) {
    for (const name of ["artist", "track"]) {
      if (!edited.has(name) && metadata[name]) {
        fields[name].value = metadata[name];
      }
    }
  }

  function searchRecordings(artist, track) {
    const url = recordingSearchUrl(artist, track);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        anonymous: true,
        timeout: 20000,
        headers: { Accept: "application/json" },
        onload(response) {
          if (response.status !== 200) {
            reject(
              new Error(
                response.status === 429 || response.status === 503
                  ? "MusicBrainz is busy. Wait a moment and try again."
                  : `MusicBrainz search failed (HTTP ${response.status}).`,
              ),
            );
            return;
          }
          try {
            const data = JSON.parse(response.responseText);
            if (!Array.isArray(data.recordings)) {
              throw new Error("Invalid MusicBrainz search response.");
            }
            resolve(data.recordings.filter((item) => UUID.test(item.id)));
          } catch (error) {
            reject(error);
          }
        },
        onerror: () =>
          reject(new Error("Could not reach MusicBrainz. Try again.")),
        ontimeout: () =>
          reject(new Error("MusicBrainz search timed out. Try again.")),
      });
    });
  }

  function recordingSummary(recording) {
    const artist = (recording["artist-credit"] || []).map((credit) =>
      (credit.name || credit.artist?.name || "") + (credit.joinphrase || "")
    ).join("");
    const seconds = Math.round(Number(recording.length) / 1000);
    const duration = seconds > 0
      ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
      : "";
    return [
      artist,
      duration,
      recording["first-release-date"],
      recording.releases?.[0]?.title,
      recording.video ? "Video recording" : "",
    ].filter(Boolean).join(" · ");
  }

  function addRecordingSearch(box, mbidInput) {
    const form = document.createElement("form");
    // Do not seed a search from generic page chrome such as "TIDAL — High
    // Fidelity Music Streaming" while the actual share card is still loading.
    const initial = shareCardMetadata(document) ?? { artist: "", track: "" };
    function field(label, value) {
      const wrapper = document.createElement("label");
      wrapper.textContent = label;
      wrapper.style.cssText = "display:block;margin-top:8px";
      const input = document.createElement("input");
      input.value = value;
      input.required = true;
      input.style.cssText = mbidInput.style.cssText;
      wrapper.append(input);
      form.append(wrapper);
      return input;
    }
    const artist = field("Artist", initial.artist);
    const track = field("Track", initial.track);
    const search = button(form, "Search MusicBrainz", () => {});
    search.type = "submit";
    search.disabled = !initial.artist || !initial.track;
    const status = message(
      form,
      search.disabled
        ? "Waiting for TIDAL track details…"
        : "Choose a recording from search, or paste its MBID below.",
    );
    status.setAttribute("role", "status");
    const results = document.createElement("div");
    form.append(results);
    box.insertBefore(form, mbidInput);
    let revision = 0;
    let lastRequest = 0;
    const invalidate = () => {
      revision++;
      results.replaceChildren();
      status.textContent = "Search again to see matching recordings.";
    };
    const edited = new Set();
    const fields = { artist, track };
    for (const name of ["artist", "track"]) {
      fields[name].addEventListener("input", () => {
        edited.add(name);
        invalidate();
        search.disabled = !artist.value.trim() || !track.value.trim();
        if (!search.disabled) {
          status.textContent =
            "Choose a recording from search, or paste its MBID below.";
        }
      });
    }
    // TIDAL populates metadata asynchronously on some share-page loads.
    let attempts = 0;
    const metadataTimer = setInterval(() => {
      if (!box.isConnected || ++attempts > 120) {
        clearInterval(metadataTimer);
        return;
      }
      const metadata = shareCardMetadata(document);
      if (metadata) {
        const before = [artist.value, track.value].join("\n");
        syncMetadataFields(metadata, fields, edited);
        if (before !== [artist.value, track.value].join("\n")) invalidate();
        search.disabled = !artist.value.trim() || !track.value.trim();
        if (!search.disabled) {
          status.textContent =
            "Choose a recording from search, or paste its MBID below.";
          clearInterval(metadataTimer);
        }
      } else if (attempts >= 120) {
        // Let the user proceed manually if TIDAL never renders the card.
        syncMetadataFields(trackMetadata(document), fields, edited);
        search.disabled = !artist.value.trim() || !track.value.trim();
        status.textContent = search.disabled
          ? "TIDAL track details did not load. Enter artist and track to search."
          : "TIDAL share card did not load. Verify these page details before searching.";
        clearInterval(metadataTimer);
      }
    }, 250);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (search.disabled) return;
      const version = ++revision;
      search.disabled = true;
      results.replaceChildren();
      status.textContent = "Searching MusicBrainz…";
      try {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, 1100 - (Date.now() - lastRequest)))
        );
        if (!box.isConnected || version !== revision) return;
        lastRequest = Date.now();
        const recordings = await searchRecordings(artist.value, track.value);
        if (!box.isConnected || version !== revision) return;
        status.textContent = recordings.length
          ? `${recordings.length} results (up to 25). Select the matching recording/version.`
          : "No recordings found. Adjust the artist or track name and search again.";
        for (const recording of recordings) {
          const row = document.createElement("div");
          row.style.cssText = "border-top:1px solid #75839b;padding:8px 0";
          const title = document.createElement("a");
          title.textContent = recording.title +
            (recording.disambiguation ? ` (${recording.disambiguation})` : "");
          title.href = `https://musicbrainz.org/recording/${recording.id}`;
          title.target = "_blank";
          title.rel = "noopener";
          title.style.color = "#c9d6fa";
          const choose = document.createElement("input");
          choose.type = "checkbox";
          choose.setAttribute("aria-label", `Select ${recording.title}`);
          choose.style.cssText =
            "width:15px;height:15px;margin:0 7px 0 0;vertical-align:middle;accent-color:#c9d6fa";
          choose.addEventListener("change", () => {
            for (
              const other of results.querySelectorAll('input[type="checkbox"]')
            ) {
              if (other !== choose) other.checked = false;
            }
            mbidInput.value = choose.checked ? recording.id : "";
            status.textContent = choose.checked
              ? `Selected: ${recording.title}. Review links below, then open the recording editor.`
              : "Choose a recording from search, or paste its MBID below.";
          });
          title.style.cssText = "color:#c9d6fa;vertical-align:middle";
          row.append(choose, title);
          message(row, recordingSummary(recording));
          results.append(row);
        }
      } catch (error) {
        if (version === revision) {
          status.textContent = String(error?.message ?? error);
        }
      } finally {
        search.disabled = false;
      }
    });
  }

  function recordingEditUrl(mbid, links, source, title) {
    if (!UUID.test(mbid)) throw new Error("Invalid recording MBID.");
    const params = [];
    const add = (key, value) =>
      params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    links.forEach((link, index) => {
      const canonical = canonicalTrackLink(link.url);
      if (!canonical || canonical.type !== link.type) {
        throw new Error("Invalid track relationship.");
      }
      add(`edit-recording.url.${index}.text`, canonical.url);
      add(
        `edit-recording.url.${index}.link_type_id`,
        canonical.type === FREE_STREAMING ? 268 : 979,
      );
    });
    add(
      "edit-recording.edit_note",
      `Track links from ${source || "TIDAL share page"} (${title || "track"}).`,
    );
    return `https://musicbrainz.org/recording/${mbid.toLowerCase()}/edit?${
      params.join("&")
    }`;
  }

  function onTidalPage() {
    const box = panel("Import track links to MusicBrainz");
    const linksContainer = document.createElement("div");
    const mbidInput = document.createElement("input");
    mbidInput.placeholder = "Recording MBID or MusicBrainz recording URL";
    mbidInput.style.cssText =
      "box-sizing:border-box;width:100%;padding:7px;margin:8px 0;color:#111;background:white";
    box.append(mbidInput, linksContainer);
    addRecordingSearch(box, mbidInput);
    const status = message(box, "Loading links…");
    let links = [];
    const render = () => {
      links = collectTrackLinks(document, location.href);
      linksContainer.replaceChildren();
      for (const link of links) {
        const row = document.createElement("label");
        row.style.cssText = "display:block;margin:5px 0;overflow-wrap:anywhere";
        const check = document.createElement("input");
        check.type = "checkbox";
        check.checked = true;
        check.value = link.url;
        const text = document.createTextNode(` ${link.service}: ${link.url}`);
        row.append(check, text);
        linksContainer.append(row);
      }
      status.textContent = links.length
        ? `${links.length} track links found. Check the recording and each destination.`
        : "No direct track links found yet.";
    };
    button(box, "Refresh links", render);
    button(box, "Open recording editor", () => {
      const mbid = mbidInput.value.trim().match(
        /(?:^|\/recording\/)([0-9a-f-]{36})(?:\/|$)/i,
      )?.[1];
      if (!mbid || !UUID.test(mbid)) {
        status.textContent = "Enter a valid recording MBID or URL.";
        return;
      }
      const selected = [...linksContainer.querySelectorAll("input:checked")]
        .map((input) => links.find((link) => link.url === input.value)).filter(
          Boolean,
        );
      if (!selected.length) {
        status.textContent = "Select at least one track link.";
        return;
      }
      const title =
        document.querySelector('meta[property="og:title"]')?.content ||
        document.title;
      globalThis.open(
        recordingEditUrl(
          mbid,
          selected,
          tidalSharePageUrl(location.href) ?? location.href,
          title,
        ),
        "_blank",
        "noopener",
      );
    });
    button(box, "Close", () => box.remove());
    render();
    if (links.length < 2) {
      let attempts = 0;
      const timer = setInterval(() => {
        if (!box.isConnected || ++attempts >= 60) {
          clearInterval(timer);
          return;
        }
        if (collectTrackLinks(document, location.href).length > links.length) {
          render();
          if (links.length > 1) clearInterval(timer);
        }
      }, 250);
    }
  }

  function draftRelationships(payload, mb) {
    const editor = mb?.relationshipEditor;
    const entity = editor?.state?.entity;
    if (
      !entity || entity.entityType !== "recording" ||
      entity.gid?.toLowerCase() !== payload.mbid
    ) {
      throw new Error(
        "MusicBrainz editor is not open for the selected recording.",
      );
    }
    if (!mb?.linkedEntities?.link_type) {
      throw new Error("MusicBrainz relationship types are unavailable.");
    }
    const existing = new Set(
      (entity.relationships ?? []).filter((rel) => rel.target_type === "url")
        .map((rel) =>
          canonicalTrackLink(rel.target?.href_url || rel.target?.name)?.url
        ).filter(Boolean),
    );
    let added = 0;
    for (const link of payload.links) {
      if (existing.has(link.url)) continue;
      const type = mb.linkedEntities.link_type[link.type];
      if (!type || type.type0 !== "recording" || type.type1 !== "url") {
        throw new Error(
          `MusicBrainz has no recording URL relationship type for ${link.service}.`,
        );
      }
      const target = {
        decoded: "",
        editsPending: false,
        entityType: "url",
        gid: "",
        name: link.url,
        id: editor.getRelationshipStateId(null),
        last_updated: null,
        href_url: "",
        pretty_name: "",
      };
      editor.dispatch({
        type: "update-relationship-state",
        sourceEntity: entity,
        oldRelationshipState: null,
        newRelationshipState: {
          id: editor.getRelationshipStateId(null),
          linkOrder: 0,
          linkTypeID: type.id,
          _lineage: ["added"],
          _original: null,
          _status: 1,
          attributes: null,
          begin_date: null,
          end_date: null,
          editsPending: false,
          ended: false,
          entity0: entity,
          entity0_credit: "",
          entity1: target,
          entity1_credit: "",
        },
        batchSelectionCount: undefined,
        creditsToChangeForSource: "",
        creditsToChangeForTarget: "",
      });
      existing.add(link.url);
      added++;
    }
    if (added) {
      const prior = editor.state.editNoteField?.value ?? "";
      editor.dispatch({
        type: "update-edit-note",
        editNote: [
          prior,
          `Track links from ${payload.source ?? "TIDAL share page"} (${
            payload.title ?? "track"
          }).`,
        ].filter(Boolean).join("\n"),
      });
    }
    return added;
  }

  async function onMusicBrainzPage(payload) {
    const box = panel("TIDAL links for this recording");
    message(box, payload.title ?? payload.source ?? "TIDAL track");
    for (const link of payload.links) {
      message(box, `${link.service}: ${link.url}`);
    }
    const status = message(box, "Waiting for the relationship editor…");
    let editor;
    for (let i = 0; i < 150; i++) {
      editor = (typeof unsafeWindow !== "undefined" ? unsafeWindow : globalThis)
        .MB?.relationshipEditor;
      if (editor?.state?.entity) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!editor?.state?.entity) {
      status.textContent =
        "MusicBrainz editor did not load. Reload and try again.";
      return;
    }
    const entity = editor.state.entity;
    if (entity.gid?.toLowerCase() !== payload.mbid) {
      status.textContent = "Recording MBID mismatch; no links added.";
      return;
    }
    status.textContent = `Ready for ${
      entity.name ?? payload.mbid
    }. Review destinations before preparing edits.`;
    const prepare = button(box, "Prepare relationships", () => {
      try {
        const added = draftRelationships(
          payload,
          (typeof unsafeWindow !== "undefined" ? unsafeWindow : globalThis).MB,
        );
        prepare.disabled = true;
        status.textContent = added
          ? `${added} relationships prepared. Review their types and destinations, then submit the MusicBrainz edit.`
          : "All selected links are already present on this recording.";
      } catch (error) {
        status.textContent = String(error?.message ?? error);
      }
    });
    button(box, "Close", () => box.remove());
  }

  if (globalThis.__sorseeTidalImporterTesting === true) {
    globalThis.__sorseeTidalImporter = {
      recordingEditUrl,
      tidalSharePageUrl,
      recordingSearchUrl,
      trackMetadata,
      shareCardMetadata,
      syncMetadataFields,
      searchRecordings,
      recordingSummary,
      canonicalTrackLink,
      collectTrackLinks,
      importedPayload,
      draftRelationships,
    };
    return;
  }
  if (
    location.hostname.endsWith("tidal.com") &&
    /^\/track\/\d+\/u\/?$/.test(location.pathname)
  ) onTidalPage();
  if (location.hostname === "musicbrainz.org") {
    const payload = importedPayload(location.hash);
    if (payload) void onMusicBrainzPage(payload);
  }
})();
