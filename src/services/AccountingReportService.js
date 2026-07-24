// Laporan akuntansi (feature/accounting Lapis 4): buku besar, neraca saldo,
// laba rugi, neraca, arus kas. Read-only — tidak menulis apa pun.
//
// ATURAN WAJIB di seluruh file ini:
//  1. TIDAK ADA filter `je.status = 'posted'` di query mana pun. Baris dari
//     entry yang sudah 'reversed' TETAP diikutkan — itu caranya jurnal
//     asli + jurnal pembalik saling meniadakan secara matematis (net = 0).
//     Kalau difilter ke 'posted' saja, entry asli yang sudah dibalik akan
//     HILANG dari perhitungan padahal jurnal pembaliknya tetap terhitung —
//     hasilnya saldo yang salah (bukan bersih nol), persis kebalikan dari
//     yang diminta.
//  2. Semua penjumlahan pakai decimal.js, dan PEMBULATAN CUMA DI toFixed(4)
//     (presisi penuh) di sini. Tidak ada Math.round/toFixed(0) di file ini
//     sama sekali — itu tugas UI saat render, bukan tugas hitung di sini.
//     Total (grand total / totalAssets / dst) SELALU dihitung dari
//     penjumlahan Decimal presisi penuh, bukan dari menjumlah angka yang
//     sudah dibulatkan — supaya properti "balance" terjaga otomatis secara
//     matematis, tidak perlu dipaksa.
//  3. isBalanced/cross-check SELALU dibandingkan pakai Decimal.eq() (exact),
//     BUKAN dibandingkan setelah dibulatkan — kalau ada selisih sekecil
//     apa pun, itu harus kelihatan, bukan hilang gara-gara pembulatan.
const Decimal = require('decimal.js');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

const INCEPTION_DATE = '2000-01-01'; // batas bawah aman, jauh sebelum data sungguhan mana pun
const CASH_ACCOUNT_CODES = ['1-101', '1-102'];

// Kategori bersaldo-normal debit (aset, beban) -> kontribusi = debit-credit.
// Kategori bersaldo-normal kredit (kewajiban, modal, pendapatan) -> kontribusi
// = credit-debit. Ini otomatis menangani akun kontra dengan benar (mis.
// Akumulasi Penyusutan/Prive/Retur & Potongan Penjualan) TANPA kasus khusus
// per akun — akun kontra secara alami "melawan" arah kategorinya, jadi
// hasilnya otomatis negatif = mengurangi total kategori itu.
const DEBIT_NORMAL_CATEGORIES = new Set(['asset', 'expense']);
function categoryNet(category, debitSum, creditSum) {
  return DEBIT_NORMAL_CATEGORIES.has(category) ? debitSum.minus(creditSum) : creditSum.minus(debitSum);
}

// Deteksi saldo abnormal (bukan error sistem — indikasi data belum lengkap
// atau salah posting, mis. akun Persediaan yang belum pernah dijurnal saldo
// awalnya jadi keblok kredit karena cuma dikurangi HPP terus-menerus).
// SENGAJA dibandingkan ke normal_balance AKUN ITU SENDIRI (bukan kategori) —
// supaya akun kontra (Akumulasi Penyusutan/Prive/Retur, yang normal_balance-
// nya memang sudah dibalik dari kategorinya) TIDAK ikut ditandai abnormal
// padahal itu memang wajar buat akun kontra.
function isAbnormalBalance(normalBalance, rawNet) {
  return normalBalance === 'debit' ? rawNet.lt(0) : rawNet.gt(0);
}

