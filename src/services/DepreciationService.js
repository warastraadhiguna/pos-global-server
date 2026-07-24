// Depresiasi garis lurus (feature/accounting Lapis 3). SENGAJA tidak ada
// cron/scheduler/trigger apa pun di sini — proses ini HANYA jalan kalau
// dipanggil eksplisit (lewat route admin), satu periode pada satu waktu,
// supaya operator yang mengontrol kapan buku ditutup untuk suatu bulan.
const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');
const AccountingService = require('./AccountingService');

function monthsBetween(y1, m1, y2, m2) {
  return (y2 - y1) * 12 + (m2 - m1);
}

async function accumulatedDepreciationSoFar(conn, assetId) {
  const [[row]] = await conn.query(
    `SELECT COALESCE(SUM(depreciation_amount), 0) AS total FROM fixed_asset_depreciation_entries WHERE fixed_asset_id = ?`,
    [assetId]
  );
  return new Decimal(row.total);
}

// Satu aset, satu periode, satu transaksi. Cegah dobel dgn DUA lapis: (1) cek
// eksplisit di sini sebelum posting (pesan error jelas), (2) UNIQUE KEY
// (fixed_asset_id, period_year, period_month) di tabel sbg jaring pengaman
// terakhir kalau ada race condition — kalau baris #1 lolos tapi INSERT #2
// (jaring pengaman) tetap gagal karena constraint, transaksi rollback total,
// TIDAK ADA jurnal kedua yang nyangkut.
async function postDepreciationForAsset({ fixedAssetId, periodYear, periodMonth, createdBy }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[asset]] = await conn.query(`SELECT * FROM fixed_assets WHERE id = ? FOR UPDATE`, [fixedAssetId]);
    if (!asset || !asset.is_active) {
      throw new HttpError(404, 'fixed_asset_not_found', 'Aset tetap tidak ditemukan/nonaktif');
    }

    const [[existing]] = await conn.query(
      `SELECT id FROM fixed_asset_depreciation_entries WHERE fixed_asset_id = ? AND period_year = ? AND period_month = ?`,
      [fixedAssetId, periodYear, periodMonth]
    );
    if (existing) {
      throw new HttpError(409, 'already_depreciated', `Aset "${asset.name}" sudah dijurnal depresiasinya untuk periode ${periodMonth}/${periodYear} — tidak dijurnal ulang`);
    }

    const acqDate = new Date(asset.acquisition_date);
    const acqYear = acqDate.getFullYear();
    const acqMonth = acqDate.getMonth() + 1;
    // Konvensi: bulan perolehan sendiri BELUM didepresiasi, mulai bulan
    // berikutnya (penyederhanaan umum utk usaha kecil — bukan prorata
    // harian/setengah-bulan). Didokumentasikan di sini karena ini keputusan
    // konvensi akuntansi, bukan sekadar detail teknis.
    if (monthsBetween(acqYear, acqMonth, periodYear, periodMonth) <= 0) {
      throw new HttpError(400, 'not_yet_acquired', `Aset "${asset.name}" belum mulai didepresiasi pada periode ${periodMonth}/${periodYear} (diperoleh ${acqMonth}/${acqYear})`);
    }

    const cost = new Decimal(asset.acquisition_cost);
    const residual = new Decimal(asset.residual_value);
    const depreciableBase = cost.minus(residual);
    const monthlyAmount = depreciableBase.div(asset.useful_life_months).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

    const accumulatedBefore = await accumulatedDepreciationSoFar(conn, fixedAssetId);
    const remaining = depreciableBase.minus(accumulatedBefore);
    if (remaining.lte(0)) {
      throw new HttpError(409, 'fully_depreciated', `Aset "${asset.name}" sudah terdepresiasi penuh sampai nilai residunya`);
    }
    // Bulan terakhir: potong ke sisa yang tersedia, supaya nilai buku tidak
    // pernah turun di bawah nilai residu walau ada sisa pembulatan.
    const amountToPost = Decimal.min(monthlyAmount, remaining);

    const entryDate = new Date(periodYear, periodMonth - 1, 1);
    const journalEntry = await AccountingService.postJournalEntry(conn, {
      entryDate,
      description: `Depresiasi ${asset.name} periode ${periodMonth}/${periodYear}`,
      sourceType: 'depreciation',
      sourceUuid: fixedAssetId,
      lines: [
        { accountId: asset.depreciation_expense_account_id, debit: amountToPost, description: asset.name },
        { accountId: asset.accumulated_depreciation_account_id, credit: amountToPost, description: asset.name },
      ],
      createdBy,
    });

    const depEntryId = uuidv4();
    await conn.query(
      `INSERT INTO fixed_asset_depreciation_entries
        (id, fixed_asset_id, period_year, period_month, depreciation_amount, journal_entry_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [depEntryId, fixedAssetId, periodYear, periodMonth, amountToPost.toFixed(4), journalEntry.id, createdBy]
    );

    await conn.commit();
    return {
      id: depEntryId,
      fixedAssetId,
      assetName: asset.name,
      periodYear,
      periodMonth,
      amount: amountToPost.toFixed(4),
      journalEntry,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Kenyamanan admin: proses SATU periode utk SEMUA aset aktif sekaligus.
// Tiap aset diproses di transaksinya sendiri (postDepreciationForAsset) —
// satu aset gagal/sudah-pernah TIDAK menggagalkan aset lain dalam batch yg
// sama. Aset yang periode ini sudah pernah dijurnal cuma dilaporkan sbg
// 'skipped' (bukan bikin seluruh batch error) — tapi TETAP TIDAK ADA jurnal
// kedua yang terbentuk untuknya, itu jaminan yang tidak boleh dilanggar.
async function runMonthlyDepreciation({ periodYear, periodMonth, createdBy }) {
  if (!Number.isInteger(Number(periodYear)) || !Number.isInteger(Number(periodMonth)) || periodMonth < 1 || periodMonth > 12) {
    throw new HttpError(400, 'bad_request', 'periodYear/periodMonth tidak valid');
  }

  const [assets] = await pool.query(`SELECT id, name FROM fixed_assets WHERE is_active = 1 ORDER BY acquisition_date ASC`);

  const processed = [];
  const skipped = [];

  for (const asset of assets) {
    try {
      const result = await postDepreciationForAsset({ fixedAssetId: asset.id, periodYear, periodMonth, createdBy });
      processed.push(result);
    } catch (err) {
      if (['already_depreciated', 'fully_depreciated', 'not_yet_acquired'].includes(err.code)) {
        skipped.push({ fixedAssetId: asset.id, assetName: asset.name, reason: err.code, message: err.message });
      } else {
        throw err;
      }
    }
  }

  return { periodYear: Number(periodYear), periodMonth: Number(periodMonth), processed, skipped };
}

module.exports = { postDepreciationForAsset, runMonthlyDepreciation };
