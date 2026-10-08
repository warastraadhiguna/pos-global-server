// Satu titik kebenaran untuk mekanisme "reset sync_status setelah baris
// yang sudah pernah tersync berubah lagi" — lihat server/docs/
// SYNC_STATUS_RESET_AUDIT.md untuk audit lengkap & alasan desainnya.
//
// SYNCABLE_TABLES = tabel yang punya jalur UPDATE setelah INSERT (void,
// tutup, edit, dst) DAN kolom sync_status, sehingga WAJIB memanggil
// markDirtyForSync() di jalur UPDATE itu. Dipakai juga oleh
// src/db/audit-sync-status.js sebagai daftar tabel yang disisir.
//
// SENGAJA TIDAK termasuk di sini meski sama-sama punya sync_status:
//   - journal_entries — reversal (AccountingService.reverseJournalEntry)
//     DITUNDA ke Lapis 3. Entri pembalik adalah baris BARU (otomatis
//     local_only, tidak perlu helper), dan status basi di entri ASLI
//     yang di-reverse TIDAK merusak total (debit/kredit entri pembalik
//     sudah menetralkan di SUM manapun) — cuma soal tampilan, bukan
//     angka. Jangan tambahkan ke sini tanpa keputusan ulang.
//   - stock_opnames — BUKAN kasus "reset setelah mutasi". Opname baru
//     layak disync setelah finalisasi (status='finalized'), bukan sejak
//     dibuat — bentuk masalahnya beda (kapan PERTAMA layak sync, bukan
//     kapan di-reset balik). Jangan dicampur dengan mekanisme ini;
//     tangani terpisah saat stock_opnames resmi masuk scope sync.
//   - sales_returns — PUNYA sync_status (Lapis 1), tapi create-only,
//     tidak ada jalur UPDATE sama sekali — tidak pernah butuh
//     markDirtyForSync dipanggil atasnya. Sengaja tidak dimasukkan ke
//     daftar ini (daftar ini khusus tabel yang BUTUH reset), bukan
//     "semua tabel yang punya sync_status".
const SYNCABLE_TABLES = new Set([
  'sales',
  'purchases',
  'internal_stock_usages',
  'cashier_shifts',
  'suppliers',
]);

// queryable = PoolConnection (di dalam transaksi) ATAU pool langsung
// (service yang memang tidak transaksional, mis. SupplierService) — kedua
// punya method .query() yang sama, jadi helper ini transparan dipakai di
// kedua gaya tanpa memaksa refactor pola transaksi yang sudah ada.
async function markDirtyForSync(queryable, table, id) {
  if (!SYNCABLE_TABLES.has(table)) {
    throw new Error(
      `markDirtyForSync: tabel '${table}' tidak terdaftar di SYNCABLE_TABLES (src/utils/syncStatus.js). ` +
        `Kalau tabel ini memang perlu reset sync_status, tambahkan dulu ke daftar itu — jangan panggil langsung tanpa didaftarkan.`
    );
  }
  await queryable.query(`UPDATE ${table} SET sync_status = 'local_only' WHERE id = ?`, [id]);
}

module.exports = { SYNCABLE_TABLES, markDirtyForSync };
