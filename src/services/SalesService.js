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
const PricingSettingsService = require('./PricingSettingsService');

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
// client tidak pernah mengirim harga, cuma productId/unitId/priceLevelId/qty
// (+ diskon item kalau ada). Dipakai baik oleh preview (quote, read-only)
// maupun checkout (di dalam transaksi). `conn` boleh pool (quote) atau
// koneksi transaksi (checkout). `warehouseId` dibutuhkan utk baca HPP saat
// ini (aturan besi diskon — lihat di bawah).
//
// item.discountType: 'percent' | 'rupiah' | null/undefined (tanpa diskon).
// item.discountValue: angka — makna tergantung discountType (Batch 3B,
// kasir pilih persen ATAU rupiah per baris).
async function resolveItemPricing(conn, item, warehouseId) {
  const { productId, unitId, priceLevelId } = item;
  const quantity = new Decimal(item.quantity);

  const [[productUnit]] = await conn.query(
    `SELECT conversion_factor FROM product_units WHERE product_id = ? AND unit_id = ? LIMIT 1`,
    [productId, unitId]
  );
  if (!productUnit) {
    throw new HttpError(400, 'invalid_unit', `Satuan tidak valid untuk produk ${productId}`);
  }
  const conversionFactor = new Decimal(productUnit.conversion_factor);
  const quantityBase = quantity.mul(conversionFactor);

  const rawPrice = await resolvePrice({ productId, unitId, priceLevelId, quantityBase: quantityBase.toFixed(4) }, conn);
  // product_prices.price boleh punya pecahan (Batch 3A — harga hasil markup
  // otomatis sengaja TIDAK dibulatkan di master). TAPI angka yang benar-benar
  // dipakai di transaksi (quote & struk) WAJIB rupiah utuh — ini SATU-SATUNYA
  // titik pembulatan, konsisten dgn "Uang = INT rupiah" (Bagian 5 poin 4).
  // `priceDecimal` di sini = HARGA BAKU (harga master, sebelum harga manual
  // kasir dipertimbangkan) — dipakai sebagai lantai/batas bawah harga manual
  // di bawah, dan TIDAK PERNAH ditulis ulang ke product_prices (fitur harga
  // manual murni per-transaksi, master tidak tersentuh).
  const priceDecimal = new Decimal(rawPrice).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const basePrice = priceDecimal;

  const discountType = item.discountType === 'percent' || item.discountType === 'rupiah' ? item.discountType : null;
  const discountValue = new Decimal(item.discountValue || 0);
  const hasItemDiscount = discountType !== null && discountValue.gt(0);

  // Harga manual per item — kasir boleh NAIKKAN harga jual baris ini di atas
  // harga baku (tidak pernah diturunkan), mutually exclusive dgn diskon item
  // (keputusan klien: kalau salah satu sudah aktif, yang lain ditolak, bukan
  // saling menimpa diam-diam). item.manualPrice absen/null = tidak dipakai
  // (mis. kasir batalkan lewat "h0" di client, atau memang tidak pernah diisi).
  const hasManualPrice = item.manualPrice !== undefined && item.manualPrice !== null && item.manualPrice !== '';
  if (hasManualPrice && hasItemDiscount) {
    throw new HttpError(
      400,
      'manual_price_discount_conflict',
      'Item tidak boleh punya harga manual dan diskon item sekaligus — batalkan salah satu dulu.'
    );
  }

  let effectivePrice = priceDecimal;
  let manualPriceApplied = false;
  if (hasManualPrice) {
    const manualPriceDecimal = new Decimal(item.manualPrice).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    if (manualPriceDecimal.lt(priceDecimal)) {
      throw new HttpError(
        400,
        'manual_price_below_base',
        `Harga manual tidak boleh di bawah harga baku Rp${priceDecimal.toFixed(0)}`
      );
    }
    effectivePrice = manualPriceDecimal;
    manualPriceApplied = true;
  }

  const price = effectivePrice.toFixed(0);
  const grossSubtotal = effectivePrice.mul(quantity);

  let discountAmount;
  if (discountType === 'percent') {
    if (discountValue.lt(0) || discountValue.gt(100)) {
      throw new HttpError(400, 'bad_request', 'Diskon persen item harus antara 0-100');
    }
    discountAmount = grossSubtotal.mul(discountValue.div(100));
  } else if (discountType === 'rupiah') {
    if (discountValue.lt(0)) {
      throw new HttpError(400, 'bad_request', 'Diskon rupiah item tidak boleh negatif');
    }
    discountAmount = discountValue;
  } else {
    discountAmount = new Decimal(0);
  }

  const subtotal = grossSubtotal.minus(discountAmount);
  if (subtotal.lt(0)) {
    throw new HttpError(400, 'invalid_discount', 'Diskon melebihi subtotal item');
  }

  // Aturan besi (sama seperti Batch 3A): harga jual tidak pernah boleh di
  // bawah HPP — di sini diterapkan ke diskon PER ITEM. Baca HPP rata-rata
  // SAAT INI (bukan snapshot lama), plain SELECT (bukan FOR UPDATE — ini
  // guard bisnis, bukan pengunci kuantitas; pengecekan stok yang sungguhan
  // tetap FOR UPDATE terpisah di createSale).
  const [[balanceRow]] = await conn.query(
    `SELECT avg_cost_per_base_unit FROM stock_balances WHERE warehouse_id = ? AND product_id = ?`,
    [warehouseId, productId]
  );
  const avgCost = balanceRow ? new Decimal(balanceRow.avg_cost_per_base_unit) : new Decimal(0);
  const costInUnit = avgCost.mul(conversionFactor);
  const itemTotalCost = costInUnit.mul(quantity);
  if (subtotal.lt(itemTotalCost)) {
    const maxDiscount = grossSubtotal.minus(itemTotalCost);
    throw new HttpError(
      400,
      'discount_below_cost',
      `Diskon item membuat harga di bawah HPP (Rp${costInUnit.toFixed(2)}/satuan). Maksimal diskon utk baris ini Rp${maxDiscount.toFixed(0)}.`
    );
  }

  return {
    productId, unitId, quantity, conversionFactor, quantityBase, price, priceDecimal,
    basePrice, manualPriceApplied,
    grossSubtotal, discountType, discountValue, discountAmount, subtotal, itemTotalCost,
  };
}