async function fetchCategoryActivity({ categories, upToDate, sinceDate = null }) {
  const dateCondition = sinceDate ? 'je.entry_date BETWEEN ? AND ?' : 'je.entry_date <= ?';
  const dateParams = sinceDate ? [sinceDate, upToDate] : [upToDate];
  const [rows] = await pool.query(
    `SELECT a.id, a.code, a.name, a.category, a.normal_balance,
            COALESCE(SUM(jel.debit), 0) AS total_debit,
            COALESCE(SUM(jel.credit), 0) AS total_credit
     FROM accounts a
     LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
     LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id AND ${dateCondition}
     WHERE a.is_postable = 1 AND a.is_active = 1 AND a.category IN (${categories.map(() => '?').join(',')})
     GROUP BY a.id, a.code, a.name, a.category, a.normal_balance
     ORDER BY a.code ASC`,
    [...dateParams, ...categories]
  );
  return rows;
}

// Neraca saldo — universal per-akun: net = debit-credit. Positif tampil di
// kolom Debit, negatif (nilai absolutnya) tampil di kolom Kredit. Aturan ini
// SAMA untuk semua akun tanpa perlu tahu category/normal_balance-nya —
// itulah kenapa neraca saldo pasti balance secara matematis (total kolom
// Debit = total kolom Kredit) selama tiap jurnal yang pernah diposting sudah
// balance sendiri-sendiri (dijamin AccountingService.postJournalEntry).
async function getTrialBalance({ asOfDate }) {
  if (!asOfDate) throw new HttpError(400, 'bad_request', 'asOfDate wajib diisi');

  const rows = await fetchCategoryActivity({
    categories: ['asset', 'liability', 'equity', 'revenue', 'expense'],
    upToDate: asOfDate,
  });

  let totalDebitRaw = new Decimal(0);
  let totalCreditRaw = new Decimal(0);
  const accountRows = [];

  for (const r of rows) {
    const debitSum = new Decimal(r.total_debit);
    const creditSum = new Decimal(r.total_credit);
    const net = debitSum.minus(creditSum);
    if (net.eq(0)) continue;

    const displayDebit = net.gt(0) ? net : new Decimal(0);
    const displayCredit = net.lt(0) ? net.abs() : new Decimal(0);
    totalDebitRaw = totalDebitRaw.plus(displayDebit);
    totalCreditRaw = totalCreditRaw.plus(displayCredit);

    accountRows.push({
      accountId: r.id, code: r.code, name: r.name, category: r.category, normalBalance: r.normal_balance,
      debit: displayDebit.toFixed(4), credit: displayCredit.toFixed(4),
      isAbnormal: isAbnormalBalance(r.normal_balance, net),
    });
  }

  return {
    asOfDate,
    accounts: accountRows,
    totalDebit: totalDebitRaw.toFixed(4),
    totalCredit: totalCreditRaw.toFixed(4),
    isBalanced: totalDebitRaw.eq(totalCreditRaw),
  };
}

// Laba rugi utk satu rentang tanggal. Akun kontra-pendapatan (Retur &
// Potongan Penjualan, normal_balance=debit) otomatis MENGURANGI total
// pendapatan lewat categoryNet — tidak ada logic khusus dibutuhkan.
async function getIncomeStatement({ startDate, endDate }) {
  if (!startDate || !endDate) throw new HttpError(400, 'bad_request', 'startDate dan endDate wajib diisi');

  const rows = await fetchCategoryActivity({
    categories: ['revenue', 'expense'],
    upToDate: endDate,
    sinceDate: startDate,
  });

  const revenue = [];
  const expense = [];
  let totalRevenue = new Decimal(0);
  let totalExpense = new Decimal(0);

  for (const r of rows) {
    const debitSum = new Decimal(r.total_debit);
    const creditSum = new Decimal(r.total_credit);
    const rawNet = debitSum.minus(creditSum);
    const net = categoryNet(r.category, debitSum, creditSum);
    if (net.eq(0)) continue;
    const line = {
      accountId: r.id, code: r.code, name: r.name, amount: net.toFixed(4),
      normalBalance: r.normal_balance, isAbnormal: isAbnormalBalance(r.normal_balance, rawNet),
    };
    if (r.category === 'revenue') {
      revenue.push(line);
      totalRevenue = totalRevenue.plus(net);
    } else {
      expense.push(line);
      totalExpense = totalExpense.plus(net);
    }
  }

  const netIncome = totalRevenue.minus(totalExpense);

  return {
    startDate, endDate,
    revenue, totalRevenue: totalRevenue.toFixed(4),
    expense, totalExpense: totalExpense.toFixed(4),
    netIncome: netIncome.toFixed(4),
  };
}

