const express = require('express');
const StockOpnameService = require('../services/StockOpnameService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const opnames = await StockOpnameService.listOpnames();
    res.json({ opnames });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const detail = await StockOpnameService.getOpnameDetail(req.params.id);
    res.json(detail);
  })
);

// POST /api/admin/stock-opnames — body: { notes? }
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const opname = await StockOpnameService.createOpnameSession({ notes: req.body.notes, createdBy: req.user.id });
    res.status(201).json({ opname });
  })
);

// PUT /api/admin/stock-opnames/:id/items/:itemId — body: { physicalQtyBase }
router.put(
  '/:id/items/:itemId',
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
  asyncHandler(async (req, res) => {
    const result = await StockOpnameService.finalizeOpname({ opnameId: req.params.id, userId: req.user.id });
    res.json(result);
  })
);

module.exports = router;
