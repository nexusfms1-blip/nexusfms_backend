const express = require('express');
const router = express.Router();
const { getDashboardStats } = require('../controllers/dashboard.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

// All dashboard routes require JWT authentication
router.use(authenticateToken);

// GET /api/v1/dashboard/stats — aggregated stats for the Maintenance Dashboard
router.get('/stats', getDashboardStats);

module.exports = router;
