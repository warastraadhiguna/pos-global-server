const express = require('express');
const ReportService = require('../services/ReportService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

// GET /api/admin/reports/daily-sales?date=YYYY-MM-DD — read-only, tidak
// menyentuh logic transaksi sama sekali.
router.get(
  '/daily-sales',
  asyncHandler(async (req, res) => {
    const report = await ReportService.getDailySalesReport(req.query.date);
    res.json({ report });
  })
);

module.exports = router;
