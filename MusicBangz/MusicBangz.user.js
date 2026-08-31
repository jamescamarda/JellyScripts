// ==UserScript==
// @name         MusicBangz
// @namespace    https://github.com/jamescamarda/JellyScripts
// @version      1.0.2
// @description  Search Discogs music metadata with configurable sources and an optional locked search tab.
// @compatible    violentmonkey
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_openInTab
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const messageKey = 'discogs-search-query';
  const targetKey = 'discogs-search-target-tab';
  const preservingTargetKey = 'discogs-search-preserving-target';
  const tabLockKey = 'discogs-search-tab-lock-enabled';
  const pendingTargetKey = 'discogs-search-pending-target';
  const targetHeartbeatPrefix = 'discogs-search-target-heartbeat:';
  const sourceKey = 'discogs-search-source';
  const targetHeartbeatMs = 5000;
  const targetStaleMs = 15000;
  const pendingTargetStaleMs = 30000;
  const tabLockMarker = 'discogs-search-lock';
  const buttonTheme = {
    surface: '#1e1f22',
    surfaceHover: '#24272b',
    outline: '#4b5561',
    outlineHover: '#9aa3af',
    onSurface: '#e8eaed',
  };

  const sources = {
    youtube: {
      label: 'YouTube',
      url: (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    },
    spotify: {
      label: 'Spotify',
      url: (query) => `https://open.spotify.com/search/${encodeURIComponent(query)}`,
    },
    qobuz: {
      label: 'Qobuz',
      url: (query) => `https://www.qobuz.com/au-en/search?q=${encodeURIComponent(query)}`,
    },
    bandcamp: {
      label: 'Bandcamp',
      url: (query) => `https://bandcamp.com/search?q=${encodeURIComponent(query)}`,
    },
    apple: {
      label: 'Apple Music',
      url: (query) => `https://music.apple.com/au/search?term=${encodeURIComponent(query)}`,
    },
    google: {
      label: 'Google',
      url: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    },
    yandex: {
      label: 'Yandex',
      url: (query) => `https://yandex.ru/search/?text=${encodeURIComponent(query)}`,
    },
    lastfm: {
      label: 'Last.fm',
      url: (query) => `https://www.last.fm/search?q=${encodeURIComponent(query)}`,
    },
  };

  const siteAdapters = [
    {
      id: 'discogs',
      matches: () => location.hostname.endsWith('discogs.com'),
      addButtons: addDiscogsButtons,
    },
  ];

  start();

  function start() {
    safeRun(() => maintainTargetHeartbeat(activeLockToken()));
    safeRun(releaseLockOnExit);
    safeRun(registerMenus);
    safeRun(listenForTargetedSearches);
    safeRun(claimPendingTarget);

    const site = activeSite();
    if (!site) return;

    installButtonStyles();
    site.addButtons();
    safeRun(() => GM_addValueChangeListener(sourceKey, () => {
      document.querySelectorAll('button.discogs-search').forEach(renderButton);
    }));
    new MutationObserver(() => site.addButtons()).observe(document.body, { childList: true, subtree: true });
  }

  function safeRun(fn) {
    try {
      return fn();
    } catch (error) {
      console.warn('[Discogs search script]', error);
      return undefined;
    }
  }

  function registerMenus() {
    let tabLockMenuId;
    const sourceMenuIds = {};

    function updateTabLockMenu() {
      const active = tabLockEnabled();
      tabLockMenuId = registerMenu(
        active ? '✓ Tab lock' : 'Tab lock',
        () => {
          GM_setValue(tabLockKey, !active);
          if (active) {
            GM_setValue(targetKey, '');
            GM_setValue(preservingTargetKey, '');
            GM_setValue(pendingTargetKey, null);
          }
          updateTabLockMenu();
        },
        tabLockMenuId,
      );
    }

    function updateSourceMenu() {
      const active = activeSource();
      Object.entries(sources).forEach(([id, source]) => {
        sourceMenuIds[id] = registerMenu(
          `${id === active ? '✓ ' : ''}Search source: ${source.label}`,
          () => {
            GM_setValue(sourceKey, id);
            updateSourceMenu();
          },
          sourceMenuIds[id],
        );
      });
    }

    safeRun(() => GM_addValueChangeListener(tabLockKey, updateTabLockMenu));
    safeRun(() => GM_addValueChangeListener(sourceKey, updateSourceMenu));
    updateTabLockMenu();
    updateSourceMenu();
  }

  function registerMenu(label, handler, id) {
    if (typeof GM_registerMenuCommand !== 'function') return id;
    return safeRun(() => GM_registerMenuCommand(label, handler, { id, autoClose: false }))
      || safeRun(() => GM_registerMenuCommand(label, handler))
      || id;
  }

  function listenForTargetedSearches() {
    GM_addValueChangeListener(messageKey, (_key, _old, message, remote) => {
      if (!remote || !message?.query || !tabLockEnabled()
        || activeLockToken() !== message.token) return;
      recordTargetHeartbeat(message.token);
      GM_setValue(preservingTargetKey, message.token);
      location.href = lockableSearchUrl(searchUrl(message.query, message.source), message.token);
    });
  }

  function heartbeatKey(tabId) {
    return `${targetHeartbeatPrefix}${tabId}`;
  }

  function recordTargetHeartbeat(tabId) {
    GM_setValue(heartbeatKey(tabId), Date.now());
  }

  function maintainTargetHeartbeat(tabId) {
    if (!tabId) return;
    recordTargetHeartbeat(tabId);
    setInterval(() => recordTargetHeartbeat(tabId), targetHeartbeatMs);
  }

  function isLockedTargetAlive(tabId) {
    const heartbeat = Number(GM_getValue(heartbeatKey(tabId), 0));
    return Number.isFinite(heartbeat) && Date.now() - heartbeat <= targetStaleMs;
  }

  function activeLockToken() {
    return sessionStorage.getItem('discogs-search-active-lock') || '';
  }

  function releaseLockOnExit() {
    addEventListener('pagehide', () => {
      const token = activeLockToken();
      if (!token || GM_getValue(targetKey, '') !== token) return;
      if (GM_getValue(preservingTargetKey, '') === token) {
        GM_setValue(preservingTargetKey, '');
        return;
      }
      GM_setValue(targetKey, '');
    });
  }

  function tabLockEnabled() {
    return GM_getValue(tabLockKey, false) === true;
  }

  function claimPendingTarget() {
    if (!tabLockEnabled() || isLockedTargetAlive(GM_getValue(targetKey, ''))) return;

    const pending = GM_getValue(pendingTargetKey, null);
    if (!pending || Date.now() - pending.sentAt > pendingTargetStaleMs) return;
    if (!isSearchPageFor(pending.source) || lockMarker() !== pending.token) return;

    sessionStorage.setItem('discogs-search-active-lock', pending.token);
    recordTargetHeartbeat(pending.token);
    GM_setValue(targetKey, pending.token);
    GM_setValue(pendingTargetKey, null);
    const url = searchUrl(pending.query, pending.source);
    if (location.href.split('#')[0] !== url) {
      GM_setValue(preservingTargetKey, pending.token);
      location.href = url;
    } else {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    }
  }

  function isSearchPageFor(source) {
    const expected = safeRun(() => new URL(searchUrl('', source)).hostname);
    return Boolean(expected) && location.hostname === expected;
  }

  function lockMarker() {
    return new URLSearchParams(location.hash.slice(1)).get(tabLockMarker) || '';
  }

  function lockableSearchUrl(url, token) {
    return `${url}#${tabLockMarker}=${encodeURIComponent(token)}`;
  }

  function newLockToken() {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function activeSource() {
    const id = GM_getValue(sourceKey, 'youtube');
    return sources[id] ? id : 'youtube';
  }

  function searchUrl(query, source = activeSource()) {
    return sources[source]?.url(query) || sources.youtube.url(query);
  }

  function activeSite() {
    return siteAdapters.find((site) => site.matches()) || null;
  }

  function runSearch(query) {
    const source = activeSource();
    const targetToken = GM_getValue(targetKey, '');
    if (tabLockEnabled() && targetToken && isLockedTargetAlive(targetToken)) {
      GM_setValue(messageKey, { query, source, token: targetToken, sentAt: Date.now() });
      return;
    }
    if (targetToken) {
      GM_setValue(targetKey, '');
      GM_setValue(preservingTargetKey, '');
    }

    if (tabLockEnabled()) {
      const pending = GM_getValue(pendingTargetKey, null);
      if (pending && pending.source === source && Date.now() - pending.sentAt <= pendingTargetStaleMs) {
        GM_setValue(pendingTargetKey, { source, query, token: pending.token, sentAt: pending.sentAt });
        return;
      }
      const token = newLockToken();
      GM_setValue(pendingTargetKey, { source, query, token, sentAt: Date.now() });
      const tab = openSearchTab(lockableSearchUrl(searchUrl(query, source), token));
      if (tab) tab.onclose = () => {
        if (GM_getValue(targetKey, '') === token) GM_setValue(targetKey, '');
      };
      return;
    }
    openSearchTab(searchUrl(query, source));
  }

  function openSearchTab(url) {
    if (typeof GM_openInTab === 'function') {
      return GM_openInTab(url, { active: true, insert: true });
    }
    return window.open(url, '_blank', 'noopener');
  }

  function installButtonStyles() {
    GM_addStyle(`
      :root {
        --discogs-search-surface: #1e1f22;
        --discogs-search-surface-hover: #24272b;
        --discogs-search-outline: #4b5561;
        --discogs-search-outline-hover: #9aa3af;
        --discogs-search-on-surface: #e8eaed;
        --discogs-search-focus: #8ab4f8;
      }

      button.discogs-search {
        align-items: center;
        appearance: none;
        background: var(--discogs-search-surface) !important;
        border: 1px solid var(--discogs-search-outline) !important;
        border-radius: 999px !important;
        box-shadow: none !important;
        color: var(--discogs-search-on-surface) !important;
        cursor: pointer;
        display: inline-flex !important;
        font: 500 11px/1 system-ui, sans-serif !important;
        gap: 3px !important;
        height: 20px !important;
        line-height: 18px !important;
        margin-left: .35rem !important;
        padding: 0 5px !important;
        text-shadow: none !important;
        vertical-align: middle;
      }

      button.discogs-search:hover {
        background: var(--discogs-search-surface-hover) !important;
        border-color: var(--discogs-search-outline-hover) !important;
      }

      button.discogs-search:active {
        transform: translateY(1px);
      }

      button.discogs-search:focus-visible {
        outline: 2px solid var(--discogs-search-focus) !important;
        outline-offset: 2px !important;
      }

      button.discogs-search svg {
        height: 12px !important;
        width: 12px !important;
      }

      button.discogs-search svg .search-glyph {
        fill: none !important;
        stroke: currentColor !important;
        stroke-linecap: round;
        stroke-width: 2;
      }

      tr.discogs-search-row > td,
      tr.discogs-search-row > th,
      td.discogs-search-cell,
      th.discogs-search-cell {
        vertical-align: middle !important;
      }

      .discogs-search-track-title {
        cursor: pointer;
        text-decoration: underline dotted currentColor;
        text-decoration-thickness: 1px;
        text-underline-offset: 3px;
      }

      .discogs-search-track-title:hover {
        text-decoration-style: solid;
      }

      .discogs-search-track-title:focus-visible {
        outline: 2px solid var(--discogs-search-focus) !important;
        outline-offset: 2px !important;
      }
    `);
  }

  function addDiscogsButtons() {
    addDiscogsReleaseButton();
    addDiscogsTrackButtons();
  }

  function addDiscogsReleaseButton() {
    if (!/\/(?:release|master)\//.test(location.pathname)) return;

    const heading = document.querySelector('h1');
    if (!heading || heading.querySelector('button.discogs-search')) return;

    const query = discogsReleaseQuery(heading);
    if (!query) return;

    const button = createSearchButton('release', () => discogsReleaseQuery(heading) || query);
    button.classList.add('discogs-search-release');
    heading.append(button);
  }

  function addDiscogsTrackButtons() {
    document.querySelectorAll(
      [
        '#release-tracklist tr',
        '#tracklist tr',
        'tr.tracklist_track',
        'table.tracklist tr',
      ].join(', '),
    ).forEach((node) => {
      if (node.dataset.discogsSearchTrackProcessed === 'true') return;

      const track = discogsTrackFromTableRow(node);
      if (!track) return;

      node.dataset.discogsSearchTrackProcessed = 'true';
      node.classList.add('discogs-search-row');
      track.target.classList.add('discogs-search-cell');
      makeTrackTitleSearchable(track.target, () => `${track.artist} — ${track.title}`);
    });
  }

  function createSearchButton(kind, queryFn) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'discogs-search';
    button.dataset.searchKind = kind;
    button.dataset.discogsSearchButton = 'true';
    button.addEventListener('mouseenter', () => applyButtonTheme(button, true));
    button.addEventListener('mouseleave', () => applyButtonTheme(button));
    button.addEventListener('focus', () => applyButtonTheme(button, true));
    button.addEventListener('blur', () => applyButtonTheme(button));
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const query = cleanText(queryFn());
      if (query) runSearch(query);
    });
    renderButton(button);
    return button;
  }

  function makeTrackTitleSearchable(element, queryFn) {
    if (!element || element.dataset.discogsSearchTrackTitle === 'true') return;

    element.dataset.discogsSearchTrackTitle = 'true';
    element.classList.add('discogs-search-track-title');
    if (element.tagName !== 'A') {
      element.setAttribute('role', 'button');
      element.tabIndex = 0;
    }
    element.title = 'Search this track';
    element.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      const query = cleanText(queryFn());
      if (query) runSearch(query);
    });
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      const query = cleanText(queryFn());
      if (query) runSearch(query);
    });
  }

  function renderButton(button) {
    const source = sources[activeSource()];
    const kind = button.dataset.searchKind || 'track';
    button.dataset.source = activeSource();
    button.title = `Search ${kind} on ${source.label}`;
    button.setAttribute('aria-label', `Search ${kind} on ${source.label}`);
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="search-glyph" cx="10.5" cy="10.5" r="5.5"/><path class="search-glyph" d="m15 15 4.5 4.5"/></svg>';
    applyButtonTheme(button);
    button.querySelectorAll('.search-glyph').forEach((glyph) => {
      glyph.style.setProperty('fill', 'none', 'important');
      glyph.style.setProperty('stroke', 'currentColor', 'important');
    });
  }

  function applyButtonTheme(button, hovered = false) {
    button.style.setProperty('background', hovered ? buttonTheme.surfaceHover : buttonTheme.surface, 'important');
    button.style.setProperty('background-color', hovered ? buttonTheme.surfaceHover : buttonTheme.surface, 'important');
    button.style.setProperty('border', `1px solid ${hovered ? buttonTheme.outlineHover : buttonTheme.outline}`, 'important');
    button.style.setProperty('border-color', hovered ? buttonTheme.outlineHover : buttonTheme.outline, 'important');
    button.style.setProperty('box-shadow', 'none', 'important');
    button.style.setProperty('color', buttonTheme.onSurface, 'important');
  }

  function discogsReleaseQuery(heading = document.querySelector('h1')) {
    if (!heading) return '';
    const copy = heading.cloneNode(true);
    copy.querySelectorAll('button.discogs-search').forEach((button) => button.remove());
    return cleanText(copy.textContent || '');
  }

  function discogsReleaseArtist() {
    return document.querySelector('h1 a[href*="/artist/"]')?.textContent
      || document.querySelector('h1')?.textContent?.split(/\s[-–—]\s/)[0]
      || '';
  }

  function discogsTrackFromTableRow(row) {
    const cells = [...row.cells];
    if (cells.length < 2 || !isDiscogsTrackRow(row, cells)) return null;

    const legacyArtistCell = row.querySelector('.tracklist_track_artists');
    const hasTrackArtist = Boolean(legacyArtistCell) || cells.length >= 4;
    const artistCell = legacyArtistCell || (hasTrackArtist ? cells[1] : null);
    const titleCell = row.querySelector('.tracklist_track_title') || (hasTrackArtist ? cells[2] : cells[1]);
    const artist = cleanArtist(artistCell?.textContent || discogsReleaseArtist());
    const titleTarget = discogsTrackTitleTarget(titleCell);
    const title = cleanText(titleTarget?.textContent || '');

    return artist && title && titleTarget
      ? { artist, title, target: titleTarget }
      : null;
  }

  function discogsTrackTitleTarget(container) {
    if (!container) return null;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode && !cleanText(textNode.nodeValue || '')) {
      textNode = walker.nextNode();
    }
    if (!textNode) return null;

    const text = textNode.nodeValue || '';
    const target = document.createElement('span');
    target.textContent = text;
    textNode.parentNode.insertBefore(target, textNode);
    textNode.remove();
    return target;
  }

  function isDiscogsTrackRow(row, cells) {
    return isDuration(cells.at(-1)?.textContent || '')
      || isTrackPosition(row.dataset.trackPosition || cells[0]?.textContent || '');
  }

  function cleanArtist(text) {
    return cleanText(text).replace(/\s*[-–—]\s*$/, '');
  }

  function isDuration(text) {
    return /^\d{1,2}:\d{2}(?::\d{2})?$/.test(cleanText(text));
  }

  function isTrackPosition(text) {
    return /^[A-Z]?\d+(?:[.-]\d+)?[A-Z]?$|^[A-Z]\d*$/i.test(cleanText(text));
  }

  function cleanText(text) {
    return String(text).replace(/\s+/g, ' ').trim();
  }
})();
