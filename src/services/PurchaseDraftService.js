// Draft pembelian (admin panel) — sama pola dgn SaleDraftService di kasir.
// Lihat catatan panjang di schema.sql (purchase_drafts) soal kenapa harga
// beli IKUT disimpan (beda dgn sale_drafts yg sengaja tidak simpan harga).
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

const BRANCH_ID = 1;

function sanitizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpError(400, 'bad_request', 'Draft tidak boleh kosong');
  }
  return items.map((it) => {
    if (!it.productId || !it.unitId || !it.quantity || Number(it.quantity) <= 0 || !it.costPerUnit || Number(it.costPerUnit) <= 0) {
      throw new HttpError(400, 'bad_request', 'Item draft tidak lengkap (productId/unitId/quantity/costPerUnit)');
    }
    return {
      productId: it.productId,
      productName: it.productName || null,
      unitId: it.unitId,
      unitName: it.unitName || null,
      quantity: Number(it.quantity),
      costPerUnit: Number(it.costPerUnit),
      discountType: it.discountType === 'percent' || it.discountType === 'rupiah' ? it.discountType : null,
      discountValue: it.discountValue ? Number(it.discountValue) : null,
    };
  });
}

async function listDrafts() {
  const [rows] = await pool.query(
    `SELECT pd.id, pd.label, pd.supplier_id, s.name AS supplier_name, pd.purchase_date, pd.payment_type, pd.notes,
            pd.ppn_json, pd.total_discount_json, pd.items_json, pd.created_at, u.full_name AS created_by_name
     FROM purchase_drafts pd
     LEFT JOIN suppliers s ON s.id = pd.supplier_id
     JOIN users u ON u.id = pd.user_id
     ORDER BY pd.created_at DESC`
  );
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    purchaseDate: r.purchase_date,
    paymentType: r.payment_type,
    notes: r.notes,
    ppn: r.ppn_json, // mysql2 auto-parse JSON
    totalDiscount: r.total_discount_json,
    items: r.items_json,
    itemCount: r.items_json.length,
    createdAt: r.created_at,
    createdByName: r.created_by_name,
  }));
}

async function createDraft({ userId, label, supplierId, purchaseDate, paymentType, notes, ppn, totalDiscount, items }) {
  const cleanItems = sanitizeItems(items);
  const id = uuidv4();
  await pool.query(
    `INSERT INTO purchase_drafts (id, branch_id, user_id, label, supplier_id, purchase_date, payment_type, notes, ppn_json, total_discount_json, items_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, BRANCH_ID, userId, (label || '').trim() || null,
      supplierId || null, purchaseDate || null, paymentType || null, (notes || '').trim() || null,
      ppn ? JSON.stringify(ppn) : null, totalDiscount ? JSON.stringify(totalDiscount) : null, JSON.stringify(cleanItems),
    ]
  );
  return { id };
}

async function deleteDraft(draftId) {
  const [result] = await pool.query(`DELETE FROM purchase_drafts WHERE id = ?`, [draftId]);
  if (result.affectedRows === 0) {
    throw new HttpError(404, 'draft_not_found', 'Draft tidak ditemukan');
  }
}

module.exports = { listDrafts, createDraft, deleteDraft };
