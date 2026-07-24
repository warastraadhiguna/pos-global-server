const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');
const { logActivity } = require('./AuthService');
const { applyStockMovement } = require('./StockMovementService');
const { resolvePrice } = require('./PricingService');
const { getDefaultWarehouseId } = require('./WarehouseService');
const { getActiveMethodById } = require('./PaymentMethodService');
const JournalService = require('./JournalService');

const BRANCH_ID = 1;

function generateSaleNumber() {
  const now = new Date();
  // WAJIB pakai getter waktu lokal (bukan toISOString() yang UTC) di kedua
  // bagian — sebelumnya datePart pakai toISOString() (UTC) sementara timePart
  // pakai toTimeString() (lokal WIB), jadi nomor struk bisa menampilkan
  // tanggal "kemarin" untuk transaksi jam 00:00-06:59 WIB walau created_at
  // di database sudah benar. Ditemukan & dilaporkan user 2026-07-18.
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const randomPart = Math.floor(100000 + Math.random() * 900000); // lihat catatan di AccountingService.generateEntryNumber
  return `S${BRANCH_ID}-${datePart}-${timePart}${randomPart}`;
}

// Resolusi harga 1 item keranjang. Server adalah SATU-SATUNYA otoritas —
// client tidak pernah mengirim harga, cuma productId/unitId/priceLevelId/qty.
// Dipakai baik oleh preview (quote, read-only) maupun checkout (di dalam
// transaksi). `conn` boleh pool (quote) atau koneksi transaksi (checkout).
async function resolveItemPricing(conn, item) {
  const { productId, unitId, priceLevelId } = item;
  const quantity = new Decimal(item.quantity);
  const discountAmount = new Decimal(item.discountAmount || 0);

  const [[productUnit]] = await conn.query(
    `SELECT conversion_factor FROM product_units WHERE product_id = ? AND unit_id = ? LIMIT 1`,
    [productId, unitId]
  );
  if (!productUnit) {
    throw new HttpError(400, 'invalid_unit', `Satuan tidak valid untuk produk ${productId}`);
  }
  const conversionFactor = new Decimal(productUnit.conversion_factor);
  const quantityBase = quantity.mul(conversionFactor);

  const price = await resolvePrice({ productId, unitId, priceLevelId, quantityBase: quantityBase.toFixed(4) }, conn);
  const priceDecimal = new Decimal(price);
  const subtotal = priceDecimal.mul(quantity).minus(discountAmount);
  if (subtotal.lt(0)) {
    throw new HttpError(400, 'invalid_discount', 'Diskon melebihi subtotal item');
  }

  return { productId, unitId, quantity, conversionFactor, quantityBase, price, priceDecimal, discountAmount, subtotal };
}

// Preview harga keranjang TANPA menyimpan apa pun (tidak mengunci stok,
// tidak menulis stock_movements). Dipakai client utk menampilkan harga —
// client tidak pernah menghitung harga sendiri, cuma menampilkan hasil ini.
// items: [{ productId, unitId, quantity, priceLevelId, discountAmount? }]
async function previewSale({ items, manualDiscount = 0 }) {
  if (!items || items.length === 0) {
    return { items: [], subtotal: '0', discountTotal: new Decimal(manualDiscount || 0).toFixed(0), grandTotal: '0' };
  }

  const warehouseId = await getDefaultWarehouseId();
  let subtotalSum = new Decimal(0);
  let discountSum = new Decimal(manualDiscount || 0);
  const itemResults = [];

  for (const item of items) {
    const pricing = await resolveItemPricing(pool, item);

    const [[balance]] = await pool.query(
      `SELECT qty_base FROM stock_balances WHERE warehouse_id = ? AND product_id = ?`,
      [warehouseId, pricing.productId]
    );
    const availableQty = new Decimal(balance ? balance.qty_base : 0);

    itemResults.push({
      productId: pricing.productId,
      unitId: pricing.unitId,
      quantity: pricing.quantity.toFixed(4),
      price: pricing.price,
      subtotal: pricing.subtotal.toFixed(0),
      inStock: availableQty.gte(pricing.quantityBase),
      availableQty: availableQty.toFixed(4),
    });

    subtotalSum = subtotalSum.plus(pricing.priceDecimal.mul(pricing.quantity));
    discountSum = discountSum.plus(pricing.discountAmount);
  }

  const grandTotal = subtotalSum.minus(discountSum);
  if (grandTotal.lt(0)) {
    throw new HttpError(400, 'invalid_discount', 'Total diskon melebihi subtotal');
  }

  return {
    items: itemResults,
    subtotal: subtotalSum.toFixed(0),
    discountTotal: discountSum.toFixed(0),
    grandTotal: grandTotal.toFixed(0),
  };
}

