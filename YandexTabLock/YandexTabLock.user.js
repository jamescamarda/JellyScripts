// ==UserScript==
// @name         YandexTabLock
// @namespace    https://github.com/jamescamarda/JellyScripts
// @version      1.0.0
// @description  Keep normal Yandex link clicks in the current tab instead of opening new tabs.
// @compatible    violentmonkey
// @match        https://yandex.ru/*
// @match        https://www.yandex.ru/*
// @match        https://yandex.com/*
// @match        https://www.yandex.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  function isPlainLeftClick(event) {
    return event.button === 0 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey;
  }

  function linkFromEvent(event) {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    const link = target.closest('a[href]');
    return link instanceof HTMLAnchorElement ? link : null;
  }

  function shouldHandle(link) {
    const href = link.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return false;
    if (/^(?:javascript|mailto|tel):/i.test(href)) return false;
    return link.target === '_blank' || link.dataset.sorseeSameTab === '1';
  }

  function openInThisTab(event) {
    if (!isPlainLeftClick(event)) return;

    const link = linkFromEvent(event);
    if (!link || !shouldHandle(link)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    location.assign(link.href);
  }

  function removeBlankTargets(root = document) {
    const links = [
      ...(
        root instanceof HTMLAnchorElement && root.target === '_blank'
          ? [root]
          : []
      ),
      ...(root.querySelectorAll?.('a[target="_blank"]') ?? []),
    ];
    for (const link of links) {
      link.dataset.sorseeSameTab = '1';
      link.removeAttribute('target');
      link.removeAttribute('rel');
    }
  }

  document.addEventListener('click', openInThisTab, true);
  document.addEventListener('mousedown', () => removeBlankTargets(), true);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) removeBlankTargets(node);
      }
    }
  });

  function startObserver() {
    const root = document.documentElement;
    if (!root) return;
    observer.observe(root, {
      childList: true,
      subtree: true,
    });
  }

  startObserver();

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => removeBlankTargets(),
      { once: true },
    );
  } else {
    removeBlankTargets();
  }
})();
