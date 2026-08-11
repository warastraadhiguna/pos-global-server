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

module.exports = router;
