const express = require('express');
const SupplierService = require('../services/SupplierService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

// GET /api/admin/suppliers — cuma yang aktif (dipakai dropdown form pembelian)
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const suppliers = await SupplierService.listActiveSuppliers();
    res.json({ suppliers });
  })
);

// GET /api/admin/suppliers/all — termasuk nonaktif
router.get(
  '/all',
  asyncHandler(async (req, res) => {
    const suppliers = await SupplierService.listAllSuppliers();
    res.json({ suppliers });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const supplier = await SupplierService.createSupplier(req.body);
    res.status(201).json({ supplier });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const supplier = await SupplierService.updateSupplier(req.params.id, req.body);
    res.json({ supplier });
  })
);

module.exports = router;
