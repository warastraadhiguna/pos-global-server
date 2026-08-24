// Backup database — dump via mysqldump (bukan implementasi manual query per
// tabel, supaya dijamin konsisten & lengkap termasuk struktur, sama seperti
// cara standar backup MySQL). Dijalankan lewat child_process.execFile
// (BUKAN exec/shell) supaya argumen (termasuk password lewat env var, bukan
// argv — lihat runBackup) tidak melewati shell interpretation sama sekali.
//
// mysqldump HARUS ada — di PATH sistem, atau override lewat MYSQLDUMP_PATH
// di .env kalau instalasi MySQL-nya tidak menaruh mysqldump.exe di PATH
// (umum di Windows, mis. WAMP/XAMPP). Kalau binary tidak ketemu sama
// sekali, runBackup gagal dgn pesan jelas (dicatat ke backup_history sbg
// 'failed', BUKAN exception yang bikin API 500 tanpa jejak).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

const BRANCH_ID = 1;
const BACKUP_DIR = path.join(__dirname, '../../backups');
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

// Singleton — auto-insert baris default kalau belum ada, sama pola dgn
// StoreSettingsService.getSettings().
async function getSettings() {
  const [rows] = await pool.query(`SELECT * FROM backup_settings WHERE branch_id = ?`, [BRANCH_ID]);
  if (rows[0]) return rows[0];
  await pool.query(`INSERT INTO backup_settings (branch_id) VALUES (?)`, [BRANCH_ID]);
  const [inserted] = await pool.query(`SELECT * FROM backup_settings WHERE branch_id = ?`, [BRANCH_ID]);
  return inserted[0];
}

async function updateSettings({ autoEnabled, scheduleTime, retentionCount, userId }) {
  const current = await getSettings();

  const newAutoEnabled = autoEnabled !== undefined ? (autoEnabled ? 1 : 0) : current.auto_enabled;
  const newScheduleTime = scheduleTime !== undefined ? scheduleTime : current.schedule_time;
  const newRetentionCount = retentionCount !== undefined ? Number(retentionCount) : current.retention_count;

  if (!TIME_RE.test(newScheduleTime)) {
    throw new HttpError(400, 'bad_request', 'scheduleTime harus format HH:MM (24 jam)');
  }
  if (!Number.isInteger(newRetentionCount) || newRetentionCount < 1 || newRetentionCount > 90) {
    throw new HttpError(400, 'bad_request', 'retentionCount harus bilangan bulat antara 1-90');
  }

  await pool.query(
    `UPDATE backup_settings SET auto_enabled = ?, schedule_time = ?, retention_count = ?, updated_by = ? WHERE branch_id = ?`,
    [newAutoEnabled, newScheduleTime, newRetentionCount, userId, BRANCH_ID]
  );
  return getSettings();
}

async function listBackups() {
  const [rows] = await pool.query(
    `SELECT bh.id, bh.filename, bh.file_size, bh.status, bh.error_message, bh.triggered_by, bh.created_at,
            u.full_name AS triggered_by_name
     FROM backup_history bh
     LEFT JOIN users u ON u.id = bh.triggered_by_user
     ORDER BY bh.created_at DESC
     LIMIT 200`
  );
  return rows;
}

// Password LEWAT env var MYSQL_PWD ke child process, BUKAN sbg argumen
// command-line (-pXXXX) — argv proses bisa dibaca user lain via
// tasklist/ps di banyak OS, env var child process tidak.
async function execMysqldump(outputPath) {
  const mysqldumpPath = process.env.MYSQLDUMP_PATH || 'mysqldump';
  const dbName = process.env.DB_NAME || 'pos_branch';
  const args = [
    `--host=${process.env.DB_HOST || '127.0.0.1'}`,
    `--port=${Number(process.env.DB_PORT) || 3306}`,
    `--user=${process.env.DB_USER || 'root'}`,
    '--single-transaction', // snapshot konsisten tanpa lock tabel InnoDB berjalan
    '--routines',
    '--events',
    `--result-file=${outputPath}`,
    dbName,
  ];

  await new Promise((resolve, reject) => {
    execFile(
      mysqldumpPath,
      args,
      { env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD || '' } },
      (err, stdout, stderr) => {
        if (err) {
          const hint = err.code === 'ENOENT'
            ? ` (mysqldump tidak ditemukan di PATH — set MYSQLDUMP_PATH di .env ke lokasi mysqldump yang benar)`
            : '';
          reject(new Error((stderr?.trim() || err.message) + hint));
        } else {
          resolve();
        }
      }
    );
  });
}

function generateFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `backup_pos_branch_${stamp}.sql`;
}

// Hapus file+baris TERLAMA (status='success') begitu jumlah melebihi
// retention_count — backup 'failed' TIDAK ikut dihitung/dihapus di sini
// (tidak ada file besar utk dihapus, dan justru berguna sbg jejak
// diagnostik kalau backup pernah gagal berulang).
async function applyRetention(retentionCount) {
  const [successRows] = await pool.query(
    `SELECT id, filename FROM backup_history WHERE status = 'success' ORDER BY created_at DESC`
  );
  const toDelete = successRows.slice(retentionCount);
  for (const row of toDelete) {
    const filePath = path.join(BACKUP_DIR, row.filename);
    fs.promises.unlink(filePath).catch(() => {}); // file mungkin sudah tidak ada, tidak fatal
    await pool.query(`DELETE FROM backup_history WHERE id = ?`, [row.id]);
  }
}

async function runBackup({ triggeredBy, userId = null }) {
  ensureBackupDir();
  const filename = generateFilename();
  const outputPath = path.join(BACKUP_DIR, filename);
  const historyId = uuidv4();

  try {
    await execMysqldump(outputPath);
    const stat = await fs.promises.stat(outputPath);

    await pool.query(
      `INSERT INTO backup_history (id, branch_id, filename, file_size, status, triggered_by, triggered_by_user)
       VALUES (?, ?, ?, ?, 'success', ?, ?)`,
      [historyId, BRANCH_ID, filename, stat.size, triggeredBy, userId]
    );
    await pool.query(
      `UPDATE backup_settings SET last_run_at = NOW(), last_run_status = 'success', last_run_error = NULL WHERE branch_id = ?`,
      [BRANCH_ID]
    );

    const settings = await getSettings();
    await applyRetention(settings.retention_count);

    return { id: historyId, filename, fileSize: stat.size, status: 'success' };
  } catch (err) {
    await pool.query(
      `INSERT INTO backup_history (id, branch_id, filename, file_size, status, error_message, triggered_by, triggered_by_user)
       VALUES (?, ?, ?, NULL, 'failed', ?, ?, ?)`,
      [historyId, BRANCH_ID, filename, err.message, triggeredBy, userId]
    );
    await pool.query(
      `UPDATE backup_settings SET last_run_at = NOW(), last_run_status = 'failed', last_run_error = ? WHERE branch_id = ?`,
      [err.message, BRANCH_ID]
    );
    // File gagal/parsial dibersihkan supaya tidak nyangkut di folder backups/
    fs.promises.unlink(outputPath).catch(() => {});
    throw new HttpError(500, 'backup_failed', `Backup gagal: ${err.message}`);
  }
}

async function getBackupFilePath(id) {
  const [[row]] = await pool.query(`SELECT filename, status FROM backup_history WHERE id = ?`, [id]);
  if (!row) throw new HttpError(404, 'backup_not_found', 'Riwayat backup tidak ditemukan');
  if (row.status !== 'success') throw new HttpError(400, 'backup_not_downloadable', 'Backup ini gagal, tidak ada file untuk diunduh');
  const filePath = path.join(BACKUP_DIR, row.filename);
  if (!fs.existsSync(filePath)) {
    throw new HttpError(404, 'backup_file_missing', 'File backup tercatat tapi sudah tidak ada di disk (mungkin sudah dihapus manual)');
  }
  return { filePath, filename: row.filename };
}

async function deleteBackup(id) {
  const [[row]] = await pool.query(`SELECT filename FROM backup_history WHERE id = ?`, [id]);
  if (!row) throw new HttpError(404, 'backup_not_found', 'Riwayat backup tidak ditemukan');
  const filePath = path.join(BACKUP_DIR, row.filename);
  await fs.promises.unlink(filePath).catch(() => {});
  await pool.query(`DELETE FROM backup_history WHERE id = ?`, [id]);
}

module.exports = { getSettings, updateSettings, listBackups, runBackup, getBackupFilePath, deleteBackup };
