// Migrasi INKREMENTAL, AMAN dijalankan di database yang sudah berisi data
// sungguhan — BEDA dari migrate.js (yang drop+recreate SEMUA tabel).
// Skrip ini CUMA menambah yang baru (tabel purchase_drafts + 3 izin RBAC
// terkait), tidak menyentuh/menghapus data yang sudah ada sama sekali.
// Idempotent — aman dijalankan berkali-kali (CREATE TABLE IF NOT EXISTS,
// INSERT IGNORE), tidak akan error atau duplikat kalau sudah pernah jalan.
//
// Usage: node src/db/add-purchase-drafts-table.js
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');

const NEW_PERMISSIONS = [
  ['purchase_drafts', 'view', 'Lihat daftar draft pembelian'],
  ['purchase_drafts', 'create', 'Simpan draft pembelian (belum masuk stok/akuntansi)'],
  ['purchase_drafts', 'delete', 'Hapus draft pembelian'],
];

async function run() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    console.log('Membuat tabel purchase_drafts (kalau belum ada)...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS purchase_drafts (
        id            CHAR(36)     NOT NULL PRIMARY KEY,
        branch_id     INT          NOT NULL DEFAULT 1,
        user_id       CHAR(36)     NOT NULL,
        label         VARCHAR(100) NULL,
        supplier_id   CHAR(36)     NULL,
        purchase_date DATE         NULL,
        payment_type  VARCHAR(10)  NULL,
        notes         TEXT         NULL,
        ppn_json      JSON         NULL,
        total_discount_json JSON   NULL,
        items_json    JSON         NOT NULL,
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_purchase_drafts_user FOREIGN KEY (user_id) REFERENCES users(id)
      ) ENGINE=InnoDB
    `);

    console.log('Menambah 3 izin baru (purchase_drafts.view/create/delete)...');
    for (const [module, action, description] of NEW_PERMISSIONS) {
      await conn.query(
        `INSERT IGNORE INTO permissions (id, module, action, description, is_sensitive) VALUES (?, ?, ?, ?, 0)`,
        [uuidv4(), module, action, description]
      );
    }

    // Default tertutup (prinsip RBAC yang sudah disepakati) — CUMA role
    // 'admin' bawaan yang otomatis dapat izin baru ini (persis logic
    // ADMIN_GRANTS di seed.js: admin dapat semua kecuali modul 'roles').
    // superadmin bypass (tidak butuh baris role_permissions). Role LAIN
    // (termasuk role custom buatan sendiri) SENGAJA TIDAK ikut dapat —
    // kalau perlu, berikan manual lewat Kelola Role.
    console.log('Memberi izin baru ke role "admin" (default tertutup utk role lain)...');
    const [result] = await conn.query(`
      INSERT IGNORE INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM roles r, permissions p
      WHERE r.name = 'admin' AND p.module = 'purchase_drafts'
    `);
    console.log(`  ${result.affectedRows} baris role_permissions ditambahkan (0 kalau sudah pernah jalan sebelumnya).`);

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