// items: [{ productId, unitId, quantity, priceLevelId, discountAmount? }]
// cashTendered: jumlah uang tunai yang diserahkan pelanggan (mentah, bukan
// hasil hitungan client) — cuma wajib & dipakai untuk metode pembayaran tunai
// (is_cash=1). Untuk metode non-tunai (QRIS, kartu, dst) tidak ada kembalian,
// server yang menetapkan cashTendered = grandTotal & changeDue = 0.
// Server yang menghitung grandTotal & kembalian — client cuma menampilkan
// apa yang dikembalikan di sini.
async function createSale({ userId, shiftId, items, paymentMethodId, cashTendered, manualDiscount = 0, customerName = null }) {
  if (!items || items.length === 0) {
    throw new HttpError(400, 'bad_request', 'Keranjang kosong');
  }
  if (!paymentMethodId) {
    throw new HttpError(400, 'bad_request', 'paymentMethodId wajib diisi');
  }
  const paymentMethod = await getActiveMethodById(paymentMethodId);
  if (paymentMethod.is_cash && (cashTendered === undefined || cashTendered === null)) {
    throw new HttpError(400, 'bad_request', 'cashTendered wajib diisi untuk pembayaran tunai');
  }

  const warehouseId = await getDefaultWarehouseId();
  const saleId = uuidv4();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Pastikan shift ini benar-benar milik user & masih terbuka (dikunci row-nya
    // supaya tidak ada dua checkout bersamaan menutup shift yang sama).
    const [[shift]] = await conn.query(
      `SELECT * FROM cashier_shifts WHERE id = ? FOR UPDATE`,
      [shiftId]
    );
    if (!shift || shift.user_id !== userId || shift.status !== 'open') {
      throw new HttpError(409, 'shift_not_open', 'Shift kasir tidak aktif untuk user ini');
    }

    let subtotalSum = new Decimal(0);
    let discountSum = new Decimal(manualDiscount || 0);
    let totalCostSum = new Decimal(0);
    const itemRows = [];
    let anyManualDiscount = discountSum.gt(0);

    for (const item of items) {
      const pricing = await resolveItemPricing(conn, item);
      if (pricing.discountAmount.gt(0)) anyManualDiscount = true;

      // Cek stok cukup sebelum commit ke movement (hindari stok minus tanpa sengaja)
      const [[balance]] = await conn.query(
        `SELECT qty_base FROM stock_balances WHERE warehouse_id = ? AND product_id = ? FOR UPDATE`,
        [warehouseId, pricing.productId]
      );
      const currentQty = new Decimal(balance ? balance.qty_base : 0);
      if (currentQty.lt(pricing.quantityBase)) {
        throw new HttpError(409, 'insufficient_stock', `Stok tidak cukup untuk produk ${pricing.productId}`);
      }

      const { avgCostPerBaseUnit } = await applyStockMovement(conn, {
        warehouseId,
        productId: pricing.productId,
        movementType: 'sale',
        referenceType: 'sale',
        referenceUuid: saleId,
        qtyOutBase: pricing.quantityBase.toFixed(4),
        movementDate: new Date(),
      });

      const totalCost = avgCostPerBaseUnit.mul(pricing.quantityBase);
      const grossProfit = pricing.subtotal.minus(totalCost);

      itemRows.push({
        id: uuidv4(),
        productId: pricing.productId,
        unitId: pricing.unitId,
        quantity: pricing.quantity.toFixed(4),
        conversionFactor: pricing.conversionFactor.toFixed(4),
        quantityBase: pricing.quantityBase.toFixed(4),
        sellingPrice: pricing.price,
        discountAmount: pricing.discountAmount.toFixed(0),
        subtotal: pricing.subtotal.toFixed(0),
        costPerBaseUnit: avgCostPerBaseUnit.toFixed(4),
        totalCost: totalCost.toFixed(4),
        grossProfit: grossProfit.toFixed(4),
      });

      subtotalSum = subtotalSum.plus(pricing.priceDecimal.mul(pricing.quantity));
      discountSum = discountSum.plus(pricing.discountAmount);
      totalCostSum = totalCostSum.plus(totalCost);
    }

    const grandTotal = subtotalSum.minus(discountSum);
    if (grandTotal.lt(0)) {
      throw new HttpError(400, 'invalid_discount', 'Total diskon melebihi subtotal');
    }

    let cashTenderedDecimal;
    let changeDue;
    if (paymentMethod.is_cash) {
      cashTenderedDecimal = new Decimal(cashTendered);
      if (cashTenderedDecimal.lt(grandTotal)) {
        throw new HttpError(400, 'insufficient_cash', `Uang tunai (${cashTenderedDecimal}) kurang dari total belanja (${grandTotal})`);
      }
      changeDue = cashTenderedDecimal.minus(grandTotal);
    } else {
      // Non-tunai: tidak ada kembalian, jumlah yang "diserahkan" = tepat grandTotal.
      cashTenderedDecimal = grandTotal;
      changeDue = new Decimal(0);
    }

    const grossProfitSum = grandTotal.minus(totalCostSum);
    const saleNumber = generateSaleNumber();

    await conn.query(
      `INSERT INTO sales
        (id, branch_id, sale_number, cashier_shift_id, user_id, customer_name,
         subtotal, discount_total, grand_total, total_cost, gross_profit, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')`,
      [
        saleId, BRANCH_ID, saleNumber, shiftId, userId, customerName,
        subtotalSum.toFixed(0), discountSum.toFixed(0), grandTotal.toFixed(0),
        totalCostSum.toFixed(4), grossProfitSum.toFixed(4),
      ]
    );

    for (const row of itemRows) {
      await conn.query(
        `INSERT INTO sale_items
          (id, sale_id, product_id, unit_id, quantity, conversion_factor, quantity_base,
           selling_price, discount_amount, subtotal, cost_per_base_unit, total_cost, gross_profit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id, saleId, row.productId, row.unitId, row.quantity, row.conversionFactor, row.quantityBase,
          row.sellingPrice, row.discountAmount, row.subtotal, row.costPerBaseUnit, row.totalCost, row.grossProfit,
        ]
      );
    }

    // sale_payments.amount = jumlah yang DITERAPKAN ke invoice (= grand_total),
    // bukan uang fisik yang diserahkan pelanggan. Kembalian mengalir keluar
    // lagi dalam transaksi yang sama, jadi efek bersih ke laci = grand_total —
    // ini yang dipakai ShiftService.calculateExpectedCash utk rekonsiliasi kas
    // (cuma menjumlah baris yang payment_methods.is_cash = 1).
    await conn.query(
      `INSERT INTO sale_payments (id, sale_id, payment_method_id, payment_method_name, amount) VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), saleId, paymentMethod.id, paymentMethod.name, grandTotal.toFixed(0)]
    );

    // Diskon manual wajib tercatat ke activity_logs (Bagian 4)
    if (anyManualDiscount) {
      await logActivity(conn, {
        userId,
        action: 'manual_discount',
        entityType: 'sale',
        entityUuid: saleId,
        description: `Diskon manual diterapkan pada transaksi ${saleNumber}, total diskon Rp${discountSum.toFixed(0)}`,
      });
    }

    // Jurnal akuntansi (feature/accounting Lapis 2) — panggilan eksplisit,
    // di dalam transaksi yang sama, SEBELUM commit: kalau jurnal gagal
    // (mis. tidak balance), seluruh sale ikut rollback lewat catch di bawah.
    // Tidak mengubah alur/hasil checkout yang sudah ada — cuma tambahan.
    await JournalService.postSaleJournals(conn, {
      saleId,
      saleNumber,
      entryDate: new Date(),
      subtotal: subtotalSum,
      discountTotal: discountSum,
      grandTotal,
      totalCost: totalCostSum,
      isCashPayment: !!paymentMethod.is_cash,
      createdBy: userId,
    });

    await conn.commit();

    return {
      id: saleId,
      saleNumber,
      subtotal: subtotalSum.toFixed(0),
      discountTotal: discountSum.toFixed(0),
      grandTotal: grandTotal.toFixed(0),
      cashTendered: cashTenderedDecimal.toFixed(0),
      changeDue: changeDue.toFixed(0),
      paymentMethodId: paymentMethod.id,
      paymentMethodName: paymentMethod.name,
      isCashPayment: !!paymentMethod.is_cash,
      items: itemRows,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { createSale, previewSale };
