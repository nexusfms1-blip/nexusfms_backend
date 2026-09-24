const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload.middleware');
const {
  getPublicRequestByToken,
  submitPublicQuoteUpload,
  submitPublicBooking,
  generatePublicRequestLink,
  getPublicJobCompletionReport,
} = require('../controllers/public.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const { getPublicBookingAvailableSlots } = require('../controllers/calendar.controller');

// Public Unauthenticated Endpoints (For Resident Booking, Photo/Video Upload Portals & Job Completion Reports)
router.get('/request/:token', getPublicRequestByToken);
router.get('/booking/:token/available-slots', getPublicBookingAvailableSlots);
router.post('/quote-request/:token/upload', upload.array('mediaFiles', 10), submitPublicQuoteUpload);
router.post('/booking/:token/confirm', submitPublicBooking);
router.get('/jobs/:id/report', getPublicJobCompletionReport);

// Protected Admin Endpoint to Generate Public Links
router.post('/jobs/:id/generate-link', authenticateToken, generatePublicRequestLink);

module.exports = router;
