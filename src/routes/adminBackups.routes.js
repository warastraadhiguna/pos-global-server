const express = require('express');
const BackupService = require('../services/BackupService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/admin/backups — { settings, history }
router.get(
  '/',
  requirePermission('backups', 'view'),
  asyncHandler(async (req, res) => {
    const [settings, history] = await Promise.all([BackupService.getSettings(), BackupService.listBackups()]);
    res.json({ settings, history });
  })
);

// PUT /api/admin/backups/settings — body: { autoEnabled?, scheduleTime?, retentionCount? }
router.put(
  '/settings',
  requirePermission('backups', 'manage'),
  asyncHandler(async (req, res) => {
    const settings = await BackupService.updateSettings({ ...req.body, userId: req.user.id });
    res.json({ settings });
  })
);

// POST /api/admin/backups/run — jalankan backup sekarang (manual)
router.post(
  '/run',
  requirePermission('backups', 'manage'),
  asyncHandler(async (req, res) => {
    const backup = await BackupService.runBackup({ triggeredBy: 'manual', userId: req.user.id });
    res.status(201).json({ backup });
  })
);

// GET /api/admin/backups/:id/download
router.get(
  '/:id/download',
  requirePermission('backups', 'manage'),
  asyncHandler(async (req, res) => {
    const { filePath, filename } = await BackupService.getBackupFilePath(req.params.id);
    res.download(filePath, filename);
  })
);

// DELETE /api/admin/backups/:id
router.delete(
  '/:id',
  requirePermission('backups', 'manage'),
  asyncHandler(async (req, res) => {
    await BackupService.deleteBackup(req.params.id);
    res.json({ success: true });
  })
);

module.exports = router;
