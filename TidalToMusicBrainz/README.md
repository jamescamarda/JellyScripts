# TIDAL track links → MusicBrainz recording

Install [`tidal-track-links-to-musicbrainz.user.js`](tidal-track-links-to-musicbrainz.user.js) in Violentmonkey. Open a TIDAL track share page ending in `/u`, such as `https://tidal.com/track/21027485/u`. The script displays the direct track links behind TIDAL's service buttons. Search by artist and track (prefilled from TIDAL), choose **Use this recording**, or enter the exact MusicBrainz **recording** MBID (or its recording URL). Then review the checked links, and choose **Open recording editor**. Sign in to MusicBrainz if prompted, then reopen the generated recording editor URL.

The button opens the selected recording's **`/edit` page**, prefilling the native External links fields with the selected URLs and their free/subscription streaming types, plus an edit note citing TIDAL. Review the recording title/version, links, and relationship types, then submit the MusicBrainz form yourself. New imports do not require a separate **Prepare relationships** step. Previously generated `/edit-relationships` links remain supported.


The importer accepts only direct TIDAL, Spotify, Apple Music, YouTube Music **track** links. Album links, search pages, and Feature.fm's own page are excluded. TIDAL's cross-service matching can select a different mix, so check the destinations for the recording you chose. New imports use MusicBrainz's external-link URL seeding. The legacy draft step uses its relationship editor state.

Run the focused parser and draft tests with `deno test --allow-read TidalToMusicBrainz/tidal_userscript_test.ts` from the repository root.

The search uses the MusicBrainz recording API with `artist:"Artist name" AND recording:"Track name"`. Both fields are editable, and quotes/backslashes in names are escaped. Results show artist credits, duration, first release date, release title, and version information when available. Click a result title to inspect it on MusicBrainz; selecting a result only fills the MBID, without submitting edits. Search is explicit, with at least 1.1 seconds between request starts.

Version 0.2.0 adds a Violentmonkey network permission for `musicbrainz.org` and `unsafeWindow` access to the existing MusicBrainz relationship editor. Update/reinstall the userscript to receive these permissions. Search uses an anonymous request; editing still uses your MusicBrainz page session.
