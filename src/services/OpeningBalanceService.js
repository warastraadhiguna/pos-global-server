// Jurnal saldo awal (feature/accounting Lapis 4, tambahan). Melengkapi celah
// yang ditemukan setelah demo: nilai persediaan tidak pernah dijurnal, jadi
// akun Persediaan mulai dari nol lalu terus-menerus dikredit oleh HPP
// penjualan — hasilnya saldo kredit (mustahil secara akuntansi utk akun
// aset). Proses ini MANUAL, sekali-jalan, dgn pengaman level-database
// (UNIQUE opening_balance_runs.balance_type) — lihat schema.sql.
const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');
const AccountingService = require('./AccountingService');

const PERSEDIAAN_CODE = '1-301';
const MODAL_PEMILIK_CODE = '3-101';
const INVENTORY_BALANCE_TYPE = 'inventory';

async function computeInventoryValue() {
  const [rows] = await pool.query(
    `SELECT sb.qty_base, sb.avg_cost_per_base_unit, p.name AS product_name
     FROM stock_balances sb
     JOIN products p ON p.id = sb.product_id
     WHERE sb.qty_base <> 0
     ORDER BY p.name ASC`
  );
  let totalValue = new Decimal(0);
  const items = rows.map((r) => {
    const value = new Decimal(r.qty_base).mul(r.avg_cost_per_base_unit);
    totalValue = totalValue.plus(value);
    return {
      productName: r.product_name,
      qtyBase: r.qty_base,
      avgCostPerBaseUnit: r.avg_cost_per_base_unit,
      value: value.toFixed(4),
    };
  });
  return { items, totalValue };
}

// Read-only — dipakai admin UI utk lihat berapa nilai yang AKAN dijurnal
// sebelum menekan tombol jalankan, dan apakah sudah pernah dijalankan.
async function previewInventoryOpeningBalance() {
  const { items, totalValue } = await computeInventoryValue();
  const [[existingRun]] = await pool.query(
    `SELECT id, journal_entry_id, created_at FROM opening_balance_runs WHERE balance_type = ?`,
    [INVENTORY_BALANCE_TYPE]
  );
  return {
    items,
    totalValue: totalValue.toFixed(4),
    alreadyPosted: !!existingRun,
    postedAt: existingRun ? existingRun.created_at : null,
  };
}

// Debit Persediaan Barang Dagang, Kredit Modal Pemilik, sebesar
// SUM(qty_base x avg_cost_per_base_unit) dari stock_balances SAAT INI
// (sumber kebenaran stok yang sudah ada — bukan angka baru, cuma belum
// pernah dijurnal). Ditolak kalau sudah pernah dijalankan sebelumnya.
async function postInventoryOpeningBalance({ entryDate, createdBy }) {
  if (!entryDate) throw new HttpError(400, 'bad_request', 'entryDate wajib diisi');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[existingRun]] = await conn.query(
      `SELECT id FROM opening_balance_runs WHERE balance_type = ? FOR UPDATE`,
      [INVENTORY_BALANCE_TYPE]
    );
    if (existingRun) {
      throw new HttpError(409, 'already_posted', 'Jurnal saldo awal persediaan sudah pernah dijalankan sebelumnya — tidak dijalankan ulang');
    }

    const [rows] = await conn.query(
      `SELECT qty_base, avg_cost_per_base_unit FROM stock_balances WHERE qty_base <> 0`
    );
    let totalValue = new Decimal(0);
    for (const r of rows) {
      totalValue = totalValue.plus(new Decimal(r.qty_base).mul(r.avg_cost_per_base_unit));
    }
    if (totalValue.lte(0)) {
      throw new HttpError(400, 'bad_request', 'Tidak ada nilai persediaan untuk dijurnal (stok kosong atau nilai nol)');
    }

    const persediaanAccount = await AccountingService.getAccountByCode(PERSEDIAAN_CODE, conn);
    const modalAccount = await AccountingService.getAccountByCode(MODAL_PEMILIK_CODE, conn);

    const journalEntry = await AccountingService.postJournalEntry(conn, {
      entryDate,
      description: 'Saldo awal persediaan barang dagang',
      sourceType: 'opening_inventory_balance',
      lines: [
        { accountId: persediaanAccount.id, debit: totalValue, description: 'Nilai persediaan awal (qty x avg cost)' },
        { accountId: modalAccount.id, credit: totalValue, description: 'Modal — nilai persediaan awal' },
      ],
      createdBy,
    });

    // INI pengaman sesungguhnya thd race condition: UNIQUE(balance_type).
    // Kalau ada dua percobaan bersamaan lolos pengecekan di atas, INSERT ini
    // cuma akan berhasil utk salah satu — yang kalah gagal di sini, seluruh
    // transaksinya (termasuk jurnal yang baru saja diposting) ikut rollback.
    await conn.query(
      `INSERT INTO opening_balance_runs (id, balance_type, journal_entry_id, created_by) VALUES (?, ?, ?, ?)`,
      [uuidv4(), INVENTORY_BALANCE_TYPE, journalEntry.id, createdBy]
    );

    await conn.commit();
    return journalEntry;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { previewInventoryOpeningBalance, postInventoryOpeningBalance };
