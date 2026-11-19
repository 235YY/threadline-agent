export const APPLICATION_ID = 0x4a594331;
// Guard derived graph indexes and query semantics as well as mind and attention contracts.
export const SCHEMA_VERSION = 12;
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS objects (
  id TEXT PRIMARY KEY, type TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK(current_revision > 0)
) STRICT;
CREATE TABLE IF NOT EXISTS versions (
  id TEXT NOT NULL REFERENCES objects(id), revision INTEGER NOT NULL,
  body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(id, revision)
) STRICT;
CREATE TABLE IF NOT EXISTS event_sources (
  system TEXT NOT NULL, source_key TEXT NOT NULL, id TEXT NOT NULL REFERENCES objects(id),
  PRIMARY KEY(system, source_key), UNIQUE(id)
) STRICT;
CREATE TABLE IF NOT EXISTS operations (
  request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
  result TEXT NOT NULL CHECK(json_valid(result))
) STRICT;
CREATE TABLE IF NOT EXISTS uses (
  memory_id TEXT NOT NULL REFERENCES objects(id), encounter_id TEXT NOT NULL REFERENCES objects(id),
  revision INTEGER NOT NULL, used_at INTEGER NOT NULL, reason TEXT NOT NULL,
  PRIMARY KEY(memory_id, encounter_id)
) STRICT;
CREATE INDEX IF NOT EXISTS objects_by_type ON objects(type, id);
-- Lookup indexes over record bodies. Pure query acceleration: no record or contract changes,
-- created on open for existing files, ignored by older readers.
CREATE INDEX IF NOT EXISTS versions_by_scene_time ON versions(json_extract(body,'$.scene'),coalesce(json_extract(body,'$.occurredAt'),json_extract(body,'$.recordedAt'))) WHERE json_extract(body,'$.scene') IS NOT NULL;
CREATE INDEX IF NOT EXISTS versions_by_sender_time ON versions(json_extract(body,'$.sender.id'),coalesce(json_extract(body,'$.occurredAt'),json_extract(body,'$.recordedAt'))) WHERE json_extract(body,'$.sender.id') IS NOT NULL;
CREATE INDEX IF NOT EXISTS versions_by_thread ON versions(json_extract(body,'$.threadId')) WHERE json_extract(body,'$.threadId') IS NOT NULL;
CREATE INDEX IF NOT EXISTS versions_by_current_event ON versions(json_extract(body,'$.currentEvent.id')) WHERE json_extract(body,'$.currentEvent.id') IS NOT NULL;
CREATE INDEX IF NOT EXISTS versions_by_receipt ON versions(json_extract(body,'$.receipt.id')) WHERE json_extract(body,'$.receipt.id') IS NOT NULL;
CREATE INDEX IF NOT EXISTS versions_by_state_type ON versions(json_extract(body,'$.stateType'),json_extract(body,'$.owner')) WHERE json_extract(body,'$.stateType') IS NOT NULL;
CREATE INDEX IF NOT EXISTS versions_by_link_process ON versions(json_extract(body,'$.value.processId')) WHERE json_extract(body,'$.value.processId') IS NOT NULL;
CREATE TABLE IF NOT EXISTS subject_inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id TEXT NOT NULL REFERENCES objects(id), event_id TEXT NOT NULL REFERENCES objects(id),
  status TEXT NOT NULL CHECK(status IN ('received','handled','deferred')),
  decision_id TEXT REFERENCES objects(id), updated_at INTEGER NOT NULL,
  UNIQUE(subject_id,event_id)
) STRICT;
CREATE INDEX IF NOT EXISTS subject_inbox_pending ON subject_inbox(subject_id,status,seq);
CREATE TABLE IF NOT EXISTS maintenance_seen (
  subject_id TEXT NOT NULL REFERENCES objects(id), event_id TEXT NOT NULL REFERENCES objects(id),
  job_id TEXT NOT NULL REFERENCES objects(id), reviewed_at INTEGER NOT NULL,
  PRIMARY KEY(subject_id,event_id)
) STRICT;
CREATE TABLE IF NOT EXISTS graph_nodes (
  node_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, owner_revision INTEGER NOT NULL,
  node_type TEXT NOT NULL, subject_id TEXT,
  descriptor TEXT NOT NULL CHECK(json_valid(descriptor)),
  FOREIGN KEY(owner_id,owner_revision) REFERENCES versions(id,revision)
) STRICT;
CREATE INDEX IF NOT EXISTS graph_nodes_by_type ON graph_nodes(node_type,subject_id,node_key);
CREATE INDEX IF NOT EXISTS graph_nodes_by_owner ON graph_nodes(owner_id,owner_revision);
CREATE TABLE IF NOT EXISTS graph_tags (
  node_key TEXT NOT NULL REFERENCES graph_nodes(node_key) ON DELETE CASCADE,
  tag TEXT NOT NULL, PRIMARY KEY(node_key,tag)
) STRICT;
CREATE INDEX IF NOT EXISTS graph_tags_lookup ON graph_tags(tag,node_key);
CREATE TABLE IF NOT EXISTS graph_edges (
  edge_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, owner_revision INTEGER NOT NULL,
  source_key TEXT NOT NULL, target_key TEXT NOT NULL, subject_id TEXT,
  body TEXT NOT NULL CHECK(json_valid(body)),
  FOREIGN KEY(owner_id,owner_revision) REFERENCES versions(id,revision)
) STRICT;
CREATE INDEX IF NOT EXISTS graph_edges_out ON graph_edges(source_key,owner_id,owner_revision);
CREATE INDEX IF NOT EXISTS graph_edges_in ON graph_edges(target_key,owner_id,owner_revision);
CREATE TABLE IF NOT EXISTS graph_meta (
  id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL
) STRICT;
INSERT OR IGNORE INTO graph_meta(id,epoch) VALUES(1,0);
CREATE TABLE IF NOT EXISTS debug_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL,
  subject_id TEXT, decision_id TEXT, packet_id TEXT, job_id TEXT,
  entry TEXT NOT NULL CHECK(json_valid(entry))
) STRICT;
CREATE INDEX IF NOT EXISTS debug_by_subject ON debug_events(subject_id,seq);
CREATE INDEX IF NOT EXISTS debug_by_decision ON debug_events(decision_id,seq);
CREATE INDEX IF NOT EXISTS debug_by_packet ON debug_events(packet_id,seq);
CREATE TABLE IF NOT EXISTS debug_packets (
  packet_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
  at INTEGER NOT NULL, body_bytes INTEGER NOT NULL,
  body TEXT NOT NULL CHECK(json_valid(body))
) STRICT;
-- One compressed canonical copy of a model packet. Records refer to it by
-- packetId; old full-field versions remain readable without this table.
CREATE TABLE IF NOT EXISTS model_packets (
  packet_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
  at INTEGER NOT NULL, body_bytes INTEGER NOT NULL,
  compressed_bytes INTEGER NOT NULL, body BLOB NOT NULL
) STRICT;
PRAGMA user_version = ${SCHEMA_VERSION};
PRAGMA application_id = ${APPLICATION_ID};
`;
