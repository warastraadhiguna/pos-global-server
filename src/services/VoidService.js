const pool = require('../config/db');
const HttpError = require('../utils/HttpError');
const { logActivity } = require('./AuthService');
const { applyStockMovement } = require('./StockMovementService');
const { getDefaultWarehouseId } = require('./WarehouseService');

// Void dibatasi selama shift transaksi itu MASIH TERBUKA — begitu shift
// ditutup, angka rekonsiliasi kas (closing_cash_expected) sudah dikunci dan
// tidak dihitung ulang otomatis. Manager yang perlu koreksi setelah shift
// tutup harus lewat penyesuaian manual (di luar scope MVP ini).
async function voidSale({ saleId, userId, userRole, reason }) {
  if (!reason || !reason.trim()) {
    throw new HttpError(400, 'bad_request', 'Alasan void wajib diisi');
  }

  const warehouseId = await getDefaultWarehouseId();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[sale]] = await conn.query(`SELECT * FROM sales WHERE id = ? FOR UPDATE`, [saleId]);
    if (!sale) {
      throw new HttpError(404, 'sale_not_found', 'Transaksi tidak ditemukan');
    }
    if (sale.status !== 'completed') {
      throw new HttpError(409, 'already_voided', 'Transaksi ini sudah di-void sebelumnya');
    }
    if (userRole !== 'admin' && sale.user_id !== userId) {
      throw new HttpError(403, 'forbidden', 'Hanya kasir yang membuat transaksi ini atau admin yang bisa void');
    }

    const [[shift]] = await conn.query(`SELECT status FROM cashier_shifts WHERE id = ?`, [sale.cashier_shift_id]);
    if (!shift || shift.status !== 'open') {
      throw new HttpError(409, 'shift_closed', 'Shift transaksi ini sudah ditutup, tidak bisa void lagi');
    }

    const [items] = await conn.query(`SELECT * FROM sale_items WHERE sale_id = ?`, [saleId]);

    for (const item of items) {
      // Kembalikan stok pakai cost snapshot ASLI item ini (bukan avg cost
      // sekarang) — supaya efek void terhadap moving average cost simetris
      // dengan efek sale-nya dulu (Bagian 5 poin 5: snapshot HPP, bukan hitung ulang).
      await applyStockMovement(conn, {
        warehouseId,
        productId: item.product_id,
        movementType: 'void_reversal',
        referenceType: 'sale',
        referenceUuid: saleId,
        qtyInBase: item.quantity_base,
        costPerBaseUnit: item.cost_per_base_unit,
        movementDate: new Date(),
      });
    }

    await conn.query(
      `UPDATE sales SET status = 'voided', void_reason = ?, voided_at = NOW(), voided_by = ? WHERE id = ?`,
      [reason.trim(), userId, saleId]
    );

    await logActivity(conn, {
      userId,
      action: 'void_sale',
      entityType: 'sale',
      entityUuid: saleId,
      description: `Void transaksi ${sale.sale_number}. Alasan: ${reason.trim()}`,
    });

    await conn.commit();
    return { id: saleId, saleNumber: sale.sale_number, status: 'voided' };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { voidSale };
