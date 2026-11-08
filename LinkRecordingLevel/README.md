# LinkRecordingLevel

Install [the userscript](LinkRecordingLevel.user.js), currently version **0.9.8**.

## Workflow

1. Open a MusicBrainz release page and choose **Import recording links** above its URL relationships. The importer opens inline on the page.
2. Select any available **Spotify, YouTube/YouTube Music, or SoundCloud** release URLs.
3. Choose **Collect selected providers**. Spotify and SoundCloud tabs activate one at a time and scroll as needed. YouTube collection runs alongside them.
4. Review every track mapping. A different track count requires confirmation before matching by order. Unavailable positions are preserved; failed sources are excluded.
5. Click **Import all selected links**. The script combines provider links per recording and skips existing URLs. The current tab visits the recording editors, shows progress on each page, and returns to the release when complete.

Provider pages only act as collection workers opened from a release. They have no import button. If a release is missing a YouTube album URL, the barcode search and **Add release URL** controls can help add it first.

Collection tabs close when finished. Switching away pauses Spotify and SoundCloud collection. Failed or incomplete sources report an error and are excluded. Review the mapping before importing.

## Tests

```sh
deno test --allow-read LinkRecordingLevel/importer_test.ts
deno run --allow-all LinkRecordingLevel/submission_browser_test.ts
deno run --allow-all LinkRecordingLevel/spotify_collection_browser_test.ts --headed
```

The first two commands run local tests. The live Spotify browser check uses real Spotify pages with Playwright and a bridge for userscript storage/tab APIs; it does not load the script through an installed Violentmonkey extension. Authenticated MusicBrainz submission has not been tested end to end.

Each release import now has its own saved batch, so separate release pages can
collect and submit recording links at the same time. Recording editors update
only the batch ID in their URL. Stopping or completing one import leaves other
batches untouched.


### Release URL timing

Adding a release URL now checks the release data already loaded by the importer
and the visible relationship table. It avoids downloading the full release a
second time just to check for a duplicate. The remaining delay is MusicBrainz
loading the native release editor and processing its submission.


### Performance benchmark

Measured 2026-09-30 against MusicBrainz release `11fde1d2-395f-492c-bfe7-b870109e3031` (Emancipation), from this environment:

| Stage | Observed time | Notes |
| --- | ---: | --- |
| Release page to DOMContentLoaded | 11.0 s | Public page, cold browser session |
| Release page full load | 13.6 s | Third-party page resources dominate; five resources took about 5.9–6.0 s |
| Full release API request | 2.0 s | 12,093 bytes; 36 tracks |
| Edit URL without sign-in | 3.6 s | Redirected to MetaBrainz sign-in; authenticated editor and save time not measurable here |

The manual release-URL form now appears before the full recordings request finishes,
so entering an external URL does not wait on that API response. The duplicate check
uses the response already in memory plus visible release links; it no longer repeats
the full API request. Editor readiness now wakes on DOM changes and retains a 250 ms
backup poll instead of adding up to 500 ms of polling delay. MusicBrainz page loads
and authenticated save time remain external waits.


Recording imports use the current tab and return to the release on completion.
The original tab is never closed.

Version 0.9.3 clears the initial loading label once the provider picker is ready.
The release URL worker starts as soon as the page body exists, without waiting
for DOMContentLoaded, and shows editor/validation/save progress. Its readiness
window is 45 seconds of elapsed time, so unrelated DOM changes cannot exhaust
the retry count prematurely. Browser fixtures cover these startup states; an
authenticated live save timing has not yet been measured.

### Resuming an interrupted recording import

Reopen the release and click **Import recording links**, then **Resume import**.
The saved recording order, selected URLs, and completed position survive page or
browser restarts. Resume also recovers batches older than an hour. Existing links
are checked before continuing. If the interrupted save has an uncertain outcome,
check its pending edits before confirming a retry. **Discard import** removes the
saved batch. Resuming revokes the previous worker; other release batches continue
independently. Resumed imports also use the current tab and return to the release on completion.
Provider collection and unsaved mapping reviews are not checkpointed.

SoundCloud uses the matching playlist’s reported track count and page data to verify completeness. Loaded track positions are retained while scrolling. An unknown total or missing positions produces an error instead of importing a partial list. SoundCloud changes have browser-fixture coverage; a live SoundCloud playlist has not yet been verified.
