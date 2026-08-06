const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

const BRANCH_ID = 1;

// Singleton — auto-insert baris default (semua OFF) kalau belum ada, supaya
// caller tidak perlu tahu soal "belum pernah diatur" vs "sudah diatur ke OFF".
async function getSettings() {
  const [rows] = await pool.query(`SELECT * FROM pricing_settings WHERE branch_id = ?`, [BRANCH_ID]);
  if (rows[0]) return rows[0];
  await pool.query(`INSERT INTO pricing_settings (branch_id, auto_pricing_enabled, ppn_enabled) VALUES (?, 0, 0)`, [BRANCH_ID]);
  const [inserted] = await pool.query(`SELECT * FROM pricing_settings WHERE branch_id = ?`, [BRANCH_ID]);
  return inserted[0];
}

// Semua field opsional (partial update) — field yang tidak dikirim tetap
// memakai nilai yang sudah tersimpan, sama seperti pola updatePrice/
// updatePriceLevel di tempat lain.
async function updateSettings({ autoPricingEnabled, ppnEnabled, ppnRate, ppnMode, userId }) {
  const current = await getSettings();

  const newAutoPricingEnabled = autoPricingEnabled !== undefined ? (autoPricingEnabled ? 1 : 0) : current.auto_pricing_enabled;
  const newPpnEnabled = ppnEnabled !== undefined ? (ppnEnabled ? 1 : 0) : current.ppn_enabled;
  const newPpnRate = ppnRate !== undefined ? ppnRate : current.ppn_rate;
  const newPpnMode = ppnMode !== undefined ? ppnMode : current.ppn_mode;

  if (newPpnEnabled) {
    if (newPpnRate === null || newPpnRate === undefined || Number(newPpnRate) < 0) {
      throw new HttpError(400, 'bad_request', 'Tarif PPN wajib diisi (>= 0) sebelum PPN diaktifkan');
    }
    if (newPpnMode !== 'exclude' && newPpnMode !== 'included') {
      throw new HttpError(400, 'bad_request', `Mode PPN harus 'exclude' atau 'included'`);
    }
  }

  await pool.query(
    `UPDATE pricing_settings
     SET auto_pricing_enabled = ?, ppn_enabled = ?, ppn_rate = ?, ppn_mode = ?, updated_by = ?
     WHERE branch_id = ?`,
    [newAutoPricingEnabled, newPpnEnabled, newPpnRate, newPpnMode, userId, BRANCH_ID]
  );
  return getSettings();
}

module.exports = { getSettings, updateSettings };
