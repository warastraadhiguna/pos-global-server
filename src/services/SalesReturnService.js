// Retur penjualan — pelanggan mengembalikan barang yang SUDAH dibeli.
// Beda dari Retur Pembelian (OUT biasa di avg cost BERJALAN, karena barang
// keluar ke supplier tanpa histori "harga jual" apa pun yang perlu dijaga):
// di sini WAJIB terkait ke sale_item ASAL, karena retur penjualan punya DUA
// sisi yang harus tetap akurat:
//   1) Sisi pendapatan — nilai jual yang dikembalikan (prorata dari subtotal
//      ASLI baris nota itu, BUKAN harga sekarang — harga produk bisa saja
//      sudah berubah sejak nota lama itu dibuat).
//   2) Sisi HPP — Persediaan bertambah & HPP berkurang PERSIS sebesar
//      cost_per_base_unit SNAPSHOT baris nota asal (avg cost SAAT itu),
//      bukan avg cost sekarang — supaya pembalikan HPP benar2 menghapus
//      HPP yang dulu tercatat, bukan angka baru yang kebetulan mirip.
// Ini simetris dgn prinsip void_reversal (VoidService), TAPI ini transaksi
// bisnis NYATA (dokumen baru, bukan pembalik jurnal lama) — jurnal ASLI
// penjualan itu TIDAK disentuh sama sekali, retur cuma menambah jurnal baru.
//
// Boleh SEBAGIAN qty/item saja, nota kapan pun (tidak dibatasi status
// shift) — proporsi dihitung dari qty/subtotal ASLI baris nota (bukan sisa
// yang belum diretur), supaya retur bertahap (lebih dari 1x) tetap akurat.
//
// PPN: SENGAJA belum ditangani di sini (retur dihitung dari subtotal net
// pre-PPN) — konsisten dgn Retur Pembelian yang juga belum menyentuh PPN
// Masukan. Keterbatasan yang disengaja, bukan lupa; kalau toko PKP aktif
// pakai PPN, retur besar/sering sebaiknya tetap dicek manual dulu.
const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');
const { applyStockMovement } = require('./StockMovementService');
const { getDefaultWarehouseId } = require('./WarehouseService');
const AccountingService = require('./AccountingService');
const { logActivity } = require('./AuthService');

const BRANCH_ID = 1;
const KAS_CODE = '1-101';
const BANK_CODE = '1-102';
const PERSEDIAAN_CODE = '1-301';
const RETUR_POTONGAN_PENJUALAN_CODE = '4-102';
const HPP_CODE = '5-101';

function generateReturnNumber() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const randomPart = Math.floor(100000 + Math.random() * 900000); // lihat catatan di AccountingService.generateEntryNumber
  return `SR${BRANCH_ID}-${datePart}-${timePart}${randomPart}`;
}

async function listSalesReturns() {
  const [rows] = await pool.query(
    `SELECT sr.id, sr.return_number, sr.return_date, sr.grand_total, sr.total_cost, sr.is_cash_refund, sr.reason,
            s.sale_number, u.full_name AS processed_by_name
     FROM sales_returns sr
     JOIN sales s ON s.id = sr.sale_id
     JOIN users u ON u.id = sr.processed_by
     ORDER BY sr.created_at DESC`
  );
  return rows;
}

async function getSalesReturnDetail(returnId) {
  const [[ret]] = await pool.query(
    `SELECT sr.*, s.sale_number, u.full_name AS processed_by_name
     FROM sales_returns sr
     JOIN sales s ON s.id = sr.sale_id
     JOIN users u ON u.id = sr.processed_by
     WHERE sr.id = ?`,
    [returnId]
  );
  if (!ret) throw new HttpError(404, 'sales_return_not_found', 'Retur penjualan tidak ditemukan');

  const [items] = await pool.query(
    `SELECT sri.*, p.name AS product_name, un.name AS unit_name
     FROM sales_return_items sri
     JOIN products p ON p.id = sri.product_id
     JOIN units un ON un.id = sri.unit_id
     WHERE sri.sales_return_id = ?`,
    [returnId]
  );
  return { ...ret, items };
}

