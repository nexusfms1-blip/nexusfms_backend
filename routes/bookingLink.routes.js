const express = require('express');
const router = express.Router();
const {
  getBookingRequests,
  generateBookingLink,
  updateBookingRequest,
  deleteBookingRequest
} = require('../controllers/bookingLink.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');

// All endpoints here require authentication and Admin role
router.use(authenticateToken);
router.use(authorizeRoles('OFFICE_ADMIN', 'OFFICE_TEAM'));

router.get('/', getBookingRequests);
router.post('/', generateBookingLink);
router.put('/:id', updateBookingRequest);
router.delete('/:id', deleteBookingRequest);

module.exports = router;
