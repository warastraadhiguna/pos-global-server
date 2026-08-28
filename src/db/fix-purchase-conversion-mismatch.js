// ============================================================================
// PERBAIKAN: konversi satuan yang berubah di tengah riwayat pembelian.
// ============================================================================
//
// KASUS YANG DITANGANI (ditemukan 2026-08-28, produk "Lux Cup Saos Container
// 25 ml" & "35 ml"): faktor konversi sebuah satuan (mis. "dus" = berapa
// satuan dasar) SEMPAT DIUBAH di menu Produk > Satuan & Konversi SETELAH
// sudah ada pembelian yang memakai satuan itu. Pembelian LAMA tetap
// menyimpan konversi yang berlaku SAAT ITU (snapshot, ini benar & disengaja
// — lihat catatan di schema.sql), tapi kalau konversinya SALAH diketik lalu
// dikoreksi belakangan, pembelian lama itu jadi punya:
//   - quantity_base (jumlah stok masuk dalam satuan dasar) yang salah
//   - cost_per_base_unit (dipakai utk hitung HPP rata-rata) yang ikut salah
// Akibatnya HPP produk jadi menyimpang jauh dari harga beli sungguhan —
// gejalanya: harga jual "selalu dianggap di bawah HPP" padahal tidak ada
// diskon, dan angka Acuan HPP di halaman detail produk kelihatan aneh
// (kelipatan 2x, dst) dibanding harga di Riwayat Pembelian.
//
// APAKAH SCRIPT INI BISA DIPAKAI LAGI DI MASA DEPAN? — YA. Script ini TIDAK
// hardcode nama produk tertentu. Deteksinya generik: cari semua baris
// purchase_items (dari pembelian yang statusnya 'completed', bukan draft
// ataupun void) yang conversion_factor-nya BEDA dari conversion_factor yang
// SEKARANG berlaku di product_units untuk kombinasi produk+satuan itu. Jadi
// kalau suatu saat nanti ada lagi kasus serupa (satuan produk lain sempat
// salah lalu dikoreksi), tinggal jalankan script ini lagi — akan otomatis
// ketemu & bisa diperbaiki, tanpa perlu diedit dulu.
//
// ASUMSI PENTING (baca sebelum --apply): script ini menganggap ANGKA
// KONVERSI YANG SEKARANG di Produk > Satuan & Konversi itu BENAR, dan
// pembelian lama yang beda dari itu itu YANG SALAH. Kalau ternyata
// sebaliknya (angka yang SEKARANG justru yang salah), JANGAN jalankan
// --apply — perbaiki dulu angka konversinya di menu Produk, baru jalankan
// script ini lagi.
//
// APA YANG DIUBAH (kalau --apply):
//   1. purchase_items: conversion_factor, quantity_base, cost_per_base_unit
//      baris yang salah dikoreksi pakai konversi yang benar (SEKARANG).
//      quantity (jumlah dus/pack yang diketik) dan subtotal (total rupiah
//      yang dibayar) TIDAK PERNAH diubah — itu fakta transaksi asli, bukan
//      hasil hitung.
//   2. stock_movements: baris pembelian yang berpasangan (qty_in_base,
//      cost_per_base_unit, total_cost) dikoreksi sama persis.
//   3. balance_after_base tiap baris stock_movements produk yang terdampak,
//      dan stock_balances (qty_base + avg_cost_per_base_unit) dihitung ULANG
//      dari nol lewat replay kronologis (StockMovementService.applyMovementStep,
//      fungsi YANG SAMA dipakai sistem live, bukan logic duplikat).
//
// APA YANG **TIDAK** DIUBAH:
//   - Jurnal akuntansi (journal_entries/journal_entry_lines) — nilai rupiah
//     yang sudah dibayar/dicatat di jurnal itu FAKTA, tidak pernah salah,
//     tidak disentuh sama sekali.
//   - Baris stock_movements non-pembelian (penjualan, void, retur, opname,
//     pemakaian internal) — cost_per_base_unit yang tercatat di situ murni
//     snapshot "avg cost SAAT itu", tetap dibiarkan sbg jejak historis apa
//     adanya.
//
// ⚠️ PERINGATAN — INI MENGUBAH JUMLAH STOK (quantity_base), BUKAN CUMA
// HARGA. Kalau konversi lama SALAH lebih kecil dari yang benar (spt kasus
// 25ml: 12 -> 24), maka STOK YANG TERCATAT MASUK JUGA IKUT NAIK (krn
// quantity_base = quantity x conversion). Cek dulu ke stok FISIK toko
// sebelum --apply kalau ragu — kalau angka stok fisik tidak cocok, JANGAN
// jalankan --apply, laporkan dulu.
//
// CARA PAKAI:
//   1. node src/db/fix-purchase-conversion-mismatch.js
//      -> MODE DRY-RUN (default, TIDAK mengubah apa pun). Tampilkan semua
//         yang akan diperbaiki, cek dulu angkanya masuk akal.
//   2. node src/db/fix-purchase-conversion-mismatch.js --apply
//      -> Baru benar-benar memperbaiki, dibungkus SATU transaksi (kalau ada
//         yang gagal di tengah, semua dibatalkan/rollback, tidak ada
//         perubahan setengah-setengah).
//   3. Jalankan lagi TANPA --apply setelahnya utk konfirmasi sudah bersih
//      (idempotent — kalau tidak ada lagi yang cocok kriteria, "Tidak ada
//      masalah ditemukan").
require('dotenv').config();
const Decimal = require('decimal.js');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const { applyMovementStep } = require('../services/StockMovementService');

