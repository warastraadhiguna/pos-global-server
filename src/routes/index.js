const express = require('express');
const authRoutes = require('./auth.routes');
const productsRoutes = require('./products.routes');
const shiftsRoutes = require('./shifts.routes');
const salesRoutes = require('./sales.routes');
const priceLevelsRoutes = require('./priceLevels.routes');
const categoriesRoutes = require('./categories.routes');
const unitsRoutes = require('./units.routes');
const adminProductsRoutes = require('./adminProducts.routes');
const adminReportsRoutes = require('./adminReports.routes');
const cashDenominationsRoutes = require('./cashDenominations.routes');
const adminUsersRoutes = require('./adminUsers.routes');
const paymentMethodsRoutes = require('./paymentMethods.routes');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pos-branch-server', time: new Date().toISOString() });
});

router.use('/auth', authRoutes);
router.use('/products', productsRoutes);
router.use('/shifts', shiftsRoutes);
router.use('/sales', salesRoutes);
router.use('/price-levels', priceLevelsRoutes);
router.use('/categories', categoriesRoutes);
router.use('/units', unitsRoutes);
router.use('/admin/products', adminProductsRoutes);
router.use('/admin/reports', adminReportsRoutes);
router.use('/cash-denominations', cashDenominationsRoutes);
router.use('/admin/users', adminUsersRoutes);
router.use('/payment-methods', paymentMethodsRoutes);

module.exports = router;
