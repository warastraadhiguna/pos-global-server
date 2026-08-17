const express = require('express');
const StockOpnameService = require('../services/StockOpnameService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get(
  '/',
  requirePermission('stock_opnames', 'view'),
  asyncHandler(async (req, res) => {
    const opnames = await StockOpnameService.listOpnames();
    res.json({ opnames });
  })
);

router.get(
  '/:id',
  requirePermission('stock_opnames', 'view'),
  asyncHandler(async (req, res) => {
    const detail = await StockOpnameService.getOpnameDetail(req.params.id);
    res.json(detail);
  })
);

// POST /api/admin/stock-opnames — body: { notes? }
router.post(
  '/',
  requirePermission('stock_opnames', 'create'),
  asyncHandler(async (req, res) => {
    const opname = await StockOpnameService.createOpnameSession({ notes: req.body.notes, createdBy: req.user.id });
    res.status(201).json({ opname });
  })
);

// PUT /api/admin/stock-opnames/:id/items/:itemId — body: { physicalQtyBase }
router.put(
  '/:id/items/:itemId',
  requirePermission('stock_opnames', 'edit'),
  asyncHandler(async (req, res) => {
    const item = await StockOpnameService.recordPhysicalCount({
      opnameId: req.params.id,
      itemId: req.params.itemId,
      physicalQtyBase: req.body.physicalQtyBase,
    });
    res.json({ item });
  })
);

// POST /api/admin/stock-opnames/:id/finalize
router.post(
  '/:id/finalize',
  requirePermission('stock_opnames', 'edit'),
  asyncHandler(async (req, res) => {
    const result = await StockOpnameService.finalizeOpname({ opnameId: req.params.id, userId: req.user.id });
    res.json(result);
  })
);

module.exports = router;
