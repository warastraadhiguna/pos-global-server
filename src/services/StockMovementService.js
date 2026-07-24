// Stock movement = sumber kebenaran stok (Bagian 5 poin 6). stock_balances
// cuma cache dan HARUS selalu bisa direkonstruksi ulang dari SUM/replay
// stock_movements. Jangan pernah ubah stock_balances tanpa menulis baris
// stock_movements dulu.
const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');
const pool = require('../config/db');

const BRANCH_ID = 1;

// movement_type yang menandai "OUT berbasis nilai" — pembalik sebuah IN
// movement lama (mis. void pembelian), BUKAN konsumsi biasa (jual/opname/
// retur). Lihat catatan panjang di applyMovementStep soal kenapa keduanya
// butuh formula yang beda secara matematis, bukan cuma soal istilah.
const VALUE_REVERSAL_MOVEMENT_TYPES = new Set(['purchase_void']);

// Terapkan satu movement ke state {qty, avgCost} dan hasilkan state baru.
//
// Moving average (weighted average): saat barang masuk, avg cost dihitung
// ulang tertimbang. Saat barang keluar, ada DUA kemungkinan cara yang
// hasilnya beda secara matematis:
//   1. Konsumsi biasa (jual, retur ke supplier, opname selisih kurang) —
//      qty berkurang, avgCost TIDAK berubah. Ini benar karena yang keluar
//      adalah unit generik dari pool yang sudah membaur, bukan membatalkan
//      penambahan value tertentu.
//   2. Reversal-nilai (void pembelian) — membatalkan KONTRIBUSI VALUE dari
//      sebuah IN movement yang sudah lama terjadi (bisa saja SETELAH ada
//      penjualan lain yang sudah mengunci HPP-nya sendiri dan tidak boleh
//      diubah lagi). Di sini avgCost WAJIB direkalkulasi: kurangi total
//      value sebesar (qtyOut x cost ASLI movement yang dibatalkan), baru
//      bagi ulang dengan sisa qty. Formula ini kebalikan MATEMATIS dari
//      blending IN di atas — BUKAN "OUT pada avg cost berjalan" (itu akan
//      salah bahkan di kasus paling sederhana sekalipun, sudah dibuktikan
//      dengan angka & disepakati sebelum kode ini ditulis).
//   `movement.cost_per_base_unit` dipakai sbg basis nilai yang dibatalkan
//   utk mode reversal — WAJIB diisi cost ASLI item pembelian yang di-void,
//   bukan avg cost sekarang.
function applyMovementStep(state, movement) {
  let qty = state.qty;
  let avgCost = state.avgCost;

  const qtyIn = new Decimal(movement.qty_in_base || 0);
  const qtyOut = new Decimal(movement.qty_out_base || 0);

  if (qtyIn.gt(0)) {
    const costIn = new Decimal(movement.cost_per_base_unit || 0);
    const totalCostBefore = qty.mul(avgCost);
    const totalCostIn = qtyIn.mul(costIn);
    const newQty = qty.plus(qtyIn);
    avgCost = newQty.gt(0) ? totalCostBefore.plus(totalCostIn).div(newQty) : new Decimal(0);
    qty = newQty;
  }

  if (qtyOut.gt(0)) {
    if (VALUE_REVERSAL_MOVEMENT_TYPES.has(movement.movement_type)) {
      const reversalCost = new Decimal(movement.cost_per_base_unit || 0);
      const totalValueBefore = qty.mul(avgCost);
      const valueRemoved = qtyOut.mul(reversalCost);
      const newQty = qty.minus(qtyOut);
      avgCost = newQty.gt(0) ? totalValueBefore.minus(valueRemoved).div(newQty) : new Decimal(0);
      qty = newQty;
    } else {
      qty = qty.minus(qtyOut);
    }
  }

  return { qty, avgCost };
}

function replayMovements(movements) {
  let state = { qty: new Decimal(0), avgCost: new Decimal(0) };
  for (const m of movements) {
    state = applyMovementStep(state, m);
  }
  return { qtyBase: state.qty, avgCostPerBaseUnit: state.avgCost };
}

