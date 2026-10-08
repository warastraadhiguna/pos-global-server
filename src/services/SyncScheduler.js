// Scheduler sync — pola IDENTIK dgn BackupScheduler.js (setInterval,
// dicek tiap menit, start()/stop()), BEDA cuma logika "sudah waktunya?":
// backup itu jam tetap harian (HH:MM), sync ini interval BERULANG dalam
// menit (interval_minutes sejak last_run_at), jadi perbandingannya durasi
// berlalu, bukan cocok jam.
const SyncService = require('./SyncService');
const SyncSettingsService = require('./SyncSettingsService');

let intervalHandle = null;

// Penjaga tumpang-tindih — relevan SEKARANG krn dgn batching, sync aktif
// (enabled) lebih sering berada dalam kondisi "masih ada backlog, bakal
// tick lagi segera" dibanding sebelumnya. last_run_at BARU ter-update
// SETELAH runSync() selesai (lihat SyncSettingsService.recordRunResult) —
// kalau satu batch kebetulan butuh waktu lebih lama dari interval_minutes
// (jaringan lambat, dll), tick BERIKUTNYA (tiap 60 detik) bisa membaca
// last_run_at yang masih LAMA (punya run sebelumnya yg belum selesai) dan
// mengira sudah waktunya lagi — tanpa penjaga ini, dua runSync() bisa
// jalan BERSAMAAN dan berebut baris local_only yang sama.
let isRunning = false;

async function tick() {
  if (isRunning) return;
  try {
    const settings = await SyncSettingsService.getSettings();
    if (!settings.enabled) return;

    const now = new Date();
    const lastRunAt = settings.last_run_at ? new Date(settings.last_run_at) : null;
    const minutesSinceLastRun = lastRunAt ? (now - lastRunAt) / 60000 : Infinity;

    if (minutesSinceLastRun >= settings.interval_minutes) {
      isRunning = true;
      console.log('[SyncScheduler] Menjalankan sync terjadwal...');
      const result = await SyncService.runSync();
      console.log(`[SyncScheduler] Sync terjadwal selesai — ${result.sales} sales, ${result.salesReturns} sales_returns.`);
    }
  } catch (err) {
    // Kegagalan sudah tercatat ke sync_settings oleh runSync sendiri — log
    // di sini murni supaya kelihatan di console server, tidak boleh sampai
    // menjatuhkan proses (sama prinsip dgn BackupScheduler).
    console.error('[SyncScheduler] Gagal menjalankan sync terjadwal:', err.message);
  } finally {
    isRunning = false;
  }
}

function start() {
  if (intervalHandle) return;
  tick();
  intervalHandle = setInterval(tick, 60 * 1000);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { start, stop };
