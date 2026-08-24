const express = require('express');
const InternalStockUsageService = require('../services/InternalStockUsageService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get(
  '/',
  requirePermission('internal_stock_usage', 'view'),
  asyncHandler(async (req, res) => {
    const usages = await InternalStockUsageService.listInternalStockUsages();
    res.json({ usages });
  })
);

router.get(
  '/:id',
  requirePermission('internal_stock_usage', 'view'),
  asyncHandler(async (req, res) => {
    const usage = await InternalStockUsageService.getInternalStockUsageDetail(req.params.id);
    res.json({ usage });
  })
);

// POST /api/admin/internal-stock-usage — body: { usageDate, items, reason }
// items: [{ productId, unitId, quantity }]
router.post(
  '/',
  requirePermission('internal_stock_usage', 'create'),
  asyncHandler(async (req, res) => {
    const usage = await InternalStockUsageService.createInternalStockUsage({ ...req.body, userId: req.user.id });
    res.status(201).json({ usage });
  })
);

module.exports = router;