async function upsertBalance(conn, { warehouseId, productId, qtyBase, avgCostPerBaseUnit }) {
  const [existing] = await conn.query(
    `SELECT id FROM stock_balances WHERE warehouse_id = ? AND product_id = ? LIMIT 1`,
    [warehouseId, productId]
  );

  if (existing[0]) {
    await conn.query(
      `UPDATE stock_balances SET qty_base = ?, avg_cost_per_base_unit = ? WHERE id = ?`,
      [qtyBase.toFixed(4), avgCostPerBaseUnit.toFixed(4), existing[0].id]
    );
  } else {
    await conn.query(
      `INSERT INTO stock_balances (id, branch_id, warehouse_id, product_id, qty_base, avg_cost_per_base_unit)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), BRANCH_ID, warehouseId, productId, qtyBase.toFixed(4), avgCostPerBaseUnit.toFixed(4)]
    );
  }
}

// Tulis satu baris stock_movements lalu update cache stock_balances secara
// incremental (bukan recompute penuh) di dalam transaksi yang sama.
// Dipakai oleh service lain (mis. SalesService) — wajib dipanggil dengan
// `conn` dari transaksi yang sedang berjalan, bukan pool langsung.
// `costPerBaseUnit` maknanya beda tergantung arah:
//  - qtyInBase > 0: harga barang masuk, dipakai blending avg cost seperti biasa.
//  - qtyOutBase > 0 & movementType TERMASUK VALUE_REVERSAL_MOVEMENT_TYPES:
//    WAJIB cost ASLI movement IN yang dibatalkan (bukan avg cost sekarang) —
//    lihat applyMovementStep.
//  - qtyOutBase > 0 & movementType lain (konsumsi biasa): diabaikan, cost
//    basis diambil otomatis dari avg cost saat ini.
async function applyStockMovement(conn, {
  warehouseId,
  productId,
  movementType,
  referenceType = null,
  referenceUuid = null,
  qtyInBase = 0,
  qtyOutBase = 0,
  costPerBaseUnit = 0,
  movementDate = new Date(),
}) {
  const [balRows] = await conn.query(
    `SELECT qty_base, avg_cost_per_base_unit FROM stock_balances
     WHERE warehouse_id = ? AND product_id = ? FOR UPDATE`,
    [warehouseId, productId]
  );
  const currentState = balRows[0]
    ? { qty: new Decimal(balRows[0].qty_base), avgCost: new Decimal(balRows[0].avg_cost_per_base_unit) }
    : { qty: new Decimal(0), avgCost: new Decimal(0) };

  const isValueReversal = VALUE_REVERSAL_MOVEMENT_TYPES.has(movementType);
  // costForOut = basis nilai yang dicatat di baris stock_movements ini utk
  // sisi OUT — avg cost berjalan utk konsumsi biasa, atau cost ASLI yg
  // dibatalkan utk reversal-nilai (supaya replay nanti mereproduksi hasil
  // yang sama persis, lihat recalculateAllBalances di bawah).
  const costForOut = isValueReversal ? new Decimal(costPerBaseUnit || 0) : currentState.avgCost;
  const newState = applyMovementStep(currentState, {
    qty_in_base: qtyInBase,
    qty_out_base: qtyOutBase,
    cost_per_base_unit: costPerBaseUnit,
    movement_type: movementType,
  });

  const totalCost = new Decimal(qtyInBase || 0).mul(costPerBaseUnit || 0)
    .plus(new Decimal(qtyOutBase || 0).mul(costForOut));

  const movementId = uuidv4();
  await conn.query(
    `INSERT INTO stock_movements
      (id, branch_id, warehouse_id, product_id, movement_type, reference_type, reference_uuid,
       qty_in_base, qty_out_base, cost_per_base_unit, total_cost, balance_after_base, movement_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      movementId, BRANCH_ID, warehouseId, productId, movementType, referenceType, referenceUuid,
      qtyInBase, qtyOutBase,
      qtyInBase > 0 ? costPerBaseUnit : costForOut.toFixed(4),
      totalCost.toFixed(4),
      newState.qty.toFixed(4),
      movementDate,
    ]
  );

  await upsertBalance(conn, { warehouseId, productId, qtyBase: newState.qty, avgCostPerBaseUnit: newState.avgCost });

  return { movementId, qtyBase: newState.qty, avgCostPerBaseUnit: newState.avgCost };
}

// Rekalkulasi PENUH stock_balances dari nol, replay seluruh stock_movements
// per (warehouse, product) terurut kronologis. Dipakai untuk perbaikan kalau
// cache dicurigai drift dari ledger — sesuai Bagian 5 poin 6.
async function recalculateAllBalances() {
  const conn = await pool.getConnection();
  const results = [];
  try {
    const [pairs] = await conn.query(
      `SELECT DISTINCT warehouse_id, product_id FROM stock_movements`
    );

    await conn.beginTransaction();

    for (const { warehouse_id: warehouseId, product_id: productId } of pairs) {
      // movement_type WAJIB ikut di-SELECT — applyMovementStep butuh itu utk
      // tahu baris mana yang reversal-nilai (lihat VALUE_REVERSAL_MOVEMENT_TYPES),
      // supaya replay mereproduksi avg cost yang sama persis dgn saat live.
      const [movements] = await conn.query(
        `SELECT qty_in_base, qty_out_base, cost_per_base_unit, movement_type
         FROM stock_movements
         WHERE warehouse_id = ? AND product_id = ?
         ORDER BY movement_date ASC, created_at ASC, id ASC`,
        [warehouseId, productId]
      );

      const { qtyBase, avgCostPerBaseUnit } = replayMovements(movements);
      await upsertBalance(conn, { warehouseId, productId, qtyBase, avgCostPerBaseUnit });

      results.push({
        warehouseId,
        productId,
        qtyBase: qtyBase.toFixed(4),
        avgCostPerBaseUnit: avgCostPerBaseUnit.toFixed(4),
        movementsReplayed: movements.length,
      });
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return results;
}

module.exports = { applyStockMovement, recalculateAllBalances, replayMovements };
