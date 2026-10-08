// Migrasi INKREMENTAL, AMAN dijalankan di database yang sudah berisi data
// sungguhan — cuma ALTER TABLE ADD COLUMN (dicek dulu blm ada), tidak ada
// DROP/TRUNCATE/DELETE apa pun. Idempotent — aman dijalankan berkali-kali.
//
// Fitur: identitas sync untuk Retur Penjualan (lihat server/docs/
// SYNC_STATUS_RESET_AUDIT.md Bagian 4) — sales_returns/sales_return_items
// dulu luput ditambahi sync_status saat tabelnya dibuat (lihat
// BRANCH_IDENTITY_AUDIT.md 1.0). Keputusan: retur penjualan masuk Lapis 1
// sync (omzet pusat harus bersih dari retur, bukan gross).
//
// TIDAK perlu logika reset (markDirtyForSync) untuk tabel ini — dicek
// eksplisit, sales_returns create-only, tidak ada jalur UPDATE sama
// sekali di seluruh codebase. Default 'local_only' saat INSERT sudah
// cukup, beda dari sales/purchases/dll yang punya jalur void/edit.
//
// Usage: node src/db/add-sales-returns-sync-status.js
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

    console.log('Menambah kolom sync_status ke sales_returns & sales_return_items...');
    await addColumnIfMissing(conn, 'sales_returns', 'sync_status', `VARCHAR(20) NOT NULL DEFAULT 'local_only'`);
    await addColumnIfMissing(conn, 'sales_return_items', 'sync_status', `VARCHAR(20) NOT NULL DEFAULT 'local_only'`);

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
