const express = require('express');
const PurchaseService = require('../services/PurchaseService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const purchases = await PurchaseService.listPurchases();
    res.json({ purchases });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const purchase = await PurchaseService.getPurchaseDetail(req.params.id);
    res.json({ purchase });
  })
);

// POST /api/admin/purchases — body: { supplierId, purchaseDate, items, paymentType }
// items: [{ productId, unitId, quantity, costPerUnit }]
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const purchase = await PurchaseService.createPurchase({ ...req.body, userId: req.user.id });
    res.status(201).json({ purchase });
  })
);

// POST /api/admin/purchases/:id/void — body: { reason }
router.post(
  '/:id/void',
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
