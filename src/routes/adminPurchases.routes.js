const express = require('express');
const PurchaseService = require('../services/PurchaseService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get(
  '/',
  requirePermission('purchases', 'view'),
  asyncHandler(async (req, res) => {
    const { q, dateFrom, dateTo, page, limit } = req.query;
    const result = await PurchaseService.listPurchases({ search: q, dateFrom, dateTo, page, limit });
    res.json(result);
  })
);

// GET /api/admin/purchases/by-product?q=&dateFrom=&dateTo=&page=&limit= —
// HARUS didaftarkan SEBELUM '/:id' di bawah, kalau tidak Express akan
// menganggap "by-product" sbg nilai :id (route matching berurutan).
router.get(
  '/by-product',
  requirePermission('purchases', 'view'),
  asyncHandler(async (req, res) => {
    const { q, dateFrom, dateTo, page, limit } = req.query;
    const result = await PurchaseService.listPurchaseItemsByProduct({ search: q, dateFrom, dateTo, page, limit });
    res.json(result);
  })
);

router.get(
  '/:id',
  requirePermission('purchases', 'view'),
  asyncHandler(async (req, res) => {
    const purchase = await PurchaseService.getPurchaseDetail(req.params.id);
    res.json({ purchase });
  })
);

// POST /api/admin/purchases — body: { supplierId, purchaseDate, items, paymentType, ppnMode?, ppnRate? }
// items: [{ productId, unitId, quantity, costPerUnit }]
// ppnMode ('exclude'|'included')/ppnRate: PPN Masukan pembelian INI SAJA,
// cuma valid kalau tax_mode toko='pkp' — lihat PurchaseService.createPurchase.
router.post(
  '/',
  requirePermission('purchases', 'create'),
  asyncHandler(async (req, res) => {
    const purchase = await PurchaseService.createPurchase({ ...req.body, userId: req.user.id });
    res.status(201).json({ purchase });
  })
);

// POST /api/admin/purchases/:id/void — body: { reason }
router.post(
  '/:id/void',
  requirePermission('purchases', 'void'),
  asyncHandler(async (req, res) => {
    const result = await PurchaseService.voidPurchase({
      purchaseId: req.params.id,
      reason: req.body.reason,
      userId: req.user.id,
    });
    res.json(result);
  })
);

module.exports = router;
