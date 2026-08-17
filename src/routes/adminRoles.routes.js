const express = require('express');
const RoleService = require('../services/RoleService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Seluruh route di sini digerbang izin modul 'roles' — praktis cuma
// superadmin (bypass) yang punya, karena role_permissions SENGAJA tidak
// pernah mengisi modul 'roles' utk role manapun (lihat seed.js). Kalau
// superadmin nanti sengaja memberi izin 'roles' ke role lain lewat modul
// ini sendiri, role itu juga akan bisa masuk sini — itu memang dirancang
// begitu (permission-driven, bukan hardcode nama role).
router.use(requireAuth);

// GET /api/admin/roles — daftar role + ringkasan (jumlah izin & user)
router.get(
  '/',
  requirePermission('roles', 'view'),
  asyncHandler(async (req, res) => {
    const roles = await RoleService.listRoles();
    res.json({ roles });
  })
);

// GET /api/admin/roles/permissions-catalog — seluruh katalog modul+aksi,
// dipakai render kolom matriks centang izin.
router.get(
  '/permissions-catalog',
  requirePermission('roles', 'view'),
  asyncHandler(async (req, res) => {
    const permissions = await RoleService.getPermissionsCatalog();
    res.json({ permissions });
  })
);

// GET /api/admin/roles/:id/permissions — permissionId yang sedang
// diberikan ke role ini (dipakai centang awal matriks).
router.get(
  '/:id/permissions',
  requirePermission('roles', 'view'),
  asyncHandler(async (req, res) => {
    const permissionIds = await RoleService.getRolePermissionIds(req.params.id);
    res.json({ permissionIds });
  })
);

// POST /api/admin/roles — body: { name }
router.post(
  '/',
  requirePermission('roles', 'manage'),
  asyncHandler(async (req, res) => {
    const role = await RoleService.createRole(req.body, req.user.id);
    res.status(201).json({ role });
  })
);

// PUT /api/admin/roles/:id — body: { name }
router.put(
  '/:id',
  requirePermission('roles', 'manage'),
  asyncHandler(async (req, res) => {
    const role = await RoleService.updateRoleName(req.params.id, req.body, req.user.id);
    res.json({ role });
  })
);

// PUT /api/admin/roles/:id/permissions — body: { permissionIds: [] } — set
// LENGKAP (bukan partial toggle), lihat catatan di RoleService.
router.put(
  '/:id/permissions',
  requirePermission('roles', 'manage'),
  asyncHandler(async (req, res) => {
    const role = await RoleService.updateRolePermissions(req.params.id, req.body.permissionIds, req.user.id);
    res.json({ role });
  })
);

// PUT /api/admin/roles/:id/cashier-flag — body: { canLoginPos: boolean }.
// Nyalakan/matikan boleh-login-PIN-di-mesin-kasir utk role ini. Ditolak
// kalau role superadmin, atau (saat menyalakan) kalau role punya izin di
// luar cakupan aksi kasir — lihat RoleService.POS_ALLOWED_PERMISSIONS.
router.put(
  '/:id/cashier-flag',
  requirePermission('roles', 'manage'),
  asyncHandler(async (req, res) => {
    const role = await RoleService.updateRoleCashierFlag(req.params.id, req.body.canLoginPos, req.user.id);
    res.json({ role });
  })
);

// DELETE /api/admin/roles/:id — ditolak kalau masih dipakai user, atau
// kalau target role superadmin.
router.delete(
  '/:id',
  requirePermission('roles', 'manage'),
  asyncHandler(async (req, res) => {
    await RoleService.deleteRole(req.params.id, req.user.id);
    res.status(204).end();
  })
);

module.exports = router;
