const express = require('express');
const router = express.Router();
const {
  getQuoteRequests,
  generateQuoteRequest,
  updateQuoteRequestStatus
} = require('../controllers/quoteRequest.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');

// All endpoints here require authentication and Admin role
router.use(authenticateToken);
router.use(authorizeRoles('OFFICE_ADMIN', 'OFFICE_TEAM'));

router.get('/', getQuoteRequests);
router.post('/', generateQuoteRequest);
router.put('/:token/status', updateQuoteRequestStatus);

module.exports = router;
