const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

const BRANCH_ID = 1;

// Hanya field yang dibutuhkan quote/checkout yang disimpan — TIDAK ada nama
// produk/harga/satuan snapshot di sini. Saat draft dipanggil, client selalu
// ambil ulang data produk (getForPos) supaya harga & satuan yang tampil
// selalu yang TERBARU, bukan yang beku sejak draft dibuat.
function sanitizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpError(400, 'bad_request', 'Draft tidak boleh kosong');
  }
  return items.map((it) => {
    if (!it.productId || !it.unitId || !it.priceLevelId || !it.quantity || Number(it.quantity) <= 0) {
      throw new HttpError(400, 'bad_request', 'Item draft tidak lengkap (productId/unitId/priceLevelId/quantity)');
    }
    return {
      productId: it.productId,
      unitId: it.unitId,
      priceLevelId: it.priceLevelId,
      quantity: Number(it.quantity),
    };
  });
}

async function listDraftsForShift(shiftId) {
  const [rows] = await pool.query(
    `SELECT id, label, items_json, created_at FROM sale_drafts WHERE cashier_shift_id = ? ORDER BY created_at DESC`,
    [shiftId]
  );
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    items: r.items_json, // mysql2 auto-parse kolom JSON jadi array/objek JS
    itemCount: r.items_json.length,
    createdAt: r.created_at,
  }));
}

async function createDraft({ shiftId, userId, label, items }) {
  const cleanItems = sanitizeItems(items);
  const id = uuidv4();
  await pool.query(
    `INSERT INTO sale_drafts (id, branch_id, cashier_shift_id, user_id, label, items_json) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, BRANCH_ID, shiftId, userId, (label || '').trim() || null, JSON.stringify(cleanItems)]
  );
  return { id, label: (label || '').trim() || null, items: cleanItems, itemCount: cleanItems.length };
}

// Dibatasi ke shift yang sama dengan yang sedang login — kasir tidak boleh
// menghapus draft milik shift lain (row scoped by cashier_shift_id, bukan cuma id).
async function deleteDraft(draftId, shiftId) {
  const [result] = await pool.query(
    `DELETE FROM sale_drafts WHERE id = ? AND cashier_shift_id = ?`,
    [draftId, shiftId]
  );
  if (result.affectedRows === 0) {
    throw new HttpError(404, 'draft_not_found', 'Draft tidak ditemukan untuk shift ini');
  }
}

module.exports = { listDraftsForShift, createDraft, deleteDraft };
