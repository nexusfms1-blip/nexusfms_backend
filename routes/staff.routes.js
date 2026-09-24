const express = require('express');
const router = express.Router();
const {
  getStaff,
  getStaffById,
  createStaff,
  updateStaff,
  deleteStaff,
  savePushToken,
} = require('../controllers/staff.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');

const {
  getMyAssignedJobs,
  getMyAssignedJobById,
  submitWorkReport,
  uploadCompletionPhotos,
  markJobComplete,
} = require('../controllers/staffCompletion.controller');
const photoUpload = require('../middleware/photoUpload.middleware');

// All staff routes require JWT authentication
router.use(authenticateToken);

// Device Push Token registration
router.put('/push-token', savePushToken);

// Technician Assigned Work Orders Endpoints (Must be mounted before /:id)
router.get('/my-jobs', getMyAssignedJobs);
router.get('/my-jobs/:id', getMyAssignedJobById);
router.post('/jobs/:id/report', submitWorkReport);
router.post('/jobs/:id/photos', photoUpload.array('photos', 5), uploadCompletionPhotos);
router.put('/jobs/:id/complete', markJobComplete);

// Read Endpoints (Accessible by Office Admin & Maintenance Staff)
router.get('/', authorizeRoles('OFFICE_ADMIN', 'MAINTENANCE_STAFF', 'OFFICE_TEAM'), getStaff);
router.get('/:id', authorizeRoles('OFFICE_ADMIN', 'MAINTENANCE_STAFF', 'OFFICE_TEAM'), getStaffById);

// Write / Management Endpoints
router.post('/', authorizeRoles('OFFICE_ADMIN', 'OFFICE_TEAM'), photoUpload.single('avatar'), createStaff);
router.put('/:id', authorizeRoles('OFFICE_ADMIN', 'OFFICE_TEAM', 'MAINTENANCE_STAFF'), photoUpload.single('avatar'), updateStaff);
router.delete('/:id', authorizeRoles('OFFICE_ADMIN', 'OFFICE_TEAM'), deleteStaff);

module.exports = router;
