// Migrasi INKREMENTAL, AMAN dijalankan di database yang sudah berisi data
// sungguhan — cuma ALTER TABLE ADD COLUMN (dicek dulu blm ada), tidak ada
// DROP/TRUNCATE/DELETE apa pun. Idempotent — aman dijalankan berkali-kali.
//
// Fitur: Void Pemakaian Internal — sebelumnya dokumen ini TIDAK BISA
// dibatalkan sama sekali (lihat catatan lama di InternalStockUsageService.js).
// Void di sini HANYA boleh dipakai superadmin (requireRole('superadmin')
// literal di route, BUKAN lewat permission catalog biasa — sengaja tidak
// bisa didelegasikan ke role lain lewat Kelola Role), karena membalik
// stok+jurnal yang sudah mempengaruhi Laba Rugi.
//
// Usage: node src/db/add-internal-stock-usage-void.js
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

    console.log('Menambah kolom status/void ke internal_stock_usages...');
    await addColumnIfMissing(conn, 'internal_stock_usages', 'status', `ENUM('completed','voided') NOT NULL DEFAULT 'completed'`);
    await addColumnIfMissing(conn, 'internal_stock_usages', 'void_reason', 'TEXT NULL');
    await addColumnIfMissing(conn, 'internal_stock_usages', 'voided_at', 'DATETIME NULL');
    await addColumnIfMissing(conn, 'internal_stock_usages', 'voided_by', 'CHAR(36) NULL');

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
