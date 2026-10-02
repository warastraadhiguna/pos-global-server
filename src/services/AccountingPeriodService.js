// Tutup Buku (period closing) — Lapis 4 tambahan. Satu baris accounting_periods
// per (branch, year, month); belum ada baris = dianggap terbuka (lihat
// AccountingService.assertPeriodOpen — penegakan SEBENARNYA sudah ada di
// sana sejak awal & dipanggil wajib oleh postJournalEntry. File ini cuma
// menyediakan cara resmi mengubah status baris itu — tutup & buka kembali —
// plus daftar periode terakhir buat ditampilkan di UI.
//
// SENGAJA tidak menegakkan urutan tutup-berurutan (mis. wajib tutup Agustus
// dulu sebelum September) — biar nggak over-engineering utk kasus yang belum
// tentu dibutuhkan. Kalau nanti ternyata perlu dipaksa berurutan, tinggal
// tambah pengecekan di closePeriod.
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');
const { logActivity } = require('./AuthService');

const BRANCH_ID = 1;

// N bulan terakhir (termasuk bulan berjalan), terbaru duluan.
function recentYearMonths(count) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  return out;
}

async function listPeriods() {
  const yearMonths = recentYearMonths(12);
  const [rows] = await pool.query(
    `SELECT ap.period_year, ap.period_month, ap.status, ap.closed_at, u.full_name AS closed_by_name
     FROM accounting_periods ap
     LEFT JOIN users u ON u.id = ap.closed_by
     WHERE ap.branch_id = ?`,
    [BRANCH_ID]
  );
  const byKey = new Map(rows.map((r) => [`${r.period_year}-${r.period_month}`, r]));

  return yearMonths.map(({ year, month }) => {
    const row = byKey.get(`${year}-${month}`);
    return {
      year,
      month,
      status: row ? row.status : 'open',
      closedAt: row ? row.closed_at : null,
      closedByName: row ? row.closed_by_name : null,
    };
  });
}

async function closePeriod({ year, month, userId }) {
  if (!year || !month) throw new HttpError(400, 'bad_request', 'year dan month wajib diisi');

  // Nggak masuk akal nutup periode yang belum terjadi.
  const requested = new Date(year, month - 1, 1);
  const now = new Date();
  const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  if (requested > currentMonth) {
    throw new HttpError(400, 'bad_request', 'Tidak bisa menutup periode yang belum terjadi');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[existing]] = await conn.query(
      `SELECT id, status FROM accounting_periods WHERE branch_id = ? AND period_year = ? AND period_month = ? FOR UPDATE`,
      [BRANCH_ID, year, month]
    );
    if (existing && existing.status === 'closed') {
      throw new HttpError(409, 'already_closed', `Periode ${month}/${year} sudah ditutup sebelumnya`);
    }

    if (existing) {
      await conn.query(
        `UPDATE accounting_periods SET status = 'closed', closed_at = NOW(), closed_by = ? WHERE id = ?`,
        [userId, existing.id]
      );
    } else {
      await conn.query(
        `INSERT INTO accounting_periods (id, branch_id, period_year, period_month, status, closed_at, closed_by)
         VALUES (?, ?, ?, ?, 'closed', NOW(), ?)`,
        [uuidv4(), BRANCH_ID, year, month, userId]
      );
    }

    await logActivity(conn, {
      userId,
      action: 'close_accounting_period',
      entityType: 'accounting_period',
      description: `Tutup periode akuntansi ${month}/${year}`,
    });

    await conn.commit();
    return { year, month, status: 'closed' };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function reopenPeriod({ year, month, userId, reason }) {
  if (!year || !month) throw new HttpError(400, 'bad_request', 'year dan month wajib diisi');
  if (!reason || !reason.trim()) throw new HttpError(400, 'bad_request', 'Alasan buka kembali wajib diisi');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[existing]] = await conn.query(
      `SELECT id, status FROM accounting_periods WHERE branch_id = ? AND period_year = ? AND period_month = ? FOR UPDATE`,
      [BRANCH_ID, year, month]
    );
    if (!existing || existing.status !== 'closed') {
      throw new HttpError(409, 'not_closed', `Periode ${month}/${year} tidak sedang ditutup`);
    }

    await conn.query(
      `UPDATE accounting_periods SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id = ?`,
      [existing.id]
    );

    await logActivity(conn, {
      userId,
      action: 'reopen_accounting_period',
      entityType: 'accounting_period',
      description: `Buka kembali periode akuntansi ${month}/${year}. Alasan: ${reason.trim()}`,
    });

    await conn.commit();
    return { year, month, status: 'open' };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { listPeriods, closePeriod, reopenPeriod };
