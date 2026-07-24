// Mesin jurnal akuntansi — Lapis 1 (feature/accounting). Cuma primitif
// generik di sini: baca COA & postJournalEntry (satu-satunya jalur menulis
// journal_entries/journal_entry_lines, wajib balance). Auto-posting dari
// penjualan/void (Lapis 2), input manual (Lapis 3), dan laporan (Lapis 4)
// dibangun di atas fungsi-fungsi ini, BUKAN trigger database/event tersembunyi
// — selalu dipanggil eksplisit dari service pemanggilnya.
const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

const BRANCH_ID = 1;

function generateEntryNumber() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // 6 digit (bukan 3) — dgn 3 digit (900 kemungkinan), dua jurnal yg
  // diposting di detik yang sama (wajar, mis. revenue+HPP satu penjualan)
  // punya peluang tabrakan nyata, terbukti lewat testing (ER_DUP_ENTRY).
  const randomPart = Math.floor(100000 + Math.random() * 900000);
  return `JE${BRANCH_ID}-${datePart}-${timePart}${randomPart}`;
}

async function listAccounts({ activeOnly = true } = {}) {
  const where = activeOnly ? 'WHERE is_active = 1' : '';
  const [rows] = await pool.query(`SELECT * FROM accounts ${where} ORDER BY code ASC`);
  return rows;
}

// Dipakai lapis lanjutan (mis. JournalService di Lapis 2) utk resolusi akun
// tetap by kode COA, bukan hardcode UUID di kode.
async function getAccountByCode(code, conn = pool) {
  const [[row]] = await conn.query(`SELECT * FROM accounts WHERE code = ?`, [code]);
  if (!row) {
    throw new HttpError(500, 'account_not_found', `Akun COA dengan kode ${code} tidak ditemukan — cek seed COA`);
  }
  return row;
}

