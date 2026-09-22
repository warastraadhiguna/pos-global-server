// Migrasi INKREMENTAL, AMAN dijalankan di database yang sudah berisi data
// sungguhan — cuma CREATE TABLE IF NOT EXISTS/INSERT IGNORE, tidak ada
// DROP/TRUNCATE/DELETE apa pun. Idempotent — aman dijalankan berkali-kali.
//
// Fitur: Retur Penjualan — pelanggan mengembalikan barang yang SUDAH
// dibeli. Beda dari Retur Pembelian (yang sudah ada, ke supplier): di sini
// WAJIB terkait ke sale_item ASAL (bukan produk bebas) supaya cost_per_base
// unit yang dibalik ke Persediaan/HPP persis sama dgn yang dulu dijual —
// bukan avg cost berjalan sekarang (lihat catatan panjang di
// SalesReturnService.js). Boleh sebagian qty/item saja, nota kapan pun
// (tidak dibatasi status shift).
//
// Usage: node src/db/add-sales-returns.js
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');

const NEW_PERMISSIONS = [
  ['sales_returns', 'view', 'Lihat retur penjualan'],
  ['sales_returns', 'create', 'Input retur penjualan'],
];

async function run() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    console.log('Membuat tabel sales_returns (kalau belum ada)...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS sales_returns (
        id              CHAR(36)     NOT NULL PRIMARY KEY,
        branch_id       INT          NOT NULL DEFAULT 1,
        return_number   VARCHAR(30)  NOT NULL UNIQUE,
        sale_id         CHAR(36)     NOT NULL,
        warehouse_id    CHAR(36)     NOT NULL,
        return_date     DATE         NOT NULL,
        is_cash_refund  TINYINT(1)   NOT NULL DEFAULT 1,
        reason          TEXT         NOT NULL,
        grand_total     INT          NOT NULL,
        total_cost      INT          NOT NULL,
        processed_by    CHAR(36)     NOT NULL,
        created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_sales_returns_sale FOREIGN KEY (sale_id) REFERENCES sales(id),
        CONSTRAINT fk_sales_returns_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
        CONSTRAINT fk_sales_returns_user FOREIGN KEY (processed_by) REFERENCES users(id)
      ) ENGINE=InnoDB
    `);
    await conn.query(`CREATE INDEX idx_sales_returns_sale ON sales_returns(sale_id)`).catch((err) => {
      if (err.code !== 'ER_DUP_KEYNAME') throw err;
    });

    console.log('Membuat tabel sales_return_items (kalau belum ada)...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS sales_return_items (
        id                  CHAR(36)      NOT NULL PRIMARY KEY,
        sales_return_id     CHAR(36)      NOT NULL,
        sale_item_id        CHAR(36)      NOT NULL,
        product_id          CHAR(36)      NOT NULL,
        unit_id             CHAR(36)      NOT NULL,
        quantity            DECIMAL(18,4) NOT NULL,
        conversion_factor   DECIMAL(18,4) NOT NULL,
        quantity_base       DECIMAL(18,4) NOT NULL,
        cost_per_base_unit  DECIMAL(18,4) NOT NULL,
        amount              INT           NOT NULL,
        cost_amount         INT           NOT NULL,
        created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_sales_return_items_return FOREIGN KEY (sales_return_id) REFERENCES sales_returns(id),
        CONSTRAINT fk_sales_return_items_sale_item FOREIGN KEY (sale_item_id) REFERENCES sale_items(id),
        CONSTRAINT fk_sales_return_items_product FOREIGN KEY (product_id) REFERENCES products(id),
        CONSTRAINT fk_sales_return_items_unit FOREIGN KEY (unit_id) REFERENCES units(id)
      ) ENGINE=InnoDB
    `);
    await conn.query(`CREATE INDEX idx_sales_return_items_return ON sales_return_items(sales_return_id)`).catch((err) => {
      if (err.code !== 'ER_DUP_KEYNAME') throw err;
    });
    await conn.query(`CREATE INDEX idx_sales_return_items_sale_item ON sales_return_items(sale_item_id)`).catch((err) => {
      if (err.code !== 'ER_DUP_KEYNAME') throw err;
    });

    console.log('Menambah 2 izin baru (sales_returns.view/create)...');
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
      WHERE r.name = 'admin' AND p.module = 'sales_returns'
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
