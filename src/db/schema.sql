-- ============================================================================
-- POS 1 Cabang — MVP Schema
-- Prinsip wajib (lihat MVP_Blueprint_POS_1_Cabang.md Bagian 5):
--   1. UUID (CHAR(36)) sebagai PK semua tabel transaksi & master
--   2. sync_status di semua tabel transaksi (default 'local_only')
--   3. branch_id di semua tabel transaksi, hardcode 1 untuk MVP
--   4. Uang = INT rupiah (tanpa sen). Biaya/HPP yang butuh presisi = DECIMAL
--   5. Snapshot HPP wajib di sale_items (cost_per_base_unit)
--   6. stock_movements = sumber kebenaran stok, stock_balances cuma cache
--   7. Tidak ada hard delete pada data transaksi (voided_at/cancelled_at)
--   8. Base unit + konversi (quantity, unit_id, conversion_factor, quantity_base)
-- ============================================================================

CREATE DATABASE IF NOT EXISTS pos_branch
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE pos_branch;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------------------------------------------------------
-- USER & ROLE
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS roles;
CREATE TABLE roles (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  name          VARCHAR(30)  NOT NULL UNIQUE,   -- 'admin', 'kasir'
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Login kasir pakai PIN pendek (ganti shift cepat), login admin pakai
-- username + password. Auth API pakai JWT stateless (keputusan dikonfirmasi
-- user tanggal 2026-07-17).
DROP TABLE IF EXISTS users;
CREATE TABLE users (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  branch_id     INT          NOT NULL DEFAULT 1,
  role_id       CHAR(36)     NOT NULL,
  username      VARCHAR(50)  NULL UNIQUE,        -- wajib untuk admin, opsional untuk kasir
  full_name     VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NULL,               -- bcrypt, wajib untuk admin
  pin_hash      VARCHAR(255) NULL,                -- bcrypt, wajib untuk kasir
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  failed_login_attempts INT      NOT NULL DEFAULT 0,
  locked_until           DATETIME NULL,            -- akun terkunci sementara sampai waktu ini
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id)
) ENGINE=InnoDB;

CREATE INDEX idx_users_branch ON users(branch_id);

