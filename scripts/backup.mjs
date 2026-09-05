// ============================================================================
//  Backup and restore.
//
//  Copying a live SQLite file with `cp` can capture a torn page or miss data
//  still sitting in the WAL, so this uses SQLite's own VACUUM INTO, which writes
//  a consistent snapshot while the server keeps serving. Uploaded files are
//  content-addressed, so they only ever need to be added to, never rewritten.
//
//  Usage:
//    node scripts/backup.mjs create [--out backups] [--files]
//    node scripts/backup.mjs list [--out backups]
//    node scripts/backup.mjs prune --keep 7 [--out backups]
//    node scripts/backup.mjs restore <snapshot.db> [--force]
//    node scripts/backup.mjs verify <snapshot.db>
// ============================================================================
import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';

const [, , command = 'create', ...rest] = process.argv;

const flag = (name, fallback = null) => {
  const index = rest.indexOf(`--${name}`);
  return index === -1 ? fallback : (rest[index + 1] ?? true);
};
const has = (name) => rest.includes(`--${name}`);

// Everything that is neither a flag nor a flag's value. --files and --force are
// booleans, so the argument after them is positional, not their value.
const BOOLEAN_FLAGS = new Set(['--files', '--force']);
const positional = rest.filter((arg, index) => {
  if (arg.startsWith('--')) return false;
  const previous = rest[index - 1];
  return !(previous?.startsWith('--') && !BOOLEAN_FLAGS.has(previous));
});

const DB_PATH = process.env.DB_PATH || './discord.db';
const STORAGE_ROOT = process.env.STORAGE_ROOT || './public/uploads';
const OUT_DIR = flag('out', 'backups');

/** Local time, filename-safe, sorts chronologically. */
function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

const openDb = (file, mode) => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(file, mode, (err) => (err ? reject(err) : resolve(db)));
});

const run = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, (err) => (err ? reject(err) : resolve()));
});

const all = (db, sql) => new Promise((resolve, reject) => {
  db.all(sql, [], (err, rows) => (err ? reject(err) : resolve(rows)));
});

const humanBytes = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

/** Recursive copy that skips files already present — safe to re-run. */
function copyNew(from, to) {
  let copied = 0;
  let skipped = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      const nested = copyNew(source, target);
      copied += nested.copied;
      skipped += nested.skipped;
    } else if (fs.existsSync(target) && fs.statSync(target).size === fs.statSync(source).size) {
      // Content-addressed: same name and size means same bytes.
      skipped += 1;
    } else {
      fs.copyFileSync(source, target);
      copied += 1;
    }
  }
  return { copied, skipped };
}

