# MusicBrainz Loved enrichment

A Violentmonkey coordinator for String Theory. It checks **Loved recordings**
against live MusicBrainz and adds verified release and recording links. It can
also prepare and submit a verified digital edition when only a physical edition
exists. Running it requires no remote debugging or terminal process.

## Install and run

1. Import [SorseeLoved.user.js](SorseeLoved.user.js) into Violentmonkey in the
   browser with String Theory installed. Enable Platform Check, ISRC Scout,
   First Contact, Apollo and Falcon, and sign in to MusicBrainz.
2. Open [the coordinator](https://musicbrainz.org/?sorsee-loved=1), or choose
   **Sorsee Loved enrichment** from Violentmonkey's menu on a MusicBrainz page.
3. Import Sorsee's account-data export (version 9). Only Loved recording IDs are
   retained. To migrate an earlier campaign, import its checkpoint backup into
   an empty coordinator instead.
4. Click **Run enrichment**. The complete remaining queue runs by default;
   **Preview without edits** is optional. Use the maximum field only to limit a
   particular run. Cases that cannot be verified are collected for review while
   the queue continues.

Keep the coordinator and worker tabs open. The initial live audit checks every
Loved ID; 906 recordings need at least about 17 minutes without cached reads.
Successful reads are cached for 24 hours. A labelled progress bar and current
operation show progress. **Stop after current release** saves at the next safe
boundary; **Run enrichment** resumes later.

The results list shows verified additions, unmatched releases, provider failures
and recording-level conflicts. Raw checkpoints are available under **Diagnostic
evidence** and **Export checkpoints**. Reviewed releases are revisited once when
matching rules improve; **Recheck releases already reviewed** requests another
pass explicitly.

## Manual intervention

A dedicated **Manual intervention** list shows unresolved releases and
recordings, with MusicBrainz links and the reasons they could not be completed.
It includes no digital candidate, no suitable new supported links, provider
failures, identity/ISRC conflicts, native editor problems and submissions
needing verification. Recordings with no associated release or failed lookups
are listed and counted too. Partially successful releases show links to affected
recordings.

Successful, ready-to-submit and currently running work is excluded. The count
and **Download manual-intervention list** use the same classification as the
visible list. The download is plain text for working through the cases outside
the browser. **All release outcomes** remains available as a collapsed full
history; raw evidence stays under **Diagnostic evidence**. The list is rebuilt
from saved checkpoints on reload, so existing campaigns need no migration or
rerun.

## Matching and editing policy

- Scope is Loved only. Playlists, indexed folders and saved series are excluded.
- Check live MusicBrainz before editing, resolve merged recording IDs, and skip
  relationships already present.
- Run **Platform Check before ISRC Scout**, with strict barcode and format
  checks. Prefer **Tidal** for album metadata and ISRCs, falling back when its
  actual product cannot be verified.
- Add suitable extra PC album sources only to **Digital Media** editions with
  matching valid barcode and complete track count. Skip withheld, ambiguous,
  existing and ended links. Plan mode never queues Falcon.
- For physical editions, check direct provider URLs and the complete release
  group for an existing digital edition. Reuse a verified match or import the
  provider's actual product through First Contact/Apollo into the existing
  group. Preserve known Recording IDs and the original physical edition. Check
  duplicates again immediately before saving.
- Unresolved artists, labels, recordings, identity conflicts and native-editor
  validation errors require review. A missing digital candidate is recorded; no
  edition is invented.
- Use ISRC Scout across the complete validated release, including recordings
  outside Loved. Resolve MusicBrainz artist, release and recording aliases for
  translated/transliterated names. Latin accent folding preserves meaningful
  marks in other scripts. Cross-script recording names require an existing
  shared ISRC, matching artist identity and duration within two seconds;
  conflicting version qualifiers still block matching. An album with a
  cross-script title additionally needs the same strict barcode and count, and
  independently verified ISRCs at at least 75% of positions (at least three, or
  all positions on smaller releases). No kanji readings or translations are
  guessed. Conflicting or ambiguous ISRCs block the affected rows. ISRCs guide
  discovery; the coordinator does not submit separate ISRC edits.
- Recording links target Spotify, YouTube/YouTube Music and SoundCloud. Tidal
  supplies metadata without adding Tidal playback support to Sorsee.
- Leave edit notes to String Theory. Supply no custom note or attribution,
  including when seeding new digital releases.

## Progress and recovery

Checkpoints live in the userscript's Violentmonkey storage. **Export
checkpoints** downloads the Loved queue, audit and per-release write journals.
Back up before removing/reinstalling the script or switching browsers. Account
exports do not contain edit progress.

One coordinator runs at a time per browser. Workers execute named, bundled
operations once per command, including across navigation. Replies, readiness and
tab closures use storage events; display timers do not gate completion. New
controllers wait for accepted operations before revoking stale commands.
Unsubmitted editor drafts are closed after saving their review evidence. An
uncertain write retains its worker and pauses further submissions for
verification.

Every intended write is checkpointed before dispatch and verified against live
relationships afterward. Pending or lost responses are reconciled without
repeating uncertain submissions. A missing relationship does not establish that
an earlier edit failed: inspect unresolved outcomes and MusicBrainz pending
edits.

Reimporting Loved data retains edit journals. A checkpoint restore requires
empty coordinator storage and cannot overwrite newer work. An interrupted
restore must be finished with the same backup before running.

## Development

```text
MusicBrainzLibrary/
  SorseeLoved.user.js   Generated installable userscript
  src/                 Coordinator, matching policy and String Theory integration
  tests/               Policy, workflow, editor and recovery tests
  tools/               Deno build command
  .local/              One private checkpoint backup; ignored by Git
```

Edit source files, then rebuild the userscript using Deno:

```sh
deno task test
deno task test:browser
deno task check
deno task build
```

No Node tooling or UI framework is required. The generated userscript is kept at
the top level for installation. The obsolete remote-debugging runner has been
removed; there is one supported browser workflow.

The retained `.local/loved/userscript-checkpoints.json` contains the existing
campaign and can be imported into an empty coordinator. Duplicate file-based
campaign data, experimental evidence and the one-time migration tool have been
removed. Future backups come from **Export checkpoints** in the coordinator.

## Verification limits

Automated checks cover matching, PC/Falcon handoff and readback, editor
validation, import scope, orchestration and worker replay protection. Earlier
live checks exercised recording-link discovery/dry submission and native-editor
seeding with preserved release group, barcode, artists and Recording IDs.

Live Brave verification on 2026-11-07 exercised the installed coordinator,
worker, Platform Check and Falcon: it added the Tidal album link to release
`6aa63b94-fe21-40b9-ab41-8d1d28d91733` in
[edit #157335135](https://musicbrainz.org/edit/157335135), then confirmed the
relationship through a fresh MusicBrainz lookup. The transliteration-aware
matching policy now validates 33 of the album's 34 recordings using the actual
provider metadata and MusicBrainz artist alias. The remaining recording has a
conflicting ISRC and stays excluded.

A subsequent installed-coordinator run verified 33 recordings, submitted 23 new
Spotify recording links through ISRC Scout, and confirmed all 23 through fresh
MusicBrainz relationships
([example edit](https://musicbrainz.org/edit/157352285)). The conflicting ISRC
was excluded.

A real new digital-release save has not yet been verified end to end. Unexpected
adapter or editor models produce review outcomes. Read-only network failures
receive bounded retries and pause the campaign for resumption; uncertain writes
are reconciled before further edits.

References:
[String Theory event protocol](https://github.com/majkinetor/musicbrainz-userscripts/blob/main/userscripts/mission_control/DEVELOP.md),
[MusicBrainz release-editor seeding](https://musicbrainz.org/doc/Development/Seeding/Release_Editor),
[Violentmonkey APIs](https://violentmonkey.github.io/api/gm/).
