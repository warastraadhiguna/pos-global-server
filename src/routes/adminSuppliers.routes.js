const express = require('express');
const SupplierService = require('../services/SupplierService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/admin/suppliers — cuma yang aktif (dipakai dropdown form pembelian)
router.get(
  '/',
  requirePermission('suppliers', 'view'),
  asyncHandler(async (req, res) => {
    const suppliers = await SupplierService.listActiveSuppliers();
    res.json({ suppliers });
  })
);

// GET /api/admin/suppliers/all — termasuk nonaktif
router.get(
  '/all',
  requirePermission('suppliers', 'view'),
  asyncHandler(async (req, res) => {
    const suppliers = await SupplierService.listAllSuppliers();
    res.json({ suppliers });
  })
);

router.post(
  '/',
  requirePermission('suppliers', 'create'),
  asyncHandler(async (req, res) => {
    const supplier = await SupplierService.createSupplier(req.body);
    res.status(201).json({ supplier });
  })
);

router.put(
  '/:id',
  requirePermission('suppliers', 'edit'),
  asyncHandler(async (req, res) => {
    const supplier = await SupplierService.updateSupplier(req.params.id, req.body);
    res.json({ supplier });
  })
);

module.exports = router;
