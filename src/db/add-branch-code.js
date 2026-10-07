// Migrasi INKREMENTAL, AMAN dijalankan di database yang sudah berisi data
// sungguhan — cuma ALTER TABLE ADD COLUMN (dicek dulu blm ada)/UPDATE
// bersyarat, tidak ada DROP/TRUNCATE/DELETE apa pun. Idempotent — aman
// dijalankan berkali-kali.
//
// Fitur: identitas cabang (branch_code) — lihat server/docs/
// BRANCH_IDENTITY_AUDIT.md untuk audit & opsi desain lengkapnya. Ini BUKAN
// pengganti branch_id (yang tetap partisi LOKAL dalam satu DB, selalu 1) —
// branch_code adalah identitas GLOBAL cabang ini (mis. "SMG", "PWD") yang
// nanti ditempelkan ke payload sync satu-arah cabang->pusat. Sync engine-nya
// SENDIRI belum dibangun di migrasi ini — cuma menyiapkan identitasnya.
//
// NULL (bukan string kosong/placeholder) = belum pernah diisi admin cabang
// ini — SENGAJA tidak diberi default blanket supaya instalasi cabang baru
// tidak diam-diam mewarisi kode yang bisa bentrok dengan cabang lain.
// Semarang (branch_id=1, SUDAH live) jadi satu-satunya baris yang diisi
// eksplisit di migrasi ini, karena memang sudah diketahui identitasnya.
//
// Usage: node src/db/add-branch-code.js
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

    console.log('Menambah kolom branch_code ke store_settings...');
    await addColumnIfMissing(conn, 'store_settings', 'branch_code', 'VARCHAR(20) NULL');

    console.log('Mengisi branch_code = \'SMG\' untuk baris branch_id=1 (Semarang) kalau masih kosong...');
    const [result] = await conn.query(
      `UPDATE store_settings SET branch_code = 'SMG' WHERE branch_id = 1 AND branch_code IS NULL`
    );
    console.log(`  ${result.affectedRows} baris diisi (0 kalau sudah pernah terisi sebelumnya, atau baris branch_id=1 belum ada sama sekali).`);

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
