const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

const BRANCH_ID = 1;

// Singleton — auto-insert baris default kalau belum ada, sama pola dgn
// BackupService.getSettings(). enabled default 0 (lihat schema.sql).
async function getSettings() {
  const [rows] = await pool.query(`SELECT * FROM sync_settings WHERE branch_id = ?`, [BRANCH_ID]);
  if (rows[0]) return rows[0];
  await pool.query(`INSERT INTO sync_settings (branch_id) VALUES (?)`, [BRANCH_ID]);
  const [inserted] = await pool.query(`SELECT * FROM sync_settings WHERE branch_id = ?`, [BRANCH_ID]);
  return inserted[0];
}

async function updateSettings({ enabled, intervalMinutes, batchSize, userId }) {
  const current = await getSettings();
  const newEnabled = enabled !== undefined ? (enabled ? 1 : 0) : current.enabled;
  const newIntervalMinutes = intervalMinutes !== undefined ? Number(intervalMinutes) : current.interval_minutes;
  const newBatchSize = batchSize !== undefined ? Number(batchSize) : current.batch_size;

  if (!Number.isInteger(newIntervalMinutes) || newIntervalMinutes < 1 || newIntervalMinutes > 1440) {
    throw new HttpError(400, 'bad_request', 'intervalMinutes harus bilangan bulat antara 1-1440 (maks 24 jam)');
  }
  // Batas atas 2000 sengaja longgar tapi tidak tak terbatas — lihat
  // SYNC_BATCHING.md soal kenapa batch_size tidak dimaksudkan utk "kirim
  // semua sekaligus", berapa pun besar backlog-nya.
  if (!Number.isInteger(newBatchSize) || newBatchSize < 1 || newBatchSize > 2000) {
    throw new HttpError(400, 'bad_request', 'batchSize harus bilangan bulat antara 1-2000');
  }

  await pool.query(
    `UPDATE sync_settings SET enabled = ?, interval_minutes = ?, batch_size = ?, updated_by = ? WHERE branch_id = ?`,
    [newEnabled, newIntervalMinutes, newBatchSize, userId, BRANCH_ID]
  );
  return getSettings();
}

// Dipanggil SyncService setiap kali runSync() benar2 jalan (ada data atau
// tidak) — sama pola dgn BackupService mencatat last_run_at/status/error.
async function recordRunResult({ status, error }) {
  await pool.query(
    `UPDATE sync_settings SET last_run_at = NOW(), last_run_status = ?, last_run_error = ? WHERE branch_id = ?`,
    [status, error || null, BRANCH_ID]
  );
}

module.exports = { getSettings, updateSettings, recordRunResult };
