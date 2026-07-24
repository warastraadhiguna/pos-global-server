// Seed data demo — tema "Toko Plastik" (retail plastik & perlengkapan
// sekali pakai), supaya database tidak kosong saat demo presentasi.
// Roles, admin, kasir contoh, warehouse, price level: data dasar wajib ada.
// Produk: 6 item realistis dengan multi satuan pcs/lusin/dus (konversi beda
// per produk sesuai ukuran kemasan bulk sungguhan), harga ecer & grosir
// bertingkat, dan stok awal.
// Password/PIN default HANYA untuk development — wajib diganti sebelum
// deploy ke mesin produksi toko (lihat Bagian 9 protokol eskalasi poin 6).

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const { applyStockMovement } = require('../services/StockMovementService');

const DEV_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'admin123';
const DEV_CASHIER_PIN = process.env.SEED_CASHIER_PIN || '1234';

// dusPerLusin = berapa lusin per 1 dus (beda-beda per produk, sesuai ukuran
// kemasan bulk sungguhan di lapangan).
const PRODUCTS = [
  {
    name: 'Sendok Plastik', sku: 'SKU-SDK-001', category: 'Alat Makan Sekali Pakai',
    dusPerLusin: 12, costPerPcs: 180, openingStockPcs: 2000,
    barcodePcs: '8991000100014', barcodeDus: '8991000100021',
    ecerPcs: 300, grosirPcs: 250, grosirMinLusin: 1, ecerLusin: 3000, ecerDus: 33000,
  },
  {
    name: 'Garpu Plastik', sku: 'SKU-GRP-001', category: 'Alat Makan Sekali Pakai',
    dusPerLusin: 12, costPerPcs: 180, openingStockPcs: 2000,
    barcodePcs: '8991000200011', barcodeDus: '8991000200028',
    ecerPcs: 300, grosirPcs: 250, grosirMinLusin: 1, ecerLusin: 3000, ecerDus: 33000,
  },
  {
    name: 'Gelas Plastik 12oz', sku: 'SKU-GLS-001', category: 'Alat Makan Sekali Pakai',
    dusPerLusin: 40, costPerPcs: 320, openingStockPcs: 1500,
    barcodePcs: '8991000300018', barcodeDus: '8991000300025',
    ecerPcs: 500, grosirPcs: 450, grosirMinLusin: 2, ecerLusin: 5500, ecerDus: 200000,
  },
  {
    name: 'Piring Plastik Sedang', sku: 'SKU-PRG-001', category: 'Alat Makan Sekali Pakai',
    dusPerLusin: 20, costPerPcs: 550, openingStockPcs: 800,
    barcodePcs: '8991000400015', barcodeDus: '8991000400022',
    ecerPcs: 800, grosirPcs: 700, grosirMinLusin: 1, ecerLusin: 8500, ecerDus: 160000,
  },
  {
    name: 'Sedotan Plastik Bening', sku: 'SKU-SDT-001', category: 'Kemasan & Perlengkapan',
    dusPerLusin: 100, costPerPcs: 55, openingStockPcs: 5000,
    barcodePcs: '8991000500012', barcodeDus: '8991000500029',
    ecerPcs: 100, grosirPcs: 80, grosirMinLusin: 5, ecerLusin: 1000, ecerDus: 85000,
  },
  {
    name: 'Kantong Plastik Kresek Uk.20', sku: 'SKU-KRS-001', category: 'Kemasan & Perlengkapan',
    dusPerLusin: 20, costPerPcs: 90, openingStockPcs: 3000,
    barcodePcs: '8991000600019', barcodeDus: '8991000600026',
    ecerPcs: 150, grosirPcs: 120, grosirMinLusin: 1, ecerLusin: 1600, ecerDus: 32000,
  },
];

