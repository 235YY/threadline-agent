#!/usr/bin/env node
// Offline migration for JY-STORAGE-LEAN-001. Operates only on the database
// path given on the command line; never opens the live service.
import {DatabaseSync} from 'node:sqlite';
import {gzipSync} from 'node:zlib';
import {canonical, digest} from '../src/contracts.mjs';
import {SCHEMA} from '../src/schema.mjs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/storage-lean-migrate.mjs <sqlite-copy>');
  process.exit(2);
}

const db = new DatabaseSync(path);
const version = db.prepare('PRAGMA user_version').get().user_version;
if (![11, 12].includes(version)) throw new Error(`UNSUPPORTED_SCHEMA ${version}; expected 11 or 12`);
const PACKET = /^[a-f0-9]{64}$/;
const FIELDS = {
  decision: ['input'],
  review: ['input'],
  decision_attempt: ['input'],
  affect_turn: ['packet']
};
const TERMINAL_AFFECT = status => !['prepared', 'dispatched', 'captured'].includes(status);

function packetMeta(packet, {bytes, fingerprint} = {}) {
  const payload = packet.payload ?? {}, continuity = payload.continuity ?? {};
  const compact = value => {
    if (value == null) return null;
    const encoded = canonical(value);
    if (Buffer.byteLength(encoded) <= 4096) return value;
    return {id: value.id ?? null, type: value.type ?? null, revision: value.revision ?? null,
      scene: value.scene ?? null, ref: value.ref ?? null, summary: value.summary ?? null,
      compact: true, bytes: Buffer.byteLength(encoded)};
  };
  return {packetId: packet.packetId, stage: packet.stage ?? null,
    bytes: bytes ?? Buffer.byteLength(canonical(packet)),
    fingerprint: fingerprint ?? digest(canonical(packet)),
    instructionHash: packet.instruction ? digest(packet.instruction) : null,
    messageHash: Array.isArray(packet.messages) ? digest(canonical(packet.messages)) : null,
    current: compact(payload.current), workspace: compact(payload.workspace),
    subject: continuity.subject ?? null, algorithmV011: payload.algorithmV011 ?? null,
    format: payload.format ?? null};
}

function putPacket(packet, at) {
  const body = canonical(packet), bytes = Buffer.byteLength(body), fingerprint = digest(body);
  const old = db.prepare('SELECT fingerprint FROM model_packets WHERE packet_id=?').get(packet.packetId);
  if (old) {
    if (old.fingerprint !== fingerprint) throw new Error(`MODEL_PACKET_COLLISION ${packet.packetId}`);
  } else {
    const compressed = gzipSync(Buffer.from(body, 'utf8'), {level: 6});
    db.prepare('INSERT INTO model_packets(packet_id,fingerprint,at,body_bytes,compressed_bytes,body) VALUES(?,?,?,?,?,?)')
      .run(packet.packetId, fingerprint, at, bytes, compressed.byteLength, compressed);
  }
  return packetMeta(packet, {bytes, fingerprint});
}

function resolveRecovery(record, id, seen) {
  if (!record.$recoveryFrom) return true;
  const holder = record.type === 'extension_record' ? record.value : record;
  if (!holder || typeof holder !== 'object') return false;
  const resolved = {};
  for (const [field, rev] of Object.entries(record.$recoveryFrom)) {
    const key = `${id}@${rev}`;
    if (seen.has(key)) return false;
    const saved = db.prepare('SELECT body FROM versions WHERE id=? AND revision=?').get(id, rev);
    if (!saved) return false;
    const source = JSON.parse(saved.body);
    if (!resolveRecovery(source, id, new Set(seen).add(key))) return false;
    const sourceHolder = source.type === 'extension_record' ? source.value : source;
    if (!sourceHolder || !Object.hasOwn(sourceHolder, field)) return false;
    resolved[field] = sourceHolder[field];
  }
  Object.assign(holder, resolved);
  delete record.$recoveryFrom;
  return true;
}

function migrateBody(row) {
  const record = JSON.parse(row.body);
  const hadRecovery = !!record.$recoveryFrom;
  if (hadRecovery && !resolveRecovery(record, row.id, new Set([`${row.id}@${row.revision}`]))) {
    throw new Error(`MIGRATION_RECOVERY_MISSING ${row.id}@${row.revision}`);
  }
  const holder = record.type === 'extension_record' ? record.value : record;
  if (!holder || typeof holder !== 'object') return {changed: false};
  let changed = hadRecovery;
  const at = Number.isSafeInteger(record.recordedAt) ? record.recordedAt : Date.now();
  for (const field of FIELDS[record.type] ?? []) {
    const value = holder[field];
    if (!value || typeof value !== 'object' || value.$packetRef) continue;
    if (!PACKET.test(value.packetId ?? '')) continue;
    holder[field] = {$packetRef: value.packetId, $packetMeta: putPacket(value, at)};
    changed = true;
  }
  if (record.type === 'affect_turn' && holder.preview && TERMINAL_AFFECT(holder.status)) {
    const preview = holder.preview;
    if (preview.snapshot && !preview.$packetRef) {
      holder.preview = {baseRef: preview.baseRef ?? null, baseHash: preview.baseHash ?? null,
        previewHash: preview.previewHash ?? digest(canonical(preview.snapshot)),
        snapshotHash: preview.snapshotHash ?? digest(canonical(preview.snapshot)), compact: true};
      changed = true;
    }
  }
  return {changed, body: changed ? canonical(record) : null};
}

db.exec('PRAGMA foreign_keys=ON');
const rows = db.prepare(`SELECT o.type AS type,o.id AS id,v.revision AS revision,v.body AS body
  FROM objects o JOIN versions v ON v.id=o.id AND v.revision=o.current_revision
  WHERE o.type IN ('decision','review','decision_attempt','affect_turn','extension_record')`).all();
let changed = 0, packets = 0, skipped = 0;
const update = db.prepare('UPDATE versions SET body=? WHERE id=? AND revision=?');
// Keep both the additive table and PRAGMA user_version inside this transaction.
// A collision or I/O failure must leave the source at schema 11, not a
// half-migrated database that looks like schema 12 to the new reader.
db.exec('BEGIN IMMEDIATE');
try {
  db.exec(SCHEMA);
  for (const row of rows) {
    const result = migrateBody(row);
    if (result.changed) {
      update.run(result.body, row.id, row.revision);
      changed++;
    } else if (result.reason) skipped++;
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
packets = db.prepare('SELECT count(*) AS n FROM model_packets').get().n;
db.exec('VACUUM');
const integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
const fk = db.prepare('PRAGMA foreign_key_check').all().length;
console.log(JSON.stringify({path, schemaVersion: db.prepare('PRAGMA user_version').get().user_version, changed, skipped, packets, bytes: db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size, integrity, foreignKeyViolations: fk}, null, 2));
db.close();
