const express = require('express');
const InternalStockUsageService = require('../services/InternalStockUsageService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission, requireRole } = require('../middleware/auth');

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

// POST /api/admin/internal-stock-usage/:id/void — body: { reason }. SENGAJA
// requireRole('superadmin') literal (bukan requirePermission) — void di sini
// membalik jurnal yang sudah mempengaruhi Laba Rugi, tidak boleh
// didelegasikan ke role lain lewat Kelola Role sama sekali.
router.post(
  '/:id/void',
  requireRole('superadmin'),
  asyncHandler(async (req, res) => {
    const { reason } = req.body;
    const usage = await InternalStockUsageService.voidInternalStockUsage(req.params.id, { userId: req.user.id, reason });
    res.json({ usage });
  })
);

module.exports = router;
