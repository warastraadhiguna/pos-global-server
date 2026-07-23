const express = require('express');
const UnitService = require('../services/UnitService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const units = await UnitService.listUnits();
    res.json({ units });
  })
);

router.use(requireRole('admin'));

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const unit = await UnitService.createUnit(req.body);
    res.status(201).json({ unit });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const unit = await UnitService.updateUnit(req.params.id, req.body);
    res.json({ unit });
  })
);

module.exports = router;
