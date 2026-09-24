const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const { getSmartSuggestion } = require('../controllers/maps.controller');

// @route   POST /api/v1/maps/smart-suggestion
// @desc    Get the best staff member to assign based on proximity to a job address
// @access  Private (JWT Required)
router.post('/smart-suggestion', authenticateToken, getSmartSuggestion);

module.exports = router;