async function create() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ no database at ${DB_PATH}`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const target = path.resolve(OUT_DIR, `discord-${stamp()}.db`);
  if (fs.existsSync(target)) {
    console.error(`❌ ${target} already exists`);
    process.exit(1);
  }

  // VACUUM INTO takes a consistent snapshot of a live database and compacts it
  // on the way out, so the backup is both safe and smaller than the original.
  const db = await openDb(DB_PATH, sqlite3.OPEN_READONLY);
  try {
    await run(db, `VACUUM INTO ?`, [target]);
  } finally {
    db.close();
  }

  const size = fs.statSync(target).size;
  console.log(`✅ database → ${path.relative(process.cwd(), target)} (${humanBytes(size)})`);

  if (has('files')) {
    if (!fs.existsSync(STORAGE_ROOT)) {
      console.warn(`⚠️  no storage directory at ${STORAGE_ROOT} — skipping files`);
    } else {
      const filesTarget = path.resolve(OUT_DIR, 'uploads');
      fs.mkdirSync(filesTarget, { recursive: true });
      const { copied, skipped } = copyNew(STORAGE_ROOT, filesTarget);
      console.log(`✅ files    → ${path.relative(process.cwd(), filesTarget)} `
        + `(${copied} new, ${skipped} already present)`);
    }
  } else {
    console.log('ℹ️  uploaded files not included — pass --files to copy them too.');
  }
}

function snapshots() {
  if (!fs.existsSync(OUT_DIR)) return [];
  return fs.readdirSync(OUT_DIR)
    .filter((name) => /^discord-\d{8}-\d{6}\.db$/.test(name))
    .sort()
    .map((name) => {
      const full = path.join(OUT_DIR, name);
      return { name, full, size: fs.statSync(full).size, mtime: fs.statSync(full).mtime };
    });
}

function list() {
  const found = snapshots();
  if (found.length === 0) {
    console.log(`no snapshots in ${OUT_DIR}`);
    return;
  }
  console.log(`\n${found.length} snapshot(s) in ${OUT_DIR}:\n`);
  for (const entry of found) {
    console.log(`   ${entry.name}  ${humanBytes(entry.size).padStart(9)}  ${entry.mtime.toISOString()}`);
  }
  console.log('');
}

function prune() {
  const keep = Number(flag('keep', 7));
  const found = snapshots();
  const doomed = found.slice(0, Math.max(0, found.length - keep));
  if (doomed.length === 0) {
    console.log(`nothing to prune — ${found.length} snapshot(s), keeping ${keep}.`);
    return;
  }
  for (const entry of doomed) {
    fs.unlinkSync(entry.full);
    console.log(`🗑️  removed ${entry.name}`);
  }
  console.log(`kept ${found.length - doomed.length} of ${found.length}.`);
}

/** Integrity check plus a row count, so a corrupt or truncated file is caught. */
async function verify(file) {
  if (!file || !fs.existsSync(file)) {
    console.error('❌ pass the path to a snapshot');
    process.exit(1);
  }
  // Read-write, not read-only: validating an FTS5 inverted index needs a
  // writable handle, and on a read-only one integrity_check reports a failure
  // that is really just a permission problem.
  const db = await openDb(file, sqlite3.OPEN_READWRITE);
  try {
    const [{ integrity_check: result }] = await all(db, 'PRAGMA integrity_check');
    const tables = await all(db,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    const [{ n: users }] = await all(db, 'SELECT COUNT(*) AS n FROM users');
    const [{ n: messages }] = await all(db, 'SELECT COUNT(*) AS n FROM messages');

    console.log(`\n   integrity_check : ${result}`);
    console.log(`   tables          : ${tables.length}`);
    console.log(`   users           : ${users}`);
    console.log(`   messages        : ${messages}\n`);
    if (result !== 'ok') process.exit(1);
    console.log('✅ snapshot is readable and consistent.\n');
  } finally {
    db.close();
  }
}

async function restore(file) {
  if (!file || !fs.existsSync(file)) {
    console.error('❌ pass the path to a snapshot');
    process.exit(1);
  }
  if (!has('force')) {
    console.error(
      `\nThis will overwrite ${DB_PATH} with ${file}.\n`
      + 'Stop the server first — restoring under a running process leaves it holding\n'
      + 'a stale WAL. Re-run with --force when the server is down.\n'
    );
    process.exit(1);
  }

  await verify(file);

  // Keep the current database rather than destroying it: a restore is exactly
  // when you most want the ability to change your mind.
  if (fs.existsSync(DB_PATH)) {
    const aside = `${DB_PATH}.replaced-${stamp()}`;
    fs.renameSync(DB_PATH, aside);
    console.log(`ℹ️  previous database kept at ${aside}`);
  }
  // The WAL and shm belong to the old database and must not survive it.
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(DB_PATH + suffix)) fs.unlinkSync(DB_PATH + suffix);
  }

  fs.copyFileSync(file, DB_PATH);
  console.log(`✅ restored ${file} → ${DB_PATH}`);
  console.log('   Start the server; migrations run automatically on connect.');
}

const commands = {
  create,
  list: async () => list(),
  prune: async () => prune(),
  verify: () => verify(positional[0]),
  restore: () => restore(positional[0])
};

if (!commands[command]) {
  console.error(`unknown command "${command}". Use: create | list | prune | verify | restore`);
  process.exit(1);
}

commands[command]().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
