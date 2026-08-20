// Retur pembelian (feature/accounting — tutup lubang void/retur, Bagian A).
// Beda dari void: ini transaksi bisnis NYATA (barang benar-benar keluar ke
// supplier), bukan koreksi kesalahan input. Karena itu pakai OUT BIASA di
// avg cost BERJALAN (persis seperti jual) — bukan reversal-nilai seperti
// void. Lewat StockMovementService.applyStockMovement & AccountingService.
// postJournalEntry yang sudah ada, tidak ada jalur baru.
const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');
const { applyStockMovement } = require('./StockMovementService');
const { getDefaultWarehouseId } = require('./WarehouseService');
const AccountingService = require('./AccountingService');

const BRANCH_ID = 1;
const PERSEDIAAN_CODE = '1-301';
const KAS_CODE = '1-101';
const UTANG_USAHA_CODE = '2-101';

function generateReturnNumber() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const randomPart = Math.floor(100000 + Math.random() * 900000); // lihat catatan di AccountingService.generateEntryNumber
  return `PR${BRANCH_ID}-${datePart}-${timePart}${randomPart}`;
}

async function listPurchaseReturns() {
  const [rows] = await pool.query(
    `SELECT pr.id, pr.return_number, pr.return_date, pr.grand_total, pr.payment_type, pr.reason,
            s.name AS supplier_name, u.full_name AS processed_by_name
     FROM purchase_returns pr
     JOIN suppliers s ON s.id = pr.supplier_id
     JOIN users u ON u.id = pr.processed_by
     ORDER BY pr.created_at DESC`
  );
  return rows;
}

// items: [{ productId, unitId, quantity }] — quantity dalam satuan yang
// dipilih (mis. dus), dikonversi ke base unit sama seperti pembelian.
async function createPurchaseReturn({ supplierId, returnDate, items, paymentType, reason, userId }) {
  if (!supplierId) throw new HttpError(400, 'bad_request', 'supplierId wajib diisi');
  if (!returnDate) throw new HttpError(400, 'bad_request', 'returnDate wajib diisi');
  if (!items || items.length === 0) throw new HttpError(400, 'bad_request', 'Item retur tidak boleh kosong');
  if (!['cash', 'credit'].includes(paymentType)) {
    throw new HttpError(400, 'bad_request', 'paymentType harus "cash" atau "credit"');
  }
  if (!reason || !reason.trim()) {
    throw new HttpError(400, 'bad_request', 'Alasan retur wajib diisi');
  }

  const returnId = uuidv4();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const warehouseId = await getDefaultWarehouseId(conn);

    const [[supplier]] = await conn.query(`SELECT id, is_active FROM suppliers WHERE id = ?`, [supplierId]);
    if (!supplier || !supplier.is_active) {
      throw new HttpError(400, 'invalid_supplier', 'Supplier tidak valid atau sudah nonaktif');
    }

    let grandTotal = new Decimal(0);
    const itemRows = [];

    for (const item of items) {
      const quantity = new Decimal(item.quantity);
      if (quantity.lte(0)) throw new HttpError(400, 'bad_request', 'Qty retur harus > 0');

      const [[productUnit]] = await conn.query(
        `SELECT pu.conversion_factor, p.name AS product_name
         FROM product_units pu JOIN products p ON p.id = pu.product_id
         WHERE pu.product_id = ? AND pu.unit_id = ? LIMIT 1`,
        [item.productId, item.unitId]
      );
      if (!productUnit) {
        throw new HttpError(400, 'invalid_unit', `Satuan tidak valid untuk produk ${item.productId}`);
      }
      const conversionFactor = new Decimal(productUnit.conversion_factor);
      const quantityBase = quantity.mul(conversionFactor);

      const [[balance]] = await conn.query(
        `SELECT qty_base, avg_cost_per_base_unit FROM stock_balances WHERE warehouse_id = ? AND product_id = ? FOR UPDATE`,
        [warehouseId, item.productId]
      );
      const currentQty = balance ? new Decimal(balance.qty_base) : new Decimal(0);
      if (currentQty.lt(quantityBase)) {
        throw new HttpError(409, 'insufficient_stock', `Stok produk ${item.productId} tidak cukup untuk retur sebesar ini (sisa ${currentQty.toFixed(4)})`);
      }
      // OUT biasa — cost basis = avg cost BERJALAN, avg cost TIDAK berubah
      // setelahnya (persis mekanisme penjualan). Diambil SEBELUM movement
      // supaya nilainya konsisten dgn yang dipakai applyStockMovement sendiri.
      const avgCostNow = balance ? new Decimal(balance.avg_cost_per_base_unit) : new Decimal(0);
      const amount = quantityBase.mul(avgCostNow);

      await applyStockMovement(conn, {
        warehouseId,
        productId: item.productId,
        movementType: 'purchase_return',
        referenceType: 'purchase_return',
        referenceUuid: returnId,
        qtyOutBase: quantityBase.toFixed(4),
        // Waktu submit sebenarnya, bukan returnDate (tanggal bisnis tanpa
        // jam) — sama alasan dgn PurchaseService.createPurchase.
        movementDate: new Date(),
      });

      itemRows.push({
        id: uuidv4(),
        productId: item.productId,
        productName: productUnit.product_name,
        unitId: item.unitId,
        quantity: quantity.toFixed(4),
        conversionFactor: conversionFactor.toFixed(4),
        quantityBase: quantityBase.toFixed(4),
        costPerBaseUnit: avgCostNow.toFixed(4),
        amount: amount.toFixed(0),
      });

      grandTotal = grandTotal.plus(amount);
    }

    const returnNumber = generateReturnNumber();

    await conn.query(
      `INSERT INTO purchase_returns (id, branch_id, return_number, supplier_id, warehouse_id, return_date, payment_type, reason, grand_total, processed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [returnId, BRANCH_ID, returnNumber, supplierId, warehouseId, returnDate, paymentType, reason.trim(), grandTotal.toFixed(0), userId]
    );

    for (const row of itemRows) {
      await conn.query(
        `INSERT INTO purchase_return_items
          (id, purchase_return_id, product_id, unit_id, quantity, conversion_factor, quantity_base, cost_per_base_unit, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, returnId, row.productId, row.unitId, row.quantity, row.conversionFactor, row.quantityBase, row.costPerBaseUnit, row.amount]
      );
    }

    // Jurnal — tunai: Debit Kas / Kredit Persediaan; kredit: Debit Utang
    // Usaha / Kredit Persediaan (mengurangi utang, bukan terima kas).
    const persediaanAccount = await AccountingService.getAccountByCode(PERSEDIAAN_CODE, conn);
    const counterAccount = await AccountingService.getAccountByCode(
      paymentType === 'cash' ? KAS_CODE : UTANG_USAHA_CODE,
      conn
    );
    const journalEntry = await AccountingService.postJournalEntry(conn, {
      entryDate: returnDate,
      description: `Retur Pembelian ${returnNumber}`,
      sourceType: 'purchase_return',
      sourceUuid: returnId,
      lines: [
        { accountId: counterAccount.id, debit: grandTotal, description: paymentType === 'cash' ? 'Kas diterima kembali' : 'Mengurangi utang usaha' },
        { accountId: persediaanAccount.id, credit: grandTotal, description: 'Barang dikembalikan ke supplier' },
      ],
      createdBy: userId,
    });

    await conn.commit();

    return {
      id: returnId,
      returnNumber,
      returnDate,
      grandTotal: grandTotal.toFixed(0),
      paymentType,
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

module.exports = { listPurchaseReturns, createPurchaseReturn };
