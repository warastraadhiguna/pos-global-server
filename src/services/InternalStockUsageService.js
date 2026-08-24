// Pemakaian internal stok — barang dagangan dipakai utk kebutuhan toko
// sendiri (mis. gelas dipakai di kasir), BUKAN dijual. Bukan penjualan:
// tidak ada pendapatan, tidak ada HPP penjualan. Nilainya murni pindah dari
// aset (Persediaan) ke beban operasional sebesar HPP (avg cost BERJALAN)
// saat itu — BUKAN harga jual. Sama mekanisme dgn retur pembelian: OUT
// BIASA (avg cost tidak berubah setelahnya), BUKAN reversal-nilai seperti
// void. Lewat StockMovementService.applyStockMovement & AccountingService.
// postJournalEntry yang sudah ada, tidak ada jalur tulis stok baru.
//
// Mode pajak: avg_cost_per_base_unit yang dipakai di sini SUDAH otomatis
// berbasis DPP kalau pembelian sumbernya PKP (resolveInventoryCostMultiplier
// di PurchaseService selalu = 1 utk PKP, PPN Masukan tidak pernah melebur ke
// nilai persediaan) — jadi TIDAK ADA PPN yang ikut ke beban di sini, tidak
// perlu penyesuaian tambahan. Utk non-PKP, avg cost SUDAH termasuk PPN yang
// memang tidak bisa dikreditkan (correct — itu memang beban riil).
//
// Belum ada jalur void/pembalik utk dokumen ini (beda dgn void penjualan/
// pembelian) — kalau salah input, koreksinya utk sekarang lewat
// stock_adjustments manual di luar fitur ini. Keterbatasan yang disengaja,
// dilaporkan eksplisit, bukan terlewat.
const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');
const { applyStockMovement } = require('./StockMovementService');
const { getDefaultWarehouseId } = require('./WarehouseService');
const AccountingService = require('./AccountingService');
const { logActivity } = require('./AuthService');

const BRANCH_ID = 1;
const PERSEDIAAN_CODE = '1-301';
const BEBAN_PERLENGKAPAN_CODE = '5-204';

function generateUsageNumber() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const randomPart = Math.floor(100000 + Math.random() * 900000); // lihat catatan di AccountingService.generateEntryNumber
  return `IU${BRANCH_ID}-${datePart}-${timePart}${randomPart}`;
}

async function listInternalStockUsages() {
  const [rows] = await pool.query(
    `SELECT isu.id, isu.usage_number, isu.usage_date, isu.reason, isu.total_value, u.full_name AS processed_by_name
     FROM internal_stock_usages isu
     JOIN users u ON u.id = isu.processed_by
     ORDER BY isu.created_at DESC`
  );
  return rows;
}

async function getInternalStockUsageDetail(usageId) {
  const [[usage]] = await pool.query(
    `SELECT isu.*, u.full_name AS processed_by_name
     FROM internal_stock_usages isu JOIN users u ON u.id = isu.processed_by
     WHERE isu.id = ?`,
    [usageId]
  );
  if (!usage) throw new HttpError(404, 'internal_stock_usage_not_found', 'Pemakaian internal tidak ditemukan');

  const [items] = await pool.query(
    `SELECT isui.*, p.name AS product_name, un.name AS unit_name
     FROM internal_stock_usage_items isui
     JOIN products p ON p.id = isui.product_id
     JOIN units un ON un.id = isui.unit_id
     WHERE isui.usage_id = ?`,
    [usageId]
  );
  return { ...usage, items };
}

