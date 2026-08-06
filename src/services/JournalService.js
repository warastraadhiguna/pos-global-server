// Jembatan eksplisit antara modul penjualan (SalesService/VoidService) dan
// mesin jurnal generik (AccountingService) — Lapis 2 (feature/accounting).
// SENGAJA dipanggil langsung dari SalesService/VoidService di dalam transaksi
// yang sama (bukan trigger DB, bukan event/listener tersembunyi), supaya
// jelas terbaca di kode kapan jurnal dibuat dan supaya kalau jurnal gagal,
// seluruh transaksi (sale/stock_movements/void) ikut rollback lewat mekanisme
// try/catch yang sudah ada di sana — tidak ada logic transaksi baru di sini.
const Decimal = require('decimal.js');
const AccountingService = require('./AccountingService');

const ACCOUNT_CODES = {
  KAS: '1-101',
  BANK: '1-102',
  PERSEDIAAN: '1-301',
  PENJUALAN: '4-101',
  RETUR_POTONGAN_PENJUALAN: '4-102',
  HPP: '5-101',
  PPN_KELUARAN: '2-104',
};

// Pembayaran tunai -> akun Kas, semua metode non-tunai (QRIS/kartu/transfer,
// dst) -> akun Bank (disederhanakan jadi satu akun bank bersama utk MVP;
// payment_methods belum ada pemetaan akun per-metode — cukup jelas kalau
// nanti perlu dipisah per rekening/e-wallet).
async function resolvePaymentAccount(conn, isCashPayment) {
  return AccountingService.getAccountByCode(isCashPayment ? ACCOUNT_CODES.KAS : ACCOUNT_CODES.BANK, conn);
}

