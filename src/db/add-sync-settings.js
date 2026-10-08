// Migrasi INKREMENTAL, AMAN dijalankan di database yang sudah berisi data
// sungguhan — cuma CREATE TABLE IF NOT EXISTS, tidak ada DROP/TRUNCATE/
// DELETE apa pun. Idempotent — aman dijalankan berkali-kali.
//
// Fitur: Sync Engine (Tahap 2, pengirim) — lihat server/docs/
// SYNC_DESIGN_TAHAP1.md & SYNC_STATUS_RESET_AUDIT.md. Tabel ini HANYA
// menyimpan pengaturan OPERASIONAL (nyala/mati, interval) — token rahasia
// cabang TIDAK PERNAH di sini, selalu di .env (SYNC_BRANCH_TOKEN) sesuai
// keputusan keamanan yang dikunci.
//
// enabled default 0 — SENGAJA tidak otomatis nyala begitu fitur di-deploy
// (sama filosofi dgn backup_settings.auto_enabled) — ini mengirim data POS
// sungguhan keluar jaringan toko, admin harus aktifkan sadar.
//
// Usage: node src/db/add-sync-settings.js
require('dotenv').config();
const pool = require('../config/db');

async function run() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    console.log('Membuat tabel sync_settings (kalau belum ada)...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS sync_settings (
        branch_id         INT         NOT NULL PRIMARY KEY DEFAULT 1,
        enabled           TINYINT(1)  NOT NULL DEFAULT 0,
        interval_minutes  INT         NOT NULL DEFAULT 15,
        last_run_at       DATETIME    NULL,
        last_run_status   VARCHAR(20) NULL,
        last_run_error    TEXT        NULL,
        updated_at        DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        updated_by        CHAR(36)    NULL,
        CONSTRAINT fk_sync_settings_user FOREIGN KEY (updated_by) REFERENCES users(id)
      ) ENGINE=InnoDB
    `);

    await conn.commit();
    console.log('\nSelesai — tidak ada data lain yang tersentuh/terhapus.');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('Migrasi gagal:', err);
  process.exit(1);
});
