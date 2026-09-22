// Migrasi INKREMENTAL, AMAN dijalankan di database yang sudah berisi data
// sungguhan — cuma ALTER TABLE ADD COLUMN (dicek dulu blm ada)/CREATE TABLE
// IF NOT EXISTS/INSERT IGNORE, tidak ada DROP/TRUNCATE/DELETE apa pun.
// Idempotent — aman dijalankan berkali-kali.
//
// Fitur: Otorisasi Jual di Bawah HPP. Owner login langsung boleh jual rugi
// (asal isi alasan). Kasir biasa butuh "Kode Otorisasi" — kode TOTP 6 digit
// (standar sama dgn Google Authenticator/token bank, RFC 6238) yang dibaca
// Owner dari app authenticator-nya sendiri (offline, tanpa perlu Owner
// terhubung ke jaringan toko) lalu disebutkan lewat telepon. Server
// verifikasi & terbitkan token sekali-pakai (below_cost_authorizations),
// yang baru benar2 dipakai (consumed) saat checkout nota tsb berhasil.
//
// Usage: node src/db/add-below-cost-authorization.js
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');

const NEW_PERMISSIONS = [
  // Role dgn izin ini (mis. "Owner") boleh langsung jual di bawah HPP dari
  // layar kasir (cukup isi alasan, tanpa perlu kode otorisasi tambahan) —
  // DAN satu-satunya role yg boleh punya totp_secret (lihat catatan di
  // BelowCostAuthorizationService.js). Sengaja aksi TERPISAH dari
  // 'sales.create' biasa (kasir yg TIDAK punya izin ini tetap boleh
  // berjualan normal, cuma ditolak kalau harga jatuh di bawah HPP kecuali
  // dapat otorisasi).
  ['sales', 'sell_below_cost', 'Boleh menjual di bawah HPP langsung (khusus Owner, cukup isi alasan)'],
];

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

    console.log('Menambah kolom TOTP ke users (secret disimpan APA ADANYA/base32,');
    console.log('bukan hash — beda dari password_hash/pin_hash yg satu-arah, karena');
    console.log('secret ini WAJIB bisa dibaca ulang server tiap verifikasi)...');
    await addColumnIfMissing(conn, 'users', 'totp_secret', 'VARCHAR(64) NULL');
    await addColumnIfMissing(conn, 'users', 'totp_enabled_at', 'DATETIME NULL');

    console.log('Membuat tabel below_cost_authorizations (kalau belum ada)...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS below_cost_authorizations (
        id                     CHAR(36)     NOT NULL PRIMARY KEY,
        token                  CHAR(36)     NOT NULL UNIQUE,
        code_hash              CHAR(64)     NOT NULL,
        authorized_by_user_id  CHAR(36)     NOT NULL,
        requested_by_user_id   CHAR(36)     NOT NULL,
        expires_at             DATETIME     NOT NULL,
        consumed_at            DATETIME     NULL,
        consumed_sale_id       CHAR(36)     NULL,
        created_at             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_bca_authorized_by FOREIGN KEY (authorized_by_user_id) REFERENCES users(id),
        CONSTRAINT fk_bca_requested_by FOREIGN KEY (requested_by_user_id) REFERENCES users(id),
        UNIQUE KEY uq_bca_owner_code (authorized_by_user_id, code_hash)
      ) ENGINE=InnoDB
    `);
    // uq_bca_owner_code = proteksi replay: 1 kode TOTP dari 1 Owner cuma
    // bisa diterima SATU KALI selamanya (bukan cuma dalam jendela 30 detik),
    // jadi kalau kasir kepo coba pakai kode yg sama dua kali (mis. minta
    // token 2x sebelum kodenya berganti), percobaan kedua ditolak — Owner
    // harus tunggu kode berikutnya.

    console.log('Menambah izin baru (sales.sell_below_cost)...');
    for (const [module, action, description] of NEW_PERMISSIONS) {
      await conn.query(
        `INSERT IGNORE INTO permissions (id, module, action, description, is_sensitive) VALUES (?, ?, ?, ?, 1)`,
        [uuidv4(), module, action, description]
      );
    }
    console.log('  (izin ini SENGAJA tidak otomatis diberikan ke role manapun —');
    console.log('   buat role "Owner" via menu Kelola Role lalu centang izin ini sendiri)');

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
