// ==UserScript==
// @name         LinkRecordingLevel
// @namespace    https://github.com/jamescamarda/jellyscripts
// @version      0.9.8
// @description  Review page tracks against a release, then seed and submit each recording editor.
// @match        https://music.youtube.com/*
// @match        https://www.youtube.com/*
// @match        https://youtube.com/*
// @match        https://musicbrainz.org/recording/*
// @match        https://musicbrainz.org/release/*
// @match        https://open.spotify.com/*
// @match        https://soundcloud.com/*
// @match        https://www.soundcloud.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_listValues
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @connect      musicbrainz.org
// @run-at       document-start
// ==/UserScript==
(() => {
  'use strict';
  const KEY = 'release-stream-import-v3';
  const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function waitForDomOr(ms) {
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); observer?.disconnect(); resolve(); };
      const observer = document.body ? new MutationObserver(finish) : null;
      observer?.observe(document.body, {childList:true, subtree:true});
      const timer = setTimeout(finish, ms);
    });
  }
  const batchKey = batchId => `${KEY}:batch:${batchId}`;
  async function readBatch(batchId) {
    const own = await GM_getValue(batchKey(batchId), null);
    if (own?.batchId === batchId) return own;
    const legacy = await GM_getValue(KEY, null);
    return legacy?.batchId === batchId ? legacy : null;
  }
  async function saveBatch(batch) {
    await GM_setValue(batchKey(batch.batchId), batch);
    const legacy = await GM_getValue(KEY, null);
    if (legacy?.batchId === batch.batchId) await GM_setValue(KEY, null);
  }
  function unfinishedBatch(batch, now = Date.now()) {
    return !!batch && typeof batch.batchId === 'string' &&
      Number.isFinite(batch.created) && now - batch.created >= 0 && now - batch.created < 3600000 &&
      Array.isArray(batch.jobs) && Number.isInteger(batch.index) &&
      batch.index >= 0 && batch.index < batch.jobs.length;
  }
  async function cancelBatch(batchId) {
    const current = await readBatch(batchId);
    if (current?.batchId !== batchId) return false;
    await GM_setValue(batchKey(batchId), null);
    const legacy = await GM_getValue(KEY, null);
    if (legacy?.batchId === batchId) await GM_setValue(KEY, null);
    return true;
  }
  function releaseId(raw) {
    const text = raw.trim();
    if (UUID.test(text)) return text.toLowerCase();
    try {
      const u = new URL(text);
      const id = u.pathname.match(/^\/release\/([^/]+)\/?$/)?.[1];
      if (u.hostname === 'musicbrainz.org' && UUID.test(id || '')) return id.toLowerCase();
    } catch { /* Display validation error below. */ }
    throw Error('Paste a release MBID or MusicBrainz release URL.');
  }
  function trackUrl(raw) {
    try {
      const u = new URL(raw, 'https://music.youtube.com');
      const id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v');
      const supported = ['music.youtube.com', 'www.youtube.com', 'youtube.com'].includes(u.hostname) && u.pathname === '/watch' || u.hostname === 'youtu.be';
      return u.protocol === 'https:' && supported && /^[\w-]{11}$/.test(id || '')
        ? `https://www.youtube.com/watch?v=${id}` : null;
    } catch { return null; }
  }
  function playlistUrl(raw) {
    try {
      const u = new URL(raw);
      const id = u.searchParams.get('list');
      if (u.protocol === 'https:' && ['www.youtube.com', 'youtube.com', 'music.youtube.com'].includes(u.hostname) && /^[\w-]+$/.test(id || '')) return `https://www.youtube.com/playlist?list=${id}`;
    } catch { /* Not a supported playlist URL. */ }
    return null;
  }
  function collectionUrl(raw) {
    const youtube = playlistUrl(raw);
    if (youtube) return youtube;
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:') return null;
      const spotify = u.pathname.match(/^\/(?:intl-[a-z]{2}\/)?(album|playlist)\/([a-zA-Z0-9]{22})\/?$/);
      if (u.hostname === 'open.spotify.com' && spotify) return `https://open.spotify.com/${spotify[1]}/${spotify[2]}`;
      if (['soundcloud.com', 'www.soundcloud.com'].includes(u.hostname) && /^\/[\w-]+\/sets\/[\w-]+\/?$/.test(u.pathname)) return `https://soundcloud.com${u.pathname.replace(/\/$/, '')}`;
    } catch { /* Not a supported album. */ }
    return null;
  }
  function collectProvider(root, source) {
    const host = new URL(source).hostname;
    if (!['open.spotify.com', 'soundcloud.com', 'www.soundcloud.com'].includes(host)) return collect(root, source);
    const spotify = host === 'open.spotify.com';
    const rowSelector = spotify ? '[data-testid="tracklist-row"]' : '.trackList__item';
    const scope = root.querySelector('main, [role="main"]') || root;
    const first = scope.querySelector(rowSelector);
    if (!first) throw Error('No album track rows found. Load the full album track list and retry.');
    const list = first.closest('[role="grid"], .trackList, [data-testid="track-list"]') || first.parentElement;
    return [...list.querySelectorAll(rowSelector)].map((row, i) => {
      const anchors = [...row.querySelectorAll('a[href]')];
      const matches = anchors.map(a => ({ a, link: canonicalTrackLink(new URL(a.getAttribute('href'), source).href) })).filter(item => item.link);
      const match = matches[0];
      return { title: match?.a.textContent.trim() || row.querySelector('.trackItem__trackTitle, [data-testid="track-name"]')?.textContent.trim() || `Unavailable track ${i + 1}`, url: match?.link.url || null };
    });
  }
  function spotifySnapshot(root, source, collected) {
    const scope = root.querySelector('main, [role="main"]') || root;
    const first = scope.querySelector('[data-testid="tracklist-row"]');
    const grid = first?.closest('[role="grid"]');
    const total = Number(grid?.getAttribute('aria-rowcount')) - 1;
    if (!grid || !Number.isInteger(total) || total < 1 || total > 10000) return null;
    const elements = [...grid.querySelectorAll('[data-testid="tracklist-row"]')];
    const rows = collectProvider(root, source);
    elements.forEach((element, i) => {
      const index = Number(element.closest('[aria-rowindex]')?.getAttribute('aria-rowindex')) - 2;
      if (Number.isInteger(index) && index >= 0 && index < total) {
        collected.set(index, rows[i]);
        // Spotify counts disc dividers in aria-rowcount but gives them no
        // aria-rowindex. They immediately precede the first track wrapper.
        const heading = element.closest('[aria-rowindex]')?.parentElement?.previousElementSibling;
        if (index > 0 && heading?.matches('[role="presentation"]') &&
            heading.querySelector('[role="gridcell"][aria-colindex="2"]')?.textContent.trim() &&
            !heading.querySelector('[data-testid="tracklist-row"], [aria-rowindex], a[href]')) {
          collected.set(index - 1, null);
        }
      }
    });
    const complete = Array.from({length:total}, (_, i) => collected.has(i)).every(Boolean);
    return {total, complete, rows: complete ? Array.from({length:total}, (_, i) => collected.get(i)).filter(Boolean) : [], elements};
  }
  function soundcloudSnapshot(root, source, collected) {
    let hydration = root === document && typeof unsafeWindow !== 'undefined' ? unsafeWindow.__sc_hydration : null;
    if (!Array.isArray(hydration)) for (const script of root.querySelectorAll('script:not([src])')) {
      const match = script.textContent.match(/(?:window\.)?__sc_hydration\s*=\s*(\[[\s\S]*?\]);/);
      if (match) { try { hydration=JSON.parse(match[1]); } catch { /* Wait for page data. */ } }
    }
    const playlist = hydration?.find(entry => entry.hydratable === 'playlist' && collectionUrl(entry.data?.permalink_url) === collectionUrl(source))?.data;
    const scope = root.querySelector('main, [role="main"]') || root;
    const list = scope.querySelector('.trackList');
    const elements = [...(list?.querySelectorAll('.trackList__item') || [])];
    const total = Number(playlist?.track_count || list?.getAttribute('aria-setsize') || elements[0]?.getAttribute('aria-setsize'));
    if (!Number.isInteger(total) || total < 1 || total > 10000) return null;
    (playlist?.tracks || []).forEach((track, index) => {
      const link = canonicalTrackLink(track.permalink_url);
      if (index < total && link?.service === 'SoundCloud') collected.set(index,{title:track.title || `Track ${index+1}`,url:link.url});
    });
    const rows = elements.length ? collectProvider(root, source) : [];
    const position = (element) => Number(element.getAttribute('aria-posinset') || element.querySelector('.trackItem__number')?.textContent.trim().match(/^\d+/)?.[0]) - 1;
    elements.forEach((element,i) => {
      const index=position(element);
      if (Number.isInteger(index) && index >= 0 && index < total && rows[i]?.url) collected.set(index,rows[i]);
    });
    const complete=Array.from({length:total},(_,i)=>collected.has(i)).every(Boolean);
    return {total,complete,rows:complete ? Array.from({length:total},(_,i)=>collected.get(i)) : [],elements,firstIndex:elements.length ? position(elements[0]) : 0};
  }
  function requiresActiveCollection(url) {
    return ['open.spotify.com','soundcloud.com','www.soundcloud.com'].includes(new URL(url).hostname);
  }
  function streamingSources(release) {
    const seen = new Set();
    return (release.relations || []).flatMap(r => {
      if (r['target-type'] !== 'url' || r.ended || !/stream/i.test(r.type || '')) return [];
      const raw = r.url?.resource, supported = collectionUrl(raw);
      try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'https:') return [];
        const url = supported || parsed.href;
        if (seen.has(url)) return [];
        seen.add(url); return [{url, supported: !!supported, label: parsed.hostname}];
      } catch { return []; }
    });
  }
  function pageStreamingSources(root) {
    const sources = [];
    for (const row of root.querySelectorAll('table.details tr')) {
      const phrase = row.querySelector('th')?.textContent || '';
      if (!/stream/i.test(phrase)) continue;
      for (const anchor of row.querySelectorAll('td a[href]')) {
        if (anchor.closest('del, s, .deleted')) continue;
        const url = collectionUrl(anchor.href);
        if (url) sources.push({url, supported:true, label:new URL(anchor.href).hostname});
      }
    }
    return sources;
  }
  function currentStreamingSources(release, root) {
    const sources = new Map(streamingSources(release).map(source => [source.url,source]));
    const ended = new Set((release.relations || []).filter(relation => relation.ended).map(relation => collectionUrl(relation.url?.resource)));
    for (const source of pageStreamingSources(root)) if (!ended.has(source.url)) sources.set(source.url,source);
    return [...sources.values()];
  }
  function canonicalTrackLink(raw) {
    const youtube = trackUrl(raw);
    if (youtube) return { service: 'YouTube', url: youtube, type: '268' };
    let url;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol !== 'https:') return null;
    const host = url.hostname, path = url.pathname;
    if (host === "open.spotify.com") {
      const id = path.match(
        /^\/(?:intl-[a-z]{2}\/)?track\/([a-zA-Z0-9]{22})\/?$/,
      )?.[1];
      return id
        ? {
          service: "Spotify",
          url: `https://open.spotify.com/track/${id}`,
          type: '268',
        }
        : null;
    }
    if (['soundcloud.com', 'www.soundcloud.com'].includes(host) && /^\/[\w-]+\/[\w-]+\/?$/.test(path) && !/^\/(discover|charts|search|you|stations|stream|upload|settings)\//.test(path)) {
      return { service: 'SoundCloud', url: `https://soundcloud.com${path.replace(/\/$/, '')}`, type: '268' };
    }
    return null;
  }
  function jobLinks(job) {
    const links = job.links || [{ url: job.url }];
    if (!links.length) throw Error('No links selected.');
    return links.map(link => {
      const canonical = canonicalTrackLink(link.url);
      if (!canonical || link.type && canonical.type !== link.type) throw Error('Invalid track relationship.');
      return canonical;
    });
  }
  function collect(root, source = '') {
    // Current desktop YouTube uses lockup rows inside an item section.
    // Match playlist IDs so recommendations and unrelated sections are excluded.
    let requestedList;
    try { requestedList = new URL(source).searchParams.get('list'); } catch { /* DOM fixtures or unspecified source. */ }
    const sections = [...root.querySelectorAll('yt-item-section-renderer, ytd-item-section-renderer')];
    for (const section of sections) {
      const cards = [...section.querySelectorAll('yt-lockup-view-model')];
      const entries = cards.map(card => {
        const anchor = card.querySelector('h3 a[href*="watch?"], a.ytLockupMetadataViewModelTitle[href*="watch?"], a[href*="watch?"]');
        if (!anchor) return null;
        const href = new URL(anchor.getAttribute('href'), 'https://www.youtube.com');
        const list = href.searchParams.get('list'), index = Number(href.searchParams.get('index'));
        if (!list || requestedList && list !== requestedList || !Number.isInteger(index) || index < 1 || index > 10000) return null;
        return {list, index, title: card.querySelector('h3')?.textContent.trim() || `Unavailable track ${index}`, url: trackUrl(href.href)};
      }).filter(Boolean);
      if (!entries.length) continue;
      const list = requestedList || entries[0].list;
      const matching = entries.filter(entry => entry.list === list);
      // Preserve missing/deleted positions so later tracks cannot silently shift.
      const rows = Array.from({length: Math.max(...matching.map(entry => entry.index))}, (_, i) => ({title:`Unavailable track ${i + 1}`,url:null}));
      for (const entry of matching) rows[entry.index - 1] = {title:entry.title,url:entry.url};
      return rows;
    }

    // Prefer the full playlist; a watch page may also contain a sidebar playlist.
    const playlist = [...root.querySelectorAll('ytd-playlist-video-list-renderer, ytd-playlist-panel-renderer')]
      .find(el => el.getClientRects().length);
    if (playlist) {
      return [...playlist.querySelectorAll('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer')].map((row, index) => {
        const a = row.querySelector('a#video-title, a#wc-endpoint');
        const title = row.querySelector('#video-title')?.textContent.trim();
        return { title: title || `Unavailable track ${index + 1}`, url: trackUrl(a?.getAttribute('href') || '') };
      });
    }
    // Deliberately exclude player queue, navigation and recommendation shelves.
    const shelves = [...root.querySelectorAll('ytmusic-playlist-shelf-renderer, ytmusic-shelf-renderer')]
      .filter(s => s.getClientRects().length && !s.closest('ytmusic-player-queue'));
    const primary = shelves.find(s => s.tagName.toLowerCase() === 'ytmusic-playlist-shelf-renderer') || shelves[0];
    if (!primary) throw Error('Open an album or playlist with a visible track list.');
    return [...primary.querySelectorAll('ytmusic-responsive-list-item-renderer')].map((row, index) => {
      const a = row.querySelector('.title-column a[href*="watch?"], .flex-columns a[href*="watch?"]');
      return { title: a?.textContent.trim() || `Unavailable track ${index + 1}`, url: trackUrl(a?.getAttribute('href') || '') };
    });
  }
  function releaseTracks(release) {
    const tracks = (release.media || []).flatMap(medium => (medium.tracks || []).map(track => ({
      id: track.recording?.id, title: track.title || track.recording?.title,
      position: `${medium.position}.${track.position}`, length: track.length,
    })));
    if (!tracks.length || tracks.some(t => !UUID.test(t.id || ''))) throw Error('Release has missing recording identities.');
    return tracks;
  }
  function jobsFor(rows, tracks, selection) {
    const byRecording = new Map();
    rows.forEach((row, i) => {
      const index = selection[i];
      if (index === -1) return;
      if (!Number.isInteger(index) || !tracks[index] || !row.url || !canonicalTrackLink(row.url)) throw Error('Every selected track needs a valid URL and recording.');
      const track = tracks[index];
      const links = jobLinks({ links: undefined, url: row.url });
      const prior = byRecording.get(track.id);
      if (prior && JSON.stringify(prior.links) !== JSON.stringify(links)) throw Error(`Conflicting URLs for repeated recording: ${track.title}. Exclude one or import it separately.`);
      byRecording.set(track.id, { id: track.id, title: track.title, url: row.url, links });
    });
    if (!byRecording.size) throw Error('Select at least one track.');
    return [...byRecording.values()];
  }
  function editUrl(job, source, batchId, runId) {
    if (!UUID.test(job.id)) throw Error('Invalid import job.');
    const params = new URLSearchParams();
    jobLinks(job).forEach((link, index) => {
      params.set(`edit-recording.url.${index}.text`, link.url);
      params.set(`edit-recording.url.${index}.link_type_id`, link.type);
    });
    return `https://musicbrainz.org/recording/${job.id}/edit?${params}#ytm-import=${batchId}${runId ? `&run=${runId}` : ''}`;
  }
  function hasSubmittedLink(form, job) {
    const data = new FormData(form);
    return jobLinks(job).every(link => [...data.entries()].some(([name, value]) =>
      /^edit-recording\.url\.\d+\.text$/.test(name) &&
      canonicalTrackLink(String(value))?.url === link.url &&
      String(data.get(name.replace(/\.text$/, '.link_type_id'))) === link.type));
  }

  function seededForm(root, job) {
    for (const form of root.querySelectorAll('form.edit-recording')) {
      // React serializes external links on the document's submit event.
      // Before that event, only the visible editor URL is available.
      const visibleLink = jobLinks(job).every(link => [...form.querySelectorAll('.external-link-item input.value, .external-link-item a.url')]
        .some(el => canonicalTrackLink(el.value || el.href)?.url === link.url));
      if (!visibleLink && !hasSubmittedLink(form, job)) continue;
      const submit = form.querySelector('button.submit[type="submit"], input.submit[type="submit"]');
      if (submit && !submit.disabled && form.checkValidity()) return { form, submit };
    }
    return null;
  }
  function submitVerified({ form, submit }, job) {
    let accepted = false;
    const verify = event => {
      if (event.target !== form) return;
      // Window bubbling runs after MusicBrainz's document serializer.
      accepted = !event.defaultPrevented && hasSubmittedLink(form, job);
      if (!accepted) event.preventDefault();
    };
    window.addEventListener('submit', verify);
    try { form.requestSubmit(submit); }
    finally { window.removeEventListener('submit', verify); }
    return accepted;
  }
  function node(tag, text, parent) {
    const el = document.createElement(tag); if (text) el.textContent = text; parent?.append(el); return el;
  }
  function panel(title, {inline = false} = {}) {
    document.getElementById('ytm-mb-import')?.remove();
    const box = node('aside'); box.id = 'ytm-mb-import'; box.open = true;
    box.style.cssText = 'position:fixed;top:12px;right:12px;box-sizing:border-box;width:min(420px,calc(100vw - 24px));max-height:80vh;overflow:auto;background:#f3f5f7;color:#20252b;border:1px solid #aab3bd;border-radius:8px;padding:14px 16px;font:14px/1.4 system-ui;z-index:2147483647;box-shadow:0 4px 20px #0004';
    if (inline) {
      box.style.cssText = 'box-sizing:border-box;width:100%;margin:0 0 20px;padding:18px 20px;background:#eaf2ff;color:#162c49;border:2px solid #416ca6;border-left-width:6px;border-radius:6px;font:16px/1.5 system-ui;';
      (document.querySelector('#content') || document.body).prepend(box);
    } else document.body.append(box);
    const header=node('div','',box);header.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:12px';
    if (!title) header.style.display = 'none';
    node('strong',title,header);
    const close=node('button','×',header);close.type='button';close.title='Close';close.setAttribute('aria-label','Close importer');
    close.style.cssText='font-size:20px;border:0;background:transparent;cursor:pointer';
    close.hidden = inline;
    close.onclick=()=>box.close();
    box.close=()=>{if(!box.open)return;box.open=false;box.hidden=true;box.dispatchEvent(new Event('close'));};
    box.showModal=()=>{box.open=true;box.hidden=false;};
    box.focus=()=>box.scrollIntoView({block:'nearest'});
    return box;
  }
  function releasePanel(title, anchor) {
    document.getElementById('ytm-mb-import')?.remove();
    const box = node('section'); box.id = 'ytm-mb-import'; box.open = true;
    box.style.cssText = 'box-sizing:border-box;margin:10px 0 16px;padding:14px 16px;background:#f3f5f7;color:#20252b;border:1px solid #aab3bd;border-radius:8px;font:14px/1.4 system-ui;';
    anchor.after(box);
    const header = node('div','',box); header.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:12px';
    node('strong',title,header);
    const close = node('button','×',header); close.type='button'; close.title='Close'; close.setAttribute('aria-label','Close importer');
    close.style.cssText='font-size:20px;border:0;background:transparent;cursor:pointer';
    close.onclick=()=>box.close();
    box.close=()=>{if(!box.open)return;box.open=false;box.hidden=true;box.dispatchEvent(new Event('close'));};
    box.showModal=()=>{box.open=true;box.hidden=false;};
    box.focus=()=>box.scrollIntoView({block:'nearest'});
    return box;
  }
  function fetchRelease(id) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'GET', url: `https://musicbrainz.org/ws/2/release/${id}?inc=recordings+url-rels&fmt=json&_lrl=${Date.now()}`, anonymous: true, timeout: 20000,
      headers: {'Cache-Control':'no-cache', 'Pragma':'no-cache'},
      onload: r => { try { if (r.status !== 200) throw Error(`MusicBrainz returned ${r.status}.`); resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); } },
      onerror: () => reject(Error('MusicBrainz request failed.')), ontimeout: () => reject(Error('MusicBrainz request timed out.')),
    }));
  }
  function missingLinks(job, recording) {
    return jobLinks(job).filter(link => !(recording.relations || []).some(relation =>
      relation['target-type'] === 'url' && canonicalTrackLink(relation.url?.resource)?.url === link.url));
  }
  function fetchRecording(id) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'GET', url: `https://musicbrainz.org/ws/2/recording/${id}?inc=url-rels&fmt=json`, anonymous: true, timeout: 20000,
      onload: r => { try { if (r.status !== 200) throw Error(`MusicBrainz returned ${r.status}.`); const recording = JSON.parse(r.responseText); if (recording.id !== id) throw Error('Recording identity mismatch.'); resolve(recording); } catch (e) { reject(e); } },
      onerror: () => reject(Error('Could not check existing recording links.')), ontimeout: () => reject(Error('Recording lookup timed out.')),
    }));
  }
  function confirmTrackOrder(box, pageCount, releaseCount) {
    const warning = node('div', '', box);
    node('p', `The page has ${pageCount} tracks but the release has ${releaseCount}. Attempt matching by track order anyway? Missing or extra tracks may shift matches. Review every recording before importing.`, warning);
    return new Promise(resolve => {
      const finish = answer => {
        box.removeEventListener('close', cancel);
        warning.remove();
        resolve(answer);
      };
      const cancel = () => finish(false);
      box.addEventListener('close', cancel, { once: true });
      node('button', 'Yes, match by track order', warning).onclick = () => finish(true);
      node('button', 'No, select matches manually', warning).onclick = () => finish(false);
    });
  }
  function providerCheckboxes(box, choices) {
    const fieldset = node('fieldset', '', box);
    node('legend', 'Which providers would you like to import?', fieldset);
    const names = {'open.spotify.com':'Spotify','soundcloud.com':'SoundCloud','www.soundcloud.com':'SoundCloud','www.youtube.com':'YouTube','music.youtube.com':'YouTube Music'};
    const selections = choices.filter(choice => choice.supported && names[choice.label]).map(choice => {
      const label = node('label', '', fieldset); label.style.display = 'block';
      const check = node('input', '', label); check.type = 'checkbox';
      check.checked = ['open.spotify.com', 'www.youtube.com', 'music.youtube.com'].includes(choice.label);
      label.append(document.createTextNode(` ${names[choice.label]} `));
      const a = node('a', 'View album / playlist', label); a.href = choice.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      return {choice, check};
    });
    if (!selections.length) node('p', 'No supported streaming sources found.', fieldset);
    return () => selections.filter(item => item.check.checked && !item.check.disabled).map(item => item.choice);
  }
  function mergeJobs(groups) {
    const byId = new Map();
    for (const jobs of groups) for (const job of jobs) {
      const existing = byId.get(job.id) || { ...job, links: [] };
      for (const link of jobLinks(job)) if (!existing.links.some(prior => prior.url === link.url)) existing.links.push(link);
      byId.set(job.id, existing);
    }
    return [...byId.values()];
  }
  let activeCollection = Promise.resolve();
  function collectSource(choice, signal, options = {}) {
    if (!requiresActiveCollection(choice.url)) return collectSourceTab(choice, signal, false);
    const pending = activeCollection.then(() => {
      if (signal.aborted) throw Error('Collection cancelled.');
      return collectSourceTab(choice, signal, options.activateSpotify !== false);
    });
    // Failure must release the queue just like successful collection.
    activeCollection = pending.catch(() => {});
    return pending;
  }
  async function collectSourceTab(choice, signal, active) {
    const token = crypto.randomUUID(), key = `${KEY}:source:${token}`;
    await GM_setValue(key, {url:choice.url, created:Date.now()});
    let tab, listener, timer, abort;
    try {
      return await new Promise((resolve, reject) => {
        let finished = false;
        const finish = (error, rows) => { if (finished) return; finished = true; error ? reject(error) : resolve(rows); };
        listener = GM_addValueChangeListener(key, (_name, _old, value) => {
          if (value?.error) finish(Error(value.error));
          else if (value?.rows) finish(null, value.rows);
        });
        abort = () => finish(Error('Collection cancelled.'));
        signal.addEventListener('abort', abort, {once:true});
        const activeProvider = requiresActiveCollection(choice.url);
        timer = setTimeout(() => finish(Error(activeProvider
          ? 'Provider collection expired after five minutes. Retry and activate its tab.'
          : 'Provider did not return its track list within 45 seconds.')), activeProvider ? 300000 : 45000);
        if (signal.aborted) { abort(); return; }
        tab = GM_openInTab(`${choice.url}#mb-source=${token}`, {active, insert:true});
        if (!tab) { finish(Error('Could not open the provider tab. Check your userscript manager and retry.')); return; }
        tab.onclose = () => finish(Error('Provider tab closed before collection finished. Retry to collect this source.'));
      });
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (listener !== undefined) GM_removeValueChangeListener(listener);
      await tab?.close(); await GM_setValue(key, null);
    }
  }
  async function sourceWorker(token) {
    const key = `${KEY}:source:${token}`, request = await GM_getValue(key, null);
    if (!request || Date.now() - request.created > 300000 || collectionUrl(location.href) !== request.url) return;
    let observer, timer, stableTimer, pollTimer, finished = false, signature = '';
    const spotify = new URL(request.url).hostname === 'open.spotify.com';
    const activeProvider = requiresActiveCollection(request.url);
    const provider = spotify ? 'Spotify' : 'SoundCloud';
    const collected = new Map();
    let expected = 0, visibleElapsed = 0, lastTick = Date.now();
    let wasVisible = !document.hidden;
    const finish = async value => {
      if (finished) return; finished = true;
      observer?.disconnect(); clearTimeout(timer); clearTimeout(stableTimer); clearInterval(pollTimer);
      if (await GM_getValue(key, null)) await GM_setValue(key, {...request, ...value});
    };
    const inspect = () => {
      if (finished) return;
      try {
        if (activeProvider) {
          const now = Date.now();
          if (wasVisible && !document.hidden) visibleElapsed += Math.min(now - lastTick, 1000);
          lastTick = now; wasVisible = !document.hidden;
          if (now - request.created >= 300000) { void finish({error:`${provider} collection expired after five minutes.`}); return; }
          if (document.hidden) return;
          if (visibleElapsed >= 60000) { void finish({error:`Incomplete ${provider} list after one minute active. No partial list imported.`}); return; }
          if (collectionUrl(location.href) !== request.url) { void finish({error:`${provider} navigated away from the requested album or playlist. Retry on the original source.`}); return; }
          const snapshot = spotify ? spotifySnapshot(document, request.url, collected) : soundcloudSnapshot(document, request.url, collected);
          if (!snapshot) return;
          expected = snapshot.total;
          if (snapshot.complete) { void finish({rows:snapshot.rows}); return; }
          // Advance only when the provider explicitly reports missing positions.
          // Retain previous positions when virtualized rows leave the DOM.
          const missing = Array.from({length:expected}, (_, i) => i).find(i => !collected.has(i));
          const firstIndex = spotify ? Number(snapshot.elements[0]?.closest('[aria-rowindex]')?.getAttribute('aria-rowindex')) - 2 : snapshot.firstIndex;
          const target = missing < firstIndex ? snapshot.elements[0] : snapshot.elements.at(-1);
          target?.scrollIntoView({block:missing < firstIndex ? 'start' : 'end', behavior:'instant'});
          return;
        }
        const rows = collectProvider(document, request.url);
        if (!rows.length) return;
        const next = JSON.stringify(rows);
        if (signature === next) return;
        signature = next; clearTimeout(stableTimer);
        stableTimer = setTimeout(() => void finish({rows}), 750);
      } catch { /* Wait for the provider's list to render. */ }
    };
    if (activeProvider) pollTimer = setInterval(inspect, 500);
    else {
      observer = new MutationObserver(inspect);
      observer.observe(document.body, {childList:true, subtree:true, attributes:true, attributeFilter:['href']});
    }
    if (!activeProvider) timer = setTimeout(() => void finish({error:'Track list unavailable. Login, availability or the provider layout may prevent collection.'}), 30000);
    inspect();
  }
  function barcodeSearchUrl(release) {
    const barcode = String(release?.barcode || '').trim();
    if (!/^\d{8,14}$/.test(barcode)) return null;
    return `https://music.youtube.com/search?q=${encodeURIComponent(`"${barcode}"`)}`;
  }
  function hasYouTubeAlbum(release) {
    return (release.relations || []).some(r => playlistUrl(r.url?.resource) || /^https:\/\/music\.youtube\.com\/browse\//.test(r.url?.resource || ''));
  }
  function releaseUrl(raw) {
    try {
      const url = new URL(raw.trim());
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
      return collectionUrl(url.href) || url.href;
    } catch { return null; }
  }
  function youtubeAlbumResults(root, albumPage = false) {
    // Read the play button's page-owned endpoint as well as visible anchors.
    const pageRoot = root === document && typeof unsafeWindow !== 'undefined' ? unsafeWindow.document : root;
    const scope = albumPage
      ? pageRoot.querySelector('ytmusic-detail-header-renderer, ytmusic-responsive-header-renderer')
      : pageRoot.querySelector('ytmusic-search-page');
    if (!scope) return [];
    const results = new Map(), directByRow = new Map();
    if (!albumPage) for (const row of scope.querySelectorAll('ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer')) {
      const anchors = [...row.querySelectorAll('a[href]')];
      // Only use playback endpoints belonging to an album card, not song/radio results.
      if (!anchors.some(a => /\/browse\/MPRE[\w-]+/.test(a.getAttribute('href') || ''))) continue;
      let direct = anchors.map(a => {
        try {
          const url = new URL(a.getAttribute('href'), 'https://music.youtube.com');
          return url.pathname === '/playlist' || /^OLAK/.test(url.searchParams.get('list') || '') ? playlistUrl(url.href) : null;
        } catch { return null; }
      }).find(Boolean);
      if (!direct) {
        const data = row.data;
        const buttons = [data?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer,
          ...[...row.querySelectorAll('ytmusic-play-button-renderer')].map(button => button.data)];
        for (const button of buttons) {
          const endpoint = button?.playNavigationEndpoint || button?.navigationEndpoint;
          const id = endpoint?.watchPlaylistEndpoint?.playlistId || endpoint?.watchEndpoint?.playlistId;
          if (typeof id === 'string' && /^OLAK[\w-]+$/.test(id)) {
            direct = playlistUrl(`https://music.youtube.com/playlist?list=${id}`); break;
          }
        }
      }
      if (direct) directByRow.set(row, direct);
    }
    for (const a of scope.querySelectorAll('a[href]')) {
      let url; try { url = new URL(a.getAttribute('href'), 'https://music.youtube.com'); } catch { continue; }
      const row = a.closest('ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer');
      const playlist = playlistUrl(url.href);
      const browse = url.hostname === 'music.youtube.com' && /^\/browse\/MPRE[\w-]+$/.test(url.pathname);
      const target = directByRow.get(row) || (playlist && (albumPage || url.pathname === '/playlist') ? playlist : !albumPage && browse ? url.href : null);
      if (!target) continue;
      const title = row?.querySelector('.title')?.textContent.trim() || a.textContent.trim() || 'Album';
      if (!results.has(target)) results.set(target, {url:target,title});
    }
    return [...results.values()];
  }
  async function lookupYouTubeAlbums(url, signal) {
    const token=crypto.randomUUID(), key=`${KEY}:album-search:${token}`;
    await GM_setValue(key,{url,created:Date.now()});
    let listener,timer,tab,abort;
    try {
      return await new Promise((resolve,reject)=>{
        listener=GM_addValueChangeListener(key,(_key,_old,value)=>{
          if(value?.error)reject(Error(value.error)); else if(value?.results)resolve(value.results);
        });
        abort=()=>reject(Error('Search cancelled.'));signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted){abort();return;}
        timer=setTimeout(()=>reject(Error('YouTube Music album lookup timed out.')),35000);
        tab=GM_openInTab(`${url}#mb-album-search=${token}`,{active:false,insert:true});
      });
    } finally {
      clearTimeout(timer);if(abort)signal.removeEventListener('abort',abort);
      if(listener!==undefined)GM_removeValueChangeListener(listener);
      tab?.close();await GM_setValue(key,null);
    }
  }
  function albumLookupResults(root, currentUrl, expectedUrl) {
    const current = new URL(currentUrl), expected = new URL(expectedUrl);
    if (current.hostname !== 'music.youtube.com') return [];
    if (expected.pathname.startsWith('/browse/')) {
      const redirected = playlistUrl(current.href);
      if (redirected && current.pathname === '/playlist') {
        const title=root.querySelector('ytmusic-responsive-header-renderer .title, ytmusic-detail-header-renderer .title')?.textContent.trim() || 'Album';
        return [{url:redirected,title}];
      }
      if(current.pathname===expected.pathname)return youtubeAlbumResults(root,true);
      return [];
    }
    if (current.pathname !== expected.pathname || current.searchParams.get('q') !== expected.searchParams.get('q')) return [];
    return youtubeAlbumResults(root);
  }
  async function youtubeAlbumWorker(token) {
    const key=`${KEY}:album-search:${token}`,request=await GM_getValue(key,null);
    if(!request || Date.now()-request.created>60000)return;
    const expected=new URL(request.url);
    if(expected.hostname !== 'music.youtube.com')return;
    let observer,timer,settled=false,stable,last='';
    const finish=async(value)=>{
      if(settled)return;settled=true;observer?.disconnect();clearTimeout(timer);clearTimeout(stable);
      if(await GM_getValue(key,null))await GM_setValue(key,{...request,...value});
    };
    const inspect=()=>{
      const results=albumLookupResults(document,location.href,request.url);
      if(!results.length)return;
      const signature=JSON.stringify(results);if(signature===last)return;last=signature;
      clearTimeout(stable);stable=setTimeout(()=>void finish({results}),1000);
    };
    observer=new MutationObserver(inspect);observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['href']});
    timer=setTimeout(()=>void finish({error:'No album playlist could be found. You can still paste its release URL manually.'}),25000);
    inspect();
  }
  function offerBarcodeSearch(box, release, id, {manual = true} = {}) {
    const search = barcodeSearchUrl(release);
    if (!manual && (!search || hasYouTubeAlbum(release))) return;
    const section = node('fieldset', '', box);
    let input, status;
    if (manual) {
      node('legend', 'Add release URL', section);
      input = node('input', '', section); input.type = 'url'; input.placeholder = 'Release URL'; input.style.width = '95%';
      const preview = node('a', '', section);
      preview.target = '_blank'; preview.rel = 'noopener noreferrer'; preview.hidden = true;
      preview.style.cssText = 'display:none;overflow-wrap:anywhere;margin:6px 0';
      const edit = node('button', 'Edit URL', section); edit.type = 'button'; edit.hidden = true;
      input.addEventListener('blur', event => {
        // Keep action buttons in place between pointer-down and click.
        if (event.relatedTarget?.closest?.('button')) return;
        input.dispatchEvent(new Event('change', {bubbles:true}));
      });
      input.addEventListener('change', event => {
        if (event.isTrusted) return; // Convert after blur, or after barcode capture.
        const url = releaseUrl(input.value);
        input.hidden = !!url;
        edit.hidden = !url;
        preview.hidden = !url;
        preview.style.display = url ? 'block' : 'none';
        preview.textContent = url || '';
        if (url) preview.href = url; else preview.removeAttribute('href');
      });
      edit.onclick = () => {
        preview.hidden = true; preview.style.display = 'none'; edit.hidden = true;
        input.hidden = false; input.focus(); input.select();
      };
      status = node('span', '', section); status.style.marginInlineStart='8px';
    } else {
      node('legend','YouTube Music',section);
      status = node('span','',section); status.style.marginInlineStart='8px';
      input = box.querySelector('input[type="url"]');
    }
    if (search && !hasYouTubeAlbum(release)) {
      const searchButton=node('button','Find by barcode',section);
      const choices=node('div','',section), controller=new AbortController();
      box.addEventListener('close',()=>controller.abort(),{once:true});
      const choose=async(result)=>{
        status.textContent='Retrieving playlist…';
        const direct=playlistUrl(result.url);
        const resolved=direct?[{url:direct}]:await lookupYouTubeAlbums(result.url,controller.signal);
        if(resolved.length!==1)throw Error('Multiple playlists found. Paste the correct URL.');
        input.value=resolved[0].url;
        input.dispatchEvent(new Event('change', {bubbles:true}));
        status.textContent='Playlist captured.';
      };
      searchButton.onclick=async()=>{
        searchButton.disabled=true;choices.replaceChildren();status.textContent='Searching…';
        try {
          const results=await lookupYouTubeAlbums(search,controller.signal);
          if(results.length===1)await choose(results[0]);
          else {
            status.textContent=`${results.length} results. Choose the matching album.`;
            for(const result of results) {
              const button=node('button',result.title,choices);
              button.onclick=async()=>{button.disabled=true;try{await choose(result);}catch(error){status.textContent=error.message;}finally{button.disabled=false;}};
            }
          }
        }catch(error){status.textContent=error.message;}finally{searchButton.disabled=false;}
      };
    }
    if (!manual) return;
    const add = node('button', 'Add URL', section);
    add.type = 'button';
    let busy = false, navigating = false;
    add.onclick = async () => {
      if (busy) return;
      busy = true; add.disabled = true;
      try {
        const url = releaseUrl(input.value);
        if (!url) throw Error('Paste a valid HTTP or HTTPS release URL.');
        if (releaseHasUrl(release, url)) { status.textContent = 'URL already on release.'; return; }
        status.textContent = 'Opening release editor…';
        const token = crypto.randomUUID();
        await GM_setValue(`${KEY}:release-link:${token}`, {id,url,created:Date.now()});
        navigating = true;
        location.assign(`https://musicbrainz.org/release/${id}/edit#mb-release-link=${token}`);
      } catch (error) { status.textContent = error.message; }
      finally { if (!navigating) { busy = false; add.disabled = false; } }
    };
  }
  function releaseHasUrl(release, url, root = document) {
    if (((release?.relations) || []).some(relation => releaseUrl(relation.url?.resource || '') === url)) return true;
    return [...root.querySelectorAll('table.details a[href]')].some(anchor =>
      !anchor.closest('del, s, .deleted') && releaseUrl(anchor.href) === url);
  }
  function verifiedReleaseEdit(editor, tree, url) {
    if (!editor || !tree?.iterate || typeof editor.externalLinksData !== 'function') return false;
    const match = [...tree.iterate(editor.externalLinksData())].find(link => releaseUrl(link.url || '') === url);
    if (!match || !match.relationships.some(relationship => Number.isInteger(relationship.linkTypeID) && relationship.linkTypeID > 0)) return false;
    // A fresh editor should generate only the requested URL relationship.
    return typeof editor.allEdits === 'function' && editor.allEdits().length === 1 && editor.allowsSubmission();
  }
  async function fillReleasePlaylist(token) {
    if (!document.body) await new Promise(resolve => {
      const observer = new MutationObserver(() => {
        if (document.body) { observer.disconnect(); resolve(); }
      });
      observer.observe(document, {childList:true, subtree:true});
    });
    const key = `${KEY}:release-link:${token}`, draft = await GM_getValue(key, null);
    const id = location.pathname.match(/^\/release\/([\da-f-]{36})\/edit$/i)?.[1];
    if (!draft || draft.id !== id || Date.now() - draft.created > 3600000 || releaseUrl(draft.url) !== draft.url) return;
    const box = panel('Adding release URL'), status = node('p', 'Waiting for the release editor…', box);
    if (draft.submitted) {status.textContent='Submission was already attempted. Check the release edit history before trying again.';return;}
    let filled=false;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const mb = unsafeWindow.MB;
      const editor = mb?._releaseEditor || mb?.releaseEditor;
      if (!filled) {
        const inputs = [...document.querySelectorAll('.external-link-item input.value')];
        filled = inputs.some(input => releaseUrl(input.value) === draft.url);
        const input = !filled && inputs.find(input => !input.value);
        if (input) {
          input.focus();
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input,draft.url);
          input.dispatchEvent(new Event('input',{bubbles:true}));
          input.dispatchEvent(new Event('change',{bubbles:true}));
          input.blur(); filled=true;
        }
      }
      status.textContent = filled ? 'Waiting for URL validation…' : 'Waiting for the release editor…';
      if (filled && verifiedReleaseEdit(editor, mb?.tree, draft.url)) {
        const current=await GM_getValue(key,null);
        if (!current || current.submitted) return;
        await GM_setValue(key,{...draft,submitted:true});
        status.textContent = 'Saving release URL…';
        editor.submitEdits();
        return;
      }
      await waitForDomOr(250);
    }
    box.showModal();
    status.textContent='Automatic submission stopped: the URL relationship is not ready or the editor needs attention. Choose its relationship type or resolve the displayed validation errors.';
    node('button','Return to editor',box).onclick=()=>box.close();
    node('button','Retry after correcting the editor',box).onclick=()=>{box.close();void fillReleasePlaylist(token);};
  }
  function installReleaseButton(root = document) {
    const buttonId = 'link-recording-level-launch';
    if (root.querySelector(`#${buttonId}`)) return true;
    // Native relationship tables hold external album/playlist links. Locate
    // the relevant table without depending on translated relationship labels.
    const anchor = [...root.querySelectorAll('table.details a[href]')]
      .find(link => collectionUrl(link.href));
    const table = anchor?.closest('table.details') || root.querySelector('table.details');
    const fallback = root.querySelector('#content h1, #content h2.relationships');
    if (!table && !fallback) return false;
    const button = root.createElement('button');
    button.id = buttonId; button.type = 'button';
    button.textContent = 'Import recording links';
    button.style.cssText = 'margin:6px 0;padding:5px 10px;cursor:pointer';
    button.addEventListener('click', () => {
      const panel = root.getElementById('ytm-mb-import');
      if (panel?.open) { panel.focus(); return; }
      void releasePage(button);
    });
    if (table) table.before(button);
    else fallback.after(button);
    showCompletedImport(button);
    return true;
  }
  function watchReleaseButton() {
    if (!/^\/release\/[\da-f-]{36}(?:\/relationships)?\/?$/i.test(location.pathname)) return;
    installReleaseButton();
    const observer = new MutationObserver(() => {
      if (!document.getElementById('link-recording-level-launch')) installReleaseButton();
    });
    observer.observe(document.querySelector('#content') || document.body, {childList:true, subtree:true});
    window.addEventListener('pagehide', () => observer.disconnect(), {once:true});
  }
  async function resumableBatches(release) {
    const keys = await GM_listValues();
    const values = await Promise.all(keys.filter(key => key === KEY || key.startsWith(`${KEY}:batch:`)).map(key => GM_getValue(key, null)));
    const batches = new Map();
    for (const batch of values) {
      if (batch?.release !== release || !unfinishedBatch({...batch,created:Date.now()})) continue;
      if (!batch.jobs.every(job => UUID.test(job.id || '') && jobLinks(job).length && jobLinks(job).every(link => canonicalTrackLink(link.url)))) continue;
      batches.set(batch.batchId, batch);
    }
    return [...batches.values()];
  }
  async function prepareResume(batchId, approveRetry) {
    let batch = await readBatch(batchId);
    if (!batch || !unfinishedBatch({...batch,created:Date.now()})) throw Error('This batch has already finished or was discarded.');
    // Revoke older workers before checking whether their last save reached MusicBrainz.
    batch = {...batch,runId:crypto.randomUUID(),created:Date.now(),progress:'Checking saved position…'};
    await saveBatch(batch);
    const job = batch.jobs[batch.index];
    const recording = await fetchRecording(job.id);
    if ((await readBatch(batchId))?.runId !== batch.runId) throw Error('Another resume replaced this attempt.');
    const missing = missingLinks(job, recording);
    if (!missing.length) {
      batch = {...batch,index:batch.index+1,submitted:false,skipped:(batch.skipped||0)+Number(!batch.submitted)};
    } else {
      if (batch.submitted && !await approveRetry()) throw Error('Paused. Check pending edits before retrying this recording.');
      batch = {...batch,submitted:false};
    }
    batch.progress = batch.index === batch.jobs.length ? 'Complete' : 'Opening editor…';
    await saveBatch(batch);
    return batch;
  }
  function launchBatch(batch, progress) {
    progress.textContent = `Opening recording ${batch.index+1}/${batch.jobs.length}…`;
    location.assign(editUrl(batch.jobs[batch.index],batch.source,batch.batchId,batch.runId));
  }
  function showCompletedImport(anchor) {
    const key = `${KEY}:completed`;
    let completed;
    try { completed=JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return; }
    if (!completed || location.pathname.split('/')[2] !== completed.release) return;
    sessionStorage.removeItem(key);
    const box=releasePanel('Import complete',anchor);
    node('p',`${completed.total} recordings processed · ${completed.skipped} skipped.`,box);
  }
  async function offerResume(box, release) {
    const batches=await resumableBatches(release);
    if(!box.open || !box.isConnected)return;
    for(const saved of batches){
      const section=node('div','',box);
      const status=node('p',`Saved import · ${saved.index}/${saved.jobs.length} recordings completed`,section);
      const resume=node('button','Resume import',section);
      const discard=node('button','Discard import',section);
      discard.onclick=async()=>{await cancelBatch(saved.batchId);section.remove();};
      resume.onclick=async()=>{
        resume.disabled=true;status.textContent='Checking saved position…';
        try{
          const batch=await prepareResume(saved.batchId,()=>window.confirm('The previous submission may still be pending. Check this recording’s edit history before retrying. Retry the missing links?'));
          if(batch.index===batch.jobs.length){status.textContent='Complete';return;}
          status.textContent=`Resuming ${batch.index+1}/${batch.jobs.length}…`;
          launchBatch(batch,status);
        }catch(error){status.textContent=error.message;resume.disabled=false;}
      };
    }
  }
  async function releasePage(anchor) {
    const id = location.pathname.match(/^\/release\/([\da-f-]{36})(?:\/relationships)?\/?$/i)?.[1];
    if (!id) return;
    const launch = anchor || document.getElementById('link-recording-level-launch');
    if (!launch) return;
    const box = releasePanel('Import recording links', launch);
    const status = node('span', 'Loading…', box);
    status.style.cssText='display:block;margin:8px 0';
    const controller = new AbortController();
    box.addEventListener('close', () => controller.abort(), {once:true});
    try {
      void offerResume(box,id).catch(error => { node('p',`Saved imports unavailable: ${error.message}`,box); });
      offerBarcodeSearch(box, null, id);
      const release = await fetchRelease(id), tracks = releaseTracks(release), choices = currentStreamingSources(release, document);
      if (!box.open) return;
      status.remove();
      status.textContent = '';
      offerBarcodeSearch(box, release, id, {manual:false});
      const selected = providerCheckboxes(box, choices);

      const load = node('button', 'Collect selected providers', box), review = node('div', '', box);
      load.onclick = async () => {
        const sources = selected();
        if (!sources.length) {status.textContent='Select a provider.';return;}
        load.disabled = true; status.textContent = ''; review.replaceChildren();
        const results = await Promise.all(sources.map(async choice => {
          const progress = node('p', requiresActiveCollection(choice.url)
            ? `${new URL(choice.url).hostname}: opening…`
            : `Loading ${choice.label}…`, review);
          try {const rows=await collectSource(choice, controller.signal, {activateSpotify:true}); progress.textContent=`${choice.label}: ${rows.length} tracks loaded`; return {choice,rows};}
          catch (error) {progress.textContent=`${choice.label}: ${error.message}`;return {choice,error};}
        }));
        if (!box.open) return;
        const mappings = [];
        for (const result of results) {
          if (result.error) continue;
          const {choice,rows} = result;
          node('h3', choice.label, review);
          const same = rows.length === tracks.length;
          const ordered = same || await confirmTrackOrder(box, rows.length, tracks.length);
          if (!box.open) return;
          const table=node('table','',review);
          const selects=rows.map((row,i)=>{
            const tr=node('tr','',table), title=node('td','',tr);
            const link = row.url && canonicalTrackLink(row.url);
            if (link) {
              const anchor=node('a',`${i+1}. ${row.title}`,title);
              anchor.href=link.url;anchor.target='_blank';anchor.rel='noopener noreferrer';
            } else title.textContent=`${i+1}. ${row.title}`;
            const select=node('select','',node('td','',tr));
            const skip=node('option','Exclude',select);skip.value='-1';
            tracks.forEach((track,j)=>{const option=node('option',`${track.position} · ${track.title}`,select);option.value=String(j);});
            select.value=ordered && row.url && i<tracks.length?String(i):'-1';select.disabled=!row.url;return select;
          });
          mappings.push({rows,selects});
        }
        load.disabled=false;
        status.textContent='Review track matches.';
        const start=node('button','Import all selected links',review);
        start.onclick=async()=>{
          try {
            const groups=mappings.filter(m=>m.selects.some(select=>select.value!=='-1')).map(m=>jobsFor(m.rows,tracks,m.selects.map(select=>Number(select.value))));
            const jobs=mergeJobs(groups);if(!jobs.length)throw Error('No recording links selected.');
            const batchId=crypto.randomUUID(), source=location.href;
            const batch={batchId,source,release:id,jobs,index:0,submitted:false,created:Date.now(),runId:crypto.randomUUID(),progress:'Opening editor…'};
            await saveBatch(batch);
            start.disabled=true;
            const progress = node('p',`Adding 1/${jobs.length}…`,review);
            launchBatch(batch,progress);

          }catch(error){status.textContent=error.message;}
        };
      };
      box.append(status);
    }catch(error){status.textContent=error.message;box.append(status);}
  }
  async function recordingPage() {
    const marker = location.hash.match(/^#ytm-import=([\w-]+)(?:&run=([\w-]+))?$/);
    const batchId = marker?.[1] || sessionStorage.getItem(`${KEY}:recording-batch`);
    const runId = marker ? marker[2] : sessionStorage.getItem(`${KEY}:recording-run`) || undefined;
    if (!batchId) return;
    let batch = await readBatch(batchId);
    if (!unfinishedBatch(batch) || batch.batchId !== batchId || batch.runId !== runId) return;
    const job = batch.jobs[batch.index];
    if (!job || location.pathname.split('/')[2] !== job.id) return;
    sessionStorage.setItem(`${KEY}:recording-batch`, batchId);
    if(runId)sessionStorage.setItem(`${KEY}:recording-run`,runId);else sessionStorage.removeItem(`${KEY}:recording-run`);
    const box = panel('', {inline:true});
    node('p', `${job.title} — ${jobLinks(job).map(link => link.service).join(", ")}`, box);
    const meter = node('progress', '', box); meter.max=batch.jobs.length; meter.value=batch.index;
    meter.style.cssText='display:block;width:100%;height:12px;margin:10px 0;accent-color:#416ca6';
    meter.setAttribute('aria-label', 'Completed recordings');
    const status = node('p', 'Checking recording…', box);
    status.style.cssText='font-weight:600;margin:10px 0';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    node('button', 'Stop batch', box).onclick = async () => { if (!await active()) return; await cancelBatch(batchId); sessionStorage.removeItem(`${KEY}:recording-batch`); box.close(); };
    const active = async () => { const b = await readBatch(batchId); return unfinishedBatch(b) && b.batchId === batchId && b.index === batch.index && b.runId === runId; };
    await saveBatch({...batch,progress:`Checking ${batch.index+1}/${batch.jobs.length}…`});
    const advance = async (skipped = false) => {
      if (!await active()) return;
      batch = { ...batch, index: batch.index + 1, submitted: false, skipped: (batch.skipped || 0) + Number(skipped) };
      batch = {...batch,progress:batch.index===batch.jobs.length?'Complete':`Adding ${batch.index+1}/${batch.jobs.length}…`};
      await saveBatch(batch);
      meter.value = batch.index;
      if (batch.index === batch.jobs.length) {
        status.textContent = `Import finished. ${batch.skipped || 0} skipped.`;
        sessionStorage.removeItem(`${KEY}:recording-batch`);
        sessionStorage.removeItem(`${KEY}:recording-run`);
        sessionStorage.setItem(`${KEY}:completed`,JSON.stringify({release:batch.release,total:batch.jobs.length,skipped:batch.skipped||0}));
        let target = `https://musicbrainz.org/release/${batch.release}`;
        try {
          const source = new URL(batch.source);
          if (source.origin === 'https://musicbrainz.org' && [ `/release/${batch.release}`, `/release/${batch.release}/relationships` ].includes(source.pathname.replace(/\/$/,''))) target=source.href;
        } catch { /* Older batches may not have a source URL. */ }
        location.assign(target);
        return;
      }
      status.textContent = skipped ? 'Links already present. Moving to the next recording…' : 'Recording saved. Moving to the next recording…';
      await sleep(1500);
      if (await active()) location.href = editUrl(batch.jobs[batch.index], batch.source, batchId, runId);
    };
    if (!location.pathname.endsWith('/edit')) {
      if (location.pathname !== `/recording/${job.id}` || !document.referrer.startsWith(`https://musicbrainz.org/recording/${job.id}/edit`)) {
        status.textContent = 'Could not verify the return from the recording editor. Batch paused; check edit history before restarting.'; return;
      }
      if (!batch.submitted) { status.textContent = 'Unexpected page. Import stopped; no edit submitted.'; return; }
      // Only advance after the native POST redirects back to this recording.
      await advance();
      return;
    }
    if (batch.submitted) { status.textContent = 'The previous submission did not reach its recording page. Check validation/login messages. Automatic retry is disabled.'; await saveBatch({...batch,progress:'Paused · submission needs review'}); return; }
    let submissionJob;
    try {
      status.textContent = 'Checking which selected relationships already exist…';
      const recording = await fetchRecording(job.id);
      if (!await active()) return;
      submissionJob = { ...job, links: missingLinks(job, recording) };
      if (!submissionJob.links.length) { status.textContent = 'Link already added — skipping this recording.'; await advance(true); return; }
    } catch (error) { status.textContent = `Batch paused: ${error.message}`; await saveBatch({...batch,progress:`Paused · ${error.message}`}); return; }
    status.textContent = 'Waiting for the recording editor…';
    for (let n = 0; n < 40; n++) {
      if (!await active()) return;
      const seeded = seededForm(document, submissionJob);
      if (seeded) {
        status.textContent = 'Verifying selected links…';
        await sleep(1500);
        if (!await active()) return;
        const verified = seededForm(document, submissionJob);
        if (!verified) break;
        await saveBatch({ ...batch, submitted: true, progress:`Saving ${batch.index+1}/${batch.jobs.length}…` });
        status.textContent = `Saving recording links… ${batch.index + 1} of ${batch.jobs.length}`;
        if (!submitVerified(verified, submissionJob)) {
          await saveBatch({ ...batch, submitted: false, progress:'Paused · submission validation failed' });
          box.showModal();
          status.textContent = 'Submission stopped: MusicBrainz did not serialize the expected track relationships, or validation blocked it. Check the editor before retrying.';
        }
        return;
      }
      await sleep(500);
    }
    box.showModal(); status.textContent = 'Could not verify the seeded links. Nothing was submitted.'; await saveBatch({...batch,progress:'Paused · links not ready'});
  }
  if (globalThis.__ytmImporterTesting) {
    globalThis.__ytmImporter = { resumableBatches, prepareResume, releaseId, trackUrl, releaseTracks, jobsFor, editUrl, collect, seededForm, submitVerified, canonicalTrackLink, jobLinks, missingLinks, playlistUrl, collectionUrl, collectProvider, spotifySnapshot, soundcloudSnapshot, streamingSources, providerCheckboxes, mergeJobs, collectSource, sourceWorker, unfinishedBatch, cancelBatch, readBatch, saveBatch, installReleaseButton, barcodeSearchUrl, hasYouTubeAlbum, releaseUrl, verifiedReleaseEdit, releaseHasUrl, youtubeAlbumResults, albumLookupResults, currentStreamingSources, offerBarcodeSearch }; return;
  }
  // Capture the marker before YouTube Music removes it during album redirects.
  const sourceToken=location.hash.match(/^#mb-source=([\w-]+)$/)?.[1];
  const releaseToken=location.hash.match(/^#mb-release-link=([\w-]+)$/)?.[1];
  const markedAlbumToken=location.hash.match(/^#mb-album-search=([\w-]+)$/)?.[1];
  if(markedAlbumToken)sessionStorage.setItem(`${KEY}:album-worker`,markedAlbumToken);
  const albumToken=markedAlbumToken || (location.hostname==='music.youtube.com' ? sessionStorage.getItem(`${KEY}:album-worker`) : null);
  const start=()=>{
    if (location.hostname === 'musicbrainz.org') {
      if (releaseToken && /^\/release\/[\da-f-]{36}\/edit\/?$/i.test(location.pathname)) void fillReleasePlaylist(releaseToken);
      else if (location.pathname.startsWith('/release/')) watchReleaseButton();
      else void recordingPage();
    } else if(albumToken && location.hostname==='music.youtube.com') {
      void youtubeAlbumWorker(albumToken).catch(()=>sessionStorage.removeItem(`${KEY}:album-worker`));
    } else if(sourceToken) void sourceWorker(sourceToken);
  };
  if (location.hostname === 'musicbrainz.org' && releaseToken && /^\/release\/[\da-f-]{36}\/edit\/?$/i.test(location.pathname)) void fillReleasePlaylist(releaseToken);
  else if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})();
