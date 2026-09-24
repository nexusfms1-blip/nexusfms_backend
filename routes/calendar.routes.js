const express = require('express');
const router = express.Router();
const {
  getCalendar,
  dispatchJob,
} = require('../controllers/calendar.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');

// All internal calendar routes require JWT authentication
router.use(authenticateToken);

// Calendar Grid & Dispatch Endpoints
// Techs can view calendar, but only Admin and Office Team can dispatch jobs.
router.get('/', getCalendar);
router.post('/dispatch', authorizeRoles('OFFICE_ADMIN', 'OFFICE_TEAM'), dispatchJob);

module.exports = router;