// Hitung diskon TOTAL (nota) — persen ATAU rupiah, diterapkan DI ATAS jumlah
// subtotal item (subtotal setelah semua diskon per item, BUKAN subtotal
// kotor) — sesuai keputusan klien Batch 3B.
function computeTotalDiscount({ totalDiscountType, totalDiscountValue }, subtotalAfterItemDiscount) {
  const type = totalDiscountType === 'percent' || totalDiscountType === 'rupiah' ? totalDiscountType : null;
  const value = new Decimal(totalDiscountValue || 0);
  if (type === 'percent') {
    if (value.lt(0) || value.gt(100)) {
      throw new HttpError(400, 'bad_request', 'Diskon persen total harus antara 0-100');
    }
    return { type, value, amount: subtotalAfterItemDiscount.mul(value.div(100)) };
  }
  if (type === 'rupiah') {
    if (value.lt(0)) {
      throw new HttpError(400, 'bad_request', 'Diskon rupiah total tidak boleh negatif');
    }
    return { type, value, amount: value };
  }
  return { type: null, value: new Decimal(0), amount: new Decimal(0) };
}

// PPN (Batch 3C) — dihitung SETELAH diskon, dari `nilaiSetelahDiskon` (nilai
// nota bersih dari semua diskon item+total — ini adalah `grandTotal` versi
// SEBELUM PPN dipertimbangkan). Dua mode, dikunci klien:
//  - exclude: PPN DITAMBAHKAN di atas. DPP = nilaiSetelahDiskon (apa
//    adanya), PPN = DPP * tarif, total baru = DPP + PPN (BERTAMBAH).
//  - included: nilaiSetelahDiskon SUDAH termasuk PPN. DPP = nilaiSetelahDiskon
//    / (1 + tarif), PPN = nilaiSetelahDiskon - DPP — BUKAN
//    nilaiSetelahDiskon * tarif (itu keliru, PPN jadi kelebihan hitung).
//    Total TIDAK berubah (PPN cuma "dipisahkan" utk ditampilkan/dijurnal).
//
// Pembulatan: DPP dibulatkan LEBIH DULU ke rupiah utuh, lalu PPN diambil
// sbg SISA (bukan dibulatkan independen) — supaya DPP+PPN dijamin PERSIS
// sama dengan total akhir. Kalau keduanya dibulatkan sendiri-sendiri, bisa
// selisih Rp1 karena pembulatan dan bikin jurnal GAGAL balance
// (postJournalEntry menolak jurnal yang tidak persis balance).
function applyPpn(nilaiSetelahDiskon, ppnSettings) {
  const ppnEnabled = !!ppnSettings.ppn_enabled;
  const ppnMode = ppnSettings.ppn_mode;
  if (!ppnEnabled || !ppnSettings.ppn_rate || (ppnMode !== 'exclude' && ppnMode !== 'included')) {
    return {
      ppnApplied: false, dpp: nilaiSetelahDiskon, ppnAmount: new Decimal(0),
      grandTotal: nilaiSetelahDiskon, ppnRate: null, ppnMode: null,
    };
  }

  const rate = new Decimal(ppnSettings.ppn_rate);
  if (ppnMode === 'exclude') {
    const dpp = nilaiSetelahDiskon; // sudah rupiah utuh (selisih 2 angka bulat)
    const ppnAmount = dpp.mul(rate.div(100)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const grandTotal = dpp.plus(ppnAmount);
    return { ppnApplied: true, dpp, ppnAmount, grandTotal, ppnRate: rate, ppnMode };
  }

  // included
  const dppRaw = nilaiSetelahDiskon.div(rate.div(100).plus(1));
  const dpp = dppRaw.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const ppnAmount = nilaiSetelahDiskon.minus(dpp); // sisa — lihat catatan pembulatan di atas
  return { ppnApplied: true, dpp, ppnAmount, grandTotal: nilaiSetelahDiskon, ppnRate: rate, ppnMode };
}

// Preview harga keranjang TANPA menyimpan apa pun (tidak mengunci stok,
// tidak menulis stock_movements). Dipakai client utk menampilkan harga —
// client tidak pernah menghitung harga sendiri, cuma menampilkan hasil ini.
// items: [{ productId, unitId, quantity, priceLevelId, discountType?, discountValue? }]
// totalDiscountType/totalDiscountValue: diskon nota (Batch 3B), lihat computeTotalDiscount.
async function previewSale({ items, totalDiscountType = null, totalDiscountValue = 0 }) {
  if (!items || items.length === 0) {
    return {
      items: [], subtotal: '0', itemDiscountTotal: '0', subtotalAfterItemDiscount: '0',
      totalDiscountType: null, totalDiscountValue: '0', totalDiscountAmount: '0',
      discountTotal: '0', dpp: '0', ppnEnabled: false, ppnRate: null, ppnMode: null, ppnAmount: '0',
      grandTotal: '0',
    };
  }

  const warehouseId = await getDefaultWarehouseId();
  let subtotalSum = new Decimal(0); // kotor, SUM(harga*qty) SEBELUM diskon apa pun
  let itemDiscountSum = new Decimal(0);
  let totalCostSum = new Decimal(0);
  const itemResults = [];

  for (const item of items) {
    const pricing = await resolveItemPricing(pool, item, warehouseId);

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
      basePrice: pricing.basePrice.toFixed(0),
      manualPriceApplied: pricing.manualPriceApplied,
      grossSubtotal: pricing.grossSubtotal.toFixed(0),
      discountType: pricing.discountType,
      discountValue: pricing.discountValue.toFixed(4),
      discountAmount: pricing.discountAmount.toFixed(0),
      subtotal: pricing.subtotal.toFixed(0),
      inStock: availableQty.gte(pricing.quantityBase),
      availableQty: availableQty.toFixed(4),
    });

    subtotalSum = subtotalSum.plus(pricing.grossSubtotal);
    itemDiscountSum = itemDiscountSum.plus(pricing.discountAmount);
    totalCostSum = totalCostSum.plus(pricing.itemTotalCost);
  }

  const subtotalAfterItemDiscount = subtotalSum.minus(itemDiscountSum);
  const totalDiscount = computeTotalDiscount({ totalDiscountType, totalDiscountValue }, subtotalAfterItemDiscount);
  const grandTotal = subtotalAfterItemDiscount.minus(totalDiscount.amount);
  if (grandTotal.lt(0)) {
    throw new HttpError(400, 'invalid_discount', 'Diskon total melebihi subtotal');
  }
  // Aturan besi utk diskon TOTAL: nota secara keseluruhan tidak boleh terjual
  // di bawah total HPP-nya (diskon item sudah dijaga sendiri-sendiri di atas;
  // ini lapis kedua khusus utk diskon nota, yang tidak diatribusikan ke item
  // tertentu — lihat catatan di createSale).
  if (grandTotal.lt(totalCostSum)) {
    const maxTotalDiscount = subtotalAfterItemDiscount.minus(totalCostSum);
    throw new HttpError(
      400,
      'discount_below_cost',
      `Diskon total membuat nota terjual di bawah total HPP (Rp${totalCostSum.toFixed(0)}). Maksimal diskon total Rp${maxTotalDiscount.toFixed(0)}.`
    );
  }

  // PPN (Batch 3C) — dihitung dari nilai SETELAH diskon (`grandTotal` di
  // atas, sebelum PPN dipertimbangkan). Floor HPP SUDAH selesai diperiksa
  // di atas terhadap nilai pre-PPN — PPN bukan pendapatan/beban, tidak ikut
  // dibandingkan ke HPP.
  const ppnSettings = await PricingSettingsService.getSettings();
  const ppn = applyPpn(grandTotal, ppnSettings);

  return {
    items: itemResults,
    subtotal: subtotalSum.toFixed(0),
    itemDiscountTotal: itemDiscountSum.toFixed(0),
    subtotalAfterItemDiscount: subtotalAfterItemDiscount.toFixed(0),
    totalDiscountType: totalDiscount.type,
    totalDiscountValue: totalDiscount.value.toFixed(4),
    totalDiscountAmount: totalDiscount.amount.toFixed(0),
    discountTotal: itemDiscountSum.plus(totalDiscount.amount).toFixed(0),
    dpp: ppn.dpp.toFixed(0),
    ppnEnabled: ppn.ppnApplied,
    ppnRate: ppn.ppnRate ? ppn.ppnRate.toFixed(4) : null,
    ppnMode: ppn.ppnMode,
    ppnAmount: ppn.ppnAmount.toFixed(0),
    grandTotal: ppn.grandTotal.toFixed(0),
  };
}

