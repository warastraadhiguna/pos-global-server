const express = require('express');
const PurchaseReturnService = require('../services/PurchaseReturnService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const purchaseReturns = await PurchaseReturnService.listPurchaseReturns();
    res.json({ purchaseReturns });
  })
);

// POST /api/admin/purchase-returns — body: { supplierId, returnDate, items, paymentType, reason }
// items: [{ productId, unitId, quantity }]
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const purchaseReturn = await PurchaseReturnService.createPurchaseReturn({ ...req.body, userId: req.user.id });
    res.status(201).json({ purchaseReturn });
  })
);

module.exports = router;
