// Stock Opname (feature/accounting, fase Pembelian & Stock Opname — Bagian B).
//
// Prinsip yang WAJIB dijaga di file ini:
//  1. system_qty_base di stock_opname_items DIISI SEKALI saat sesi dibuat
//     (snapshot), TIDAK PERNAH dibaca ulang dari stock_balances saat
//     finalisasi. Selisih = physical - system SELALU terhadap angka beku
//     ini — supaya transaksi yang terjadi selama proses hitung fisik tidak
//     ikut mengotori angka selisih (itu bukan selisih fisik sungguhan).
//  2. Transaksi yang terjadi ANTARA sesi dibuat dan difinalisasi TIDAK
//     PERNAH menghentikan proses (tidak diblokir) — cuma dideteksi dan
//     dilaporkan balik ke caller (UI yang menampilkan peringatannya).
//  3. Avg cost yang dipakai utk jurnal & valuasi selisih adalah avg cost
//     SAAT FINALISASI (dibaca dari stock_balances saat itu), BUKAN avg cost
//     saat sesi dibuat.
//  4. Penyesuaian stok WAJIB lewat StockMovementService.applyStockMovement —
//     tidak ada jalur tulis stok baru. Jurnal WAJIB lewat
//     AccountingService.postJournalEntry.
//  5. Sesi berstatus 'finalized' tidak boleh diubah lagi (tidak ada endpoint
//     yang mengizinkannya) — koreksi harus lewat sesi opname baru.
const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');
const { applyStockMovement } = require('./StockMovementService');
const { getDefaultWarehouseId } = require('./WarehouseService');
const AccountingService = require('./AccountingService');

const BRANCH_ID = 1;
const PERSEDIAAN_CODE = '1-301';
const KERUGIAN_SELISIH_CODE = '5-207';
const KEUNTUNGAN_SELISIH_CODE = '4-202';

function generateOpnameNumber() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const randomPart = Math.floor(100000 + Math.random() * 900000); // lihat catatan di AccountingService.generateEntryNumber
  return `SO${BRANCH_ID}-${datePart}-${timePart}${randomPart}`;
}

async function listOpnames() {
  const [rows] = await pool.query(
    `SELECT so.id, so.opname_number, so.status, so.notes, so.created_at, so.finalized_at,
            w.name AS warehouse_name, u1.full_name AS created_by_name, u2.full_name AS finalized_by_name,
            (SELECT COUNT(*) FROM stock_opname_items soi WHERE soi.stock_opname_id = so.id) AS item_count,
            (SELECT COUNT(*) FROM stock_opname_items soi WHERE soi.stock_opname_id = so.id AND soi.physical_qty_base IS NULL) AS uncounted_count
     FROM stock_opnames so
     JOIN warehouses w ON w.id = so.warehouse_id
     JOIN users u1 ON u1.id = so.created_by
     LEFT JOIN users u2 ON u2.id = so.finalized_by
     ORDER BY so.created_at DESC`
  );
  return rows;
}

// Deteksi transaksi yang terjadi selama sesi berlangsung — dipakai baik saat
// sesi masih 'in_progress' (peringatan sebelum finalisasi) maupun setelah
// 'finalized' (dilaporkan balik sebagai bagian riwayat, batas atas =
// finalized_at, bukan NOW()). excludeOpnameId WAJIB diisi kalau opname-nya
// sendiri sudah/akan menghasilkan movement (referenceType='stock_opname') —
// tanpa ini, baris penyesuaian yang dihasilkan finalisasi INI SENDIRI akan
// ikut muncul seolah "transaksi mencurigakan yang terjadi di tengah",
// padahal itu justru hasil resmi proses ini, bukan interferensi dari luar.
async function detectInterveningMovements(conn, { warehouseId, productIds, sinceDate, untilDate, excludeOpnameId = null }) {
  if (productIds.length === 0) return [];
  const [rows] = await conn.query(
    `SELECT sm.product_id, p.name AS product_name, sm.movement_type, sm.reference_type,
            sm.qty_in_base, sm.qty_out_base, sm.created_at
     FROM stock_movements sm JOIN products p ON p.id = sm.product_id
     WHERE sm.warehouse_id = ? AND sm.product_id IN (${productIds.map(() => '?').join(',')})
       AND sm.created_at > ? AND sm.created_at <= ?
       AND NOT (sm.reference_type = 'stock_opname' AND sm.reference_uuid = ?)
     ORDER BY sm.created_at ASC`,
    [warehouseId, ...productIds, sinceDate, untilDate, excludeOpnameId]
  );
  return rows;
}

