import {consultationTokens} from './consultation.mjs';

export const memoryTokens=text=>[...new Set(termsOf(text))];
const termsOf=text=>consultationTokens(String(text??'').normalize('NFKC').slice(0,4000));

// Rebuildable connection-local index. Its cursor lives in the same SQLite
// transaction as the postings, so rollback cannot leave the cursor ahead.
export function searchMemoryIndex(db,terms,accept,limit){
  const tokens=memoryTokens(terms.join(' ')).filter(x=>[...x].length>=2).slice(0,32);
  if(!tokens.length)return [];
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.memory_fts USING fts5(tokens);
    CREATE TEMP TABLE IF NOT EXISTS memory_fts_cursor (id INTEGER PRIMARY KEY, position INTEGER NOT NULL);
    INSERT OR IGNORE INTO memory_fts_cursor VALUES(1,0);`);
  const previous=db.prepare('SELECT position FROM memory_fts_cursor WHERE id=1').get().position;
  const refreshed=db.prepare(`SELECT o.rowid AS objectRow,v.rowid AS versionRow,o.type,
      json_extract(v.body,'$.status') AS status,json_extract(v.body,'$.origin') AS origin,
      substr(json_extract(v.body,'$.body'),1,4000) AS body
    FROM versions v JOIN objects o ON o.id=v.id AND o.current_revision=v.revision
    WHERE v.rowid>? AND o.type IN ('event','note','personal_state') AND o.id!='note:slow-watermark' ORDER BY v.rowid`);
  const remove=db.prepare('DELETE FROM memory_fts WHERE rowid=?');
  const insert=db.prepare('INSERT INTO memory_fts(rowid,tokens) VALUES(?,?)');
  let cursor=previous;
  for(const row of refreshed.iterate(previous)){
    remove.run(row.objectRow);
    if(row.body&&(row.type==='event'?['reported','observed'].includes(row.origin):
      row.type==='note'?row.status==='current':row.status==='open'))insert.run(row.objectRow,termsOf(row.body).join(' '));
    cursor=row.versionRow;
  }
  if(cursor!==previous)db.prepare('UPDATE memory_fts_cursor SET position=? WHERE id=1').run(cursor);
  const query=tokens.map(token=>'"'+token.replaceAll('"','""')+'"').join(' OR ');
  const matches=db.prepare(`SELECT o.id,o.current_revision AS revision FROM memory_fts
    JOIN objects o ON o.rowid=memory_fts.rowid WHERE memory_fts MATCH ?
    ORDER BY bm25(memory_fts),o.id`);
  const results=[];
  // Apply audience eligibility before selecting this lane's top candidates.
  for(const {id,revision} of matches.iterate(query)){
    const ref={id,revision};
    if(accept(ref))results.push(ref);
    if(results.length===limit)break;
  }
  return results;
}
