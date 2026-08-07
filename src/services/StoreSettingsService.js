const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

const BRANCH_ID = 1;

// Singleton — auto-insert baris default (nilai yang dulu hardcode di
// receiptPrinter.js) kalau belum ada, sama pola dgn PricingSettingsService.
async function getSettings() {
  const [rows] = await pool.query(`SELECT * FROM store_settings WHERE branch_id = ?`, [BRANCH_ID]);
  if (rows[0]) return rows[0];
  await pool.query(`INSERT INTO store_settings (branch_id) VALUES (?)`, [BRANCH_ID]);
  const [inserted] = await pool.query(`SELECT * FROM store_settings WHERE branch_id = ?`, [BRANCH_ID]);
  return inserted[0];
}

// Semua field opsional (partial update) — field yang tidak dikirim tetap
// memakai nilai yang sudah tersimpan, sama pola dgn PricingSettingsService.
async function updateSettings({ storeName, storeAddress, storePhone, priceLevelSelectorVisible, userId }) {
  const current = await getSettings();

  const newStoreName = storeName !== undefined ? storeName : current.store_name;
  const newStoreAddress = storeAddress !== undefined ? storeAddress : current.store_address;
  const newStorePhone = storePhone !== undefined ? storePhone : current.store_phone;
  const newPriceLevelSelectorVisible =
    priceLevelSelectorVisible !== undefined ? (priceLevelSelectorVisible ? 1 : 0) : current.price_level_selector_visible;

  if (!newStoreName || !newStoreName.trim()) {
    throw new HttpError(400, 'bad_request', 'Nama toko wajib diisi');
  }

  await pool.query(
    `UPDATE store_settings
     SET store_name = ?, store_address = ?, store_phone = ?, price_level_selector_visible = ?, updated_by = ?
     WHERE branch_id = ?`,
    [newStoreName, newStoreAddress, newStorePhone, newPriceLevelSelectorVisible, userId, BRANCH_ID]
  );
  return getSettings();
}

module.exports = { getSettings, updateSettings };
