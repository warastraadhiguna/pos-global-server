const express = require('express');
const PurchaseDraftService = require('../services/PurchaseDraftService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/admin/purchase-drafts — semua draft (bukan cuma milik user yang
// login) — beda dari sale_drafts (dilingkupi shift kasir), draft pembelian
// dibuat admin & wajar dilihat/dilanjutkan admin lain juga.
router.get(
  '/',
  requirePermission('purchase_drafts', 'view'),
  asyncHandler(async (req, res) => {
    const drafts = await PurchaseDraftService.listDrafts();
    res.json({ drafts });
  })
);

// POST /api/admin/purchase-drafts — body: { label?, supplierId?, purchaseDate?,
// paymentType?, ppn?, items }. TIDAK menyentuh stok/avg cost/jurnal sama
// sekali — cuma snapshot ringan, lihat catatan di schema.sql & PurchaseDraftService.
router.post(
  '/',
  requirePermission('purchase_drafts', 'create'),
  asyncHandler(async (req, res) => {
    const draft = await PurchaseDraftService.createDraft({ ...req.body, userId: req.user.id });
    res.status(201).json({ draft });
  })
);

// DELETE /api/admin/purchase-drafts/:id — dipanggil setelah draft dipanggil
// balik (recall) ATAU dibuang manual.
router.delete(
  '/:id',
  requirePermission('purchase_drafts', 'delete'),
  asyncHandler(async (req, res) => {
    await PurchaseDraftService.deleteDraft(req.params.id);
    res.status(204).end();
  })
);

module.exports = router;