// COA ritel standar (feature/accounting Lapis 1). Struktur bertingkat: setiap
// grup header (is_postable=0) diikuti akun detailnya (is_postable=1, yang
// benar-benar boleh dijurnal). normal_balance akun kontra (Akumulasi
// Penyusutan, Prive, Retur Penjualan) sengaja kebalikan dari kategorinya —
// itu bukan typo, memang begitu cara kerja akun kontra.
const ACCOUNTS = [
  // --- 1. ASET ---
  { code: '1-100', name: 'Kas & Bank', category: 'asset', normalBalance: 'debit', postable: false },
  { code: '1-101', name: 'Kas', category: 'asset', normalBalance: 'debit', parent: '1-100' },
  { code: '1-102', name: 'Bank', category: 'asset', normalBalance: 'debit', parent: '1-100' },

  { code: '1-200', name: 'Piutang', category: 'asset', normalBalance: 'debit', postable: false },
  { code: '1-201', name: 'Piutang Usaha', category: 'asset', normalBalance: 'debit', parent: '1-200' },

  { code: '1-300', name: 'Persediaan', category: 'asset', normalBalance: 'debit', postable: false },
  { code: '1-301', name: 'Persediaan Barang Dagang', category: 'asset', normalBalance: 'debit', parent: '1-300' },

  { code: '1-400', name: 'Aset Tetap', category: 'asset', normalBalance: 'debit', postable: false },
  { code: '1-401', name: 'Peralatan Toko', category: 'asset', normalBalance: 'debit', parent: '1-400' },
  { code: '1-402', name: 'Kendaraan', category: 'asset', normalBalance: 'debit', parent: '1-400' },
  { code: '1-410', name: 'Akumulasi Penyusutan Peralatan Toko', category: 'asset', normalBalance: 'credit', parent: '1-400' },
  { code: '1-411', name: 'Akumulasi Penyusutan Kendaraan', category: 'asset', normalBalance: 'credit', parent: '1-400' },

  { code: '1-500', name: 'Aset Lancar Lainnya', category: 'asset', normalBalance: 'debit', postable: false },
  { code: '1-501', name: 'Biaya Dibayar Dimuka', category: 'asset', normalBalance: 'debit', parent: '1-500' },

  // --- 2. KEWAJIBAN ---
  { code: '2-100', name: 'Kewajiban Lancar', category: 'liability', normalBalance: 'credit', postable: false },
  { code: '2-101', name: 'Utang Usaha', category: 'liability', normalBalance: 'credit', parent: '2-100' },
  { code: '2-102', name: 'Utang Pajak', category: 'liability', normalBalance: 'credit', parent: '2-100' },
  { code: '2-103', name: 'Pendapatan Diterima Dimuka', category: 'liability', normalBalance: 'credit', parent: '2-100' },

  // --- 3. MODAL ---
  { code: '3-100', name: 'Modal', category: 'equity', normalBalance: 'credit', postable: false },
  { code: '3-101', name: 'Modal Pemilik', category: 'equity', normalBalance: 'credit', parent: '3-100' },
  { code: '3-102', name: 'Prive Pemilik', category: 'equity', normalBalance: 'debit', parent: '3-100' },
  { code: '3-103', name: 'Laba Ditahan', category: 'equity', normalBalance: 'credit', parent: '3-100' },

  // --- 4. PENDAPATAN ---
  { code: '4-100', name: 'Pendapatan Usaha', category: 'revenue', normalBalance: 'credit', postable: false },
  { code: '4-101', name: 'Penjualan', category: 'revenue', normalBalance: 'credit', parent: '4-100' },
  { code: '4-102', name: 'Retur & Potongan Penjualan', category: 'revenue', normalBalance: 'debit', parent: '4-100' },

  { code: '4-200', name: 'Pendapatan Lain-lain', category: 'revenue', normalBalance: 'credit', postable: false },
  { code: '4-201', name: 'Pendapatan Lain-lain', category: 'revenue', normalBalance: 'credit', parent: '4-200' },
  { code: '4-202', name: 'Keuntungan Selisih Persediaan', category: 'revenue', normalBalance: 'credit', parent: '4-200' },

  // --- 5. BEBAN ---
  { code: '5-100', name: 'Harga Pokok Penjualan', category: 'expense', normalBalance: 'debit', postable: false },
  { code: '5-101', name: 'Harga Pokok Penjualan', category: 'expense', normalBalance: 'debit', parent: '5-100' },

  { code: '5-200', name: 'Beban Operasional', category: 'expense', normalBalance: 'debit', postable: false },
  { code: '5-201', name: 'Beban Gaji', category: 'expense', normalBalance: 'debit', parent: '5-200' },
  { code: '5-202', name: 'Beban Sewa', category: 'expense', normalBalance: 'debit', parent: '5-200' },
  { code: '5-203', name: 'Beban Listrik & Air', category: 'expense', normalBalance: 'debit', parent: '5-200' },
  { code: '5-204', name: 'Beban Perlengkapan Toko', category: 'expense', normalBalance: 'debit', parent: '5-200' },
  { code: '5-205', name: 'Beban Penyusutan', category: 'expense', normalBalance: 'debit', parent: '5-200' },
  { code: '5-206', name: 'Beban Lain-lain', category: 'expense', normalBalance: 'debit', parent: '5-200' },
  { code: '5-207', name: 'Kerugian Selisih Persediaan', category: 'expense', normalBalance: 'debit', parent: '5-200' },
];

