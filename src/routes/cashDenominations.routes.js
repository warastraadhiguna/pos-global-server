const express = require('express');
const CashDenominationService = require('../services/CashDenominationService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/cash-denominations — dipakai kasir utk tombol shortcut (cuma aktif)
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const denominations = await CashDenominationService.listActiveDenominations();
    res.json({ denominations });
  })
);

router.use(requireRole('admin'));

// GET /api/cash-denominations/all — dipakai admin panel (termasuk nonaktif)
router.get(
  '/all',
  asyncHandler(async (req, res) => {
    const denominations = await CashDenominationService.listAllDenominations();
    res.json({ denominations });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const denomination = await CashDenominationService.createDenomination(req.body);
    res.status(201).json({ denomination });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const denomination = await CashDenominationService.updateDenomination(req.params.id, req.body);
    res.json({ denomination });
  })
);

module.exports = router;
