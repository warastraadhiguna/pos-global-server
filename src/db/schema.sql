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
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  name            VARCHAR(50)  NOT NULL UNIQUE,   -- 'ecer', 'grosir'
  -- Markup% markup-otomatis (Batch 3A) - NULL = level ini belum diatur,
  -- dilewati sepenuhnya oleh PricingEngineService (harga levelnya tidak
  -- pernah disentuh otomatis sampai admin mengisi angka ini).
  markup_percent  DECIMAL(8,4) NULL DEFAULT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- price DECIMAL (bukan INT) SENGAJA (Batch 3A) - harga hasil hitung markup
-- otomatis (HPP rata-rata + markup%) TIDAK dibulatkan, disimpan presisi
-- penuh apa adanya (keputusan eksplisit klien, mereka yang akan sesuaikan
-- manual kalau perlu). Harga yang benar2 dipakai di transaksi (quote/struk
-- kasir) TETAP dibulatkan ke rupiah utuh - itu terjadi di SalesService
-- (satu2nya titik pembulatan), bukan di sini. is_locked = admin mengunci
-- baris harga ini dari update markup otomatis (override manual permanen).
DROP TABLE IF EXISTS product_prices;
CREATE TABLE product_prices (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  product_id      CHAR(36)      NOT NULL,
  unit_id         CHAR(36)      NOT NULL,
  price_level_id  CHAR(36)      NOT NULL,
  min_qty_base    DECIMAL(18,4) NOT NULL DEFAULT 0,  -- ambang qty (dalam base unit) utk harga tier ini
  price           DECIMAL(14,4) NOT NULL,            -- rupiah, TIDAK dibulatkan (lihat catatan di atas)
  is_locked       TINYINT(1)    NOT NULL DEFAULT 0,  -- 1 = dikunci dari update markup otomatis
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
  -- DATETIME(3) (bukan DATETIME biasa) — dipakai StockOpnameService utk
  -- deteksi "transaksi terjadi selama opname berlangsung" dgn perbandingan
  -- created_at > waktu sesi dibuat. Presisi 1 detik terlalu kasar: dua
  -- transaksi yang terjadi berdekatan (wajar di toko sibuk, apalagi lewat
  -- script otomatis) bisa jatuh di detik yang sama dan lolos tak terdeteksi.
  created_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
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
  -- PPN (Batch 3C) — snapshot SAAT TRANSAKSI, bukan dihitung ulang dari
  -- pricing_settings sekarang (tarif/mode PPN bisa berubah di masa depan,
  -- struk lama harus tetap menunjukkan apa yang benar-benar berlaku saat
  -- itu — sama prinsipnya dgn snapshot HPP di sale_items). ppn_rate/ppn_mode
  -- NULL kalau PPN sedang OFF saat transaksi ini terjadi.
  dpp                INT          NOT NULL DEFAULT 0,   -- dasar pengenaan pajak
  ppn_rate           DECIMAL(8,4) NULL,
  ppn_mode           VARCHAR(10)  NULL,                 -- 'exclude' | 'included'
  ppn_amount         INT          NOT NULL DEFAULT 0,
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

-- ----------------------------------------------------------------------------
-- PEMBELIAN (feature/accounting, fase Pembelian & Stock Opname — Bagian A)
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS suppliers;
CREATE TABLE suppliers (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  branch_id       INT          NOT NULL DEFAULT 1,
  name            VARCHAR(150) NOT NULL,
  contact_person  VARCHAR(100) NULL,
  phone           VARCHAR(30)  NULL,
  address         TEXT         NULL,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  sync_status     VARCHAR(20)  NOT NULL DEFAULT 'local_only',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Header pembelian. status/void_* disiapkan sesuai Bagian 5 poin 7 (tidak
-- ada hard delete), TAPI aksi void pembelian belum diminta/dibangun di fase
-- ini — kolomnya siap, logic-nya menyusul kalau dibutuhkan.
DROP TABLE IF EXISTS purchases;
CREATE TABLE purchases (
  id                CHAR(36)     NOT NULL PRIMARY KEY,
  branch_id         INT          NOT NULL DEFAULT 1,
  purchase_number   VARCHAR(30)  NOT NULL UNIQUE,
  supplier_id       CHAR(36)     NOT NULL,
  warehouse_id      CHAR(36)     NOT NULL,
  user_id           CHAR(36)     NOT NULL,          -- admin yang input pembelian
  purchase_date     DATE         NOT NULL,
  grand_total       INT          NOT NULL,
  status            ENUM('completed','voided') NOT NULL DEFAULT 'completed',
  void_reason       TEXT         NULL,
  voided_at         DATETIME     NULL,
  voided_by         CHAR(36)     NULL,
  sync_status       VARCHAR(20)  NOT NULL DEFAULT 'local_only',
  -- DATETIME(3) — dipakai PurchaseService.voidPurchase utk deteksi transaksi
  -- lain yg terjadi sejak pembelian ini (created_at > waktu pembelian dibuat),
  -- dibandingkan ke stock_movements.created_at yg juga DATETIME(3). Presisi
  -- 1 detik biasa terbukti tidak cukup di StockOpnameService (lihat catatan
  -- di sana) — sama persis alasannya di sini.
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_purchases_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_purchases_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_purchases_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_purchases_voided_by FOREIGN KEY (voided_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE INDEX idx_purchases_supplier ON purchases(supplier_id);
CREATE INDEX idx_purchases_warehouse ON purchases(warehouse_id);
CREATE INDEX idx_purchases_status ON purchases(status);

-- quantity = qty dalam satuan yang DIBELI (mis. dus), quantity_base = hasil
-- konversi ke satuan dasar (dipakai StockMovementService & moving average).
-- cost_per_base_unit = cost_per_unit / conversion_factor, dipakai sbg
-- costPerBaseUnit saat applyStockMovement (bukan dihitung ulang di tempat
-- lain — snapshot yang sama dipakai utk jurnal HPP di masa depan).
DROP TABLE IF EXISTS purchase_items;
CREATE TABLE purchase_items (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  purchase_id         CHAR(36)      NOT NULL,
  product_id          CHAR(36)      NOT NULL,
  unit_id             CHAR(36)      NOT NULL,
  quantity            DECIMAL(18,4) NOT NULL,
  conversion_factor   DECIMAL(18,4) NOT NULL,
  quantity_base       DECIMAL(18,4) NOT NULL,
  cost_per_unit       INT           NOT NULL,          -- harga beli per satuan yg dibeli (rupiah)
  cost_per_base_unit  DECIMAL(18,4) NOT NULL,
  subtotal            INT           NOT NULL,          -- cost_per_unit * quantity
  sync_status         VARCHAR(20)   NOT NULL DEFAULT 'local_only',
  created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_purchase_items_purchase FOREIGN KEY (purchase_id) REFERENCES purchases(id),
  CONSTRAINT fk_purchase_items_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_purchase_items_unit FOREIGN KEY (unit_id) REFERENCES units(id)
) ENGINE=InnoDB;

CREATE INDEX idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX idx_purchase_items_product ON purchase_items(product_id);

-- payment_type di sini SENGAJA enum sederhana 'cash'/'credit' (bukan FK ke
-- payment_methods seperti sale_payments) — "kredit" di konteks pembelian
-- berarti utang ke supplier (Utang Usaha), bukan pilihan kanal pembayaran
-- seperti QRIS/kartu di sisi kasir. Pola ini sama dengan paymentType di
-- ManualJournalService.postExpense (beban tunai/kredit).
DROP TABLE IF EXISTS purchase_payments;
CREATE TABLE purchase_payments (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  purchase_id    CHAR(36)     NOT NULL,
  payment_type   ENUM('cash','credit') NOT NULL,
  amount         INT          NOT NULL,
  sync_status    VARCHAR(20)  NOT NULL DEFAULT 'local_only',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_purchase_payments_purchase FOREIGN KEY (purchase_id) REFERENCES purchases(id)
) ENGINE=InnoDB;

CREATE INDEX idx_purchase_payments_purchase ON purchase_payments(purchase_id);

-- ----------------------------------------------------------------------------
-- STOCK OPNAME (feature/accounting, fase Pembelian & Stock Opname — Bagian B)
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS stock_opnames;
CREATE TABLE stock_opnames (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  branch_id       INT          NOT NULL DEFAULT 1,
  opname_number   VARCHAR(30)  NOT NULL UNIQUE,
  warehouse_id    CHAR(36)     NOT NULL,
  status          ENUM('in_progress','finalized') NOT NULL DEFAULT 'in_progress',
  notes           TEXT         NULL,
  created_by      CHAR(36)     NOT NULL,
  finalized_by    CHAR(36)     NULL,
  finalized_at    DATETIME(3)  NULL,
  sync_status     VARCHAR(20)  NOT NULL DEFAULT 'local_only',
  -- DATETIME(3) — dibandingkan langsung ke stock_movements.created_at (juga
  -- DATETIME(3)) utk deteksi transaksi di tengah opname, lihat catatan di
  -- definisi stock_movements.created_at.
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_stock_opnames_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_stock_opnames_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_stock_opnames_finalized_by FOREIGN KEY (finalized_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- system_qty_base = SNAPSHOT stok saat sesi DIBUAT (diisi sekali, saat INSERT
-- baris ini — bukan dihitung ulang/dibaca ulang saat finalisasi). Ini akar
-- dari aturan "selisih dihitung terhadap angka saat opname dimulai": karena
-- system_qty_base sudah beku sejak awal, variance_qty_base (dihitung saat
-- finalisasi) otomatis tidak ikut terpengaruh transaksi yang terjadi selama
-- proses hitung fisik berlangsung, walau stock_balances live sudah berubah.
DROP TABLE IF EXISTS stock_opname_items;
CREATE TABLE stock_opname_items (
  id                        CHAR(36)      NOT NULL PRIMARY KEY,
  stock_opname_id           CHAR(36)      NOT NULL,
  product_id                CHAR(36)      NOT NULL,
  system_qty_base           DECIMAL(18,4) NOT NULL,
  physical_qty_base         DECIMAL(18,4) NULL,       -- NULL = belum diinput staff
  variance_qty_base         DECIMAL(18,4) NULL,       -- physical - system, diisi saat finalisasi
  avg_cost_at_finalization  DECIMAL(18,4) NULL,        -- avg cost SAAT FINALISASI (bukan saat sesi dibuat)
  variance_value            DECIMAL(18,4) NULL,        -- variance_qty_base x avg_cost_at_finalization
  counted_at                DATETIME      NULL,
  sync_status               VARCHAR(20)   NOT NULL DEFAULT 'local_only',
  created_at                DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_opname_items_opname FOREIGN KEY (stock_opname_id) REFERENCES stock_opnames(id),
  CONSTRAINT fk_opname_items_product FOREIGN KEY (product_id) REFERENCES products(id),
  UNIQUE KEY uq_opname_product (stock_opname_id, product_id)
) ENGINE=InnoDB;

CREATE INDEX idx_opname_items_opname ON stock_opname_items(stock_opname_id);

-- ----------------------------------------------------------------------------
-- RETUR PEMBELIAN (feature/accounting — tutup lubang void/retur, Bagian A)
-- ----------------------------------------------------------------------------

-- Retur ke supplier = transaksi bisnis nyata (bukan koreksi kesalahan spt
-- void), jadi TIDAK diikat ke satu purchases.id tertentu — supplier bisa
-- terima retur gabungan dari beberapa kali beli. Beda dgn void yang memang
-- membalikkan SATU pembelian spesifik.
DROP TABLE IF EXISTS purchase_returns;
CREATE TABLE purchase_returns (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  branch_id       INT          NOT NULL DEFAULT 1,
  return_number   VARCHAR(30)  NOT NULL UNIQUE,
  supplier_id     CHAR(36)     NOT NULL,
  warehouse_id    CHAR(36)     NOT NULL,
  return_date     DATE         NOT NULL,
  payment_type    ENUM('cash','credit') NOT NULL,  -- cash: dana tunai balik; credit: mengurangi utang usaha
  reason          TEXT         NOT NULL,
  grand_total     INT          NOT NULL,
  processed_by    CHAR(36)     NOT NULL,
  sync_status     VARCHAR(20)  NOT NULL DEFAULT 'local_only',
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_purchase_returns_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_purchase_returns_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_purchase_returns_user FOREIGN KEY (processed_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE INDEX idx_purchase_returns_supplier ON purchase_returns(supplier_id);

-- cost_per_base_unit = avg cost BERJALAN saat retur diproses (bukan snapshot
-- pembelian asli) — retur adalah OUT biasa, sama seperti jual, sesuai
-- kesepakatan (beda dgn void yang butuh reversal-nilai).
DROP TABLE IF EXISTS purchase_return_items;
CREATE TABLE purchase_return_items (
  id                    CHAR(36)      NOT NULL PRIMARY KEY,
  purchase_return_id    CHAR(36)      NOT NULL,
  product_id            CHAR(36)      NOT NULL,
  unit_id               CHAR(36)      NOT NULL,
  quantity              DECIMAL(18,4) NOT NULL,
  conversion_factor     DECIMAL(18,4) NOT NULL,
  quantity_base         DECIMAL(18,4) NOT NULL,
  cost_per_base_unit    DECIMAL(18,4) NOT NULL,
  amount                INT           NOT NULL,       -- quantity_base x cost_per_base_unit (dibulatkan)
  sync_status           VARCHAR(20)   NOT NULL DEFAULT 'local_only',
  created_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_purchase_return_items_return FOREIGN KEY (purchase_return_id) REFERENCES purchase_returns(id),
  CONSTRAINT fk_purchase_return_items_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_purchase_return_items_unit FOREIGN KEY (unit_id) REFERENCES units(id)
) ENGINE=InnoDB;

CREATE INDEX idx_purchase_return_items_return ON purchase_return_items(purchase_return_id);

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

-- ----------------------------------------------------------------------------
-- AKUNTANSI (feature/accounting — Lapis 1: skema + mesin jurnal saja, belum
-- ada auto-posting dari penjualan/void, belum ada input manual, belum ada
-- laporan. Lihat AccountingService.js utk validasi balance & posting.)
-- ----------------------------------------------------------------------------

-- Chart of Accounts (COA) ritel standar. Penomoran bertingkat: digit pertama
-- kode = kategori (1 aset, 2 kewajiban, 3 modal, 4 pendapatan, 5 beban),
-- parent_id membentuk hierarki header/grup -> akun detail (mis. "1-100 Kas &
-- Bank" adalah header, "1-101 Kas" & "1-102 Bank" adalah detailnya).
-- normal_balance disimpan eksplisit per akun (BUKAN diturunkan dari category)
-- karena akun kontra (mis. Akumulasi Penyusutan di kategori aset, Prive di
-- kategori modal) punya saldo normal kebalikan dari kategorinya.
-- is_postable=0 pada akun header — jurnal cuma boleh menyentuh akun detail
-- (ditegakkan di AccountingService.postJournalEntry).
DROP TABLE IF EXISTS accounts;
CREATE TABLE accounts (
  id                CHAR(36)     NOT NULL PRIMARY KEY,
  code              VARCHAR(20)  NOT NULL UNIQUE,     -- '1-101', '2-101', dst
  name              VARCHAR(100) NOT NULL,
  category          ENUM('asset','liability','equity','revenue','expense') NOT NULL,
  normal_balance    ENUM('debit','credit') NOT NULL,
  parent_id         CHAR(36)     NULL,
  is_postable       TINYINT(1)   NOT NULL DEFAULT 1,  -- 0 = akun header/grup, tidak boleh diposting langsung
  is_active         TINYINT(1)   NOT NULL DEFAULT 1,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_accounts_parent FOREIGN KEY (parent_id) REFERENCES accounts(id)
) ENGINE=InnoDB;

CREATE INDEX idx_accounts_category ON accounts(category);
CREATE INDEX idx_accounts_parent ON accounts(parent_id);

-- Periode akuntansi (bulan berjalan/tutup buku). Lapis 1 baru menyiapkan
-- tabel + pengecekan ringan di postJournalEntry (tolak posting ke periode
-- 'closed'); alur tutup periode dari admin belum dibangun (menyusul di lapis
-- lanjutan kalau dibutuhkan) — kalau belum ada baris utk suatu bulan,
-- dianggap terbuka (default permisif, bukan blokir).
DROP TABLE IF EXISTS accounting_periods;
CREATE TABLE accounting_periods (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  branch_id     INT          NOT NULL DEFAULT 1,
  period_year   INT          NOT NULL,
  period_month  INT          NOT NULL,               -- 1-12
  status        ENUM('open','closed') NOT NULL DEFAULT 'open',
  closed_at     DATETIME     NULL,
  closed_by     CHAR(36)     NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_periods_closed_by FOREIGN KEY (closed_by) REFERENCES users(id),
  UNIQUE KEY uq_period (branch_id, period_year, period_month)
) ENGINE=InnoDB;

-- Header jurnal. source_type/source_uuid melacak asal jurnal (mis. 'sale' +
-- sales.id) TANPA foreign key formal (sumbernya beda-beda tabel) — dipakai
-- lapis lanjutan (auto-posting) utk telusur balik. reversed_entry_id diisi
-- HANYA pada jurnal pembalik, menunjuk entry asal yang dibalik (void = jurnal
-- baru yang membalik, BUKAN hapus/edit jurnal lama — jejak audit utuh).
DROP TABLE IF EXISTS journal_entries;
CREATE TABLE journal_entries (
  id                 CHAR(36)     NOT NULL PRIMARY KEY,
  branch_id          INT          NOT NULL DEFAULT 1,
  entry_number       VARCHAR(30)  NOT NULL UNIQUE,    -- mis. JE1-20260724-143022123
  entry_date         DATE         NOT NULL,
  description        VARCHAR(255) NOT NULL,
  source_type        VARCHAR(30)  NOT NULL,           -- 'sale' | 'void' | 'manual' | 'depreciation' | dst
  source_uuid        CHAR(36)     NULL,
  reversed_entry_id  CHAR(36)     NULL,
  status             ENUM('posted','reversed') NOT NULL DEFAULT 'posted',
  created_by         CHAR(36)     NOT NULL,
  sync_status        VARCHAR(20)  NOT NULL DEFAULT 'local_only',
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_journal_entries_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_journal_entries_reversed FOREIGN KEY (reversed_entry_id) REFERENCES journal_entries(id)
) ENGINE=InnoDB;

CREATE INDEX idx_journal_entries_date ON journal_entries(entry_date);
CREATE INDEX idx_journal_entries_source ON journal_entries(source_type, source_uuid);

-- Baris jurnal. debit/credit DECIMAL(18,4) (bukan INT) karena baris HPP
-- mengalirkan cost_per_base_unit snapshot yang presisinya desimal, bukan
-- cuma rupiah bulat (Prinsip 4 & 5 blueprint) — satu baris cuma boleh isi
-- salah satu (debit XOR credit), ditegakkan di AccountingService, bukan di
-- constraint SQL (biar pesan error rapi lewat HttpError).
DROP TABLE IF EXISTS journal_entry_lines;
CREATE TABLE journal_entry_lines (
  id                  CHAR(36)      NOT NULL PRIMARY KEY,
  journal_entry_id    CHAR(36)      NOT NULL,
  account_id          CHAR(36)      NOT NULL,
  debit               DECIMAL(18,4) NOT NULL DEFAULT 0,
  credit              DECIMAL(18,4) NOT NULL DEFAULT 0,
  description          VARCHAR(255) NULL,
  line_order          INT           NOT NULL DEFAULT 0,
  sync_status         VARCHAR(20)   NOT NULL DEFAULT 'local_only',
  created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_journal_lines_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  CONSTRAINT fk_journal_lines_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB;

CREATE INDEX idx_journal_lines_entry ON journal_entry_lines(journal_entry_id);
CREATE INDEX idx_journal_lines_account ON journal_entry_lines(account_id);

-- Aset tetap (feature/accounting Lapis 3). Diperlakukan sbg tabel transaksi
-- (branch_id + sync_status) karena tiap baris = satu peristiwa perolehan
-- aset sungguhan, bukan master data statis. 3 referensi akun disimpan
-- eksplisit per aset (bukan hardcode di kode) supaya toko bisa punya
-- beberapa kelompok aset (Peralatan Toko vs Kendaraan) dgn akun
-- masing-masing.
DROP TABLE IF EXISTS fixed_assets;
CREATE TABLE fixed_assets (
  id                                   CHAR(36)      NOT NULL PRIMARY KEY,
  branch_id                            INT           NOT NULL DEFAULT 1,
  name                                 VARCHAR(150)  NOT NULL,
  asset_account_id                     CHAR(36)      NOT NULL,
  accumulated_depreciation_account_id  CHAR(36)      NOT NULL,
  depreciation_expense_account_id      CHAR(36)      NOT NULL,
  acquisition_date                     DATE          NOT NULL,
  acquisition_cost                     DECIMAL(18,4) NOT NULL,   -- harga perolehan
  residual_value                       DECIMAL(18,4) NOT NULL DEFAULT 0,  -- nilai residu
  useful_life_months                   INT           NOT NULL,   -- masa manfaat (bulan)
  is_active                            TINYINT(1)    NOT NULL DEFAULT 1,
  sync_status                          VARCHAR(20)   NOT NULL DEFAULT 'local_only',
  created_by                           CHAR(36)      NOT NULL,
  created_at                           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_fixed_assets_asset_account FOREIGN KEY (asset_account_id) REFERENCES accounts(id),
  CONSTRAINT fk_fixed_assets_accum_dep_account FOREIGN KEY (accumulated_depreciation_account_id) REFERENCES accounts(id),
  CONSTRAINT fk_fixed_assets_dep_expense_account FOREIGN KEY (depreciation_expense_account_id) REFERENCES accounts(id),
  CONSTRAINT fk_fixed_assets_created_by FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- Ledger "sudah didepresiasi bulan apa saja" per aset — INI mekanisme utama
-- pencegah depresiasi dobel. UNIQUE(fixed_asset_id, period_year, period_month)
-- menolak di level database kalau ada percobaan menjurnal ulang aset yang
-- sama utk periode yang sama, bukan cuma dicek di kode servis (jaring
-- pengaman kalau ada race condition).
DROP TABLE IF EXISTS fixed_asset_depreciation_entries;
CREATE TABLE fixed_asset_depreciation_entries (
  id                   CHAR(36)      NOT NULL PRIMARY KEY,
  fixed_asset_id       CHAR(36)      NOT NULL,
  period_year          INT           NOT NULL,
  period_month         INT           NOT NULL,
  depreciation_amount  DECIMAL(18,4) NOT NULL,
  journal_entry_id     CHAR(36)      NOT NULL,
  created_by           CHAR(36)      NOT NULL,
  created_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_dep_entries_asset FOREIGN KEY (fixed_asset_id) REFERENCES fixed_assets(id),
  CONSTRAINT fk_dep_entries_journal FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  CONSTRAINT fk_dep_entries_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  UNIQUE KEY uq_asset_period (fixed_asset_id, period_year, period_month)
) ENGINE=InnoDB;

-- Penanda "sudah pernah dijalankan" utk proses jurnal saldo awal (mis.
-- persediaan) yang MEMANG cuma boleh jalan sekali. UNIQUE(balance_type)
-- adalah pengaman level-database yang sesungguhnya — sama seperti
-- UNIQUE(fixed_asset_id, period_year, period_month) di atas, ini yang
-- menjamin tidak dobel walau ada race condition, bukan cuma cek di kode.
DROP TABLE IF EXISTS opening_balance_runs;
CREATE TABLE opening_balance_runs (
  id                CHAR(36)     NOT NULL PRIMARY KEY,
  balance_type      VARCHAR(50)  NOT NULL UNIQUE,   -- 'inventory' (bisa nambah jenis lain nanti)
  journal_entry_id  CHAR(36)     NOT NULL,
  created_by        CHAR(36)     NOT NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_opening_balance_runs_journal FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  CONSTRAINT fk_opening_balance_runs_created_by FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- Draft nota ("park sale") — kasir simpan keranjang berjalan supaya bisa
-- melayani pembeli lain dulu, lalu panggil lagi nanti. BELUM memotong stok
-- dan BELUM jadi penjualan sama sekali (tidak ada baris di sales/sale_items,
-- tidak ada stock_movements) — cuma snapshot ringan {productId, unitId,
-- quantity, priceLevelId} per item. Stok & harga divalidasi ULANG dari nol
-- (lewat endpoint quote/checkout yang sudah ada) begitu draft dipanggil dan
-- di-checkout, karena stok bisa saja sudah berubah sejak draft dibuat
-- (feedback klien Batch 2 poin 1).
DROP TABLE IF EXISTS sale_drafts;
CREATE TABLE sale_drafts (
  id                CHAR(36)     NOT NULL PRIMARY KEY,
  branch_id         INT          NOT NULL DEFAULT 1,
  cashier_shift_id  CHAR(36)     NOT NULL,
  user_id           CHAR(36)     NOT NULL,
  label             VARCHAR(100) NULL,
  items_json        JSON         NOT NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_sale_drafts_shift FOREIGN KEY (cashier_shift_id) REFERENCES cashier_shifts(id),
  CONSTRAINT fk_sale_drafts_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE INDEX idx_sale_drafts_shift ON sale_drafts(cashier_shift_id);

-- ----------------------------------------------------------------------------
-- MARKUP HARGA OTOMATIS (Batch 3A) — lihat PricingEngineService utk aturan
-- lengkap. Singkatnya: kalau auto_pricing_enabled ON, setiap kali HPP
-- rata-rata sebuah produk berubah (pembelian/void pembelian/opname),
-- product_prices dihitung ulang = HPP-di-satuan-itu * (1 + markup% level),
-- tidak pernah di bawah HPP, tidak dibulatkan, baris is_locked=1 dilewati.
-- ----------------------------------------------------------------------------

-- Singleton (1 baris, branch_id=1) — toggle global dulu (bukan per produk),
-- sesuai keputusan "buat global dulu, sederhana".
DROP TABLE IF EXISTS pricing_settings;
-- ppn_rate/ppn_mode NULL = belum pernah diatur admin (dianggap sama dgn OFF
-- selama ppn_enabled=0 — lihat PricingSettingsService).
CREATE TABLE pricing_settings (
  branch_id             INT        NOT NULL PRIMARY KEY DEFAULT 1,
  auto_pricing_enabled  TINYINT(1) NOT NULL DEFAULT 0,
  ppn_enabled           TINYINT(1) NOT NULL DEFAULT 0,
  ppn_rate              DECIMAL(8,4) NULL,
  ppn_mode              VARCHAR(10)  NULL,   -- 'exclude' | 'included'
  updated_at            DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by            CHAR(36)   NULL,
  CONSTRAINT fk_pricing_settings_user FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- Notifikasi WAJIB (bukan toast yang hilang) — 1 baris per produk per
-- kejadian HPP berubah yang BENAR-BENAR menghasilkan >=1 perubahan harga
-- (kalau tidak ada baris harga yang berubah, tidak ada event yang dibuat -
-- lihat PricingEngineService). Rincian per level ada di
-- price_change_event_lines.
DROP TABLE IF EXISTS price_change_events;
CREATE TABLE price_change_events (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  branch_id       INT           NOT NULL DEFAULT 1,
  product_id      CHAR(36)      NOT NULL,
  warehouse_id    CHAR(36)      NOT NULL,
  old_avg_cost    DECIMAL(18,4) NOT NULL,
  new_avg_cost    DECIMAL(18,4) NOT NULL,
  trigger_source  VARCHAR(30)   NOT NULL,   -- 'purchase' | 'purchase_void' | 'opname'
  reference_type  VARCHAR(30)   NULL,
  reference_uuid  CHAR(36)      NULL,
  is_read         TINYINT(1)    NOT NULL DEFAULT 0,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_price_change_events_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_price_change_events_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
) ENGINE=InnoDB;

CREATE INDEX idx_price_change_events_created ON price_change_events(created_at);
CREATE INDEX idx_price_change_events_read ON price_change_events(is_read);

-- product_price_id NULLABLE + ON DELETE SET NULL (bukan RESTRICT/CASCADE) —
-- ini catatan AUDIT (harga lama/baru sudah disalin sbg kolom sendiri, tidak
-- bergantung baca ulang baris product_prices), jadi kalau baris harga itu
-- suatu saat dihapus admin, riwayat notifikasi TETAP ada (bukan ikut hilang
-- atau memblokir penghapusan).
DROP TABLE IF EXISTS price_change_event_lines;
CREATE TABLE price_change_event_lines (
  id                CHAR(36)      NOT NULL PRIMARY KEY,
  event_id          CHAR(36)      NOT NULL,
  product_price_id  CHAR(36)      NULL,
  unit_id           CHAR(36)      NOT NULL,
  price_level_id    CHAR(36)      NOT NULL,
  markup_percent    DECIMAL(8,4)  NOT NULL,
  old_price         DECIMAL(14,4) NOT NULL,
  new_price         DECIMAL(14,4) NOT NULL,
  CONSTRAINT fk_pcel_event FOREIGN KEY (event_id) REFERENCES price_change_events(id),
  CONSTRAINT fk_pcel_price FOREIGN KEY (product_price_id) REFERENCES product_prices(id) ON DELETE SET NULL,
  CONSTRAINT fk_pcel_unit FOREIGN KEY (unit_id) REFERENCES units(id),
  CONSTRAINT fk_pcel_level FOREIGN KEY (price_level_id) REFERENCES price_levels(id)
) ENGINE=InnoDB;

CREATE INDEX idx_pcel_event ON price_change_event_lines(event_id);

SET FOREIGN_KEY_CHECKS = 1;
