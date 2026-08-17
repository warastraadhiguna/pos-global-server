const express = require('express');
const UnitService = require('../services/UnitService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get(
  '/',
  requirePermission('units', 'view'),
  asyncHandler(async (req, res) => {
    const units = await UnitService.listUnits();
    res.json({ units });
  })
);

router.post(
  '/',
  requirePermission('units', 'create'),
  asyncHandler(async (req, res) => {
    const unit = await UnitService.createUnit(req.body);
    res.status(201).json({ unit });
  })
);

router.put(
  '/:id',
  requirePermission('units', 'edit'),
  asyncHandler(async (req, res) => {
    const unit = await UnitService.updateUnit(req.params.id, req.body);
    res.json({ unit });
  })
);

module.exports = router;