// Dicari EXACT match sale_number (yang tertera di struk) — bukan pencarian
// bebas, supaya admin selalu merujuk ke satu nota pasti sebelum memilih
// item yang diretur.
async function getSaleForReturn(saleNumber) {
  if (!saleNumber || !saleNumber.trim()) {
    throw new HttpError(400, 'bad_request', 'Nomor nota wajib diisi');
  }
  const [[sale]] = await pool.query(`SELECT * FROM sales WHERE sale_number = ?`, [saleNumber.trim()]);
  if (!sale) {
    throw new HttpError(404, 'sale_not_found', 'Nota tidak ditemukan');
  }
  if (sale.status !== 'completed') {
    throw new HttpError(409, 'sale_not_returnable', 'Nota ini sudah di-void, tidak bisa diretur');
  }

  const [items] = await pool.query(
    `SELECT si.id, si.product_id, p.name AS product_name, si.unit_id, un.name AS unit_name,
            si.quantity, si.conversion_factor, si.quantity_base, si.selling_price, si.subtotal, si.cost_per_base_unit,
            COALESCE((SELECT SUM(sri.quantity) FROM sales_return_items sri WHERE sri.sale_item_id = si.id), 0) AS already_returned_qty
     FROM sale_items si
     JOIN products p ON p.id = si.product_id
     JOIN units un ON un.id = si.unit_id
     WHERE si.sale_id = ?
     ORDER BY si.created_at ASC`,
    [sale.id]
  );

  return {
    id: sale.id,
    saleNumber: sale.sale_number,
    createdAt: sale.created_at,
    items: items.map((it) => ({
      ...it,
      returnable_qty: new Decimal(it.quantity).minus(it.already_returned_qty).toFixed(4),
    })),
  };
}

