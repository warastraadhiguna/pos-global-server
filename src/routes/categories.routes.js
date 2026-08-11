const express = require('express');
const CategoryService = require('../services/CategoryService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/categories — semua user login boleh baca (dipakai POS & admin)
router.get(
  '/',
  requirePermission('categories', 'view'),
  asyncHandler(async (req, res) => {
    const categories = await CategoryService.listCategories();
    res.json({ categories });
  })
);

router.post(
  '/',
  requirePermission('categories', 'create'),
  asyncHandler(async (req, res) => {
    const category = await CategoryService.createCategory(req.body);
    res.status(201).json({ category });
  })
);

router.put(
  '/:id',
  requirePermission('categories', 'edit'),
  asyncHandler(async (req, res) => {
    const category = await CategoryService.updateCategory(req.params.id, req.body);
    res.json({ category });
  })
);

module.exports = router;
