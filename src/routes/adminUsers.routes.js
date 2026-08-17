const express = require('express');
const UserService = require('../services/UserService');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get(
  '/',
  requirePermission('users', 'view'),
  asyncHandler(async (req, res) => {
    const users = await UserService.listUsers();
    res.json({ users });
  })
);

router.post(
  '/',
  requirePermission('users', 'create'),
  asyncHandler(async (req, res) => {
    const user = await UserService.createUser(req.body, req.user.id);
    res.status(201).json({ user });
  })
);

router.put(
  '/:id',
  requirePermission('users', 'edit'),
  asyncHandler(async (req, res) => {
    const user = await UserService.updateUser(req.params.id, req.body, req.user.id);
    res.json({ user });
  })
);

// PUT /api/admin/users/:id/role — body: { roleId }. Digerbang izin
// 'roles.manage' (BUKAN 'users.edit') — pindah wewenang seseorang lebih
// sensitif daripada sekadar ubah nama/nonaktifkan/reset kredensial, jadi
// admin biasa yang cuma punya users.edit TIDAK bisa memindah role user.
router.put(
  '/:id/role',
  requirePermission('roles', 'manage'),
  asyncHandler(async (req, res) => {
    const user = await UserService.updateUserRole(req.params.id, req.body, req.user.id);
    res.json({ user });
  })
);

// DELETE /api/admin/users/:id — hapus PERMANEN (beda dari nonaktifkan).
// Ditolak (409) kalau user masih direferensikan data lain (transaksi,
// shift, login, dll — lihat catatan di UserService.deleteUser), kalau
// user superadmin aktif terakhir, atau kalau mencoba menghapus akun
// sendiri yang sedang login.
router.delete(
  '/:id',
  requirePermission('users', 'delete'),
  asyncHandler(async (req, res) => {
    await UserService.deleteUser(req.params.id, req.user.id);
    res.status(204).end();
  })
);

module.exports = router;