-- ----------------------------------------------------------------------------
-- MASTER PRODUK
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS product_categories;
CREATE TABLE product_categories (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

DROP TABLE IF EXISTS units;
CREATE TABLE units (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  name          VARCHAR(30)  NOT NULL UNIQUE,   -- pcs, lusin, dos, dst
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

DROP TABLE IF EXISTS products;
CREATE TABLE products (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  category_id   CHAR(36)     NULL,
  base_unit_id  CHAR(36)     NOT NULL,          -- unit dasar untuk stok & HPP (biasanya pcs)
  sku           VARCHAR(50)  NULL UNIQUE,
  name          VARCHAR(150) NOT NULL,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES product_categories(id),
  CONSTRAINT fk_products_base_unit FOREIGN KEY (base_unit_id) REFERENCES units(id)
) ENGINE=InnoDB;

CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_active ON products(is_active);

-- Konversi satuan per produk (mis. 1 dos = 12 lusin = 144 pcs).
-- conversion_factor = jumlah base unit per 1 unit ini.
DROP TABLE IF EXISTS product_units;
CREATE TABLE product_units (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  product_id          CHAR(36)      NOT NULL,
  unit_id             CHAR(36)      NOT NULL,
  conversion_factor   DECIMAL(18,4) NOT NULL,   -- base units per unit ini
  is_base_unit        TINYINT(1)    NOT NULL DEFAULT 0,
  created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_product_units_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_product_units_unit FOREIGN KEY (unit_id) REFERENCES units(id),
  UNIQUE KEY uq_product_unit (product_id, unit_id)
) ENGINE=InnoDB;

DROP TABLE IF EXISTS barcodes;
CREATE TABLE barcodes (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  product_id    CHAR(36)     NOT NULL,
  unit_id       CHAR(36)     NOT NULL,          -- barcode bisa spesifik per satuan (mis. barcode dos beda dgn pcs)
  barcode       VARCHAR(64)  NOT NULL UNIQUE,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_barcodes_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_barcodes_unit FOREIGN KEY (unit_id) REFERENCES units(id)
) ENGINE=InnoDB;

CREATE INDEX idx_barcodes_product ON barcodes(product_id);

-- ----------------------------------------------------------------------------
-- HARGA
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS price_levels;
CREATE TABLE price_levels (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  name          VARCHAR(50)  NOT NULL UNIQUE,   -- 'ecer', 'grosir'
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

DROP TABLE IF EXISTS product_prices;
CREATE TABLE product_prices (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  product_id      CHAR(36)      NOT NULL,
  unit_id         CHAR(36)      NOT NULL,
  price_level_id  CHAR(36)      NOT NULL,
  min_qty_base    DECIMAL(18,4) NOT NULL DEFAULT 0,  -- ambang qty (dalam base unit) utk harga tier ini
  price           INT           NOT NULL,            -- rupiah, integer
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_product_prices_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_product_prices_unit FOREIGN KEY (unit_id) REFERENCES units(id),
  CONSTRAINT fk_product_prices_level FOREIGN KEY (price_level_id) REFERENCES price_levels(id),
  UNIQUE KEY uq_product_price_tier (product_id, unit_id, price_level_id, min_qty_base)
) ENGINE=InnoDB;

CREATE INDEX idx_product_prices_lookup ON product_prices(product_id, price_level_id);

-- ----------------------------------------------------------------------------
-- GUDANG & STOK (stock_movements = sumber kebenaran, stock_balances = cache)
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS warehouses;
CREATE TABLE warehouses (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  branch_id     INT          NOT NULL DEFAULT 1,
  name          VARCHAR(100) NOT NULL,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

DROP TABLE IF EXISTS stock_movements;
CREATE TABLE stock_movements (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  branch_id             INT           NOT NULL DEFAULT 1,
  warehouse_id          CHAR(36)      NOT NULL,
  product_id            CHAR(36)      NOT NULL,
  movement_type         VARCHAR(30)   NOT NULL,   -- 'sale','void_reversal','sale_return','adjustment','opname',...
  reference_type        VARCHAR(30)   NULL,       -- 'sale','sale_return','stock_adjustment',...
  reference_uuid        CHAR(36)      NULL,       -- id baris sumber (sales.id, dst)
  qty_in_base           DECIMAL(18,4) NOT NULL DEFAULT 0,
  qty_out_base          DECIMAL(18,4) NOT NULL DEFAULT 0,
  cost_per_base_unit    DECIMAL(18,4) NOT NULL DEFAULT 0,
  total_cost            DECIMAL(18,4) NOT NULL DEFAULT 0,
  balance_after_base    DECIMAL(18,4) NULL,       -- snapshot saldo setelah movement ini, utk audit
  movement_date         DATETIME      NOT NULL,
  sync_status           VARCHAR(20)   NOT NULL DEFAULT 'local_only',
  created_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_stock_mv_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_stock_mv_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB;

CREATE INDEX idx_stock_mv_product_wh ON stock_movements(product_id, warehouse_id);
CREATE INDEX idx_stock_mv_reference ON stock_movements(reference_type, reference_uuid);
CREATE INDEX idx_stock_mv_date ON stock_movements(movement_date);

-- Cache saldo stok + moving average cost. Harus selalu bisa direkonstruksi
-- ulang dari SUM(stock_movements). Jangan pernah diubah langsung tanpa
-- menulis baris stock_movements terlebih dulu.
DROP TABLE IF EXISTS stock_balances;
CREATE TABLE stock_balances (
  id                      CHAR(36)      NOT NULL PRIMARY KEY,
  branch_id               INT           NOT NULL DEFAULT 1,
  warehouse_id            CHAR(36)      NOT NULL,
  product_id              CHAR(36)      NOT NULL,
  qty_base                DECIMAL(18,4) NOT NULL DEFAULT 0,
  avg_cost_per_base_unit  DECIMAL(18,4) NOT NULL DEFAULT 0,
  updated_at              DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_stock_bal_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_stock_bal_product FOREIGN KEY (product_id) REFERENCES products(id),
  UNIQUE KEY uq_stock_balance (warehouse_id, product_id)
) ENGINE=InnoDB;

DROP TABLE IF EXISTS stock_adjustments;
CREATE TABLE stock_adjustments (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  branch_id           INT           NOT NULL DEFAULT 1,
  warehouse_id        CHAR(36)      NOT NULL,
  product_id          CHAR(36)      NOT NULL,
  adjustment_type     VARCHAR(30)   NOT NULL,   -- 'correction_in','correction_out','damaged','opname'
  qty_base            DECIMAL(18,4) NOT NULL,   -- positif = tambah stok, negatif = kurangi stok
  reason              TEXT          NOT NULL,
  stock_movement_id   CHAR(36)      NULL,       -- baris ledger yang dihasilkan adjustment ini
  created_by          CHAR(36)      NOT NULL,
  sync_status         VARCHAR(20)   NOT NULL DEFAULT 'local_only',
  created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_stock_adj_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_stock_adj_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_stock_adj_movement FOREIGN KEY (stock_movement_id) REFERENCES stock_movements(id),
  CONSTRAINT fk_stock_adj_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- SHIFT KASIR
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS cashier_shifts;
CREATE TABLE cashier_shifts (
  id                      CHAR(36)    NOT NULL PRIMARY KEY,
  branch_id               INT         NOT NULL DEFAULT 1,
  user_id                 CHAR(36)    NOT NULL,
  opening_cash            INT         NOT NULL DEFAULT 0,
  closing_cash_expected   INT         NULL,     -- dihitung sistem (kas awal + tunai masuk - kas keluar)
  closing_cash_actual     INT         NULL,     -- hasil hitung fisik kasir
  cash_difference         INT         NULL,     -- actual - expected
  opened_at               DATETIME    NOT NULL,
  closed_at               DATETIME    NULL,
  status                  ENUM('open','closed') NOT NULL DEFAULT 'open',
  sync_status              VARCHAR(20) NOT NULL DEFAULT 'local_only',
  created_at               DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_shifts_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE INDEX idx_shifts_user_status ON cashier_shifts(user_id, status);

DROP TABLE IF EXISTS cash_movements;
CREATE TABLE cash_movements (
  id                  CHAR(36)    NOT NULL PRIMARY KEY,
  branch_id           INT         NOT NULL DEFAULT 1,
  cashier_shift_id    CHAR(36)    NOT NULL,
  movement_type       ENUM('cash_in','cash_out') NOT NULL,
  amount              INT         NOT NULL,
  reason              TEXT        NULL,
  created_by          CHAR(36)    NOT NULL,
  sync_status         VARCHAR(20) NOT NULL DEFAULT 'local_only',
  created_at          DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cash_mv_shift FOREIGN KEY (cashier_shift_id) REFERENCES cashier_shifts(id),
  CONSTRAINT fk_cash_mv_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- PENJUALAN
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS sales;
CREATE TABLE sales (
  id                 CHAR(36)     NOT NULL PRIMARY KEY,
  branch_id          INT          NOT NULL DEFAULT 1,
  sale_number        VARCHAR(30)  NOT NULL UNIQUE,   -- nomor struk
  cashier_shift_id   CHAR(36)     NOT NULL,
  user_id            CHAR(36)     NOT NULL,          -- kasir yang melayani
  customer_name      VARCHAR(100) NULL,
  subtotal           INT          NOT NULL,
  discount_total      INT          NOT NULL DEFAULT 0,
  grand_total         INT          NOT NULL,
  total_cost          DECIMAL(18,4) NOT NULL DEFAULT 0,  -- SUM(sale_items.total_cost), utk laporan laba
  gross_profit        DECIMAL(18,4) NOT NULL DEFAULT 0,
  status               ENUM('completed','voided') NOT NULL DEFAULT 'completed',
  void_reason           TEXT        NULL,
  voided_at             DATETIME    NULL,
  voided_by             CHAR(36)    NULL,
  sync_status            VARCHAR(20) NOT NULL DEFAULT 'local_only',
  created_at              DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_sales_shift FOREIGN KEY (cashier_shift_id) REFERENCES cashier_shifts(id),
  CONSTRAINT fk_sales_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_sales_voided_by FOREIGN KEY (voided_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE INDEX idx_sales_shift ON sales(cashier_shift_id);
CREATE INDEX idx_sales_status ON sales(status);
CREATE INDEX idx_sales_created ON sales(created_at);

DROP TABLE IF EXISTS sale_items;
CREATE TABLE sale_items (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  sale_id               CHAR(36)      NOT NULL,
  product_id            CHAR(36)      NOT NULL,
  unit_id               CHAR(36)      NOT NULL,
  quantity              DECIMAL(18,4) NOT NULL,          -- qty dalam unit yang dipilih kasir
  conversion_factor     DECIMAL(18,4) NOT NULL,
  quantity_base         DECIMAL(18,4) NOT NULL,          -- quantity * conversion_factor
  selling_price         INT           NOT NULL,          -- harga per unit (rupiah)
  discount_amount       INT           NOT NULL DEFAULT 0,
  subtotal              INT           NOT NULL,          -- (selling_price * quantity) - discount_amount
  cost_per_base_unit    DECIMAL(18,4) NOT NULL,          -- snapshot HPP saat transaksi (WAJIB, bukan hitung ulang)
  total_cost            DECIMAL(18,4) NOT NULL,          -- cost_per_base_unit * quantity_base
  gross_profit          DECIMAL(18,4) NOT NULL,          -- subtotal - total_cost
  sync_status           VARCHAR(20)   NOT NULL DEFAULT 'local_only',
  created_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sale_items_sale FOREIGN KEY (sale_id) REFERENCES sales(id),
  CONSTRAINT fk_sale_items_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_sale_items_unit FOREIGN KEY (unit_id) REFERENCES units(id)
) ENGINE=InnoDB;

CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_product ON sale_items(product_id);

DROP TABLE IF EXISTS sale_payments;
CREATE TABLE sale_payments (
  id                    CHAR(36)     NOT NULL PRIMARY KEY,
  sale_id               CHAR(36)     NOT NULL,
  payment_method_id     CHAR(36)     NOT NULL,          -- FK payment_methods, lihat section KONFIGURASI
  payment_method_name   VARCHAR(50)  NOT NULL,          -- snapshot nama saat transaksi — nama tetap benar di
                                                          -- struk/laporan lama walau admin rename/nonaktifkan metodenya nanti
  amount                INT          NOT NULL,
  sync_status           VARCHAR(20)  NOT NULL DEFAULT 'local_only',
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sale_payments_sale FOREIGN KEY (sale_id) REFERENCES sales(id),
  CONSTRAINT fk_sale_payments_method FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id)
) ENGINE=InnoDB;

CREATE INDEX idx_sale_payments_sale ON sale_payments(sale_id);

-- Tabel retur formal disiapkan sesuai Bagian 6 (kesiapan skema), TAPI modul
-- retur/logic-nya BELUM dibangun di MVP 7 hari ini (lihat Bagian 4 "Belum
-- masuk scope"). Void transaksi dulu yang dipakai untuk minggu pertama.
DROP TABLE IF EXISTS sale_returns;
CREATE TABLE sale_returns (
  id                 CHAR(36)     NOT NULL PRIMARY KEY,
  branch_id          INT          NOT NULL DEFAULT 1,
  original_sale_id   CHAR(36)     NOT NULL,
  return_number      VARCHAR(30)  NOT NULL UNIQUE,
  reason             TEXT         NULL,
  total_amount       INT          NOT NULL DEFAULT 0,
  status             ENUM('completed','voided') NOT NULL DEFAULT 'completed',
  processed_by       CHAR(36)     NOT NULL,
  sync_status        VARCHAR(20)  NOT NULL DEFAULT 'local_only',
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_sale_returns_sale FOREIGN KEY (original_sale_id) REFERENCES sales(id),
  CONSTRAINT fk_sale_returns_user FOREIGN KEY (processed_by) REFERENCES users(id)
) ENGINE=InnoDB;

DROP TABLE IF EXISTS sale_return_items;
CREATE TABLE sale_return_items (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  sale_return_id        CHAR(36)      NOT NULL,
  sale_item_id          CHAR(36)      NOT NULL,
  quantity_base         DECIMAL(18,4) NOT NULL,
  amount                INT           NOT NULL,
  cost_per_base_unit    DECIMAL(18,4) NOT NULL,   -- dibawa dari snapshot sale_items asal, bukan dihitung ulang
  sync_status           VARCHAR(20)   NOT NULL DEFAULT 'local_only',
  created_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_return_items_return FOREIGN KEY (sale_return_id) REFERENCES sale_returns(id),
  CONSTRAINT fk_return_items_sale_item FOREIGN KEY (sale_item_id) REFERENCES sale_items(id)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- AUDIT
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS activity_logs;
CREATE TABLE activity_logs (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  branch_id      INT          NOT NULL DEFAULT 1,
  user_id        CHAR(36)     NULL,
  action         VARCHAR(50)  NOT NULL,   -- 'login','void_sale','manual_discount','reprint_receipt',...
  entity_type    VARCHAR(50)  NULL,       -- 'sale','sale_item','stock_adjustment',...
  entity_uuid    CHAR(36)     NULL,
  description    TEXT         NULL,
  metadata       JSON         NULL,
  sync_status    VARCHAR(20)  NOT NULL DEFAULT 'local_only',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_activity_logs_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE INDEX idx_activity_logs_user ON activity_logs(user_id);
CREATE INDEX idx_activity_logs_action ON activity_logs(action);
CREATE INDEX idx_activity_logs_entity ON activity_logs(entity_type, entity_uuid);
CREATE INDEX idx_activity_logs_created ON activity_logs(created_at);

-- ----------------------------------------------------------------------------
-- KONFIGURASI
-- ----------------------------------------------------------------------------

-- Metode pembayaran (Tunai, QRIS, Kartu Debit, dst) — diatur admin, dipilih
-- kasir saat checkout. is_cash membedakan metode yang menyentuh kas fisik
-- laci (dipakai ShiftService.calculateExpectedCash) dari yang tidak — jadi
-- rekonsiliasi kas tetap benar berapa pun metode non-tunai yang ditambahkan.
DROP TABLE IF EXISTS payment_methods;
CREATE TABLE payment_methods (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  name          VARCHAR(50)  NOT NULL,           -- "Tunai", "QRIS", "Kartu Debit", dst
  is_cash       TINYINT(1)   NOT NULL DEFAULT 0,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order    INT          NOT NULL DEFAULT 0,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Pecahan uang tunai untuk tombol shortcut "uang diterima" di kasir. Master
-- data konfigurasi (bukan tabel transaksi) — diatur admin, dibaca kasir.
DROP TABLE IF EXISTS cash_denominations;
CREATE TABLE cash_denominations (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  amount        INT          NOT NULL,          -- rupiah, mis. 10000, 20000, 50000
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order    INT          NOT NULL DEFAULT 0,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

SET FOREIGN_KEY_CHECKS = 1;