// Buat sesi baru — snapshot stok SEMUA produk aktif di gudang default, PADA
// SAAT INI JUGA. Snapshot inilah (system_qty_base) yang jadi acuan selisih
// nanti, sengaja diambil sekarang dan tidak akan dibaca ulang.
async function createOpnameSession({ notes, createdBy }) {
  const warehouseId = await getDefaultWarehouseId();
  const opnameId = uuidv4();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [products] = await conn.query(
      `SELECT p.id AS product_id, COALESCE(sb.qty_base, 0) AS qty_base
       FROM products p
       LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.warehouse_id = ?
       WHERE p.is_active = 1
       ORDER BY p.name ASC`,
      [warehouseId]
    );
    if (products.length === 0) {
      throw new HttpError(400, 'no_products', 'Tidak ada produk aktif untuk diopname');
    }

    const opnameNumber = generateOpnameNumber();
    await conn.query(
      `INSERT INTO stock_opnames (id, branch_id, opname_number, warehouse_id, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      [opnameId, BRANCH_ID, opnameNumber, warehouseId, notes || null, createdBy]
    );

    for (const p of products) {
      await conn.query(
        `INSERT INTO stock_opname_items (id, stock_opname_id, product_id, system_qty_base) VALUES (?, ?, ?, ?)`,
        [uuidv4(), opnameId, p.product_id, p.qty_base]
      );
    }

    await conn.commit();
    return { id: opnameId, opnameNumber, warehouseId, itemCount: products.length };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getOpnameDetail(opnameId) {
  const [[opname]] = await pool.query(
    `SELECT so.*, w.name AS warehouse_name, u1.full_name AS created_by_name, u2.full_name AS finalized_by_name
     FROM stock_opnames so
     JOIN warehouses w ON w.id = so.warehouse_id
     JOIN users u1 ON u1.id = so.created_by
     LEFT JOIN users u2 ON u2.id = so.finalized_by
     WHERE so.id = ?`,
    [opnameId]
  );
  if (!opname) throw new HttpError(404, 'opname_not_found', 'Sesi opname tidak ditemukan');

  const [items] = await pool.query(
    `SELECT soi.*, p.name AS product_name, p.sku
     FROM stock_opname_items soi JOIN products p ON p.id = soi.product_id
     WHERE soi.stock_opname_id = ? ORDER BY p.name ASC`,
    [opnameId]
  );

  const interveningMovements = await detectInterveningMovements(pool, {
    warehouseId: opname.warehouse_id,
    productIds: items.map((i) => i.product_id),
    sinceDate: opname.created_at,
    untilDate: opname.finalized_at || new Date(),
    excludeOpnameId: opnameId,
  });

  return { opname, items, interveningMovements };
}

// Input stok fisik satu produk. Boleh dipanggil berkali-kali (staff bisa
// koreksi ketikan sebelum finalisasi) SELAMA sesi masih 'in_progress'.
async function recordPhysicalCount({ opnameId, itemId, physicalQtyBase }) {
  const [[opname]] = await pool.query(`SELECT status FROM stock_opnames WHERE id = ?`, [opnameId]);
  if (!opname) throw new HttpError(404, 'opname_not_found', 'Sesi opname tidak ditemukan');
  if (opname.status !== 'in_progress') {
    throw new HttpError(409, 'opname_finalized', 'Sesi opname ini sudah difinalisasi — tidak bisa diubah lagi. Buat sesi opname baru untuk koreksi.');
  }
  const qty = new Decimal(physicalQtyBase);
  if (qty.lt(0)) throw new HttpError(400, 'bad_request', 'Stok fisik tidak boleh negatif');

  const [result] = await pool.query(
    `UPDATE stock_opname_items SET physical_qty_base = ?, counted_at = NOW() WHERE id = ? AND stock_opname_id = ?`,
    [qty.toFixed(4), itemId, opnameId]
  );
  if (result.affectedRows === 0) throw new HttpError(404, 'item_not_found', 'Item opname tidak ditemukan');
  return { itemId, physicalQtyBase: qty.toFixed(4) };
}

// Finalisasi: hitung selisih (physical - system SNAPSHOT, bukan live),
// terapkan ke stok lewat applyStockMovement pakai avg cost SAAT INI,
// catat stock_adjustments, lalu posting SATU jurnal gabungan (gain & loss
// dipisah baris, bukan dinetkan, supaya kelihatan jelas di buku besar).
async function finalizeOpname({ opnameId, userId }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[opname]] = await conn.query(`SELECT * FROM stock_opnames WHERE id = ? FOR UPDATE`, [opnameId]);
    if (!opname) throw new HttpError(404, 'opname_not_found', 'Sesi opname tidak ditemukan');
    if (opname.status !== 'in_progress') {
      throw new HttpError(409, 'already_finalized', 'Sesi opname ini sudah difinalisasi sebelumnya');
    }

    const [items] = await conn.query(`SELECT * FROM stock_opname_items WHERE stock_opname_id = ?`, [opnameId]);
    const uncounted = items.filter((i) => i.physical_qty_base === null);
    if (uncounted.length > 0) {
      throw new HttpError(400, 'incomplete_count', `${uncounted.length} produk belum diinput stok fisiknya — lengkapi dulu sebelum finalisasi`);
    }

    const interveningMovements = await detectInterveningMovements(conn, {
      warehouseId: opname.warehouse_id,
      productIds: items.map((i) => i.product_id),
      sinceDate: opname.created_at,
      untilDate: new Date(),
      excludeOpnameId: opnameId,
    });
    const interveningProductIds = new Set(interveningMovements.map((r) => r.product_id));

    let totalGain = new Decimal(0);
    let totalLoss = new Decimal(0);
    const resultItems = [];

    for (const item of items) {
      const systemQty = new Decimal(item.system_qty_base);
      const physicalQty = new Decimal(item.physical_qty_base);
      const variance = physicalQty.minus(systemQty);

      const [[balance]] = await conn.query(
        `SELECT avg_cost_per_base_unit FROM stock_balances WHERE warehouse_id = ? AND product_id = ?`,
        [opname.warehouse_id, item.product_id]
      );
      const avgCostNow = balance ? new Decimal(balance.avg_cost_per_base_unit) : new Decimal(0);

      if (variance.eq(0)) {
        await conn.query(
          `UPDATE stock_opname_items SET variance_qty_base = 0, avg_cost_at_finalization = ?, variance_value = 0 WHERE id = ?`,
          [avgCostNow.toFixed(4), item.id]
        );
        resultItems.push({
          productId: item.product_id, systemQtyBase: systemQty.toFixed(4), physicalQtyBase: physicalQty.toFixed(4),
          varianceQtyBase: '0.0000', varianceValue: '0.0000',
          hadInterveningTransaction: interveningProductIds.has(item.product_id),
        });
        continue;
      }

      const varianceValue = variance.mul(avgCostNow);

      if (variance.gt(0)) {
        // Selisih LEBIH (stok fisik > sistem) — diperlakukan sbg "masuk" pada
        // avg cost SAAT INI, supaya moving average produk lain TIDAK bergeser
        // gara-gara penyesuaian yang sumbernya bukan pembelian sungguhan.
        await applyStockMovement(conn, {
          warehouseId: opname.warehouse_id, productId: item.product_id,
          movementType: 'opname', referenceType: 'stock_opname', referenceUuid: opnameId,
          qtyInBase: variance.toFixed(4), costPerBaseUnit: avgCostNow.toFixed(4), movementDate: new Date(),
        });
        totalGain = totalGain.plus(varianceValue);
      } else {
        await applyStockMovement(conn, {
          warehouseId: opname.warehouse_id, productId: item.product_id,
          movementType: 'opname', referenceType: 'stock_opname', referenceUuid: opnameId,
          qtyOutBase: variance.abs().toFixed(4), movementDate: new Date(),
        });
        totalLoss = totalLoss.plus(varianceValue.abs());
      }

      await conn.query(
        `INSERT INTO stock_adjustments (id, branch_id, warehouse_id, product_id, adjustment_type, qty_base, reason, created_by)
         VALUES (?, ?, ?, ?, 'opname', ?, ?, ?)`,
        [uuidv4(), BRANCH_ID, opname.warehouse_id, item.product_id, variance.toFixed(4), `Stock opname ${opname.opname_number}`, userId]
      );

      await conn.query(
        `UPDATE stock_opname_items SET variance_qty_base = ?, avg_cost_at_finalization = ?, variance_value = ? WHERE id = ?`,
        [variance.toFixed(4), avgCostNow.toFixed(4), varianceValue.toFixed(4), item.id]
      );

      resultItems.push({
        productId: item.product_id, systemQtyBase: systemQty.toFixed(4), physicalQtyBase: physicalQty.toFixed(4),
        varianceQtyBase: variance.toFixed(4), avgCostAtFinalization: avgCostNow.toFixed(4), varianceValue: varianceValue.toFixed(4),
        hadInterveningTransaction: interveningProductIds.has(item.product_id),
      });
    }

    let journalEntry = null;
    if (totalGain.gt(0) || totalLoss.gt(0)) {
      const persediaanAccount = await AccountingService.getAccountByCode(PERSEDIAAN_CODE, conn);
      const lines = [];
      if (totalGain.gt(0)) {
        const keuntunganAccount = await AccountingService.getAccountByCode(KEUNTUNGAN_SELISIH_CODE, conn);
        lines.push({ accountId: persediaanAccount.id, debit: totalGain, description: 'Selisih lebih stock opname' });
        lines.push({ accountId: keuntunganAccount.id, credit: totalGain, description: 'Keuntungan selisih persediaan' });
      }
      if (totalLoss.gt(0)) {
        const kerugianAccount = await AccountingService.getAccountByCode(KERUGIAN_SELISIH_CODE, conn);
        lines.push({ accountId: kerugianAccount.id, debit: totalLoss, description: 'Kerugian selisih persediaan' });
        lines.push({ accountId: persediaanAccount.id, credit: totalLoss, description: 'Selisih kurang stock opname' });
      }
      journalEntry = await AccountingService.postJournalEntry(conn, {
        entryDate: new Date(),
        description: `Penyesuaian stock opname ${opname.opname_number}`,
        sourceType: 'stock_opname',
        sourceUuid: opnameId,
        lines,
        createdBy: userId,
      });
    }

    // NOW(3), bukan NOW() — kolom finalized_at DATETIME(3), lihat catatan di
    // schema.sql. NOW() tanpa argumen akan membulatkan ke detik, kembali
    // membuka celah presisi yang sama yang baru diperbaiki.
    await conn.query(
      `UPDATE stock_opnames SET status = 'finalized', finalized_by = ?, finalized_at = NOW(3) WHERE id = ?`,
      [userId, opnameId]
    );

    await conn.commit();

    return {
      id: opnameId,
      opnameNumber: opname.opname_number,
      status: 'finalized',
      items: resultItems,
      totalGain: totalGain.toFixed(4),
      totalLoss: totalLoss.toFixed(4),
      journalEntry,
      interveningProductCount: interveningProductIds.size,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { listOpnames, createOpnameSession, getOpnameDetail, recordPhysicalCount, finalizeOpname };
