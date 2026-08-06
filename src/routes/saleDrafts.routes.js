const express = require('express');
const SaleDraftService = require('../services/SaleDraftService');
const ShiftService = require('../services/ShiftService');
const asyncHandler = require('../utils/asyncHandler');
const HttpError = require('../utils/HttpError');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Semua endpoint draft di sini SELALU dilingkupi shift TERBUKA milik kasir
// yang sedang login (bukan dari body/param) — sama seperti pola checkout di
// sales.routes.js, supaya kasir tidak bisa menyentuh draft shift lain.
async function requireOpenShift(req) {
  const shift = await ShiftService.getOpenShiftForUser(req.user.id);
  if (!shift) {
    throw new HttpError(409, 'no_open_shift', 'Buka shift terlebih dahulu');
  }
  return shift;
}

// GET /api/sale-drafts — daftar draft aktif milik shift berjalan
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const shift = await requireOpenShift(req);
    const drafts = await SaleDraftService.listDraftsForShift(shift.id);
    res.json({ drafts });
  })
);

// POST /api/sale-drafts — body: { label?, items }. items minimal
// { productId, unitId, priceLevelId, quantity } per baris, TIDAK memotong
// stok/menulis penjualan apa pun — cuma snapshot ringan.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const shift = await requireOpenShift(req);
    const { label, items } = req.body;
    const draft = await SaleDraftService.createDraft({ shiftId: shift.id, userId: req.user.id, label, items });
    res.status(201).json({ draft });
  })
);

// DELETE /api/sale-drafts/:id — dipanggil setelah draft dipanggil balik ke
// nota (recall) ATAU dibuang manual oleh kasir.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const shift = await requireOpenShift(req);
    await SaleDraftService.deleteDraft(req.params.id, shift.id);
    res.status(204).end();
  })
);

module.exports = router;