// items: [{ saleItemId, quantity }] — quantity dalam satuan sama seperti
// baris nota asal (tidak boleh pilih satuan lain, supaya conversion_factor
// & cost_per_base_unit snapshot tetap valid dipakai langsung).
async function createSalesReturn({ saleNumber, returnDate, items, isCashRefund = true, reason, userId }) {
  if (!saleNumber || !saleNumber.trim()) throw new HttpError(400, 'bad_request', 'Nomor nota wajib diisi');
  if (!returnDate) throw new HttpError(400, 'bad_request', 'returnDate wajib diisi');
  if (!items || items.length === 0) throw new HttpError(400, 'bad_request', 'Item retur tidak boleh kosong');
  if (!reason || !reason.trim()) throw new HttpError(400, 'bad_request', 'Alasan retur wajib diisi');

  const returnId = uuidv4();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[sale]] = await conn.query(`SELECT * FROM sales WHERE sale_number = ? FOR UPDATE`, [saleNumber.trim()]);
    if (!sale) throw new HttpError(404, 'sale_not_found', 'Nota tidak ditemukan');
    if (sale.status !== 'completed') throw new HttpError(409, 'sale_not_returnable', 'Nota ini sudah di-void, tidak bisa diretur');

    // Satu gudang default utk semua transaksi (Bagian 5, sama seperti
    // seluruh SalesService/VoidService) — belum ada warehouse_id per shift.
    const warehouseId = await getDefaultWarehouseId(conn);

    let grandTotal = new Decimal(0);
    let totalCost = new Decimal(0);
    const itemRows = [];
    const logParts = [];

    for (const reqItem of items) {
      const quantity = new Decimal(reqItem.quantity);
      if (quantity.lte(0)) throw new HttpError(400, 'bad_request', 'Qty retur harus > 0');

      const [[saleItem]] = await conn.query(`SELECT * FROM sale_items WHERE id = ? FOR UPDATE`, [reqItem.saleItemId]);
      if (!saleItem || saleItem.sale_id !== sale.id) {
        throw new HttpError(400, 'invalid_sale_item', `Baris nota ${reqItem.saleItemId} tidak ditemukan di nota ini`);
      }

      const [[alreadyReturned]] = await conn.query(
        `SELECT COALESCE(SUM(quantity), 0) AS qty FROM sales_return_items WHERE sale_item_id = ?`,
        [saleItem.id]
      );
      const originalQty = new Decimal(saleItem.quantity);
      const returnableQty = originalQty.minus(alreadyReturned.qty);
      if (quantity.gt(returnableQty)) {
        throw new HttpError(409, 'return_exceeds_purchased', `Qty retur (${quantity.toFixed(4)}) melebihi sisa yang bisa diretur (${returnableQty.toFixed(4)}) utk baris ini`);
      }

      const conversionFactor = new Decimal(saleItem.conversion_factor);
      const quantityBase = quantity.mul(conversionFactor);
      const costPerBaseUnit = new Decimal(saleItem.cost_per_base_unit);

      // Prorata dari qty & subtotal ASLI baris ini (bukan sisa) — supaya
      // beberapa kali retur sebagian tetap konsisten & proporsional thd
      // nilai jual ASLI, termasuk diskon yang sudah melekat di subtotal itu.
      const proportion = quantity.div(originalQty);
      const amount = new Decimal(saleItem.subtotal).mul(proportion).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      const costAmount = costPerBaseUnit.mul(quantityBase).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

      // IN biasa, pakai cost SNAPSHOT baris nota asal (BUKAN avg cost
      // sekarang) — blend masuk ke avg cost berjalan, simetris dgn
      // void_reversal, TAPI ini movement type sendiri (dokumen retur
      // beneran, bukan pembalik nota).
      await applyStockMovement(conn, {
        warehouseId,
        productId: saleItem.product_id,
        movementType: 'sales_return',
        referenceType: 'sales_return',
        referenceUuid: returnId,
        qtyInBase: quantityBase.toFixed(4),
        costPerBaseUnit: costPerBaseUnit.toFixed(4),
        movementDate: new Date(),
      });

      const [[productName]] = await conn.query(`SELECT name FROM products WHERE id = ?`, [saleItem.product_id]);

      itemRows.push({
        id: uuidv4(),
        saleItemId: saleItem.id,
        productId: saleItem.product_id,
        productName: productName ? productName.name : saleItem.product_id,
        unitId: saleItem.unit_id,
        quantity: quantity.toFixed(4),
        conversionFactor: conversionFactor.toFixed(4),
        quantityBase: quantityBase.toFixed(4),
        costPerBaseUnit: costPerBaseUnit.toFixed(4),
        amount: amount.toFixed(0),
        costAmount: costAmount.toFixed(0),
      });
      logParts.push(`${productName ? productName.name : saleItem.product_id} ${quantity.toFixed(4)} (Rp${amount.toFixed(0)})`);

      grandTotal = grandTotal.plus(amount);
      totalCost = totalCost.plus(costAmount);
    }

    const returnNumber = generateReturnNumber();

    await conn.query(
      `INSERT INTO sales_returns (id, branch_id, return_number, sale_id, warehouse_id, return_date, is_cash_refund, reason, grand_total, total_cost, processed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [returnId, BRANCH_ID, returnNumber, sale.id, warehouseId, returnDate, isCashRefund ? 1 : 0, reason.trim(), grandTotal.toFixed(0), totalCost.toFixed(0), userId]
    );

    for (const row of itemRows) {
      await conn.query(
        `INSERT INTO sales_return_items
          (id, sales_return_id, sale_item_id, product_id, unit_id, quantity, conversion_factor, quantity_base, cost_per_base_unit, amount, cost_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, returnId, row.saleItemId, row.productId, row.unitId, row.quantity, row.conversionFactor, row.quantityBase, row.costPerBaseUnit, row.amount, row.costAmount]
      );
    }

    // Satu entry jurnal, 2 sisi sekaligus (pendapatan + HPP) — satu dokumen
    // retur = satu entry, bukan dipecah kayak postSaleJournals (itu pecah
    // krn kompleksitas PPN yang di sini sengaja tidak ditangani).
    const lines = [];
    if (grandTotal.gt(0)) {
      const returAccount = await AccountingService.getAccountByCode(RETUR_POTONGAN_PENJUALAN_CODE, conn);
      const paymentAccount = await AccountingService.getAccountByCode(isCashRefund ? KAS_CODE : BANK_CODE, conn);
      lines.push({ accountId: returAccount.id, debit: grandTotal, description: 'Retur penjualan (mengurangi pendapatan)' });
      lines.push({ accountId: paymentAccount.id, credit: grandTotal, description: isCashRefund ? 'Kas keluar (refund tunai)' : 'Bank keluar (refund non-tunai)' });
    }
    if (totalCost.gt(0)) {
      const persediaanAccount = await AccountingService.getAccountByCode(PERSEDIAAN_CODE, conn);
      const hppAccount = await AccountingService.getAccountByCode(HPP_CODE, conn);
      lines.push({ accountId: persediaanAccount.id, debit: totalCost, description: 'Barang kembali ke persediaan' });
      lines.push({ accountId: hppAccount.id, credit: totalCost, description: 'Pengurangan HPP (barang tidak jadi terjual)' });
    }

    let journalEntry = null;
    if (lines.length > 0) {
      journalEntry = await AccountingService.postJournalEntry(conn, {
        entryDate: returnDate,
        description: `Retur Penjualan ${returnNumber} (nota ${sale.sale_number})`,
        sourceType: 'sales_return',
        sourceUuid: returnId,
        lines,
        createdBy: userId,
      });
    }

    await logActivity(conn, {
      userId,
      action: 'sales_return',
      entityType: 'sales_return',
      entityUuid: returnId,
      description: `Retur penjualan ${returnNumber} dari nota ${sale.sale_number} — ${logParts.join('; ')}. Total Rp${grandTotal.toFixed(0)}. Alasan: ${reason.trim()}`,
    });

    await conn.commit();

    return {
      id: returnId,
      returnNumber,
      saleNumber: sale.sale_number,
      returnDate,
      isCashRefund: !!isCashRefund,
      grandTotal: grandTotal.toFixed(0),
      totalCost: totalCost.toFixed(0),
      items: itemRows,
      journalEntry,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { listSalesReturns, getSalesReturnDetail, getSaleForReturn, createSalesReturn };