function yearMonthOf(entryDate) {
  const d = new Date(entryDate);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

// Belum ada baris utk suatu bulan = dianggap terbuka (default permisif).
// Kalau ada baris dan statusnya 'closed', posting ditolak.
async function assertPeriodOpen(conn, entryDate) {
  const { year, month } = yearMonthOf(entryDate);
  const [[period]] = await conn.query(
    `SELECT status FROM accounting_periods WHERE branch_id = ? AND period_year = ? AND period_month = ?`,
    [BRANCH_ID, year, month]
  );
  if (period && period.status === 'closed') {
    throw new HttpError(409, 'period_closed', `Periode ${month}/${year} sudah ditutup, tidak bisa memposting jurnal baru`);
  }
}

// Satu-satunya jalur menulis journal_entries/journal_entry_lines. `conn`
// WAJIB diteruskan oleh pemanggil (pool utk berdiri sendiri, koneksi transaksi
// kalau dipanggil di dalam transaksi lain seperti SalesService.createSale) —
// fungsi ini TIDAK membuka/menutup transaksinya sendiri, pemanggil yang
// bertanggung jawab atas atomicity (sama seperti pola applyStockMovement).
//
// lines: [{ accountId, debit?, credit?, description? }, ...] — tiap baris
// cuma boleh isi debit ATAU credit (bukan dua-duanya, bukan nol dua-duanya).
// Ditolak (HttpError 400/409) kalau: kurang dari 2 baris, ada baris invalid,
// total debit != total kredit, akun tidak ada/nonaktif/header (is_postable=0),
// atau periode entryDate sudah closed.
async function postJournalEntry(conn, { entryDate, description, sourceType, sourceUuid = null, reversedEntryId = null, lines, createdBy }) {
  if (!entryDate) throw new HttpError(400, 'bad_request', 'entryDate wajib diisi');
  if (!description || !description.trim()) throw new HttpError(400, 'bad_request', 'description wajib diisi');
  if (!sourceType) throw new HttpError(400, 'bad_request', 'sourceType wajib diisi');
  if (!createdBy) throw new HttpError(400, 'bad_request', 'createdBy wajib diisi');
  if (!lines || lines.length < 2) {
    throw new HttpError(400, 'bad_request', 'Jurnal minimal butuh 2 baris (debit & kredit)');
  }

  await assertPeriodOpen(conn, entryDate);

  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  const normalizedLines = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (!line.accountId) {
      throw new HttpError(400, 'bad_request', 'accountId wajib diisi di setiap baris jurnal');
    }
    const debit = new Decimal(line.debit || 0);
    const credit = new Decimal(line.credit || 0);
    if (debit.lt(0) || credit.lt(0)) {
      throw new HttpError(400, 'bad_request', 'Debit/kredit tidak boleh negatif');
    }
    if (debit.gt(0) && credit.gt(0)) {
      throw new HttpError(400, 'bad_request', 'Satu baris jurnal tidak boleh mengisi debit dan kredit sekaligus');
    }
    if (debit.eq(0) && credit.eq(0)) {
      throw new HttpError(400, 'bad_request', 'Baris jurnal tidak boleh debit dan kredit sama-sama nol');
    }

    const [[account]] = await conn.query(
      `SELECT id, is_active, is_postable FROM accounts WHERE id = ?`,
      [line.accountId]
    );
    if (!account) {
      throw new HttpError(400, 'invalid_account', `Akun ${line.accountId} tidak ditemukan`);
    }
    if (!account.is_active) {
      throw new HttpError(400, 'invalid_account', `Akun ${line.accountId} sudah nonaktif`);
    }
    if (!account.is_postable) {
      throw new HttpError(400, 'invalid_account', `Akun ${line.accountId} adalah akun header/grup, tidak boleh diposting langsung`);
    }

    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);
    normalizedLines.push({ accountId: line.accountId, debit, credit, description: line.description || null, lineOrder: idx });
  }

  if (totalDebit.eq(0)) {
    throw new HttpError(400, 'bad_request', 'Total jurnal tidak boleh nol');
  }
  if (!totalDebit.eq(totalCredit)) {
    throw new HttpError(400, 'unbalanced_journal', `Jurnal tidak balance: total debit ${totalDebit.toFixed(4)} != total kredit ${totalCredit.toFixed(4)}`);
  }

  const entryId = uuidv4();
  const entryNumber = generateEntryNumber();

  await conn.query(
    `INSERT INTO journal_entries
      (id, branch_id, entry_number, entry_date, description, source_type, source_uuid, reversed_entry_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entryId, BRANCH_ID, entryNumber, entryDate, description.trim(), sourceType, sourceUuid, reversedEntryId, createdBy]
  );

  for (const line of normalizedLines) {
    await conn.query(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), entryId, line.accountId, line.debit.toFixed(4), line.credit.toFixed(4), line.description, line.lineOrder]
    );
  }

  return {
    id: entryId,
    entryNumber,
    entryDate,
    description: description.trim(),
    sourceType,
    sourceUuid,
    reversedEntryId,
    totalDebit: totalDebit.toFixed(4),
    totalCredit: totalCredit.toFixed(4),
    lines: normalizedLines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit.toFixed(4),
      credit: l.credit.toFixed(4),
      description: l.description,
    })),
  };
}

// Jurnal pembalik generik — dipakai VoidService (lewat JournalService) supaya
// void TIDAK PERNAH menghapus/mengedit angka jurnal asli. Baris jurnal asli
// (journal_entry_lines) tidak disentuh sama sekali; satu-satunya UPDATE ke
// journal_entries lama cuma flag status 'posted' -> 'reversed' (metadata
// penanda, persis pola sales.status 'completed' -> 'voided' di VoidService —
// bukan koreksi angka). Entry baru dibuat dgn debit/kredit tiap baris
// TERTUKAR dari entry asal, jadi total pengaruhnya ke buku besar = nol net,
// tapi kedua entry (asal + pembalik) tetap ada utuh utk audit trail.
async function reverseJournalEntry(conn, { entryId, entryDate, description, sourceType, sourceUuid, createdBy }) {
  const [[original]] = await conn.query(`SELECT * FROM journal_entries WHERE id = ? FOR UPDATE`, [entryId]);
  if (!original) {
    throw new HttpError(404, 'journal_entry_not_found', `Jurnal ${entryId} tidak ditemukan`);
  }
  if (original.status !== 'posted') {
    throw new HttpError(409, 'already_reversed', `Jurnal ${original.entry_number} sudah pernah dibalik sebelumnya`);
  }

  const [originalLines] = await conn.query(
    `SELECT account_id, debit, credit, description FROM journal_entry_lines WHERE journal_entry_id = ? ORDER BY line_order ASC`,
    [entryId]
  );

  const reversedLines = originalLines.map((l) => ({
    accountId: l.account_id,
    debit: l.credit,   // tertukar sengaja — inti dari "jurnal pembalik"
    credit: l.debit,
    description: l.description,
  }));

  const reversalEntry = await postJournalEntry(conn, {
    entryDate,
    description,
    sourceType,
    sourceUuid,
    reversedEntryId: entryId,
    lines: reversedLines,
    createdBy,
  });

  await conn.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = ?`, [entryId]);

  return reversalEntry;
}

// Diekspor (bukan cuma dipakai internal oleh postJournalEntry) supaya
// service lain bisa cek periode closed EKSPLISIT di awal proses (mis.
// PurchaseService.voidPurchase) — pesan error yang jelas di depan, bukan
// nunggu rollback dari lapisan jurnal setelah stok sempat disentuh.
// postJournalEntry TETAP memanggil ini juga sbg lapisan kedua yang tidak
// bisa dilewati siapa pun.
module.exports = { listAccounts, getAccountByCode, postJournalEntry, reverseJournalEntry, assertPeriodOpen };
