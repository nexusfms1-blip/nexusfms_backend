const express = require('express');
const router = express.Router();
const { login, getMe } = require('../controllers/auth.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');

// Public Auth Routes
router.post('/login', login);

// Authenticated Routes
router.get('/me', authenticateToken, getMe);

// Role Authorization Testing Endpoint (Office Admin Only)
router.get('/admin-only-test', authenticateToken, authorizeRoles('OFFICE_ADMIN'), (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Authorized: Access granted to Office Admin resource.',
    user: req.user,
  });
});

// Role Authorization Testing Endpoint (Maintenance Staff Only)
router.get('/staff-only-test', authenticateToken, authorizeRoles('MAINTENANCE_STAFF'), (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Authorized: Access granted to Maintenance Staff resource.',
    user: req.user,
  });
});

module.exports = router;
