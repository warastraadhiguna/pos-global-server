// Migrasi INKREMENTAL, AMAN dijalankan di database yang sudah berisi data
// pembelian sungguhan — cuma ADD COLUMN (default 0/NULL), tidak ada
// DROP/TRUNCATE/DELETE apa pun. Idempotent — cek dulu kolomnya sudah ada
// atau belum sebelum ALTER, aman dijalankan berkali-kali.
//
// Pembelian LAMA (sebelum migrasi ini) otomatis dapat subtotal=0,
// discount_total=0, notes=NULL, purchase_items.discount_amount=0 — bukan
// dihitung ulang dari data lama (tidak ada cara tahu apakah dulu ada
// "diskon" krn fiturnya memang belum ada), murni default kolom baru.
// grand_total/dpp/ppn_* nota lama TIDAK berubah sama sekali.
//
// Usage: node src/db/add-purchase-discount-notes.js
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

    console.log('Menambah kolom diskon & catatan ke purchases...');
    await addColumnIfMissing(conn, 'purchases', 'subtotal', 'INT NOT NULL DEFAULT 0');
    await addColumnIfMissing(conn, 'purchases', 'discount_total', 'INT NOT NULL DEFAULT 0');
    await addColumnIfMissing(conn, 'purchases', 'notes', 'TEXT NULL');

    console.log('Menambah kolom diskon item ke purchase_items...');
    await addColumnIfMissing(conn, 'purchase_items', 'discount_amount', 'INT NOT NULL DEFAULT 0');

    // purchase_drafts sudah ada dari migrasi drafts sebelumnya (CREATE TABLE
    // IF NOT EXISTS di add-purchase-drafts-table.js jadi no-op di DB yang
    // tabelnya sudah dibuat sebelum kolom notes/total_discount_json
    // ditambahkan ke definisinya) — jadi kolomnya harus ditambah di sini juga.
    console.log('Menambah kolom catatan & diskon total ke purchase_drafts...');
    await addColumnIfMissing(conn, 'purchase_drafts', 'notes', 'TEXT NULL');
    await addColumnIfMissing(conn, 'purchase_drafts', 'total_discount_json', 'JSON NULL');

    await conn.commit();
    console.log('\nSelesai — data pembelian yang sudah ada tidak tersentuh/terhapus.');
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
