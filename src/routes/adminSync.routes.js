const express = require('express');
const SyncService = require('../services/SyncService');
const SyncSettingsService = require('../services/SyncSettingsService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/admin/sync — { settings, salesPending, salesReturnsPending }
// Token & URL pusat SENGAJA tidak pernah dikembalikan di sini — selalu dari
// .env, tidak pernah lewat DB/UI (lihat catatan di SyncService.js).
router.get(
  '/',
  requirePermission('sync', 'view'),
  asyncHandler(async (req, res) => {
    const [settings, pending] = await Promise.all([SyncSettingsService.getSettings(), SyncService.getPendingCounts()]);
    res.json({ settings, ...pending });
  })
);

// PUT /api/admin/sync/settings — body: { enabled?, intervalMinutes?, batchSize? }
router.put(
  '/settings',
  requirePermission('sync', 'manage'),
  asyncHandler(async (req, res) => {
    const settings = await SyncSettingsService.updateSettings({ ...req.body, userId: req.user.id });
    res.json({ settings });
  })
);

// POST /api/admin/sync/run — jalankan satu batch sync sekarang (manual)
router.post(
  '/run',
  requirePermission('sync', 'manage'),
  asyncHandler(async (req, res) => {
    const result = await SyncService.runSync();
    res.status(201).json({ result });
  })
);

module.exports = router;