// Neraca per satu tanggal (asOfDate). Karena belum ada proses tutup buku
// (closing entry ke Laba Ditahan), laba/rugi berjalan (dihitung sejak
// INCEPTION_DATE s.d. asOfDate) WAJIB ditambahkan ke sisi Modal — kalau
// tidak, Aset tidak akan pernah sama dengan Kewajiban+Modal begitu ada
// transaksi pendapatan/beban apa pun.
async function getBalanceSheet({ asOfDate }) {
  if (!asOfDate) throw new HttpError(400, 'bad_request', 'asOfDate wajib diisi');

  const rows = await fetchCategoryActivity({ categories: ['asset', 'liability', 'equity'], upToDate: asOfDate });

  const assets = [], liabilities = [], equity = [];
  let totalAssets = new Decimal(0), totalLiabilities = new Decimal(0), totalEquity = new Decimal(0);

  for (const r of rows) {
    const debitSum = new Decimal(r.total_debit);
    const creditSum = new Decimal(r.total_credit);
    const rawNet = debitSum.minus(creditSum);
    const net = categoryNet(r.category, debitSum, creditSum);
    if (net.eq(0)) continue;
    const line = {
      accountId: r.id, code: r.code, name: r.name, amount: net.toFixed(4),
      normalBalance: r.normal_balance, isAbnormal: isAbnormalBalance(r.normal_balance, rawNet),
    };
    if (r.category === 'asset') { assets.push(line); totalAssets = totalAssets.plus(net); }
    else if (r.category === 'liability') { liabilities.push(line); totalLiabilities = totalLiabilities.plus(net); }
    else { equity.push(line); totalEquity = totalEquity.plus(net); }
  }

  const incomeStatement = await getIncomeStatement({ startDate: INCEPTION_DATE, endDate: asOfDate });
  const currentPeriodNetIncome = new Decimal(incomeStatement.netIncome);
  const totalLiabilitiesAndEquity = totalLiabilities.plus(totalEquity).plus(currentPeriodNetIncome);

  return {
    asOfDate,
    assets, totalAssets: totalAssets.toFixed(4),
    liabilities, totalLiabilities: totalLiabilities.toFixed(4),
    equity, totalEquity: totalEquity.toFixed(4),
    currentPeriodNetIncome: currentPeriodNetIncome.toFixed(4),
    totalLiabilitiesAndEquity: totalLiabilitiesAndEquity.toFixed(4),
    isBalanced: totalAssets.eq(totalLiabilitiesAndEquity),
  };
}

