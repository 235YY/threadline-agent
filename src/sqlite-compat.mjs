// Driver-level probing only. Studio, Brain and the default test suite require Node >=26.8; see runtime-config.mjs.
// - Node >= 22.5: uses built-in `node:sqlite` (zero external dependencies).
// - Node 18 / 20: detects optional fallback drivers (`better-sqlite3` or pure-WASM `sql.js`)
//   or reports structured upgrade options (portable Node 26 / lightweight WASM SQLite).
import {existsSync, readFileSync, writeFileSync} from 'node:fs';

export function parseNodeVersion(version = process.versions.node) {
  const [major = 0, minor = 0, patch = 0] = String(version).replace(/^v/i, '').split('.').map(n => Number.parseInt(n, 10) || 0);
  return {raw: String(version), major, minor, patch};
}

export function supportsNativeSqlite(version = process.versions.node) {
  const v = parseNodeVersion(version);
  return v.major > 22 || (v.major === 22 && v.minor >= 5);
}

let cachedDriver = null;

function createSqlJsDatabaseClass(SQL) {
  return class SqlJsDatabaseCompat {
    #db;
    #path;
    #closed = false;
    constructor(filePath) {
      this.#path = filePath;
      const bytes = filePath && filePath !== ':memory:' && existsSync(filePath) ? readFileSync(filePath) : null;
      this.#db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    }
    #persist() {
      if (this.#path && this.#path !== ':memory:') {
        writeFileSync(this.#path, Buffer.from(this.#db.export()));
      }
    }
    exec(sql) {
      this.#db.run(sql);
      if (/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|COMMIT|VACUUM)\b/i.test(sql)) this.#persist();
    }
    prepare(sql) {
      const db = this.#db;
      const persist = () => this.#persist();
      const isWrite = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA)/i.test(sql);
      return {
        run(...params) {
          const stmt = db.prepare(sql);
          try {
            stmt.bind(params);
            while (stmt.step()) { /* drain */ }
            if (isWrite) persist();
            return {changes: db.getRowsModified()};
          } finally {
            stmt.free();
          }
        },
        get(...params) {
          const stmt = db.prepare(sql);
          try {
            stmt.bind(params);
            return stmt.step() ? stmt.getAsObject() : undefined;
          } finally {
            stmt.free();
          }
        },
        all(...params) {
          const stmt = db.prepare(sql);
          const rows = [];
          try {
            stmt.bind(params);
            while (stmt.step()) rows.push(stmt.getAsObject());
            return rows;
          } finally {
            stmt.free();
          }
        },
      };
    }
    close() {
      if (!this.#closed) {
        this.#persist();
        this.#db.close();
        this.#closed = true;
      }
    }
  };
}

export async function resolveSqliteDriver() {
  if (cachedDriver) return cachedDriver;
  const node = parseNodeVersion();
  if (supportsNativeSqlite(node.raw)) {
    try {
      const mod = await import('node:sqlite');
      const Database = mod.Database ?? mod.DatabaseSync;
      if (Database) {
        cachedDriver = {kind: 'node:sqlite', native: true, node, Database};
        return cachedDriver;
      }
    } catch { /* fall through to optional adapters */ }
  }
  try {
    const mod = await import('better-sqlite3');
    const Better = mod.default ?? mod;
    if (Better) {
      cachedDriver = {kind: 'better-sqlite3', native: false, node, Database: Better};
      return cachedDriver;
    }
  } catch { /* optional */ }
  try {
    const mod = await import('sql.js');
    const initSqlJs = mod.default ?? mod;
    if (typeof initSqlJs === 'function') {
      const SQL = await initSqlJs();
      cachedDriver = {kind: 'sql.js', native: false, node, Database: createSqlJsDatabaseClass(SQL)};
      return cachedDriver;
    }
  } catch { /* optional */ }

  return {
    kind: 'unavailable',
    native: false,
    node,
    Database: null,
    upgradeOptions: [
      {
        id: 'portable-node',
        recommended: true,
        label: '一键下载便携版 Node.js 26（推荐，满血零折腾）',
        detail: '独立解压到软件目录内，不影响电脑原有 Node 环境。',
      },
      {
        id: 'wasm-sqlite',
        recommended: false,
        label: '继续使用本机旧版 Node + 补装轻量 WASM SQLite（sql.js）',
        detail: '无需编译工具，在 Node 18/20 上直接运行。',
      },
    ],
  };
}

export async function inspectSqliteEnvironment() {
  const driver = await resolveSqliteDriver();
  return {
    nodeVersion: driver.node.raw,
    nodeMajor: driver.node.major,
    nodeMinor: driver.node.minor,
    nativeSupported: supportsNativeSqlite(driver.node.raw),
    activeDriver: driver.kind,
    ready: Boolean(driver.Database),
    upgradeOptions: driver.upgradeOptions ?? [],
  };
}