// items: [{ productId, unitId, quantity }] — quantity dalam satuan yang
// dipilih (mis. dus), dikonversi ke base unit sama seperti pembelian/retur.
async function createInternalStockUsage({ usageDate, items, reason, userId }) {
  if (!usageDate) throw new HttpError(400, 'bad_request', 'usageDate wajib diisi');
  if (!items || items.length === 0) throw new HttpError(400, 'bad_request', 'Item pemakaian tidak boleh kosong');
  if (!reason || !reason.trim()) {
    throw new HttpError(400, 'bad_request', 'Alasan pemakaian internal wajib diisi');
  }

  const usageId = uuidv4();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const warehouseId = await getDefaultWarehouseId(conn);

    let totalValue = new Decimal(0);
    const itemRows = [];
    const logParts = [];

    for (const item of items) {
      const quantity = new Decimal(item.quantity);
      if (quantity.lte(0)) throw new HttpError(400, 'bad_request', 'Qty pemakaian harus > 0');

      const [[productUnit]] = await conn.query(
        `SELECT pu.conversion_factor, p.name AS product_name
         FROM product_units pu JOIN products p ON p.id = pu.product_id
         WHERE pu.product_id = ? AND pu.unit_id = ? LIMIT 1`,
        [item.productId, item.unitId]
      );
      if (!productUnit) {
        throw new HttpError(400, 'invalid_unit', `Satuan tidak valid untuk produk ${item.productId}`);
      }
      const conversionFactor = new Decimal(productUnit.conversion_factor);
      const quantityBase = quantity.mul(conversionFactor);

      const [[balance]] = await conn.query(
        `SELECT qty_base, avg_cost_per_base_unit FROM stock_balances WHERE warehouse_id = ? AND product_id = ? FOR UPDATE`,
        [warehouseId, item.productId]
      );
      const currentQty = balance ? new Decimal(balance.qty_base) : new Decimal(0);
      if (currentQty.lt(quantityBase)) {
        throw new HttpError(409, 'insufficient_stock', `Stok "${productUnit.product_name}" tidak cukup untuk pemakaian sebesar ini (sisa ${currentQty.toFixed(4)})`);
      }
      // OUT biasa — cost basis = avg cost BERJALAN, avg cost TIDAK berubah
      // setelahnya. Diambil SEBELUM movement supaya nilainya konsisten
      // dengan yang dipakai applyStockMovement sendiri.
      const avgCostNow = balance ? new Decimal(balance.avg_cost_per_base_unit) : new Decimal(0);
      const subtotal = quantityBase.mul(avgCostNow);

      await applyStockMovement(conn, {
        warehouseId,
        productId: item.productId,
        movementType: 'internal_use',
        referenceType: 'internal_use',
        referenceUuid: usageId,
        qtyOutBase: quantityBase.toFixed(4),
        movementDate: new Date(),
      });

      itemRows.push({
        id: uuidv4(),
        productId: item.productId,
        productName: productUnit.product_name,
        unitId: item.unitId,
        quantity: quantity.toFixed(4),
        conversionFactor: conversionFactor.toFixed(4),
        quantityBase: quantityBase.toFixed(4),
        costPerBaseUnit: avgCostNow.toFixed(4),
        subtotal: subtotal.toFixed(0),
      });
      logParts.push(`${productUnit.product_name} ${quantityBase.toFixed(4)} (${quantity.toFixed(4)} satuan dipilih) senilai Rp${subtotal.toFixed(0)}`);

      totalValue = totalValue.plus(subtotal);
    }

    const usageNumber = generateUsageNumber();

    await conn.query(
      `INSERT INTO internal_stock_usages (id, branch_id, warehouse_id, usage_number, usage_date, reason, total_value, processed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [usageId, BRANCH_ID, warehouseId, usageNumber, usageDate, reason.trim(), totalValue.toFixed(0), userId]
    );

    for (const row of itemRows) {
      await conn.query(
        `INSERT INTO internal_stock_usage_items
          (id, usage_id, product_id, unit_id, quantity, conversion_factor, quantity_base, cost_per_base_unit, subtotal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, usageId, row.productId, row.unitId, row.quantity, row.conversionFactor, row.quantityBase, row.costPerBaseUnit, row.subtotal]
      );
    }

    // Jurnal: Debit Beban Perlengkapan Toko / Kredit Persediaan Barang
    // Dagang, sebesar total HPP yang dipakai — TIDAK ada pendapatan/HPP
    // penjualan yang tersentuh sama sekali (ini bukan transaksi jual-beli).
    const bebanAccount = await AccountingService.getAccountByCode(BEBAN_PERLENGKAPAN_CODE, conn);
    const persediaanAccount = await AccountingService.getAccountByCode(PERSEDIAAN_CODE, conn);
    const journalEntry = await AccountingService.postJournalEntry(conn, {
      entryDate: usageDate,
      description: `Pemakaian Internal Stok ${usageNumber}`,
      sourceType: 'internal_stock_usage',
      sourceUuid: usageId,
      lines: [
        { accountId: bebanAccount.id, debit: totalValue, description: 'Barang dipakai utk kebutuhan toko' },
        { accountId: persediaanAccount.id, credit: totalValue, description: 'Persediaan berkurang (bukan dijual)' },
      ],
      createdBy: userId,
    });

    // WAJIB — stok keluar di sini TANPA uang masuk (bukan penjualan), jadi
    // ini titik rawan menutupi kehilangan/pencurian stok kalau tidak
    // tercatat siapa & kenapa. Deskripsi memuat semua item+qty+nilai+alasan
    // dalam satu baris (pola sama dgn log lain di codebase ini — bukan
    // metadata JSON terpisah).
    await logActivity(conn, {
      userId,
      action: 'internal_stock_usage',
      entityType: 'internal_stock_usage',
      entityUuid: usageId,
      description: `Pemakaian internal ${usageNumber} — ${logParts.join('; ')}. Total HPP: Rp${totalValue.toFixed(0)}. Alasan: ${reason.trim()}`,
    });

    await conn.commit();

    return {
      id: usageId,
      usageNumber,
      usageDate,
      reason: reason.trim(),
      totalValue: totalValue.toFixed(0),
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

module.exports = { listInternalStockUsages, getInternalStockUsageDetail, createInternalStockUsage };