// Dipanggil dari SalesService.createSale, di dalam transaksi yang sama,
// SEBELUM conn.commit(). Menghasilkan sampai 2 jurnal:
//   1) Jurnal pendapatan — Diskon SELALU baris terpisah (akun Retur &
//      Potongan Penjualan) di SEMUA kasus, PPN aktif atau tidak (revisi —
//      keputusan klien: diskon wajib kelihatan di buku besar). Yang beda
//      cuma "Penjualan" dicatat di angka berapa & apakah ada baris PPN
//      Keluaran, tergantung PPN aktif/tidak dan mode-nya:
//      - TANPA PPN (ppnAmount=0, PERSIS perilaku sebelum Batch 3C, tidak
//        berubah): Debit Kas/Bank (grandTotal) [+ Debit Diskon kalau ada]
//        = Kredit Penjualan (subtotal kotor B, sebelum diskon).
//      - DENGAN PPN mode exclude: Debit Kas/Bank (N+PPN, PPN nambah di atas)
//        + Debit Diskon (Dc, nilai wajar/face value — SAMA persis dgn yang
//        tampil di struk) = Kredit Penjualan (B, bruto APA ADANYA — di mode
//        ini B memang sudah tax-exclusive, tidak perlu disesuaikan) +
//        Kredit PPN Keluaran (PPN).
//      - DENGAN PPN mode included: Debit Kas/Bank (N, TIDAK bertambah — PPN
//        sudah ada di dalam N) + Debit Diskon (Dc, SAMA nilai wajar seperti
//        mode exclude, TIDAK di-"bersih"-kan dari PPN — lihat derivasi yang
//        disetujui user) = Kredit Penjualan (B' = B − PPN, bruto DIKURANGI
//        PPN yang terkandung di dalamnya — supaya Penjualan yang dibukukan
//        tetap pre-tax di KEDUA mode, konsisten) + Kredit PPN Keluaran (PPN).
//        B' = B − PPN adalah pengurangan dua angka yang SUDAH bulat rupiah
//        (subtotalDec & ppnAmountDec) → hasilnya otomatis bulat, TIDAK ADA
//        pembulatan baru yang diperkenalkan di sini. Balance jurnal
//        TERJAMIN lewat identitas aljabar N+Dc=B (selalu benar, sudah
//        diverifikasi user), bukan dicek belakangan.
//   2) Jurnal HPP: Debit Harga Pokok Penjualan = Kredit Persediaan Barang
//      Dagang, sebesar totalCost — INI PAKAI totalCostSum yang sudah dihitung
//      SalesService dari cost_per_base_unit snapshot moving-average tiap
//      item (BUKAN dihitung ulang di sini), sama seperti VoidService membalik
//      stok pakai snapshot yang sama, bukan avg cost sekarang. PPN TIDAK
//      menyentuh jurnal HPP sama sekali (persediaan/HPP independen dari pajak).
// subtotal/discountTotal/ppnAmount/grandTotal/totalCost boleh Decimal atau
// angka biasa — semua dibungkus ulang lewat decimal.js di sini, tidak ada
// operator +/-/* JS biasa dipakai untuk uang.
async function postSaleJournals(conn, { saleId, saleNumber, entryDate, subtotal, discountTotal, ppnAmount = 0, ppnMode = null, grandTotal, totalCost, isCashPayment, createdBy }) {
  const subtotalDec = new Decimal(subtotal); // B — bruto, sebelum diskon
  const discountDec = new Decimal(discountTotal); // Dc — nilai wajar/face value, SAMA di semua kasus
  const ppnAmountDec = new Decimal(ppnAmount || 0);
  const grandTotalDec = new Decimal(grandTotal); // Kas/Bank yang benar2 diterima
  const totalCostDec = new Decimal(totalCost);

  let revenueEntry = null;
  // Jaga-jaga kasus ekstrem (mis. seluruh keranjang didiskon 100% jadi
  // grandTotal 0, atau subtotal 0) — tidak ada apa pun yang perlu dijurnal,
  // daripada memaksa posting baris bernilai nol yang ditolak AccountingService
  // dan bikin checkout yang tadinya sukses jadi gagal gara-gara jurnal.
  if (subtotalDec.gt(0)) {
    const lines = [];
    if (grandTotalDec.gt(0)) {
      const paymentAccount = await resolvePaymentAccount(conn, isCashPayment);
      lines.push({ accountId: paymentAccount.id, debit: grandTotalDec, description: 'Kas/Bank diterima' });
    }
    if (discountDec.gt(0)) {
      const returAccount = await AccountingService.getAccountByCode(ACCOUNT_CODES.RETUR_POTONGAN_PENJUALAN, conn);
      lines.push({ accountId: returAccount.id, debit: discountDec, description: 'Diskon penjualan' });
    }

    const penjualanAccount = await AccountingService.getAccountByCode(ACCOUNT_CODES.PENJUALAN, conn);
    if (ppnAmountDec.gt(0)) {
      const ppnAccount = await AccountingService.getAccountByCode(ACCOUNT_CODES.PPN_KELUARAN, conn);
      // exclude: B sudah tax-exclusive, dicatat apa adanya.
      // included: B mengandung PPN di dalamnya, WAJIB dikurangi dulu supaya
      // Penjualan yang dibukukan tetap pre-tax (lihat derivasi yang disetujui).
      const penjualanAmount = ppnMode === 'included' ? subtotalDec.minus(ppnAmountDec) : subtotalDec;
      if (penjualanAmount.gt(0)) lines.push({ accountId: penjualanAccount.id, credit: penjualanAmount, description: 'Penjualan (bruto)' });
      lines.push({ accountId: ppnAccount.id, credit: ppnAmountDec, description: 'PPN Keluaran' });
    } else {
      // PPN OFF — PERSIS perilaku sebelum Batch 3C, tidak berubah.
      lines.push({ accountId: penjualanAccount.id, credit: subtotalDec, description: 'Penjualan kotor' });
    }

    revenueEntry = await AccountingService.postJournalEntry(conn, {
      entryDate,
      description: `Penjualan ${saleNumber}`,
      sourceType: 'sale',
      sourceUuid: saleId,
      lines,
      createdBy,
    });
  }

  let cogsEntry = null;
  if (totalCostDec.gt(0)) {
    const hppAccount = await AccountingService.getAccountByCode(ACCOUNT_CODES.HPP, conn);
    const persediaanAccount = await AccountingService.getAccountByCode(ACCOUNT_CODES.PERSEDIAAN, conn);
    cogsEntry = await AccountingService.postJournalEntry(conn, {
      entryDate,
      description: `HPP Penjualan ${saleNumber}`,
      sourceType: 'sale',
      sourceUuid: saleId,
      lines: [
        { accountId: hppAccount.id, debit: totalCostDec, description: 'Harga pokok penjualan' },
        { accountId: persediaanAccount.id, credit: totalCostDec, description: 'Pengurangan persediaan' },
      ],
      createdBy,
    });
  }

  return { revenueEntry, cogsEntry };
}

// Dipanggil dari VoidService.voidSale, di dalam transaksi yang sama, SEBELUM
// conn.commit(). Membalik SEMUA jurnal 'posted' yang sourceType='sale' &
// sourceUuid=saleId (revenue + HPP, apa pun jumlahnya) — bukan menghapus,
// bukan mengedit, cuma menambah entry baru dgn debit/kredit tertukar plus
// menandai entry lama 'reversed' (lihat AccountingService.reverseJournalEntry).
async function reverseSaleJournals(conn, { saleId, saleNumber, entryDate, createdBy }) {
  const [entries] = await conn.query(
    `SELECT id FROM journal_entries WHERE source_type = 'sale' AND source_uuid = ? AND status = 'posted' ORDER BY created_at ASC`,
    [saleId]
  );

  const reversals = [];
  for (const entry of entries) {
    const reversal = await AccountingService.reverseJournalEntry(conn, {
      entryId: entry.id,
      entryDate,
      description: `Void Penjualan ${saleNumber}`,
      sourceType: 'void',
      sourceUuid: saleId,
      createdBy,
    });
    reversals.push(reversal);
  }
  return reversals;
}

module.exports = { postSaleJournals, reverseSaleJournals };
