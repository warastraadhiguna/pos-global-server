const express = require('express');
const SalesReturnService = require('../services/SalesReturnService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get(
  '/',
  requirePermission('sales_returns', 'view'),
  asyncHandler(async (req, res) => {
    const salesReturns = await SalesReturnService.listSalesReturns();
    res.json({ salesReturns });
  })
);

// GET /api/admin/sales-returns/lookup-sale?saleNumber=... — cari nota +
// baris item-nya (termasuk sisa qty yang masih boleh diretur), dipakai
// admin sebelum isi form retur. TIDAK menyimpan apa pun.
router.get(
  '/lookup-sale',
  requirePermission('sales_returns', 'create'),
  asyncHandler(async (req, res) => {
    const sale = await SalesReturnService.getSaleForReturn(req.query.saleNumber);
    res.json({ sale });
  })
);

router.get(
  '/:id',
  requirePermission('sales_returns', 'view'),
  asyncHandler(async (req, res) => {
    const salesReturn = await SalesReturnService.getSalesReturnDetail(req.params.id);
    res.json({ salesReturn });
  })
);

// POST /api/admin/sales-returns — body: { saleNumber, returnDate, items, isCashRefund, reason }
// items: [{ saleItemId, quantity }]
router.post(
  '/',
  requirePermission('sales_returns', 'create'),
  asyncHandler(async (req, res) => {
    const salesReturn = await SalesReturnService.createSalesReturn({ ...req.body, userId: req.user.id });
    res.status(201).json({ salesReturn });
  })
);

module.exports = router;
