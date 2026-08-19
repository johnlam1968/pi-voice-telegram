# Upstream bug: `@llblab/pi-telegram` journal compaction can leave the update journal in an unrecoverable inconsistent state

> Draft upstream bug report. Target repo: <https://github.com/llblab/pi-telegram>
> Maintainer: `llblab <shlavik@gmail.com>` (per npm `maintainers` field)
> This file is a ready-to-paste GitHub issue, with a brief leading note for in-repo reference. The issue body starts at **Summary**.

---

## Summary

`@llblab/pi-telegram`'s durable update journal (`lib/journal.ts`) can be left in an internally inconsistent state, after which polling is permanently broken and the agent can no longer receive Telegram updates. The journal's on-disk snapshot (`inbox.json`) is missing a `revision` field (effectively claims revision `0`), while the segments directory (`inbox.json.segments/`) starts at a much higher revision (`0000000000000257.json`) whose `previousRevision` does not match. The polling loop hits `"revision gap after 0"` every iteration, the error is logged in a tight loop, and the only recovery is a manual JSON edit on the bind mount — the bridge has no built-in recovery path for this state.

The likely cause is a race in the compaction code at `lib/journal.ts:2014-2040`: a new snapshot `inbox.json` is written **before** the old segments are deleted, and a concurrent admit can win the rename, overwriting the compacted snapshot with a stale in-memory state. The acknowledged-but-unsafe pattern at `lib/journal.ts:2035-2039` ("Interrupted cleanup may leave an empty directory or old segments") is the same bug, with the worst case being that the old state wins and the bridge has no way to repair itself.

## Environment

- `@llblab/pi-telegram@0.28.0` (running in container `pi-agent-john`)
- npm `latest` at time of report: `0.36.5` (8 minor versions, 24 releases later — see **Affected versions** below)
- Container: `pi-sandbox:latest`, host: `linux` (x86_64), bind-mounted agent dir
- Companion extensions in the same npm tree: `pi-voice-telegram@0.16.12`, `pi-mcp-adapter@2.26.0`, `pi-minimax-m3-caching-fix@0.2.0`

## Symptoms

```
Extension "command:telegram-connect" error: Telegram update journal has a
revision gap after 0:
/home/pi/.pi/agent/tmp/telegram/inbox.json.segments/0000000000000257.json
```

