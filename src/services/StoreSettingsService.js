const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

const BRANCH_ID = 1;
const TAX_MODES = ['pkp', 'non_pkp'];

// Singleton — auto-insert baris default (nilai yang dulu hardcode di
// receiptPrinter.js) kalau belum ada, sama pola dgn PricingSettingsService.
async function getSettings() {
  const [rows] = await pool.query(`SELECT * FROM store_settings WHERE branch_id = ?`, [BRANCH_ID]);
  if (rows[0]) return rows[0];
  await pool.query(`INSERT INTO store_settings (branch_id) VALUES (?)`, [BRANCH_ID]);
  const [inserted] = await pool.query(`SELECT * FROM store_settings WHERE branch_id = ?`, [BRANCH_ID]);
  return inserted[0];
}

// Kunci perubahan tax_mode: cuma boleh diubah kalau periode akuntansi
// BERJALAN (bulan kalender saat ini) belum ada transaksi penjualan ATAU
// pembelian sama sekali — termasuk yang sudah di-void (toko "sudah mulai
// transaksi" bulan ini tetap benar walau salah satunya kemudian dibatalkan,
// jadi TIDAK difilter status). Sengaja tidak lihat histori bulan-bulan lalu
// — sama seperti accounting_periods, unit kuncinya per bulan kalender.
async function assertTaxModeChangeAllowed() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const [[salesRow]] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM sales WHERE branch_id = ? AND created_at >= ? AND created_at < ?`,
    [BRANCH_ID, start, end]
  );
  const [[purchaseRow]] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM purchases WHERE branch_id = ? AND purchase_date >= ? AND purchase_date < ?`,
    [BRANCH_ID, start, end]
  );
  const salesCount = Number(salesRow.cnt);
  const purchaseCount = Number(purchaseRow.cnt);

  if (salesCount > 0 || purchaseCount > 0) {
    throw new HttpError(
      409,
      'tax_mode_locked',
      `Mode pajak tidak bisa diubah — periode ${now.getMonth() + 1}/${now.getFullYear()} sudah ada ` +
        `${salesCount} transaksi penjualan dan ${purchaseCount} transaksi pembelian. ` +
        `Ubah lagi di awal periode berikutnya sebelum ada transaksi.`
    );
  }
}

// Semua field opsional (partial update) — field yang tidak dikirim tetap
// memakai nilai yang sudah tersimpan, sama pola dgn PricingSettingsService.
async function updateSettings({ storeName, storeAddress, storePhone, priceLevelSelectorVisible, taxMode, userId }) {
  const current = await getSettings();

  const newStoreName = storeName !== undefined ? storeName : current.store_name;
  const newStoreAddress = storeAddress !== undefined ? storeAddress : current.store_address;
  const newStorePhone = storePhone !== undefined ? storePhone : current.store_phone;
  const newPriceLevelSelectorVisible =
    priceLevelSelectorVisible !== undefined ? (priceLevelSelectorVisible ? 1 : 0) : current.price_level_selector_visible;
  const newTaxMode = taxMode !== undefined ? taxMode : current.tax_mode;

  if (!newStoreName || !newStoreName.trim()) {
    throw new HttpError(400, 'bad_request', 'Nama toko wajib diisi');
  }
  if (!TAX_MODES.includes(newTaxMode)) {
    throw new HttpError(400, 'bad_request', `taxMode harus salah satu dari: ${TAX_MODES.join(', ')}`);
  }
  // Guard cuma perlu dicek kalau BENAR-BENAR mengubah mode — kirim ulang
  // nilai yang sama (mis. bagian dari update field lain) bukan "perubahan".
  if (taxMode !== undefined && newTaxMode !== current.tax_mode) {
    await assertTaxModeChangeAllowed();
  }

  await pool.query(
    `UPDATE store_settings
     SET store_name = ?, store_address = ?, store_phone = ?, price_level_selector_visible = ?, tax_mode = ?, updated_by = ?
     WHERE branch_id = ?`,
    [newStoreName, newStoreAddress, newStorePhone, newPriceLevelSelectorVisible, newTaxMode, userId, BRANCH_ID]
  );
  return getSettings();
}

module.exports = { getSettings, updateSettings };
