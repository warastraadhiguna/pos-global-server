// Input manual beban operasional & prive (feature/accounting Lapis 3).
// Sama seperti FixedAssetService: SEMUA jurnal wajib lewat
// AccountingService.postJournalEntry — tidak ada jalur tulis alternatif ke
// journal_entries/journal_entry_lines, sekalipun ini "cuma" input manual.
const Decimal = require('decimal.js');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');
const AccountingService = require('./AccountingService');

const KAS_CODE = '1-101';
const UTANG_USAHA_CODE = '2-101';
const PRIVE_CODE = '3-102';

// paymentType: 'cash' -> kredit Kas (1-101), 'credit' -> kredit Utang Usaha
// (2-101). Beban operasional TIDAK selalu tunai (mis. tagihan listrik/sewa
// yang dibayar belakangan) — makanya ini wajib dipilih, bukan diasumsikan.
async function postExpense({ entryDate, accountId, amount, description, paymentType, createdBy }) {
  if (!entryDate) throw new HttpError(400, 'bad_request', 'entryDate wajib diisi');
  if (!accountId) throw new HttpError(400, 'bad_request', 'accountId (akun beban) wajib diisi');
  if (!description || !description.trim()) throw new HttpError(400, 'bad_request', 'Deskripsi wajib diisi');
  if (!['cash', 'credit'].includes(paymentType)) {
    throw new HttpError(400, 'bad_request', 'paymentType harus "cash" (tunai) atau "credit" (utang)');
  }
  const amountDec = new Decimal(amount || 0);
  if (amountDec.lte(0)) throw new HttpError(400, 'bad_request', 'Jumlah beban harus > 0');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const counterAccount = await AccountingService.getAccountByCode(
      paymentType === 'cash' ? KAS_CODE : UTANG_USAHA_CODE,
      conn
    );

    const journalEntry = await AccountingService.postJournalEntry(conn, {
      entryDate,
      description: description.trim(),
      sourceType: 'expense',
      lines: [
        { accountId, debit: amountDec, description: description.trim() },
        { accountId: counterAccount.id, credit: amountDec, description: paymentType === 'cash' ? 'Dibayar tunai' : 'Dibeli/dibayar kredit' },
      ],
      createdBy,
    });

    await conn.commit();
    return journalEntry;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Prive = pengambilan kas pribadi pemilik dari usaha. Selalu mengurangi Kas
// (bukan pilihan tunai/kredit seperti beban — prive pada dasarnya penarikan
// uang tunai, beda konsep dari beban yang bisa berutang dulu).
async function postOwnerDraw({ entryDate, amount, description, createdBy }) {
  if (!entryDate) throw new HttpError(400, 'bad_request', 'entryDate wajib diisi');
  const amountDec = new Decimal(amount || 0);
  if (amountDec.lte(0)) throw new HttpError(400, 'bad_request', 'Jumlah prive harus > 0');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const priveAccount = await AccountingService.getAccountByCode(PRIVE_CODE, conn);
    const kasAccount = await AccountingService.getAccountByCode(KAS_CODE, conn);

    const journalEntry = await AccountingService.postJournalEntry(conn, {
      entryDate,
      description: description && description.trim() ? description.trim() : 'Pengambilan prive pemilik',
      sourceType: 'owner_draw',
      lines: [
        { accountId: priveAccount.id, debit: amountDec },
        { accountId: kasAccount.id, credit: amountDec },
      ],
      createdBy,
    });

    await conn.commit();
    return journalEntry;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { postExpense, postOwnerDraw };
