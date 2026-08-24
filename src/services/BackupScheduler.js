// Scheduler backup otomatis — dicek tiap menit (setInterval), BUKAN pakai
// cron library terpisah (menjaga nol dependency native/eksternal tambahan,
// sama semangat dgn keputusan cash-drawer sebelumnya). Perbandingan pakai
// TANGGAL kalender (bukan jam persis) supaya backup harian cuma jalan
// SEKALI per hari walau proses Node restart berkali-kali (mis. --watch)
// setelah jam jadwal sudah lewat hari itu.
const BackupService = require('./BackupService');

let intervalHandle = null;

function sameLocalDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

async function tick() {
  try {
    const settings = await BackupService.getSettings();
    if (!settings.auto_enabled) return;

    const now = new Date();
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const lastRunAt = settings.last_run_at ? new Date(settings.last_run_at) : null;
    const alreadyRanToday = lastRunAt && sameLocalDate(lastRunAt, now);

    if (!alreadyRanToday && nowTime >= settings.schedule_time) {
      console.log('[BackupScheduler] Menjalankan backup terjadwal...');
      await BackupService.runBackup({ triggeredBy: 'scheduled' });
      console.log('[BackupScheduler] Backup terjadwal selesai.');
    }
  } catch (err) {
    // Kegagalan sudah tercatat ke backup_history/backup_settings oleh
    // runBackup sendiri — log di sini murni supaya kelihatan di console
    // server, tidak boleh sampai menjatuhkan proses.
    console.error('[BackupScheduler] Gagal menjalankan backup terjadwal:', err.message);
  }
}

function start() {
  if (intervalHandle) return; // jangan dobel kalau start() kepanggil lagi
  tick(); // cek langsung saat boot juga (kalau jam jadwal sudah lewat sebelum server nyala hari ini)
  intervalHandle = setInterval(tick, 60 * 1000);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { start, stop };
