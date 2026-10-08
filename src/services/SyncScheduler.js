// Scheduler sync — pola IDENTIK dgn BackupScheduler.js (setInterval,
// dicek tiap menit, start()/stop()), BEDA cuma logika "sudah waktunya?":
// backup itu jam tetap harian (HH:MM), sync ini interval BERULANG dalam
// menit (interval_minutes sejak last_run_at), jadi perbandingannya durasi
// berlalu, bukan cocok jam.
const SyncService = require('./SyncService');
const SyncSettingsService = require('./SyncSettingsService');

let intervalHandle = null;

async function tick() {
  try {
    const settings = await SyncSettingsService.getSettings();
    if (!settings.enabled) return;

    const now = new Date();
    const lastRunAt = settings.last_run_at ? new Date(settings.last_run_at) : null;
    const minutesSinceLastRun = lastRunAt ? (now - lastRunAt) / 60000 : Infinity;

    if (minutesSinceLastRun >= settings.interval_minutes) {
      console.log('[SyncScheduler] Menjalankan sync terjadwal...');
      const result = await SyncService.runSync();
      console.log(`[SyncScheduler] Sync terjadwal selesai — ${result.sales} sales, ${result.salesReturns} sales_returns.`);
    }
  } catch (err) {
    // Kegagalan sudah tercatat ke sync_settings oleh runSync sendiri — log
    // di sini murni supaya kelihatan di console server, tidak boleh sampai
    // menjatuhkan proses (sama prinsip dgn BackupScheduler).
    console.error('[SyncScheduler] Gagal menjalankan sync terjadwal:', err.message);
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
