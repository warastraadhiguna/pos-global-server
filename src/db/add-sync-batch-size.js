// Migrasi INKREMENTAL, AMAN dijalankan di database yang sudah berisi data
// sungguhan — cuma ALTER TABLE ADD COLUMN (dicek dulu blm ada), tidak ada
// DROP/TRUNCATE/DELETE apa pun. Idempotent — aman dijalankan berkali-kali.
//
// Fitur: batching sync (lihat server/docs/SYNC_BATCHING.md) — sync_settings
// sebelumnya cuma enabled/interval_minutes, sekarang tambah batch_size:
// jumlah MAKS baris per tabel (sales, sales_returns masing-masing) yang
// dikirim dalam SATU batch/tick scheduler. Default 200.
//
// Usage: node src/db/add-sync-batch-size.js
require('dotenv').config();
const pool = require('../config/db');

async function columnExists(conn, table, column) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return row.cnt > 0;
}

async function addColumnIfMissing(conn, table, column, definition) {
  if (await columnExists(conn, table, column)) {
    console.log(`  ${table}.${column} sudah ada, lewati`);
    return;
  }
  await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`  ${table}.${column} ditambahkan`);
}

async function run() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    console.log('Menambah kolom batch_size ke sync_settings...');
    await addColumnIfMissing(conn, 'sync_settings', 'batch_size', 'INT NOT NULL DEFAULT 200');

    await conn.commit();
    console.log('\nSelesai — tidak ada data lain yang tersentuh/terhapus.');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('Migrasi gagal:', err);
  process.exit(1);
});
