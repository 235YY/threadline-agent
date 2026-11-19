# Storage Lean 003 — Integration Notes

## Dependency

This change is based on the unmerged `JY-MIND-CLEAN-001` branch:

- Base branch: `feat/jy-mind-clean-001`
- Base commit: `d738ee7f0b8cc17eb8140d13ec5d2434f340a24e`
- Target branch for this change: `feat/jy-storage-lean-002`
- Target pull request: based on the `JY-MIND-CLEAN-001` branch, not `main`

Do not merge this branch into `main` before `JY-MIND-CLEAN-001` is merged.

## What changed

- Schema 12 adds the additive `model_packets` table. It stores one gzip-compressed canonical copy of each model packet.
- Decision, review and decision-attempt inputs, plus the affect-turn packet, are stored as `$packetRef` / `$packetMeta` references.
- Reads hydrate the referenced packet transparently. A missing retired packet returns an explicit `packetUnavailable` record instead of silently returning an empty input.
- Terminal affect turns keep only hashes and base references for their preview; active turns still keep the full preview snapshot.
- The store keeps a bounded hot window of recent successful decision packets. Failed, uncertain, quarantined and active execution evidence is protected from retirement.
- Execution-record versions can retire only redundant intermediate `decision_attempt` and `affect_turn` revisions. Memory records such as Event, Note and personal_state are never selected by that pruning path.
- Debug defaults are reduced to 8 MiB of debug-packet storage and 512 debug events. Both are configurable through environment variables and constructor options.
- Schema 11 is not opened silently. A reviewed copy must pass `migrateV11: true`; after migration it is schema 12. Old schema-11 code rejects schema 12 with `REJECTED SCHEMA_VERSION`.

## Migration

Never migrate the live database in place.

1. Stop the service cleanly.
2. Back up the complete database, including any WAL/SHM files, and keep the previous source checkout available for rollback.
3. Copy the database to a separate path.
4. Run the offline migration against the copy only:

   ```text
   node scripts/storage-lean-migrate.mjs <sqlite-copy>
   ```

5. Check the JSON result: `schemaVersion` must be `12`, `integrity` must be `ok`, and `foreignKeyViolations` must be `0`.
6. Start the new code against the migrated copy and verify Event, Note, personal_state, Intent and AgentTask reads, plus one restart.

The migration script refuses schemas other than 11 or 12. It creates the additive `model_packets` table and replaces only the reviewed packet fields inside one transaction. The schema-version change is committed with that same transaction, so a collision or I/O failure leaves the database at schema 11. `VACUUM` runs only after a successful commit.

## Rollback

1. Stop the new process.
2. Restore the pre-migration database backup.
3. Return to the previous source checkout (`d738ee7f...` or the deployment commit).
4. Do not open a schema-12 database with schema-11 code; it is expected to reject it.

## Verification performed

- Full default regression: 912 passed, 0 failed.
- Storage Lean focused suite: 10 passed, 0 failed (commit `880bd5c`).
- Schema 11 explicit-upgrade protection: covered by the focused suite.
- Old reader vs schema 12: rejected with `REJECTED SCHEMA_VERSION`.
- Migrated-copy memory read, object/relation comparison, restart and diagnostic lookup: covered by the frozen acceptance audit.
- Clean clone at `880bd5c`: 912/912 default regression, 10/10 Storage Lean, migration `1,770` rewrites / `846` packets / `87,347,200` bytes, integrity ok, FK 0.
- No real QQ, model call, production database, or live process was touched.

## Revision 4 review fixes

- Retired review stubs are rejected by `#packetize` and `#adoptReview`; review and terminal affect packets are protected from pruning.
- `readReaction` / `readMindTrace` degrade explicitly when a retired decision input is unavailable, instead of throwing `TypeError`.
- `DebugArchive` distinguishes `INPUT_SNAPSHOT_UNAVAILABLE` from `INPUT_INTEGRITY_MISMATCH`, and resolves extension `$recoveryFrom`.
- Debug packet capture evicts the oldest snapshot when the quota is full rather than stopping permanently.
- The migration parser resolves legacy `$recoveryFrom` chains recursively; a missing source is reported as `recovery-missing` and left untouched.
- Current database has zero current affect bodies using `$recoveryFrom`; historical revisions outside the migration path are not rewritten.

## Known limitations

- The object store has no unified provider cost or request-id ledger. Only a subset of affect records contain `resolution.actualMicros`; total provider fees cannot be reconstructed from this database.
- Successful decisions outside the hot window lose their old prompt body; Event, Note and personal_state memory remain readable.
- Historical revision gaps created before this migration are preserved as they were and are not repaired by this change.