const APPLY = process.argv.includes('--apply');
const BRANCH_ID = 1;
// Selisih di bawah ini dianggap noise pembulatan desimal, bukan masalah
// sungguhan (mis. 60.0000 vs 60.0001) — supaya script tidak "memperbaiki"
// sesuatu yang sebenarnya sudah benar.
const FLOAT_TOLERANCE = 0.001;

function rp(n) {
  return `Rp${Number(n).toLocaleString('id-ID', { maximumFractionDigits: 4 })}`;
}

async function findMismatches(conn) {
  const [rows] = await conn.query(`
    SELECT pi.id AS purchase_item_id, pi.purchase_id, pi.product_id, pi.unit_id,
           pi.quantity, pi.conversion_factor AS old_conversion, pi.quantity_base AS old_quantity_base,
           pi.cost_per_base_unit AS old_cost_per_base_unit, pi.subtotal,
           puc.conversion_factor AS current_conversion,
           p.name AS product_name, un.name AS unit_name,
           pu.purchase_number, pu.purchase_date, pu.warehouse_id
    FROM purchase_items pi
    JOIN purchases pu ON pu.id = pi.purchase_id
    JOIN products p ON p.id = pi.product_id
    JOIN units un ON un.id = pi.unit_id
    JOIN product_units puc ON puc.product_id = pi.product_id AND puc.unit_id = pi.unit_id
    WHERE pu.status = 'completed'
      AND ABS(pi.conversion_factor - puc.conversion_factor) > ${FLOAT_TOLERANCE}
    ORDER BY p.name, pu.purchase_date, pu.created_at
  `);
  return rows;
}

