const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "index.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS pages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT UNIQUE NOT NULL,
    title       TEXT DEFAULT '',
    description TEXT DEFAULT '',
    content     TEXT DEFAULT '',
    domain      TEXT DEFAULT '',
    last_crawled DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Full-text search index (SQLite FTS5)
  CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    title, description, content,
    content='pages',
    content_rowid='id'
  );

  -- Keep FTS in sync with pages table
  CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
    INSERT INTO pages_fts(rowid, title, description, content)
    VALUES (new.id, new.title, new.description, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title, description, content)
    VALUES ('delete', old.id, old.title, old.description, old.content);
    INSERT INTO pages_fts(rowid, title, description, content)
    VALUES (new.id, new.title, new.description, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title, description, content)
    VALUES ('delete', old.id, old.title, old.description, old.content);
  END;

  -- Crawl queue
  CREATE TABLE IF NOT EXISTS crawl_queue (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    url   TEXT UNIQUE NOT NULL,
    depth INTEGER DEFAULT 0
  );

  -- Seed URLs (starting points for the crawler)
  CREATE TABLE IF NOT EXISTS seeds (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    url   TEXT UNIQUE NOT NULL,
    added DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = db;