- The error is logged every ~3 seconds in `phase: "loop"` (the polling loop's catch handler in `lib/polling.ts:1558-1586`)
- After a single failed retry, the bridge calls `recordRuntimeEvent("recovery", error, { phase: "polling-start" })` (`lib/bindings.ts:485`), re-throws, and `polling.phase` becomes `"stopped"` with `stopReason: "requested"`
- The agent can no longer receive inbound Telegram updates; voice messages admitted just before the inconsistency are stuck in `state: "pending"` and are never processed
- The user-recoverable command is `/telegram-connect` (registered in `lib/commands.ts:388`), which re-invokes `startPolling` — but only if the operator happens to issue it

## Affected versions

`lib/journal.ts` is **byte-identical** between `0.28.0` and `0.36.5`:

| Property | `0.28.0` | `0.36.5` |
|---|---|---|
| MD5 of `lib/journal.ts` | `da89d9bdf7b67bdc2d1de0e24dbba053` | `da89d9bdf7b67bdc2d1de0e24dbba053` |
| File size | 100,403 bytes | 100,403 bytes |
| `revision gap` error location | line 1833 | line 1833 |
| `diff --brief` between them | identical | identical |
| Compaction threshold constants | identical | identical |

Tarball sizes differ (90 files in `0.28.0` vs 98 in `0.36.5`), but all 8 additions are UI / skill / generative-apps code paths; `journal.ts` is untouched. **The bug is present in every published version from `0.28.0` through `0.36.5`** (the maintainer's choice of how to backport is their call; the report is filed against the released `latest`).

## Root cause analysis

The relevant code is in `lib/journal.ts`. Two pieces interact badly.

### 1. The compacted snapshot is written before the old segments are deleted (`lib/journal.ts:2014-2040`)

```ts
if (
  segmentCount >= TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT ||
  segmentBytes >= TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_BYTES
) {
  const compacted = serializeJournalFile(revisedFile);
  const compactedBytes = assertCapacity(revisedFile, compacted);
  writeJournalFile(path, compacted, onPublicationBoundary);   // <-- write new inbox.json
  for (const name of segmentNames) {
    if (Number(name.slice(0, 16)) <= revision) {              // <-- delete old segments
      try { unlinkSync(join(segmentDirectory, name)); }
      catch { /* redundant segments are safe and will be ignored */ }
    }
  }
  try { rmdirSync(segmentDirectory); }
  catch {
    // Interrupted cleanup may leave an empty directory or old segments.
  }
  return { file: revisedFile, serializedBytes: compactedBytes };
}
```

Two safety properties of this sequence are missing:

- The new `inbox.json` is published **before** the old segments are deleted. If a concurrent `appendBatch` runs between the snapshot write and the segment deletes, it can read the in-memory state (which has not yet incorporated the new compacted revision), compute its own snapshot, and `writeJournalFile` with the old revision field, **clobbering** the compacted snapshot. The comment about "interrupted cleanup" only considers the inverse case (old segments left behind); the clobbered-snapshot case is the one that actually bit us.
- The order of operations inside the compaction is also wrong: the snapshot is published first, then segments are deleted, then `rmdirSync`. If the process is killed between any two steps, the on-disk state is inconsistent in a way that the load code refuses to repair.

### 2. The load code is strict and has no recovery path (`lib/journal.ts:1785-1872`)

```ts
let revision = file.revision ?? 0;
let unappliedSegmentBytes = 0;
for (const name of segmentNames) {
  const nameRevision = Number(name.slice(0, 16));
  if (nameRevision <= revision) continue;
  // ... parse segment ...
  if (segment.previousRevision !== revision) {
    throw createJournalError(
      "invalid",
      segmentPath,
      `has a revision gap after ${revision}`,
    );
  }
  // ... apply segment ...
  revision = segment.revision;
}
```

`file.revision ?? 0` defaults to `0` when the snapshot is missing the field (which it is, in our case). The first segment in the directory (`257`) declares `previousRevision: 256`, the check fails, and the load throws. The polling loop catches, logs, and (per the recovery in `bindings.ts:485`) gives up. There is no path that:
- detects the inconsistency
- trusts the on-disk segments as the source of truth (which they happen to be, here)
- rebuilds the snapshot from the segments

## Trigger hypothesis (not a confirmed repro)

We were unable to reproduce the race deterministically. The strongest hypothesis is the snapshot-clobber scenario in §1: an `appendBatch` admit ran between the compaction's `writeJournalFile` and its segment deletes, won the rename, and overwrote the new snapshot with the previous in-memory state. The on-disk evidence is consistent with this:

- The current `inbox.json` mtime (`2026-08-19 18:06:57.456308113 -0400`) is **byte-for-byte equal** to the `admittedAtMs` of a voice-message entry inside it (`1787177217456`). The admit wrote the file.
- The same `inbox.json` has no `revision` field — the in-memory state at admit time was the pre-compaction state, not the post-compaction state.
- The bind mount has segments 257-380 with no trace of segments 1-256 (no `.bak`, no `recovery/` orphan).
- `inbox.json.segments/` mtime is `2026-08-18 16:17:35`, well before the failed-polling window — the segment deletes completed; only the snapshot write was clobbered.

This is consistent with a "snapshot clobbered by a concurrent admit" scenario. Other plausible triggers (external `rm`, Docker volume partial restore, OOM-kill at the wrong moment) are not ruled out, but the timing evidence points to the snapshot-clobber race.

## Impact

- Polling permanently broken for the affected agent instance.
- All inbound Telegram messages stuck in the journal as `state: "pending"`.
- The user-facing `/telegram-status` shows `polling.phase: "stopped"`, no clear error to the user beyond the high-frequency log entries.
- No data loss: the segments are intact; the snapshot is the only corrupted artifact.
- Recovery requires either a manual `revision` field injection on the bind mount (see Workaround) or a full container restart that re-seeds the journal — both are out-of-band for a normal operator.

## Workaround

For an affected install where the on-disk segments form a valid chain (i.e., the only problem is the missing `revision` field on the snapshot), injecting the right `revision` value into `inbox.json` lets the load code replay the segments and arrive at a consistent state:

```bash
# Container-side. Assumes segments 257..N are intact and form a valid chain.
TS=$(date +%s)
cp -p inbox.json "inbox.json.bak.${TS}"

node -e '
  const fs = require("node:fs");
  const path = "/home/pi/.pi/agent/tmp/telegram/inbox.json";
  const j = JSON.parse(fs.readFileSync(path, "utf8"));
  if ("revision" in j) { console.log("already has revision:", j.revision); process.exit(1); }
  // Pick the revision that lets the first segment chain correctly.
  // For segments 257..N, the right value is 256 (= first segment.previousRevision - 1).
  j.revision = 256;
  fs.writeFileSync(path, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
  console.log("wrote revision: 256");
'

# Then issue /telegram-connect from Telegram to re-invoke startPolling.
```

This is what unblocked the affected `pi-agent-john` instance today: the file edit cleared the error on the next polling iteration, `/telegram-connect` re-armed the polling loop, and the previously-stuck voice message was processed and replied to. The `inbox.json.bak.<unix-ts>` file is left in place as the safety net.

## Suggested fix directions (not prescriptions)

These are directions the maintainer can pick from; I have not patched any of them. The intent is to make the journal either consistent at all times or self-repairing on load.

### Option A — Reorder the compaction so the snapshot is the LAST write

```ts
// 1. Delete old segments first (still leaves the old snapshot intact, so reads
//    during the delete window just see the pre-compaction state).
for (const name of segmentNames) {
  if (Number(name.slice(0, 16)) <= revision) {
    try { unlinkSync(join(segmentDirectory, name)); } catch { /* idempotent */ }
  }
}
try { rmdirSync(segmentDirectory); } catch { /* idempotent */ }

// 2. THEN write the new snapshot. The new snapshot is the only state on disk
//    that references the new revision, so no concurrent admit can clobber it
//    (an admit that started before the deletes will write a stale snapshot,
//    but that snapshot's revision is still <= the deletes we just performed,
//    so the next load code will correctly skip the already-deleted segments).
writeJournalFile(path, compacted, onPublicationBoundary);
```

This is a minimal change and keeps the existing load semantics. The remaining window where the segments are gone but the snapshot is stale (reverse of the current bug) is benign because the stale snapshot's `revision` is `>=` every segment it ever referenced, and the load code's `if (nameRevision <= revision) continue;` skips them.

### Option B — Use a single atomic rename of a versioned snapshot directory

Snapshot the journal as `inbox.json.v<n>/` with `inbox.json` being a symlink (or a tiny pointer file) that is updated last via `rename(2)`. The current directory-based code already has the right shape; this is mostly a discipline change. Same outcome as A, more invasive.

### Option C — Self-repair on load

When the load code sees a segment with `previousRevision != revision`, fall back to **trusting the segments**: walk them in name order, derive the `revision` from the lowest segment's `previousRevision`, and rebuild. This is the most user-friendly change but also the most invasive (the snapshot's `entries` may diverge from what the segments describe, and the policy for merging them needs a decision). The current strictness is a defensible default for a tamper-evident log; the maintenance burden of manual recovery in the wild is the cost.

### Option D — Document and harden the manual workaround

Accept the race, add a `telegram-doctor` command (or a `--recover` flag on `telegram-connect`) that detects the inconsistency and either auto-rebuilds the snapshot from the segments or refuses with an actionable error message instead of an un-actionable 3-second log loop. The `inbox.json.bak.<ts>` discipline is the one bit of operator knowledge that's missing today.

Any of A + C, or A + D, would have prevented the production impact we hit. The current behavior (strict, no recovery, no in-band detection) is the worst of all worlds from an operator's perspective.

## Diagnostic evidence

For the maintainer's reference, the on-disk state of the affected instance before the workaround was:

- `inbox.json` (1015 bytes): no `revision` field, 1 entry (updateId `525465619`, `state: "pending"`)
- `inbox.json.segments/` (124 files): `0000000000000257.json` through `0000000000000380.json`, no lower-numbered segments
- `0000000000000257.json`: `revision: 257, previousRevision: 256, profile: "default"`, `botIdentity` matches `inbox.json`
- `0000000000000380.json`: `revision: 380, previousRevision: 379, removedUpdateIds: [525465618]`
- `state.json`: `polling.phase: "stopped", stopReason: "requested", lastSuccessfulResponseAtMs: 1787177686775, lockState: "inactive"`
- `logs.jsonl`: ~30 entries of the `phase: "loop"` error, plus one `phase: "polling-start"` recovery entry from `bindings.ts:485`; nothing logged after the recovery failure

---

*Filed by `pi-voice-telegram` maintainer (downstream user). On-disk evidence and the workaround are reproducible from the affected bind mount; the maintainer is welcome to ask for the tarball or the diff against the published tarballs if useful.*
