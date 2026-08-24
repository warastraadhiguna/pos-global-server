// Migrasi INKREMENTAL, AMAN dijalankan di database yang sudah berisi data
// sungguhan — cuma CREATE TABLE IF NOT EXISTS / INSERT IGNORE, tidak ada
// DROP/TRUNCATE/DELETE apa pun. Idempotent — aman dijalankan berkali-kali.
//
// Fitur: Pemakaian Internal Stok (barang dagangan dipakai utk kebutuhan
// toko sendiri, bukan dijual). Lihat catatan panjang di schema.sql soal
// kenapa stok keluar via OUT biasa (bukan reversal-nilai) dan kenapa belum
// ada jalur void/pembalik utk dokumen ini.
//
// Usage: node src/db/add-internal-stock-usage.js
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');

const NEW_PERMISSIONS = [
  ['internal_stock_usage', 'view', 'Lihat riwayat pemakaian internal stok'],
  ['internal_stock_usage', 'create', 'Catat pemakaian internal stok (keluar barang bukan utk dijual)'],
];

// "Beban Perlengkapan Toko" (5-204) SUDAH ADA di DB ini (dicek langsung,
// bukan asumsi) — blok ini murni jaga-jaga defensif supaya skrip tetap
// benar kalau dijalankan di database LAIN yang belum punya akun ini,
// BUKAN karena akun ini benar2 hilang di sini. INSERT IGNORE by code,
// no-op kalau sudah ada (kasus di DB ini).
async function ensureExpenseAccount(conn) {
  const [[existing]] = await conn.query(`SELECT id FROM accounts WHERE code = '5-204'`);
  if (existing) {
    console.log('  akun 5-204 "Beban Perlengkapan Toko" sudah ada, lewati');
    return;
  }
  const [[parent]] = await conn.query(`SELECT id FROM accounts WHERE code = '5-200'`);
  if (!parent) {
    throw new Error('Akun header 5-200 "Beban Operasional" tidak ditemukan — COA belum di-seed?');
  }
  await conn.query(
    `INSERT INTO accounts (id, code, name, category, normal_balance, parent_id, is_postable) VALUES (?, '5-204', 'Beban Perlengkapan Toko', 'expense', 'debit', ?, 1)`,
    [uuidv4(), parent.id]
  );
  console.log('  akun 5-204 "Beban Perlengkapan Toko" ditambahkan');
}

async function run() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    console.log('Membuat tabel internal_stock_usages (kalau belum ada)...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS internal_stock_usages (
        id            CHAR(36)     NOT NULL PRIMARY KEY,
        branch_id     INT          NOT NULL DEFAULT 1,
        warehouse_id  CHAR(36)     NOT NULL,
        usage_number  VARCHAR(30)  NOT NULL UNIQUE,
        usage_date    DATE         NOT NULL,
        reason        TEXT         NOT NULL,
        total_value   INT          NOT NULL,
        processed_by  CHAR(36)     NOT NULL,
        sync_status   VARCHAR(20)  NOT NULL DEFAULT 'local_only',
        created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        CONSTRAINT fk_internal_usage_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
        CONSTRAINT fk_internal_usage_user FOREIGN KEY (processed_by) REFERENCES users(id)
      ) ENGINE=InnoDB
    `);

    console.log('Membuat tabel internal_stock_usage_items (kalau belum ada)...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS internal_stock_usage_items (
        id                  CHAR(36)      NOT NULL PRIMARY KEY,
        usage_id            CHAR(36)      NOT NULL,
        product_id          CHAR(36)      NOT NULL,
        unit_id             CHAR(36)      NOT NULL,
        quantity            DECIMAL(18,4) NOT NULL,
        conversion_factor   DECIMAL(18,4) NOT NULL,
        quantity_base       DECIMAL(18,4) NOT NULL,
        cost_per_base_unit  DECIMAL(18,4) NOT NULL,
        subtotal            INT           NOT NULL,
        created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_internal_usage_items_usage FOREIGN KEY (usage_id) REFERENCES internal_stock_usages(id),
        CONSTRAINT fk_internal_usage_items_product FOREIGN KEY (product_id) REFERENCES products(id),
        CONSTRAINT fk_internal_usage_items_unit FOREIGN KEY (unit_id) REFERENCES units(id)
      ) ENGINE=InnoDB
    `);
    await conn.query(`CREATE INDEX idx_internal_usage_items_usage ON internal_stock_usage_items(usage_id)`).catch((err) => {
      if (err.code !== 'ER_DUP_KEYNAME') throw err;
    });

    console.log('Memastikan akun COA "Beban Perlengkapan Toko" (5-204) ada...');
    await ensureExpenseAccount(conn);

    console.log('Menambah 2 izin baru (internal_stock_usage.view/create)...');
    for (const [module, action, description] of NEW_PERMISSIONS) {
      await conn.query(
        `INSERT IGNORE INTO permissions (id, module, action, description, is_sensitive) VALUES (?, ?, ?, ?, 0)`,
        [uuidv4(), module, action, description]
      );
    }

    console.log('Memberi izin baru ke role "admin" (default tertutup utk role lain)...');
    const [result] = await conn.query(`
      INSERT IGNORE INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM roles r, permissions p
      WHERE r.name = 'admin' AND p.module = 'internal_stock_usage'
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
