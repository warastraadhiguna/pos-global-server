const express = require('express');
const ShiftService = require('../services/ShiftService');
const CashMovementService = require('../services/CashMovementService');
const asyncHandler = require('../utils/asyncHandler');
const HttpError = require('../utils/HttpError');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/shifts/current — shift terbuka milik user yang sedang login
router.get(
  '/current',
  asyncHandler(async (req, res) => {
    const shift = await ShiftService.getOpenShiftForUser(req.user.id);
    res.json({ shift });
  })
);

// POST /api/shifts/open — body: { openingCash }
router.post(
  '/open',
  asyncHandler(async (req, res) => {
    const { openingCash } = req.body;
    if (openingCash === undefined || openingCash === null || openingCash < 0) {
      throw new HttpError(400, 'bad_request', 'openingCash wajib diisi (>= 0)');
    }
    const shift = await ShiftService.openShift(req.user.id, openingCash);
    res.status(201).json({ shift });
  })
);

// POST /api/shifts/:id/close — body: { closingCashActual }
router.post(
  '/:id/close',
  asyncHandler(async (req, res) => {
    const { closingCashActual } = req.body;
    if (closingCashActual === undefined || closingCashActual === null || closingCashActual < 0) {
      throw new HttpError(400, 'bad_request', 'closingCashActual wajib diisi (>= 0)');
    }
    const shift = await ShiftService.closeShift(req.params.id, req.user.id, closingCashActual);
    res.json({ shift });
  })
);

// GET /api/shifts/:id/cash-movements — riwayat kas masuk/keluar shift ini
router.get(
  '/:id/cash-movements',
  asyncHandler(async (req, res) => {
    const movements = await CashMovementService.listCashMovements(req.params.id);
    res.json({ movements });
  })
);

// POST /api/shifts/:id/cash-movements — body: { movementType: 'cash_in'|'cash_out', amount, reason }
router.post(
  '/:id/cash-movements',
  asyncHandler(async (req, res) => {
    const { movementType, amount, reason } = req.body;
    const movement = await CashMovementService.recordCashMovement({
      shiftId: req.params.id,
      userId: req.user.id,
      movementType,
      amount,
      reason,
    });
    res.status(201).json({ movement });
  })
);

module.exports = router;