// Replay SELURUH riwayat pergerakan produk ini (kronologis), tulis ulang
// balance_after_base tiap baris + stock_balances akhir. Dipakai SETELAH
// baris pembelian yang salah dikoreksi, supaya seluruh rantai saldo
// (termasuk penjualan/void SETELAH pembelian yang dikoreksi) ikut konsisten.
async function replayAndPersist(conn, warehouseId, productId) {
  const [movements] = await conn.query(
    `SELECT id, movement_type, qty_in_base, qty_out_base, cost_per_base_unit
     FROM stock_movements
     WHERE warehouse_id = ? AND product_id = ?
     ORDER BY movement_date ASC, created_at ASC, id ASC`,
    [warehouseId, productId]
  );

  let state = { qty: new Decimal(0), avgCost: new Decimal(0) };
  for (const m of movements) {
    state = applyMovementStep(state, {
      qty_in_base: m.qty_in_base,
      qty_out_base: m.qty_out_base,
      cost_per_base_unit: m.cost_per_base_unit,
      movement_type: m.movement_type,
    });
    await conn.query(`UPDATE stock_movements SET balance_after_base = ? WHERE id = ?`, [state.qty.toFixed(4), m.id]);
  }

  const [[existing]] = await conn.query(
    `SELECT id FROM stock_balances WHERE warehouse_id = ? AND product_id = ?`,
    [warehouseId, productId]
  );
  if (existing) {
    await conn.query(
      `UPDATE stock_balances SET qty_base = ?, avg_cost_per_base_unit = ? WHERE id = ?`,
      [state.qty.toFixed(4), state.avgCost.toFixed(4), existing.id]
    );
  } else {
    await conn.query(
      `INSERT INTO stock_balances (id, branch_id, warehouse_id, product_id, qty_base, avg_cost_per_base_unit) VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), BRANCH_ID, warehouseId, productId, state.qty.toFixed(4), state.avgCost.toFixed(4)]
    );
  }
  return state;
}

async function run() {
  const conn = await pool.getConnection();
  try {
    const mismatches = await findMismatches(conn);

    if (mismatches.length === 0) {
      console.log('Tidak ada masalah konversi satuan ditemukan pada riwayat pembelian. Database ini bersih.');
      return;
    }

    console.log(`Ditemukan ${mismatches.length} baris pembelian dgn konversi satuan yang TIDAK COCOK dgn setting SEKARANG:\n`);
    for (const m of mismatches) {
      const newQtyBase = new Decimal(m.quantity).mul(m.current_conversion);
      const newCostPerBaseUnit = new Decimal(m.subtotal).div(newQtyBase);
      console.log(`- ${m.product_name} (satuan "${m.unit_name}") — Nota ${m.purchase_number} (${new Date(m.purchase_date).toLocaleDateString('id-ID')})`);
      console.log(`    Konversi tercatat saat beli: ${Number(m.old_conversion)}   ->   Konversi SEKARANG: ${Number(m.current_conversion)}`);
      console.log(`    Qty base (stok masuk): ${Number(m.old_quantity_base)}   ->   ${newQtyBase.toFixed(4)}  (${newQtyBase.gt(m.old_quantity_base) ? 'NAIK' : 'TURUN'})`);
      console.log(`    Cost per satuan dasar: ${rp(m.old_cost_per_base_unit)}   ->   ${rp(newCostPerBaseUnit)}`);
      console.log('');
    }

    if (!APPLY) {
      console.log('=== MODE DRY-RUN — belum ada satu pun yang diubah ===');
      console.log('Cek dulu angka di atas masuk akal (terutama perubahan qty base vs stok fisik).');
      console.log('Kalau sudah yakin, jalankan ulang dengan --apply:');
      console.log('  node src/db/fix-purchase-conversion-mismatch.js --apply');
      return;
    }

    console.log('=== MODE APPLY — memperbaiki data sekarang ===\n');
    await conn.beginTransaction();

    const affectedProducts = new Map(); // key: `${warehouseId}|${productId}` -> productName
    for (const m of mismatches) {
      const newQtyBase = new Decimal(m.quantity).mul(m.current_conversion);
      const newCostPerBaseUnit = new Decimal(m.subtotal).div(newQtyBase);

      await conn.query(
        `UPDATE purchase_items SET conversion_factor = ?, quantity_base = ?, cost_per_base_unit = ? WHERE id = ?`,
        [m.current_conversion, newQtyBase.toFixed(4), newCostPerBaseUnit.toFixed(4), m.purchase_item_id]
      );

      // reference_uuid + product_id SAJA belum tentu unik — produk yang
      // sama bisa dibeli dalam >1 satuan pada nota YANG SAMA (mis. dus +
      // pack sekaligus), jadi >1 baris stock_movements berbagi reference
      // yang sama. Tambahkan qty_in_base + cost_per_base_unit (nilai LAMA,
      // sebelum diupdate) sbg penanda tambahan spy tepat kena baris yang
      // berpasangan dgn purchase_item ini, bukan baris satuan lain.
      const [smRows] = await conn.query(
        `SELECT id FROM stock_movements
         WHERE reference_type = 'purchase' AND reference_uuid = ? AND product_id = ?
           AND qty_in_base = ? AND cost_per_base_unit = ?`,
        [m.purchase_id, m.product_id, m.old_quantity_base, m.old_cost_per_base_unit]
      );
      if (smRows.length !== 1) {
        throw new Error(
          `Tidak bisa menemukan tepat SATU stock_movement yang cocok utk purchase_item ${m.purchase_item_id} ` +
          `(ketemu ${smRows.length}) — dibatalkan semuanya, tidak ada yang diubah. Perlu diperiksa manual.`
        );
      }
      await conn.query(
        `UPDATE stock_movements SET qty_in_base = ?, cost_per_base_unit = ?, total_cost = ? WHERE id = ?`,
        [newQtyBase.toFixed(4), newCostPerBaseUnit.toFixed(4), m.subtotal, smRows[0].id]
      );

      affectedProducts.set(`${m.warehouse_id}|${m.product_id}`, m.product_name);
    }

    console.log('Menghitung ulang saldo & avg cost dari seluruh riwayat pergerakan produk yang terdampak...\n');
    for (const [key, productName] of affectedProducts) {
      const [warehouseId, productId] = key.split('|');
      const final = await replayAndPersist(conn, warehouseId, productId);
      console.log(`  ${productName}: stok akhir ${final.qty.toFixed(4)} satuan dasar, avg cost ${rp(final.avgCost)}/satuan dasar`);
    }

    await conn.commit();
    console.log('\nSelesai — perbaikan tersimpan.');
    console.log('Jurnal akuntansi TIDAK diubah (nilai yang sudah dibayar tetap sama persis — cuma alokasi biaya per-satuan-dasar & jumlah stok masuk yang dikoreksi).');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('Gagal:', err.message);
  process.exit(1);
});