// items: [{ productId, unitId, quantity, priceLevelId, discountType?, discountValue? }]
// totalDiscountType/totalDiscountValue: diskon nota (Batch 3B).
// cashTendered: jumlah uang tunai yang diserahkan pelanggan (mentah, bukan
// hasil hitungan client) — cuma wajib & dipakai untuk metode pembayaran tunai
// (is_cash=1). Untuk metode non-tunai (QRIS, kartu, dst) tidak ada kembalian,
// server yang menetapkan cashTendered = grandTotal & changeDue = 0.
// Server yang menghitung grandTotal & kembalian — client cuma menampilkan
// apa yang dikembalikan di sini.
async function createSale({
  userId, shiftId, items, paymentMethodId, cashTendered,
  totalDiscountType = null, totalDiscountValue = 0, customerName = null,
}) {
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

    let subtotalSum = new Decimal(0); // kotor, SUM(harga*qty) SEBELUM diskon apa pun
    let itemDiscountSum = new Decimal(0);
    let totalCostSum = new Decimal(0);
    const itemRows = [];
    const itemDiscountNotes = [];
    const manualPriceNotes = [];

    for (const item of items) {
      const pricing = await resolveItemPricing(conn, item, warehouseId);
      if (pricing.discountAmount.gt(0)) {
        itemDiscountNotes.push(
          pricing.discountType === 'percent'
            ? `${pricing.productId}: ${pricing.discountValue.toFixed(2)}% (Rp${pricing.discountAmount.toFixed(0)})`
            : `${pricing.productId}: Rp${pricing.discountAmount.toFixed(0)}`
        );
      }
      if (pricing.manualPriceApplied) {
        manualPriceNotes.push(`${pricing.productId}: harga baku Rp${pricing.basePrice.toFixed(0)} -> harga manual Rp${pricing.price}`);
      }

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

      subtotalSum = subtotalSum.plus(pricing.grossSubtotal);
      itemDiscountSum = itemDiscountSum.plus(pricing.discountAmount);
      totalCostSum = totalCostSum.plus(totalCost);
    }

    const subtotalAfterItemDiscount = subtotalSum.minus(itemDiscountSum);
    const totalDiscount = computeTotalDiscount({ totalDiscountType, totalDiscountValue }, subtotalAfterItemDiscount);
    const grandTotal = subtotalAfterItemDiscount.minus(totalDiscount.amount);
    if (grandTotal.lt(0)) {
      throw new HttpError(400, 'invalid_discount', 'Diskon total melebihi subtotal');
    }
    // Aturan besi lapis kedua (lihat catatan sama di previewSale): diskon
    // TOTAL tidak diatribusikan ke item tertentu, jadi diperiksa terhadap
    // total HPP SELURUH nota, bukan per baris.
    if (grandTotal.lt(totalCostSum)) {
      const maxTotalDiscount = subtotalAfterItemDiscount.minus(totalCostSum);
      throw new HttpError(
        400,
        'discount_below_cost',
        `Diskon total membuat nota terjual di bawah total HPP (Rp${totalCostSum.toFixed(0)}). Maksimal diskon total Rp${maxTotalDiscount.toFixed(0)}.`
      );
    }
    const discountSum = itemDiscountSum.plus(totalDiscount.amount);

    // PPN (Batch 3C) — dihitung dari nilai SETELAH diskon (`grandTotal` di
    // atas). Floor HPP sudah selesai diperiksa di atas terhadap nilai
    // pre-PPN — PPN bukan pendapatan, tidak ikut dibandingkan ke HPP. Semua
    // pemakaian "total transaksi" MULAI SINI WAJIB pakai ppn.grandTotal
    // (bukan `grandTotal` mentah lagi), supaya PPN benar2 ikut ditagih/dibayar.
    const ppnSettings = await PricingSettingsService.getSettings();
    const ppn = applyPpn(grandTotal, ppnSettings);

    let cashTenderedDecimal;
    let changeDue;
    if (paymentMethod.is_cash) {
      cashTenderedDecimal = new Decimal(cashTendered);
      if (cashTenderedDecimal.lt(ppn.grandTotal)) {
        throw new HttpError(400, 'insufficient_cash', `Uang tunai (${cashTenderedDecimal}) kurang dari total belanja (${ppn.grandTotal})`);
      }
      changeDue = cashTenderedDecimal.minus(ppn.grandTotal);
    } else {
      // Non-tunai: tidak ada kembalian, jumlah yang "diserahkan" = tepat ppn.grandTotal.
      cashTenderedDecimal = ppn.grandTotal;
      changeDue = new Decimal(0);
    }

    // Laba kotor = pendapatan BERSIH PPN (DPP) dikurangi HPP — PPN adalah
    // titipan pajak (utang ke negara), bukan pendapatan, jadi TIDAK boleh
    // ikut dianggap laba (beda dari sebelum Batch 3C, di mana grandTotal
    // = DPP karena belum ada PPN sama sekali).
    const grossProfitSum = ppn.dpp.minus(totalCostSum);
    const saleNumber = generateSaleNumber();

    await conn.query(
      `INSERT INTO sales
        (id, branch_id, sale_number, cashier_shift_id, user_id, customer_name,
         subtotal, discount_total, dpp, ppn_rate, ppn_mode, ppn_amount, grand_total, total_cost, gross_profit, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')`,
      [
        saleId, BRANCH_ID, saleNumber, shiftId, userId, customerName,
        subtotalSum.toFixed(0), discountSum.toFixed(0),
        ppn.dpp.toFixed(0), ppn.ppnRate ? ppn.ppnRate.toFixed(4) : null, ppn.ppnMode, ppn.ppnAmount.toFixed(0),
        ppn.grandTotal.toFixed(0), totalCostSum.toFixed(4), grossProfitSum.toFixed(4),
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
      [uuidv4(), saleId, paymentMethod.id, paymentMethod.name, ppn.grandTotal.toFixed(0)]
    );

    // Diskon manual wajib tercatat ke activity_logs — siapa (userId, sudah
    // jadi parameter logActivity) & berapa (rincian per item + total di
    // description). Batch 3B: berlaku sama utk diskon persen maupun rupiah.
    if (discountSum.gt(0)) {
      const parts = [];
      if (itemDiscountNotes.length > 0) parts.push(`diskon item: ${itemDiscountNotes.join('; ')}`);
      if (totalDiscount.amount.gt(0)) {
        parts.push(`diskon total: ${totalDiscount.type === 'percent' ? `${totalDiscount.value.toFixed(2)}%` : `Rp${totalDiscount.amount.toFixed(0)}`} (Rp${totalDiscount.amount.toFixed(0)})`);
      }
      await logActivity(conn, {
        userId,
        action: 'manual_discount',
        entityType: 'sale',
        entityUuid: saleId,
        description: `Diskon manual pada transaksi ${saleNumber} — ${parts.join('; ')} — total diskon Rp${discountSum.toFixed(0)}`,
      });
    }

    // Harga manual wajib tercatat ke activity_logs juga (konsisten dgn kontrol
    // diskon di atas) — siapa, item apa, harga baku -> harga manual per baris.
    // Entry TERPISAH dari 'manual_discount' (bukan digabung) karena keduanya
    // mutually exclusive per item tapi bisa hidup bareng dlm SATU nota kalau
    // item A pakai diskon & item B pakai harga manual sekaligus.
    if (manualPriceNotes.length > 0) {
      await logActivity(conn, {
        userId,
        action: 'manual_price',
        entityType: 'sale',
        entityUuid: saleId,
        description: `Harga manual pada transaksi ${saleNumber} — ${manualPriceNotes.join('; ')}`,
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
      ppnAmount: ppn.ppnAmount,
      ppnMode: ppn.ppnMode,
      grandTotal: ppn.grandTotal,
      totalCost: totalCostSum,
      isCashPayment: !!paymentMethod.is_cash,
      createdBy: userId,
    });

    await conn.commit();

    return {
      id: saleId,
      saleNumber,
      subtotal: subtotalSum.toFixed(0),
      itemDiscountTotal: itemDiscountSum.toFixed(0),
      subtotalAfterItemDiscount: subtotalAfterItemDiscount.toFixed(0),
      totalDiscountType: totalDiscount.type,
      totalDiscountValue: totalDiscount.value.toFixed(4),
      totalDiscountAmount: totalDiscount.amount.toFixed(0),
      discountTotal: discountSum.toFixed(0),
      dpp: ppn.dpp.toFixed(0),
      ppnEnabled: ppn.ppnApplied,
      ppnRate: ppn.ppnRate ? ppn.ppnRate.toFixed(4) : null,
      ppnMode: ppn.ppnMode,
      ppnAmount: ppn.ppnAmount.toFixed(0),
      grandTotal: ppn.grandTotal.toFixed(0),
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
