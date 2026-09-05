#!/usr/bin/env node
// Storage maintenance CLI.
//
//   node scripts/storage.js stats
//   node scripts/storage.js gc [--apply] [--grace-hours 24]
//   node scripts/storage.js verify
//   node scripts/storage.js reindex        # rebuild the message search index

import { initDB, closeDB, allQuery, getQuery, runQuery } from '../db.js';
import {
  initStorage, collectGarbage, verifyIntegrity, formatBytes, STORAGE_ROOT
} from '../storageService.js';

const [command = 'stats', ...args] = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

await initDB({ seed: false });
await initStorage();

try {
  switch (command) {
    case 'stats': await stats(); break;
    case 'gc': await gc(); break;
    case 'verify': await verify(); break;
    case 'reindex': await reindex(); break;
    default:
      console.error(`Unknown command '${command}'. Try: stats | gc | verify | reindex`);
      process.exitCode = 1;
  }
} finally {
  await closeDB();
}

async function stats() {
  const total = await getQuery(
    `SELECT count(*) AS files, COALESCE(sum(size), 0) AS bytes
       FROM files WHERE deleted_at IS NULL`
  );
  const variants = await getQuery(
    `SELECT count(*) AS files, COALESCE(sum(size), 0) AS bytes FROM file_variants`
  );
  const byCategory = await allQuery(
    `SELECT category, count(*) AS files, COALESCE(sum(size), 0) AS bytes
       FROM files WHERE deleted_at IS NULL GROUP BY category ORDER BY bytes DESC`
  );
  const orphans = await getQuery(
    `SELECT count(*) AS files, COALESCE(sum(size), 0) AS bytes
       FROM files WHERE deleted_at IS NULL AND ref_count = 0`
  );
  const softDeleted = await getQuery(
    `SELECT count(*) AS files, COALESCE(sum(size), 0) AS bytes
       FROM files WHERE deleted_at IS NOT NULL`
  );
  const dedupe = await getQuery(
    `SELECT count(*) AS unique_hashes FROM (SELECT DISTINCT hash FROM files WHERE deleted_at IS NULL)`
  );

  console.log(`\nStorage root: ${STORAGE_ROOT}\n`);
  console.log(`Originals      ${String(total.files).padStart(6)} files  ${formatBytes(total.bytes)}`);
  console.log(`Variants       ${String(variants.files).padStart(6)} files  ${formatBytes(variants.bytes)}`);
  console.log(`Unique hashes  ${String(dedupe.unique_hashes).padStart(6)}`);
  console.log(`Unreferenced   ${String(orphans.files).padStart(6)} files  ${formatBytes(orphans.bytes)}`);
  console.log(`Soft-deleted   ${String(softDeleted.files).padStart(6)} files  ${formatBytes(softDeleted.bytes)}`);
  console.log('\nBy category');
  for (const row of byCategory) {
    console.log(`  ${row.category.padEnd(14)} ${String(row.files).padStart(5)} files  ${formatBytes(row.bytes)}`);
  }

  const topUsers = await allQuery(
    `SELECT u.display_name, u.storage_used, u.storage_quota
       FROM users u WHERE u.storage_used > 0
      ORDER BY u.storage_used DESC LIMIT 10`
  );
  if (topUsers.length) {
    console.log('\nTop consumers');
    for (const u of topUsers) {
      console.log(`  ${u.display_name.padEnd(20)} ${formatBytes(u.storage_used)} / ${formatBytes(u.storage_quota)}`);
    }
  }
  console.log();
}

async function gc() {
  const dryRun = !flag('apply');
  const graceHours = Number(value('grace-hours', 24));
  const result = await collectGarbage({
    dryRun, orphanGraceMs: graceHours * 3600 * 1000, limit: Number(value('limit', 5000))
  });
  console.log(JSON.stringify({
    ...result,
    bytes_freed_human: formatBytes(result.bytesFreed),
    would_free_human: formatBytes(result.wouldFreeBytes)
  }, null, 2));
  if (dryRun) console.log('\nDry run — pass --apply to actually delete.');
}

async function verify() {
  const result = await verifyIntegrity();
  console.log(`Registered files: ${result.totalFiles}`);
  console.log(`Missing bytes:    ${result.missingBytes.length}`);
  for (const f of result.missingBytes.slice(0, 20)) console.log(`  ! ${f.id} → ${f.storage_key}`);
  console.log(`Orphan objects:   ${result.orphanObjects.length}`);
  for (const key of result.orphanObjects.slice(0, 20)) console.log(`  ? ${key}`);
}

async function reindex() {
  await runQuery(`DELETE FROM messages_fts`);
  await runQuery(
    `INSERT INTO messages_fts (content, message_id, channel_id)
     SELECT content, id, channel_id FROM messages
      WHERE deleted_at IS NULL AND content IS NOT NULL AND content != ''`
  );
  const { c } = await getQuery(`SELECT count(*) AS c FROM messages_fts`);
  console.log(`Search index rebuilt: ${c} messages.`);
}