// Arus kas metode langsung — murni dari mutasi akun Kas (1-101) & Bank
// (1-102), TANPA klasifikasi operasi/investasi/pendanaan dan TANPA
// rekonsiliasi ke laba (metode tidak langsung sengaja tidak dibangun, sesuai
// arahan: cukup metode langsung berbasis mutasi akun kas).
async function getCashFlow({ startDate, endDate }) {
  if (!startDate || !endDate) throw new HttpError(400, 'bad_request', 'startDate dan endDate wajib diisi');

  const [accounts] = await pool.query(`SELECT id, code, name FROM accounts WHERE code IN (?, ?)`, CASH_ACCOUNT_CODES);
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) {
    throw new HttpError(500, 'account_not_found', 'Akun Kas/Bank (1-101/1-102) tidak ditemukan di COA');
  }
  const placeholders = accountIds.map(() => '?').join(',');

  const [[openingRow]] = await pool.query(
    `SELECT COALESCE(SUM(jel.debit),0) AS d, COALESCE(SUM(jel.credit),0) AS c
     FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
     WHERE jel.account_id IN (${placeholders}) AND je.entry_date < ?`,
    [...accountIds, startDate]
  );
  const openingBalance = new Decimal(openingRow.d).minus(openingRow.c);

  const [moveRows] = await pool.query(
    `SELECT je.entry_number, je.entry_date, je.description, je.source_type, je.status,
            a.code AS account_code, a.name AS account_name, jel.debit, jel.credit
     FROM journal_entry_lines jel
     JOIN journal_entries je ON je.id = jel.journal_entry_id
     JOIN accounts a ON a.id = jel.account_id
     WHERE jel.account_id IN (${placeholders}) AND je.entry_date BETWEEN ? AND ?
     ORDER BY je.entry_date ASC, je.created_at ASC`,
    [...accountIds, startDate, endDate]
  );

  let totalIn = new Decimal(0);
  let totalOut = new Decimal(0);
  const movements = moveRows.map((r) => {
    const debit = new Decimal(r.debit);
    const credit = new Decimal(r.credit);
    totalIn = totalIn.plus(debit);
    totalOut = totalOut.plus(credit);
    return {
      entryNumber: r.entry_number, entryDate: r.entry_date, description: r.description,
      sourceType: r.source_type, status: r.status, accountCode: r.account_code, accountName: r.account_name,
      cashIn: debit.toFixed(4), cashOut: credit.toFixed(4),
    };
  });

  const netChange = totalIn.minus(totalOut);
  const closingBalance = openingBalance.plus(netChange);

  return {
    startDate, endDate,
    openingBalance: openingBalance.toFixed(4),
    movements,
    totalIn: totalIn.toFixed(4),
    totalOut: totalOut.toFixed(4),
    netChange: netChange.toFixed(4),
    closingBalance: closingBalance.toFixed(4),
  };
}

// Buku besar satu akun. Saldo awal = net saldo SEBELUM startDate (jalur yg
// sama, termasuk baris dari entry 'reversed' — lihat catatan atas file).
async function getGeneralLedger({ accountId, startDate, endDate }) {
  if (!accountId) throw new HttpError(400, 'bad_request', 'accountId wajib diisi');
  if (!startDate || !endDate) throw new HttpError(400, 'bad_request', 'startDate dan endDate wajib diisi');

  const [[account]] = await pool.query(
    `SELECT id, code, name, category, normal_balance FROM accounts WHERE id = ?`,
    [accountId]
  );
  if (!account) throw new HttpError(404, 'account_not_found', 'Akun tidak ditemukan');

  const [[openingRow]] = await pool.query(
    `SELECT COALESCE(SUM(jel.debit),0) AS d, COALESCE(SUM(jel.credit),0) AS c
     FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
     WHERE jel.account_id = ? AND je.entry_date < ?`,
    [accountId, startDate]
  );
  const openingBalance = new Decimal(openingRow.d).minus(openingRow.c);

  const [lineRows] = await pool.query(
    `SELECT je.entry_number, je.entry_date, je.description, je.source_type, je.status,
            jel.debit, jel.credit, jel.description AS line_description
     FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
     WHERE jel.account_id = ? AND je.entry_date BETWEEN ? AND ?
     ORDER BY je.entry_date ASC, je.created_at ASC`,
    [accountId, startDate, endDate]
  );

  let runningBalance = openingBalance;
  const lines = lineRows.map((r) => {
    const debit = new Decimal(r.debit);
    const credit = new Decimal(r.credit);
    runningBalance = runningBalance.plus(debit).minus(credit);
    return {
      entryNumber: r.entry_number, entryDate: r.entry_date, description: r.description,
      lineDescription: r.line_description, sourceType: r.source_type, status: r.status,
      debit: debit.toFixed(4), credit: credit.toFixed(4), runningBalance: runningBalance.toFixed(4),
    };
  });

  return { account, startDate, endDate, openingBalance: openingBalance.toFixed(4), lines, closingBalance: runningBalance.toFixed(4) };
}

module.exports = { getTrialBalance, getIncomeStatement, getBalanceSheet, getCashFlow, getGeneralLedger };