async function seedAccounts(conn) {
  const idByCode = {};
  // Dua pass: (1) insert semua header dulu supaya parent_id anak-anaknya
  // selalu sudah ada, (2) insert detail sambil resolve parent_id by kode.
  for (const a of ACCOUNTS.filter((x) => x.postable === false)) {
    const id = uuidv4();
    idByCode[a.code] = id;
    await conn.query(
      `INSERT INTO accounts (id, code, name, category, normal_balance, parent_id, is_postable) VALUES (?, ?, ?, ?, ?, NULL, 0)`,
      [id, a.code, a.name, a.category, a.normalBalance]
    );
  }
  for (const a of ACCOUNTS.filter((x) => x.postable !== false)) {
    const id = uuidv4();
    idByCode[a.code] = id;
    const parentId = a.parent ? idByCode[a.parent] : null;
    await conn.query(
      `INSERT INTO accounts (id, code, name, category, normal_balance, parent_id, is_postable) VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [id, a.code, a.name, a.category, a.normalBalance, parentId]
    );
  }
  return idByCode;
}

async function seed() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const adminRoleId = uuidv4();
    const kasirRoleId = uuidv4();
    await conn.query(
      `INSERT INTO roles (id, name) VALUES (?, 'admin'), (?, 'kasir')`,
      [adminRoleId, kasirRoleId]
    );

    const adminId = uuidv4();
    const adminPasswordHash = await bcrypt.hash(DEV_ADMIN_PASSWORD, 10);
    await conn.query(
      `INSERT INTO users (id, branch_id, role_id, username, full_name, password_hash, is_active)
       VALUES (?, 1, ?, 'admin', 'Administrator', ?, 1)`,
      [adminId, adminRoleId, adminPasswordHash]
    );

    const kasirId = uuidv4();
    const kasirPinHash = await bcrypt.hash(DEV_CASHIER_PIN, 10);
    await conn.query(
      `INSERT INTO users (id, branch_id, role_id, username, full_name, pin_hash, is_active)
       VALUES (?, 1, ?, NULL, 'Kasir Contoh', ?, 1)`,
      [kasirId, kasirRoleId, kasirPinHash]
    );

    const warehouseId = uuidv4();
    await conn.query(
      `INSERT INTO warehouses (id, branch_id, name, is_active) VALUES (?, 1, 'Gudang Utama', 1)`,
      [warehouseId]
    );

    const unitPcsId = uuidv4();
    const unitLusinId = uuidv4();
    const unitDusId = uuidv4();
    await conn.query(
      `INSERT INTO units (id, name) VALUES (?, 'pcs'), (?, 'lusin'), (?, 'dus')`,
      [unitPcsId, unitLusinId, unitDusId]
    );

    const priceLevelEcerId = uuidv4();
    const priceLevelGrosirId = uuidv4();
    await conn.query(
      `INSERT INTO price_levels (id, name) VALUES (?, 'ecer'), (?, 'grosir')`,
      [priceLevelEcerId, priceLevelGrosirId]
    );

    // Metode pembayaran standar — bisa ditambah/diubah lewat admin panel.
    // Tunai wajib is_cash=1 (dipakai rekonsiliasi kas shift); metode lain
    // (QRIS, kartu) is_cash=0, tidak masuk hitungan kas fisik laci.
    const paymentMethods = [
      { name: 'Tunai', isCash: 1 },
      { name: 'QRIS', isCash: 0 },
      { name: 'Kartu Debit', isCash: 0 },
    ];
    for (let i = 0; i < paymentMethods.length; i++) {
      await conn.query(
        `INSERT INTO payment_methods (id, name, is_cash, sort_order) VALUES (?, ?, ?, ?)`,
        [uuidv4(), paymentMethods[i].name, paymentMethods[i].isCash, i]
      );
    }

    // COA ritel standar (feature/accounting Lapis 1) + buka periode akuntansi
    // bulan berjalan.
    await seedAccounts(conn);
    const now = new Date();
    await conn.query(
      `INSERT INTO accounting_periods (id, branch_id, period_year, period_month, status) VALUES (?, 1, ?, ?, 'open')`,
      [uuidv4(), now.getFullYear(), now.getMonth() + 1]
    );

    // Pecahan uang standar utk tombol shortcut "uang diterima" di kasir —
    // bisa diatur ulang lewat admin panel.
    const denominations = [5000, 10000, 20000, 50000, 100000];
    for (let i = 0; i < denominations.length; i++) {
      await conn.query(
        `INSERT INTO cash_denominations (id, amount, sort_order) VALUES (?, ?, ?)`,
        [uuidv4(), denominations[i], i]
      );
    }

    const categoryIds = {};
    for (const categoryName of [...new Set(PRODUCTS.map((p) => p.category))]) {
      const id = uuidv4();
      categoryIds[categoryName] = id;
      await conn.query(`INSERT INTO product_categories (id, name) VALUES (?, ?)`, [id, categoryName]);
    }

    for (const p of PRODUCTS) {
      const productId = uuidv4();
      await conn.query(
        `INSERT INTO products (id, category_id, base_unit_id, sku, name, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [productId, categoryIds[p.category], unitPcsId, p.sku, p.name]
      );

      const dusConversion = 12 * p.dusPerLusin; // dus -> pcs, lewat lusin(12 pcs) x dusPerLusin
      await conn.query(
        `INSERT INTO product_units (id, product_id, unit_id, conversion_factor, is_base_unit) VALUES
         (?, ?, ?, 1, 1), (?, ?, ?, 12, 0), (?, ?, ?, ?, 0)`,
        [
          uuidv4(), productId, unitPcsId,
          uuidv4(), productId, unitLusinId,
          uuidv4(), productId, unitDusId, dusConversion,
        ]
      );

      await conn.query(
        `INSERT INTO barcodes (id, product_id, unit_id, barcode) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
        [
          uuidv4(), productId, unitPcsId, p.barcodePcs,
          uuidv4(), productId, unitDusId, p.barcodeDus,
        ]
      );

      await conn.query(
        `INSERT INTO product_prices (id, product_id, unit_id, price_level_id, min_qty_base, price) VALUES
         (?, ?, ?, ?, 0, ?),
         (?, ?, ?, ?, ?, ?),
         (?, ?, ?, ?, 0, ?),
         (?, ?, ?, ?, 0, ?)`,
        [
          uuidv4(), productId, unitPcsId, priceLevelEcerId, p.ecerPcs,
          uuidv4(), productId, unitPcsId, priceLevelGrosirId, p.grosirMinLusin * 12, p.grosirPcs,
          uuidv4(), productId, unitLusinId, priceLevelEcerId, p.ecerLusin,
          uuidv4(), productId, unitDusId, priceLevelEcerId, p.ecerDus,
        ]
      );

      await applyStockMovement(conn, {
        warehouseId,
        productId,
        movementType: 'opening_balance',
        referenceType: 'seed',
        qtyInBase: p.openingStockPcs,
        costPerBaseUnit: p.costPerPcs,
        movementDate: new Date(),
      });
    }

    await conn.commit();

    console.log('Seed selesai — Toko Plastik demo dataset:');
    console.log(`  Admin login   -> username: admin / password: ${DEV_ADMIN_PASSWORD}`);
    console.log(`  Kasir login   -> nama: "Kasir Contoh" / PIN: ${DEV_CASHIER_PIN}`);
    console.log(`  Warehouse id  : ${warehouseId}`);
    console.log(`  COA           : ${ACCOUNTS.length} akun (feature/accounting Lapis 1), periode ${now.getMonth() + 1}/${now.getFullYear()} dibuka`);
    console.log('  Produk demo   :');
    for (const p of PRODUCTS) {
      console.log(`    - ${p.name} | pcs: ${p.barcodePcs} | dus: ${p.barcodeDus} | stok awal: ${p.openingStockPcs} pcs`);
    }
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Seed gagal:', err);
  process.exit(1);
});
