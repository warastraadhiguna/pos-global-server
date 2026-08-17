const express = require('express');
const PurchaseReturnService = require('../services/PurchaseReturnService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get(
  '/',
  requirePermission('purchase_returns', 'view'),
  asyncHandler(async (req, res) => {
    const purchaseReturns = await PurchaseReturnService.listPurchaseReturns();
    res.json({ purchaseReturns });
  })
);

// POST /api/admin/purchase-returns — body: { supplierId, returnDate, items, paymentType, reason }
// items: [{ productId, unitId, quantity }]
router.post(
  '/',
  requirePermission('purchase_returns', 'create'),
  asyncHandler(async (req, res) => {
    const purchaseReturn = await PurchaseReturnService.createPurchaseReturn({ ...req.body, userId: req.user.id });
    res.status(201).json({ purchaseReturn });
  })
);

module.exports = router;
