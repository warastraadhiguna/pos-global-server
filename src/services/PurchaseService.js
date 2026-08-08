// Pembelian (feature/accounting, fase Pembelian & Stock Opname — Bagian A).
// Penerimaan barang WAJIB lewat StockMovementService.applyStockMovement yang
// sudah ada (satu-satunya jalur tulis stock_movements/stock_balances,
// sama seperti SalesService/VoidService) — tidak ada jalur tulis stok baru
// di sini. Jurnal WAJIB lewat AccountingService.postJournalEntry, dalam
// transaksi yang sama dengan penerimaan barang: kalau jurnal gagal, seluruh
// pembelian (termasuk perubahan stok/avg cost) ikut rollback.
const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');
const { applyStockMovement } = require('./StockMovementService');
const { getDefaultWarehouseId } = require('./WarehouseService');
const AccountingService = require('./AccountingService');
const { logActivity } = require('./AuthService');
const { recalculatePricesForProduct } = require('./PricingEngineService');
const StoreSettingsService = require('./StoreSettingsService');

const BRANCH_ID = 1;
const PERSEDIAAN_CODE = '1-301';
const KAS_CODE = '1-101';
const UTANG_USAHA_CODE = '2-101';
const PPN_MASUKAN_CODE = '1-502';

// PPN pembelian diset PER TRANSAKSI saat input (supplier/nota beda-beda:
// exclude, included, atau tanpa PPN sama sekali) — beda dari PPN Keluaran
// penjualan yang pakai tarif/mode GLOBAL dari pricing_settings.
//
// taxMode menentukan KEMANA PPN itu pergi (Part C):
//  - 'pkp': PPN Masukan DIPISAH dari nilai persediaan (dpp = tax-exclusive,
//    ppnAmount jadi akun PPN Masukan tersendiri, bisa dikreditkan).
//  - 'non_pkp': PPN MELEBUR ke nilai persediaan — tidak bisa dikreditkan,
//    jadi bagian dari HPP. ppnAmount SELALU 0 di sini (tidak ada akun
//    terpisah); field `dpp` di mode ini berarti "nilai yg didebit ke
//    Persediaan" (nilai PENUH termasuk PPN), bukan dasar pengenaan pajak
//    dalam arti pajak yg sesungguhnya — cuma dipakai ulang nama kolomnya
//    supaya schema/kode tidak perlu kolom terpisah lagi.
//
// Pembulatan: nilai yg didebit ke Persediaan dibulatkan LEBIH DULU ke
// rupiah utuh (sekali, di header) — pola sama persis dgn SalesService.
// applyPpn, supaya jurnal selalu balance persis.
function applyPurchasePpn(nilaiPembelian, ppnMode, ppnRate, taxMode) {
  if (!ppnMode) {
    return {
      ppnApplied: false, dpp: nilaiPembelian, ppnAmount: new Decimal(0),
      grandTotal: nilaiPembelian, ppnRate: null, ppnMode: null,
    };
  }
  const rate = new Decimal(ppnRate);

  if (taxMode === 'pkp') {
    if (ppnMode === 'exclude') {
      const dpp = nilaiPembelian; // yg diketik admin sudah basis DPP, PPN ditambahkan di atas
      const ppnAmount = dpp.mul(rate.div(100)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      const grandTotal = dpp.plus(ppnAmount);
      return { ppnApplied: true, dpp, ppnAmount, grandTotal, ppnRate: rate, ppnMode };
    }
    // included — yg diketik admin sudah termasuk PPN
    const dppRaw = nilaiPembelian.div(rate.div(100).plus(1));
    const dpp = dppRaw.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const ppnAmount = nilaiPembelian.minus(dpp);
    return { ppnApplied: true, dpp, ppnAmount, grandTotal: nilaiPembelian, ppnRate: rate, ppnMode };
  }

  // non_pkp — PPN melebur ke HPP, TIDAK ADA akun PPN Masukan.
  if (ppnMode === 'exclude') {
    // yg diketik BELUM termasuk PPN -> PPN ditambahkan, tapi hasilnya
    // LEBUR jadi satu nilai persediaan (beda dari PKP yg memisahkannya).
    const grossTotal = nilaiPembelian.mul(rate.div(100).plus(1)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    return { ppnApplied: true, dpp: grossTotal, ppnAmount: new Decimal(0), grandTotal: grossTotal, ppnRate: rate, ppnMode };
  }
  // included — yg diketik SUDAH nilai penuh (termasuk PPN), dipakai apa adanya.
  return { ppnApplied: true, dpp: nilaiPembelian, ppnAmount: new Decimal(0), grandTotal: nilaiPembelian, ppnRate: rate, ppnMode };
}

// Faktor pengali cost_per_unit -> basis yg BENAR-BENAR masuk avg cost,
// dipakai PER ITEM (StockMovementService). Dihitung dari rate transaksi
// ini langsung (bukan proporsi dari total header) — krn tarif SATU utk
// seluruh pembelian ini, jadi pembagian per-item exact secara matematis
// identik dgn alokasi proporsional dari total, tanpa perlu 2 pass.
//
// PKP: basis DPP (exclude=1 krn cost_per_unit yg diketik SUDAH basis DPP;
// included=strip PPN keluar). non_pkp: basis GROSS/nilai penuh — KEBALIKAN
// (exclude=PPN ditambahkan ke cost_per_unit; included=1 krn sudah nilai
// penuh) — inilah cara PPN "melebur" ke avg cost di mode non-PKP.
function resolveInventoryCostMultiplier(taxMode, ppnMode, ppnRate) {
  if (!ppnMode) return new Decimal(1);
  const rate = new Decimal(ppnRate);
  if (taxMode === 'pkp') {
    return ppnMode === 'included' ? new Decimal(1).div(rate.div(100).plus(1)) : new Decimal(1);
  }
  return ppnMode === 'exclude' ? rate.div(100).plus(1) : new Decimal(1);
}

function generatePurchaseNumber() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const randomPart = Math.floor(100000 + Math.random() * 900000); // lihat catatan di AccountingService.generateEntryNumber
  return `PO${BRANCH_ID}-${datePart}-${timePart}${randomPart}`;
}

async function listPurchases() {
  const [rows] = await pool.query(
    `SELECT p.id, p.purchase_number, p.purchase_date, p.dpp, p.ppn_mode, p.ppn_amount, p.grand_total, p.status,
            s.name AS supplier_name, w.name AS warehouse_name, u.full_name AS user_name,
            pp.payment_type
     FROM purchases p
     JOIN suppliers s ON s.id = p.supplier_id
     JOIN warehouses w ON w.id = p.warehouse_id
     JOIN users u ON u.id = p.user_id
     LEFT JOIN purchase_payments pp ON pp.purchase_id = p.id
     ORDER BY p.created_at DESC`
  );
  return rows;
}

async function getPurchaseDetail(purchaseId) {
  const [[purchase]] = await pool.query(
    `SELECT p.*, s.name AS supplier_name, w.name AS warehouse_name
     FROM purchases p JOIN suppliers s ON s.id = p.supplier_id JOIN warehouses w ON w.id = p.warehouse_id
     WHERE p.id = ?`,
    [purchaseId]
  );
  if (!purchase) throw new HttpError(404, 'purchase_not_found', 'Pembelian tidak ditemukan');

  const [items] = await pool.query(
    `SELECT pi.*, pr.name AS product_name, un.name AS unit_name
     FROM purchase_items pi JOIN products pr ON pr.id = pi.product_id JOIN units un ON un.id = pi.unit_id
     WHERE pi.purchase_id = ?`,
    [purchaseId]
  );
  const [[payment]] = await pool.query(`SELECT * FROM purchase_payments WHERE purchase_id = ?`, [purchaseId]);

  return { ...purchase, items, payment };
}

// items: [{ productId, unitId, quantity, costPerUnit }] — quantity dalam
// satuan yang DIBELI (mis. dus), costPerUnit = harga beli per satuan itu
// (rupiah). Konversi ke base unit (utk stok/HPP) diambil dari
// product_units.conversion_factor — WAJIB ada dulu (didaftarkan lewat admin
// produk), bukan diketik manual saat pembelian.
// ppnMode/ppnRate (opsional): PPN pembelian INI SAJA. Perlakuannya ikut
// tax_mode toko SAAT INI (StoreSettingsService) — PKP: dipisah jadi PPN
// Masukan (akun 1-502). non_pkp: melebur ke nilai persediaan/HPP, tidak
// ada akun terpisah (Part C). null/undefined = pembelian ini tanpa PPN
// sama sekali (mis. supplier bukan PKP), berlaku sama di kedua mode.
async function createPurchase({ supplierId, purchaseDate, items, paymentType, ppnMode, ppnRate, userId }) {
  if (!supplierId) throw new HttpError(400, 'bad_request', 'supplierId wajib diisi');
  if (!purchaseDate) throw new HttpError(400, 'bad_request', 'purchaseDate wajib diisi');
  if (!items || items.length === 0) throw new HttpError(400, 'bad_request', 'Item pembelian tidak boleh kosong');
  if (!['cash', 'credit'].includes(paymentType)) {
    throw new HttpError(400, 'bad_request', 'paymentType harus "cash" atau "credit"');
  }

  const storeSettings = await StoreSettingsService.getSettings();
  const taxMode = storeSettings.tax_mode;

  let normalizedPpnMode = null;
  let normalizedPpnRate = null;
  if (ppnMode !== undefined && ppnMode !== null && ppnMode !== '') {
    if (ppnMode !== 'exclude' && ppnMode !== 'included') {
      throw new HttpError(400, 'bad_request', `ppnMode harus 'exclude' atau 'included'`);
    }
    const rateNum = Number(ppnRate);
    if (!Number.isFinite(rateNum) || rateNum < 0) {
      throw new HttpError(400, 'bad_request', 'ppnRate wajib diisi (>= 0) kalau ppnMode diisi');
    }
    normalizedPpnMode = ppnMode;
    normalizedPpnRate = rateNum;
  }
  const costMultiplier = resolveInventoryCostMultiplier(taxMode, normalizedPpnMode, normalizedPpnRate);

  const purchaseId = uuidv4();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const warehouseId = await getDefaultWarehouseId(conn);

    const [[supplier]] = await conn.query(`SELECT id, is_active FROM suppliers WHERE id = ?`, [supplierId]);
    if (!supplier || !supplier.is_active) {
      throw new HttpError(400, 'invalid_supplier', 'Supplier tidak valid atau sudah nonaktif');
    }

    let subtotalSum = new Decimal(0);
    const itemRows = [];

    for (const item of items) {
      const quantity = new Decimal(item.quantity);
      const costPerUnit = new Decimal(item.costPerUnit);
      if (quantity.lte(0)) throw new HttpError(400, 'bad_request', 'Qty pembelian harus > 0');
      if (costPerUnit.lte(0)) throw new HttpError(400, 'bad_request', 'Harga beli harus > 0');

      const [[productUnit]] = await conn.query(
        `SELECT conversion_factor FROM product_units WHERE product_id = ? AND unit_id = ? LIMIT 1`,
        [item.productId, item.unitId]
      );
      if (!productUnit) {
        throw new HttpError(400, 'invalid_unit', `Satuan tidak valid untuk produk ${item.productId}`);
      }
      const conversionFactor = new Decimal(productUnit.conversion_factor);
      const quantityBase = quantity.mul(conversionFactor);
      // Basis DPP (PKP) atau basis nilai-penuh/PPN melebur (non-PKP) — lihat
      // resolveInventoryCostMultiplier & catatan schema.sql purchase_items.
      // INI yang dipakai avg cost, BUKAN cost_per_unit apa adanya diketik.
      const costPerBaseUnit = costPerUnit.div(conversionFactor).mul(costMultiplier);
      const subtotal = costPerUnit.mul(quantity); // apa adanya diketik — dijumlah jadi nilaiPembelian header

      // Saldo SEBELUM menerima barang — dilaporkan balik ke caller supaya
      // admin bisa lihat efek moving average cost-nya (bukan cuma "berhasil").
      const [[balanceBefore]] = await conn.query(
        `SELECT qty_base, avg_cost_per_base_unit FROM stock_balances WHERE warehouse_id = ? AND product_id = ?`,
        [warehouseId, item.productId]
      );
      const qtyBaseBefore = balanceBefore ? new Decimal(balanceBefore.qty_base) : new Decimal(0);
      const avgCostBefore = balanceBefore ? new Decimal(balanceBefore.avg_cost_per_base_unit) : new Decimal(0);

      // SATU-SATUNYA jalur terima barang — StockMovementService yang sudah
      // ada, moving average dihitung ulang otomatis di dalamnya.
      const { avgCostPerBaseUnit: avgCostAfter, qtyBase: qtyBaseAfter } = await applyStockMovement(conn, {
        warehouseId,
        productId: item.productId,
        movementType: 'purchase',
        referenceType: 'purchase',
        referenceUuid: purchaseId,
        qtyInBase: quantityBase.toFixed(4),
        costPerBaseUnit: costPerBaseUnit.toFixed(4),
        movementDate: purchaseDate,
      });

      // Markup otomatis (Batch 3A) — HPP produk ini baru saja berubah lewat
      // pembelian, hitung ulang harga jual semua level (kalau fitur ON).
      // No-op (return cepat) kalau auto_pricing_enabled=0.
      await recalculatePricesForProduct(conn, {
        productId: item.productId,
        warehouseId,
        oldAvgCost: avgCostBefore.toFixed(4),
        newAvgCost: avgCostAfter.toFixed(4),
        triggerSource: 'purchase',
        referenceType: 'purchase',
        referenceUuid: purchaseId,
      });

      itemRows.push({
        id: uuidv4(),
        productId: item.productId,
        unitId: item.unitId,
        quantity: quantity.toFixed(4),
        conversionFactor: conversionFactor.toFixed(4),
        quantityBase: quantityBase.toFixed(4),
        costPerUnit: costPerUnit.toFixed(0),
        costPerBaseUnit: costPerBaseUnit.toFixed(4),
        subtotal: subtotal.toFixed(0),
        qtyBaseBefore: qtyBaseBefore.toFixed(4),
        avgCostBefore: avgCostBefore.toFixed(4),
        qtyBaseAfter: qtyBaseAfter.toFixed(4),
        avgCostAfter: avgCostAfter.toFixed(4),
      });

      subtotalSum = subtotalSum.plus(subtotal);
    }

    const ppn = applyPurchasePpn(subtotalSum, normalizedPpnMode, normalizedPpnRate, taxMode);
    const purchaseNumber = generatePurchaseNumber();

    await conn.query(
      `INSERT INTO purchases (id, branch_id, purchase_number, supplier_id, warehouse_id, user_id, purchase_date, dpp, ppn_rate, ppn_mode, ppn_amount, grand_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        purchaseId, BRANCH_ID, purchaseNumber, supplierId, warehouseId, userId, purchaseDate,
        ppn.dpp.toFixed(0), ppn.ppnRate ? ppn.ppnRate.toFixed(4) : null, ppn.ppnMode, ppn.ppnAmount.toFixed(0), ppn.grandTotal.toFixed(0),
      ]
    );

    for (const row of itemRows) {
      await conn.query(
        `INSERT INTO purchase_items
          (id, purchase_id, product_id, unit_id, quantity, conversion_factor, quantity_base, cost_per_unit, cost_per_base_unit, subtotal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id, purchaseId, row.productId, row.unitId, row.quantity, row.conversionFactor,
          row.quantityBase, row.costPerUnit, row.costPerBaseUnit, row.subtotal,
        ]
      );
    }

    await conn.query(
      `INSERT INTO purchase_payments (id, purchase_id, payment_type, amount) VALUES (?, ?, ?, ?)`,
      [uuidv4(), purchaseId, paymentType, ppn.grandTotal.toFixed(0)]
    );

    // Jurnal — Debit Persediaan [+ Debit PPN Masukan kalau PKP & ada PPN],
    // Kredit Kas (tunai) atau Utang Usaha (kredit) sejumlah grandTotal.
    // non-PKP: ppn.ppnAmount SELALU 0 (dijamin applyPurchasePpn), jadi baris
    // PPN Masukan otomatis tidak pernah muncul — tanpa perlu percabangan
    // eksplisit di sini, cukup guard ppnAmount.gt(0) yang sudah ada.
    const persediaanAccount = await AccountingService.getAccountByCode(PERSEDIAAN_CODE, conn);
    const counterAccount = await AccountingService.getAccountByCode(
      paymentType === 'cash' ? KAS_CODE : UTANG_USAHA_CODE,
      conn
    );
    const persediaanDesc = taxMode === 'pkp' && ppn.ppnApplied ? 'Penerimaan barang (DPP)' : 'Penerimaan barang';
    const journalLines = [
      { accountId: persediaanAccount.id, debit: ppn.dpp, description: persediaanDesc },
    ];
    if (ppn.ppnAmount.gt(0)) {
      const ppnMasukanAccount = await AccountingService.getAccountByCode(PPN_MASUKAN_CODE, conn);
      journalLines.push({ accountId: ppnMasukanAccount.id, debit: ppn.ppnAmount, description: 'PPN Masukan' });
    }
    journalLines.push({
      accountId: counterAccount.id,
      credit: ppn.grandTotal,
      description: paymentType === 'cash' ? 'Dibayar tunai' : 'Dibeli kredit',
    });

    const journalEntry = await AccountingService.postJournalEntry(conn, {
      entryDate: purchaseDate,
      description: `Pembelian ${purchaseNumber}`,
      sourceType: 'purchase',
      sourceUuid: purchaseId,
      lines: journalLines,
      createdBy: userId,
    });

    await conn.commit();

    return {
      id: purchaseId,
      purchaseNumber,
      purchaseDate,
      warehouseId,
      dpp: ppn.dpp.toFixed(0),
      ppnRate: ppn.ppnRate ? ppn.ppnRate.toFixed(4) : null,
      ppnMode: ppn.ppnMode,
      ppnAmount: ppn.ppnAmount.toFixed(0),
      grandTotal: ppn.grandTotal.toFixed(0),
      paymentType,
      items: itemRows,
      journalEntry,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Transaksi lain (jual/opname/pembelian lain) yg terjadi pada produk-produk
// pembelian ini SEJAK pembelian dibuat — dilaporkan, TIDAK memblokir void.
// Pola sama persis dgn StockOpnameService.detectInterveningMovements.
// Movement milik pembelian ini sendiri (penerimaan asli + reversal void yg
// sedang dikerjakan) sengaja dikecualikan — itu bukan "transaksi lain".
async function detectInterveningMovements(conn, { warehouseId, productIds, sinceDate, purchaseId }) {
  if (productIds.length === 0) return [];
  const [rows] = await conn.query(
    `SELECT sm.product_id, p.name AS product_name, sm.movement_type, sm.reference_type,
            sm.qty_in_base, sm.qty_out_base, sm.created_at
     FROM stock_movements sm JOIN products p ON p.id = sm.product_id
     WHERE sm.warehouse_id = ? AND sm.product_id IN (${productIds.map(() => '?').join(',')})
       AND sm.created_at > ?
       AND NOT (sm.reference_type = 'purchase' AND sm.reference_uuid = ?)
     ORDER BY sm.created_at ASC`,
    [warehouseId, ...productIds, sinceDate, purchaseId]
  );
  return rows;
}

// Void = koreksi salah input, BUKAN transaksi bisnis (beda dari retur).
// Syarat (ditegakkan EKSPLISIT di awal, sebelum stok disentuh sama sekali):
//   1. Belum pernah di-void sebelumnya.
//   2. Periode (hari ini, saat void diproses) belum closed — dicek langsung
//      lewat AccountingService.assertPeriodOpen, BUKAN cuma mengandalkan
//      postJournalEntry menolak belakangan.
//   3. Utk tiap item: stok saat ini >= qty pembelian itu (kalau sudah
//      terjual sampai di bawah itu, tidak bisa di-void lagi — supaya stok
//      tidak pernah negatif).
// Stok dikembalikan lewat applyStockMovement mode reversal-nilai (movementType
// 'purchase_void', lihat StockMovementService) — BUKAN OUT biasa. Jurnal
// dibalik lewat AccountingService.reverseJournalEntry (entry asli tetap ada,
// status jadi 'reversed', persis pola void penjualan).
async function voidPurchase({ purchaseId, reason, userId }) {
  if (!reason || !reason.trim()) {
    throw new HttpError(400, 'bad_request', 'Alasan void wajib diisi');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[purchase]] = await conn.query(`SELECT * FROM purchases WHERE id = ? FOR UPDATE`, [purchaseId]);
    if (!purchase) throw new HttpError(404, 'purchase_not_found', 'Pembelian tidak ditemukan');
    if (purchase.status !== 'completed') {
      throw new HttpError(409, 'already_voided', 'Pembelian ini sudah di-void sebelumnya');
    }

    // Syarat #2 — cek periode EKSPLISIT di sini, sebelum apa pun disentuh.
    await AccountingService.assertPeriodOpen(conn, new Date());

    const [items] = await conn.query(`SELECT * FROM purchase_items WHERE purchase_id = ?`, [purchaseId]);

    // Syarat #3 — cek SEMUA item dulu sebelum mengubah satu pun (supaya
    // kalau ada satu item gagal syarat, tidak ada perubahan parsial).
    for (const item of items) {
      const [[balance]] = await conn.query(
        `SELECT qty_base FROM stock_balances WHERE warehouse_id = ? AND product_id = ? FOR UPDATE`,
        [purchase.warehouse_id, item.product_id]
      );
      const currentQty = balance ? new Decimal(balance.qty_base) : new Decimal(0);
      if (currentQty.lt(item.quantity_base)) {
        throw new HttpError(
          409,
          'insufficient_stock',
          `Stok produk sudah berkurang di bawah qty pembelian ini (sisa ${currentQty.toFixed(4)}, dibutuhkan ${item.quantity_base}) — tidak bisa di-void. Pertimbangkan retur pembelian sebagai gantinya.`
        );
      }
    }

    const productIds = items.map((i) => i.product_id);
    const interveningMovements = await detectInterveningMovements(conn, {
      warehouseId: purchase.warehouse_id, productIds, sinceDate: purchase.created_at, purchaseId,
    });
    const interveningProductIds = new Set(interveningMovements.map((r) => r.product_id));

    const itemResults = [];
    for (const item of items) {
      const [[balanceBefore]] = await conn.query(
        `SELECT qty_base, avg_cost_per_base_unit FROM stock_balances WHERE warehouse_id = ? AND product_id = ?`,
        [purchase.warehouse_id, item.product_id]
      );
      const qtyBefore = new Decimal(balanceBefore.qty_base);
      const avgCostBefore = new Decimal(balanceBefore.avg_cost_per_base_unit);

      // Mode reversal-nilai: costPerBaseUnit yg dikirim = cost ASLI item
      // pembelian ini (dari snapshot purchase_items), BUKAN avg cost
      // sekarang — itulah nilai yang mau "dibatalkan" dari pool.
      const { qtyBase: qtyAfter, avgCostPerBaseUnit: avgCostAfter } = await applyStockMovement(conn, {
        warehouseId: purchase.warehouse_id,
        productId: item.product_id,
        movementType: 'purchase_void',
        referenceType: 'purchase',
        referenceUuid: purchaseId,
        qtyOutBase: item.quantity_base,
        costPerBaseUnit: item.cost_per_base_unit,
        movementDate: new Date(),
      });

      // Markup otomatis (Batch 3A) — void pembelian juga mengubah HPP
      // (mode reversal-nilai), hitung ulang harga jual (kalau fitur ON).
      await recalculatePricesForProduct(conn, {
        productId: item.product_id,
        warehouseId: purchase.warehouse_id,
        oldAvgCost: avgCostBefore.toFixed(4),
        newAvgCost: avgCostAfter.toFixed(4),
        triggerSource: 'purchase_void',
        referenceType: 'purchase',
        referenceUuid: purchaseId,
      });

      itemResults.push({
        productId: item.product_id,
        quantityBase: item.quantity_base,
        originalCostPerBaseUnit: item.cost_per_base_unit,
        qtyBaseBefore: qtyBefore.toFixed(4),
        avgCostBefore: avgCostBefore.toFixed(4),
        qtyBaseAfter: qtyAfter.toFixed(4),
        avgCostAfter: avgCostAfter.toFixed(4),
        hadInterveningTransaction: interveningProductIds.has(item.product_id),
      });
    }

    // Jurnal pembalik — cari entry asli pembelian ini, balikkan lewat
    // primitif generik yang sudah ada (bukan hitung ulang manual).
    const [origEntries] = await conn.query(
      `SELECT id FROM journal_entries WHERE source_type = 'purchase' AND source_uuid = ? AND status = 'posted'`,
      [purchaseId]
    );
    let journalEntry = null;
    for (const entry of origEntries) {
      journalEntry = await AccountingService.reverseJournalEntry(conn, {
        entryId: entry.id,
        entryDate: new Date(),
        description: `Void Pembelian ${purchase.purchase_number}`,
        sourceType: 'purchase_void',
        sourceUuid: purchaseId,
        createdBy: userId,
      });
    }

    await conn.query(
      `UPDATE purchases SET status = 'voided', void_reason = ?, voided_at = NOW(), voided_by = ? WHERE id = ?`,
      [reason.trim(), userId, purchaseId]
    );

    await logActivity(conn, {
      userId,
      action: 'void_purchase',
      entityType: 'purchase',
      entityUuid: purchaseId,
      description: `Void pembelian ${purchase.purchase_number}. Alasan: ${reason.trim()}`,
    });

    await conn.commit();

    return {
      id: purchaseId,
      purchaseNumber: purchase.purchase_number,
      status: 'voided',
      items: itemResults,
      journalEntry,
      interveningMovements,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { listPurchases, getPurchaseDetail, createPurchase, voidPurchase };
