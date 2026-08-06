// Markup harga otomatis (Batch 3A) — lihat catatan panjang di schema.sql
// dekat pricing_settings/price_change_events utk ringkasan aturan.
//
// Dipanggil HANYA dari 3 titik yang disepakati eksplisit bersama klien:
// PurchaseService.createPurchase, PurchaseService.voidPurchase,
// StockOpnameService.finalizeOpname — SENGAJA bukan hook generik di
// StockMovementService.applyStockMovement, supaya penjualan/void penjualan
// (yang juga menyentuh stock_movements tapi TIDAK termasuk "HPP berubah"
// dalam keputusan yang dikunci) tidak ikut memicu tanpa diminta.
const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');
const pool = require('../config/db');

const BRANCH_ID = 1;

async function getAutoPricingEnabled(conn = pool) {
  const [rows] = await conn.query(`SELECT auto_pricing_enabled FROM pricing_settings WHERE branch_id = ?`, [BRANCH_ID]);
  return !!(rows[0] && rows[0].auto_pricing_enabled);
}

// items: [{ productId, warehouseId, oldAvgCost, newAvgCost, triggerSource, referenceType, referenceUuid }]
// WAJIB dipanggil di dalam transaksi (conn) yang sama dengan perubahan stok
// yang memicunya — kalau langkah manapun gagal, semuanya rollback bareng
// (harga & stok tidak pernah boleh "setengah update").
//
// Aturan (dikunci bersama klien):
//  - harga baru per baris = HPP_baru-di-satuan-baris-itu * (1 + markup%_level/100)
//  - markup% per LEVEL harga (bukan per produk/per tier qty) — semua tier
//    qty dalam level yang sama dapat harga hasil hitung yang SAMA
//  - level dengan markup_percent NULL (belum diatur admin) DILEWATI
//  - baris product_prices dengan is_locked=1 DILEWATI (override manual admin)
//  - harga TIDAK PERNAH di bawah HPP di satuan itu (floor keras, "aturan besi")
//  - TIDAK dibulatkan — disimpan presisi penuh apa adanya
//  - kalau tidak ada satu pun baris yang berubah, TIDAK ada event yang dibuat
//    (tidak ada notifikasi kosong/basa-basi)
async function recalculatePricesForProduct(conn, {
  productId, warehouseId, oldAvgCost, newAvgCost, triggerSource, referenceType = null, referenceUuid = null,
}) {
  const enabled = await getAutoPricingEnabled(conn);
  if (!enabled) return { changed: false, reason: 'auto_pricing_disabled' };

  const newAvgCostDecimal = new Decimal(newAvgCost);

  const [rows] = await conn.query(
    `SELECT pp.id, pp.unit_id, pp.price_level_id, pp.price, pp.is_locked,
            pu.conversion_factor, pl.markup_percent
     FROM product_prices pp
     JOIN product_units pu ON pu.product_id = pp.product_id AND pu.unit_id = pp.unit_id
     JOIN price_levels pl ON pl.id = pp.price_level_id
     WHERE pp.product_id = ?`,
    [productId]
  );

  const changedLines = [];
  for (const row of rows) {
    if (row.is_locked) continue;
    if (row.markup_percent === null || row.markup_percent === undefined) continue;

    const conversionFactor = new Decimal(row.conversion_factor);
    const markupPercent = new Decimal(row.markup_percent);
    const costInUnit = newAvgCostDecimal.mul(conversionFactor);
    let computedPrice = costInUnit.mul(markupPercent.div(100).plus(1));
    // Aturan besi: harga jual tidak pernah boleh di bawah HPP.
    if (computedPrice.lt(costInUnit)) computedPrice = costInUnit;

    const oldPrice = new Decimal(row.price);
    if (computedPrice.eq(oldPrice)) continue;

    await conn.query(`UPDATE product_prices SET price = ? WHERE id = ?`, [computedPrice.toFixed(4), row.id]);

    changedLines.push({
      productPriceId: row.id,
      unitId: row.unit_id,
      priceLevelId: row.price_level_id,
      markupPercent: markupPercent.toFixed(4),
      oldPrice: oldPrice.toFixed(4),
      newPrice: computedPrice.toFixed(4),
    });
  }

  if (changedLines.length === 0) return { changed: false, reason: 'no_price_rows_changed' };

  const eventId = uuidv4();
  await conn.query(
    `INSERT INTO price_change_events
      (id, branch_id, product_id, warehouse_id, old_avg_cost, new_avg_cost, trigger_source, reference_type, reference_uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [eventId, BRANCH_ID, productId, warehouseId, new Decimal(oldAvgCost).toFixed(4), newAvgCostDecimal.toFixed(4), triggerSource, referenceType, referenceUuid]
  );

  for (const line of changedLines) {
    await conn.query(
      `INSERT INTO price_change_event_lines
        (id, event_id, product_price_id, unit_id, price_level_id, markup_percent, old_price, new_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), eventId, line.productPriceId, line.unitId, line.priceLevelId, line.markupPercent, line.oldPrice, line.newPrice]
    );
  }

  return { changed: true, eventId, lines: changedLines };
}

module.exports = { getAutoPricingEnabled, recalculatePricesForProduct };
