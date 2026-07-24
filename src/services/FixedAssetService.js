// Input manual aset tetap (feature/accounting Lapis 3). Perolehan aset SELALU
// lewat AccountingService.postJournalEntry — tidak ada INSERT langsung ke
// journal_entries/journal_entry_lines di sini.
const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');
const AccountingService = require('./AccountingService');

const BRANCH_ID = 1;
const KAS_CODE = '1-101';
const UTANG_USAHA_CODE = '2-101';

async function listFixedAssets() {
  const [rows] = await pool.query(
    `SELECT fa.*,
            aa.code AS asset_account_code, aa.name AS asset_account_name,
            ada.code AS accum_dep_account_code, ada.name AS accum_dep_account_name,
            dea.code AS dep_expense_account_code, dea.name AS dep_expense_account_name,
            COALESCE(SUM(de.depreciation_amount), 0) AS accumulated_depreciation
     FROM fixed_assets fa
     JOIN accounts aa ON aa.id = fa.asset_account_id
     JOIN accounts ada ON ada.id = fa.accumulated_depreciation_account_id
     JOIN accounts dea ON dea.id = fa.depreciation_expense_account_id
     LEFT JOIN fixed_asset_depreciation_entries de ON de.fixed_asset_id = fa.id
     WHERE fa.is_active = 1
     GROUP BY fa.id
     ORDER BY fa.acquisition_date ASC`
  );
  return rows;
}

async function assertPostableAccount(conn, accountId, label) {
  const [[row]] = await conn.query(`SELECT is_active, is_postable FROM accounts WHERE id = ?`, [accountId]);
  if (!row) throw new HttpError(400, 'invalid_account', `${label}: akun tidak ditemukan`);
  if (!row.is_active) throw new HttpError(400, 'invalid_account', `${label}: akun sudah nonaktif`);
  if (!row.is_postable) throw new HttpError(400, 'invalid_account', `${label}: akun header/grup, tidak boleh dipakai`);
}

// Menyimpan baris fixed_assets + jurnal perolehan (debit akun aset, kredit
// Kas kalau tunai / Utang Usaha kalau kredit) — dalam satu transaksi, jadi
// kalau jurnalnya gagal (mis. tidak balance), baris aset ikut rollback,
// tidak ada aset "yatim" tanpa jurnal.
async function createFixedAsset({
  name, assetAccountId, accumulatedDepreciationAccountId, depreciationExpenseAccountId,
  acquisitionDate, acquisitionCost, residualValue, usefulLifeMonths, paymentType, createdBy,
}) {
  if (!name || !name.trim()) throw new HttpError(400, 'bad_request', 'Nama aset wajib diisi');
  if (!acquisitionDate) throw new HttpError(400, 'bad_request', 'Tanggal perolehan wajib diisi');
  if (!assetAccountId || !accumulatedDepreciationAccountId || !depreciationExpenseAccountId) {
    throw new HttpError(400, 'bad_request', 'Akun aset, akumulasi penyusutan, dan beban penyusutan wajib dipilih');
  }
  if (!['cash', 'credit'].includes(paymentType)) {
    throw new HttpError(400, 'bad_request', 'paymentType harus "cash" atau "credit"');
  }

  const cost = new Decimal(acquisitionCost || 0);
  const residual = new Decimal(residualValue || 0);
  if (cost.lte(0)) throw new HttpError(400, 'bad_request', 'Harga perolehan harus > 0');
  if (residual.lt(0)) throw new HttpError(400, 'bad_request', 'Nilai residu tidak boleh negatif');
  if (residual.gte(cost)) throw new HttpError(400, 'bad_request', 'Nilai residu harus lebih kecil dari harga perolehan');

  const usefulLife = Number(usefulLifeMonths);
  if (!Number.isInteger(usefulLife) || usefulLife <= 0) {
    throw new HttpError(400, 'bad_request', 'Masa manfaat (bulan) harus bilangan bulat > 0');
  }

  const assetId = uuidv4();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await assertPostableAccount(conn, accumulatedDepreciationAccountId, 'Akun akumulasi penyusutan');
    await assertPostableAccount(conn, depreciationExpenseAccountId, 'Akun beban penyusutan');

    await conn.query(
      `INSERT INTO fixed_assets
        (id, branch_id, name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id,
         acquisition_date, acquisition_cost, residual_value, useful_life_months, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        assetId, BRANCH_ID, name.trim(), assetAccountId, accumulatedDepreciationAccountId, depreciationExpenseAccountId,
        acquisitionDate, cost.toFixed(4), residual.toFixed(4), usefulLife, createdBy,
      ]
    );

    const counterAccount = await AccountingService.getAccountByCode(
      paymentType === 'cash' ? KAS_CODE : UTANG_USAHA_CODE,
      conn
    );

    const journalEntry = await AccountingService.postJournalEntry(conn, {
      entryDate: acquisitionDate,
      description: `Perolehan aset tetap: ${name.trim()}`,
      sourceType: 'fixed_asset_acquisition',
      sourceUuid: assetId,
      lines: [
        { accountId: assetAccountId, debit: cost, description: name.trim() },
        { accountId: counterAccount.id, credit: cost, description: paymentType === 'cash' ? 'Dibayar tunai' : 'Dibeli kredit' },
      ],
      createdBy,
    });

    await conn.commit();
    return { id: assetId, journalEntry };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { listFixedAssets, createFixedAsset };
