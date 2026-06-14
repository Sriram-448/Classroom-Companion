const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/classroom.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let _rawDb = null;

function save() {
  if (!_rawDb) return;
  const data = _rawDb.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function makePrepared(sql) {
  return {
    run(...args) {
      const params = (args.length === 1 && Array.isArray(args[0])) ? args[0] : args;
      const stmt = _rawDb.prepare(sql);
      stmt.run(params.length ? params : []);
      stmt.free();
      save();
    },
    get(...args) {
      const params = (args.length === 1 && Array.isArray(args[0])) ? args[0] : args;
      const stmt = _rawDb.prepare(sql);
      if (params.length) stmt.bind(params);
      let row = undefined;
      if (stmt.step()) row = stmt.getAsObject();
      stmt.free();
      return row;
    },
    all(...args) {
      const params = (args.length === 1 && Array.isArray(args[0])) ? args[0] : args;
      const stmt = _rawDb.prepare(sql);
      if (params.length) stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    }
  };
}

const dbShim = {
  prepare: (sql) => makePrepared(sql)
};

async function initializeDatabase() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    _rawDb = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    _rawDb = new SQL.Database();
  }

  const tables = [
    `CREATE TABLE IF NOT EXISTS schools (id TEXT PRIMARY KEY, name TEXT NOT NULL, invite_code TEXT UNIQUE NOT NULL, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, telegram_id TEXT UNIQUE, telegram_handle TEXT, name TEXT NOT NULL, role TEXT NOT NULL, school_id TEXT NOT NULL, is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS classes (id TEXT PRIMARY KEY, school_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS teacher_classes (teacher_id TEXT NOT NULL, class_id TEXT NOT NULL, PRIMARY KEY (teacher_id, class_id))`,
    `CREATE TABLE IF NOT EXISTS student_classes (student_id TEXT NOT NULL, class_id TEXT NOT NULL, PRIMARY KEY (student_id, class_id))`,
    `CREATE TABLE IF NOT EXISTS invite_codes (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, school_id TEXT NOT NULL, class_id TEXT, role TEXT NOT NULL, created_by TEXT NOT NULL, max_uses INTEGER DEFAULT 1, use_count INTEGER DEFAULT 0, expires_at TEXT, is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, school_id TEXT NOT NULL, class_id TEXT NOT NULL, teacher_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, raw_input TEXT, due_at TEXT, timezone TEXT DEFAULT 'UTC', target_type TEXT DEFAULT 'class', status TEXT DEFAULT 'assigned', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS student_assignments (id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, student_id TEXT NOT NULL, status TEXT DEFAULT 'assigned', last_student_message TEXT, submitted_at TEXT, submission_text TEXT, submission_file_path TEXT, submission_file_name TEXT, completed_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, student_assignment_id TEXT NOT NULL, teacher_id TEXT NOT NULL, content TEXT NOT NULL, sent_via_telegram INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, student_assignment_id TEXT NOT NULL, reminder_type TEXT NOT NULL, message TEXT NOT NULL, sent_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS message_log (id TEXT PRIMARY KEY, telegram_update_id TEXT UNIQUE, user_id TEXT, telegram_id TEXT, direction TEXT, content TEXT, message_type TEXT DEFAULT 'text', created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS pending_links (telegram_id TEXT PRIMARY KEY, invite_code TEXT, created_at TEXT DEFAULT (datetime('now')))`
  ];

  for (const sql of tables) {
    try { _rawDb.run(sql); } catch(e) {}
  }
  save();
  console.log('Database initialized');
  return dbShim;
}

function getDb() {
  if (!_rawDb) throw new Error('DB not ready - call initializeDatabase() first');
  return dbShim;
}

module.exports = { initializeDatabase, getDb, save };