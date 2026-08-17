const express = require('express');
const CashDenominationService = require('../services/CashDenominationService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/cash-denominations — dipakai kasir utk tombol shortcut (cuma aktif)
router.get(
  '/',
  requirePermission('cash_denominations', 'view'),
  asyncHandler(async (req, res) => {
    const denominations = await CashDenominationService.listActiveDenominations();
    res.json({ denominations });
  })
);

// GET /api/cash-denominations/all — dipakai admin panel (termasuk nonaktif).
// Sengaja digerbang 'edit' (bukan 'view') — sama alasannya dgn
// payment-methods/all, daftar lengkap itu bagian dari alur kelola.
router.get(
  '/all',
  requirePermission('cash_denominations', 'edit'),
  asyncHandler(async (req, res) => {
    const denominations = await CashDenominationService.listAllDenominations();
    res.json({ denominations });
  })
);

router.post(
  '/',
  requirePermission('cash_denominations', 'create'),
  asyncHandler(async (req, res) => {
    const denomination = await CashDenominationService.createDenomination(req.body);
    res.status(201).json({ denomination });
  })
);

router.put(
  '/:id',
  requirePermission('cash_denominations', 'edit'),
  asyncHandler(async (req, res) => {
    const denomination = await CashDenominationService.updateDenomination(req.params.id, req.body);
    res.json({ denomination });
  })
);

module.exports = router;
