// Pengirim — Lapis 1 (sales + sales_returns). Lihat server/docs/
// SYNC_DESIGN_TAHAP1.md untuk kontrak payload & SYNC_STATUS_RESET_AUDIT.md
// untuk kenapa sync_status bisa dipercaya sebagai penanda "baris ini perlu
// dikirim (ulang)".
//
// Token & URL pusat SELALU dari .env (SYNC_BRANCH_TOKEN, SYNC_CENTRAL_URL)
// — tidak pernah di DB/UI, sesuai keputusan keamanan yang dikunci.
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const SyncSettingsService = require('./SyncSettingsService');

// batch_size (sync_settings, admin-configurable — lihat server/docs/
// SYNC_BATCHING.md) BERLAKU PER TABEL, bukan gabungan: satu batch bisa
// berisi maks batch_size baris sales DAN maks batch_size baris
// sales_returns sekaligus dalam satu request (dua tabel kecil & terkait
// erat, lebih sederhana dikirim bersama daripada dipisah jadi 2 siklus).
//
// Satu runSync() = SATU batch, bukan loop sampai backlog habis — lihat
// catatan panjang di bawah runSync() soal kenapa.
async function fetchPendingSales(conn, limit) {
  const [rows] = await conn.query(
    `SELECT s.id, s.sale_number, u.full_name AS cashier_name, s.customer_name,
            s.subtotal, s.discount_total, s.dpp, s.ppn_rate, s.ppn_mode, s.ppn_amount,
            s.grand_total, s.total_cost, s.gross_profit, s.status, s.void_reason,
            s.voided_at, s.created_at
     FROM sales s
     JOIN users u ON u.id = s.user_id
     WHERE s.sync_status = 'local_only'
     ORDER BY s.created_at ASC
     LIMIT ?`,
    [limit]
  );
  return rows;
}

async function fetchPendingSalesReturns(conn, limit) {
  const [rows] = await conn.query(
    `SELECT sr.id, sr.return_number, sr.sale_id, sr.return_date, sr.is_cash_refund,
            sr.reason, sr.grand_total, sr.total_cost, u.full_name AS processed_by_name,
            sr.created_at
     FROM sales_returns sr
     JOIN users u ON u.id = sr.processed_by
     WHERE sr.sync_status = 'local_only'
     ORDER BY sr.created_at ASC
     LIMIT ?`,
    [limit]
  );
  return rows;
}

function buildPayload(salesRows, salesReturnRows) {
  return {
    batchId: uuidv4(),
    generatedAt: new Date().toISOString(),
    sales: salesRows.map((r) => ({
      id: r.id,
      saleNumber: r.sale_number,
      cashierName: r.cashier_name,
      customerName: r.customer_name,
      subtotal: r.subtotal,
      discountTotal: r.discount_total,
      dpp: r.dpp,
      ppnRate: r.ppn_rate,
      ppnMode: r.ppn_mode,
      ppnAmount: r.ppn_amount,
      grandTotal: r.grand_total,
      totalCost: r.total_cost,
      grossProfit: r.gross_profit,
      status: r.status,
      voidReason: r.void_reason,
      voidedAt: r.voided_at,
      createdAt: r.created_at,
    })),
    salesReturns: salesReturnRows.map((r) => ({
      id: r.id,
      returnNumber: r.return_number,
      saleId: r.sale_id,
      returnDate: r.return_date,
      isCashRefund: !!r.is_cash_refund,
      reason: r.reason,
      grandTotal: r.grand_total,
      totalCost: r.total_cost,
      processedByName: r.processed_by_name,
      createdAt: r.created_at,
    })),
  };
}

async function postBatch(payload) {
  const centralUrl = process.env.SYNC_CENTRAL_URL;
  const token = process.env.SYNC_BRANCH_TOKEN;
  if (!centralUrl || !token) {
    throw new Error('SYNC_CENTRAL_URL / SYNC_BRANCH_TOKEN belum diset di .env');
  }

  const response = await fetch(`${centralUrl}/api/sync/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000), // 30 detik — jangan menggantung selamanya kalau pusat tidak merespons
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Pusat menolak batch (${response.status}): ${text || response.statusText}`);
  }
  return response.json();
}

async function markSynced(conn, salesRows, salesReturnRows) {
  if (salesRows.length) {
    await conn.query(`UPDATE sales SET sync_status = 'synced' WHERE id IN (?)`, [salesRows.map((r) => r.id)]);
  }
  if (salesReturnRows.length) {
    await conn.query(`UPDATE sales_returns SET sync_status = 'synced' WHERE id IN (?)`, [salesReturnRows.map((r) => r.id)]);
  }
}

// Entry point — dipanggil scheduler (berkala) ATAU manual (uji/trigger
// langsung). TIDAK membungkus whole-run dalam satu transaksi DB besar —
// baca pending rows, kirim, baru kalau sukses tandai synced; kalau GAGAL
// di tengah (timeout/5xx/koneksi putus), baris yang belum dapat konfirmasi
// 2xx TETAP local_only apa adanya (tidak ada yang perlu di-rollback, karena
// belum ada yang diubah) — percobaan berikutnya otomatis mengulang baris
// yang sama, aman berkat UPSERT idempotent di pusat.
//
// SATU PANGGILAN = SATU BATCH (maks batch_size baris per tabel), BUKAN loop
// sampai seluruh backlog local_only habis. Keputusan ini dibuat sengaja
// (lihat server/docs/SYNC_BATCHING.md utk pembahasan lengkap +
// alternatifnya):
//   - Durasi & beban SATU tick scheduler jadi SELALU SAMA & bisa diprediksi,
//     berapa pun besar backlog-nya (10 baris atau 10.000 baris local_only
//     sama-sama cuma satu round-trip HTTP terbatas) — tidak ada skenario
//     satu tick tiba-tiba jalan bermenit-menit krn backlog besar.
//   - Mengosongkan backlog besar (mis. saat sync baru pertama kali
//     diaktifkan setelah toko jalan berbulan-bulan) dikendalikan lewat
//     sync_settings.interval_minutes yang SUDAH ada & admin-configurable —
//     turunkan sementara (mis. 1 menit) utk mempercepat pengurasan awal,
//     naikkan lagi ke nilai normal setelah caught up. Tidak perlu logic
//     "drain sekaligus" terpisah yang menambah kerumitan (kapan berhenti
//     dalam satu tick, bagaimana kegagalan DI TENGAH loop multi-batch
//     dilaporkan, dst) utk manfaat yang sudah bisa dicapai lewat tuas yang
//     sudah ada.
async function runSync() {
  const conn = await pool.getConnection();
  try {
    const settings = await SyncSettingsService.getSettings();
    const batchSize = settings.batch_size;

    const salesRows = await fetchPendingSales(conn, batchSize);
    const salesReturnRows = await fetchPendingSalesReturns(conn, batchSize);

    if (salesRows.length === 0 && salesReturnRows.length === 0) {
      await SyncSettingsService.recordRunResult({ status: 'success', error: null });
      return { sales: 0, salesReturns: 0 };
    }

    const payload = buildPayload(salesRows, salesReturnRows);

    try {
      await postBatch(payload);
    } catch (err) {
      await SyncSettingsService.recordRunResult({ status: 'failed', error: err.message });
      throw err;
    }

    await markSynced(conn, salesRows, salesReturnRows);
    await SyncSettingsService.recordRunResult({ status: 'success', error: null });
    return { sales: salesRows.length, salesReturns: salesReturnRows.length };
  } finally {
    conn.release();
  }
}

module.exports = { runSync };
