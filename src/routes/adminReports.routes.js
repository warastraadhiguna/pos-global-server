const express = require('express');
const ReportService = require('../services/ReportService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requirePermission('reports', 'view'));

// GET /api/admin/reports/daily-sales?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD —
// read-only, tidak menyentuh logic transaksi sama sekali. Rentang inklusif
// di kedua ujung (WHERE DATE(created_at) BETWEEN startDate AND endDate).
router.get(
  '/daily-sales',
  asyncHandler(async (req, res) => {
    const report = await ReportService.getDailySalesReport(req.query.startDate, req.query.endDate);
    res.json({ report });
  })
);

// GET /api/admin/reports/transactions?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD —
// daftar nota dalam rentang tanggal (termasuk voided). Detail per-nota dipakai
// endpoint GET /api/sales/:id yang sudah ada (sama seperti dipakai kasir).
router.get(
  '/transactions',
  asyncHandler(async (req, res) => {
    const report = await ReportService.getTransactionsReport(req.query.startDate, req.query.endDate);
    res.json({ report });
  })
);

module.exports = router;
