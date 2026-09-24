const express = require('express');
const router = express.Router();
const photoUpload = require('../middleware/photoUpload.middleware');
const upload = require('../middleware/upload.middleware');
const {
  getMyAssignedJobs,
  getMyAssignedJobById,
  submitWorkReport,
  uploadCompletionPhotos,
  markJobComplete,
  getJobCompletionEvidence,
  updateCompletedJobEvidence,
  getStaffInventoryItems,
  deleteCompletionMedia,
} = require('../controllers/staffCompletion.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');

// All staff completion routes require JWT authentication
router.use(authenticateToken);

// Assigned Work Orders List & Details
router.get('/my-jobs', getMyAssignedJobs);
router.get('/my-jobs/:id', getMyAssignedJobById);

// Completion Report Submission, Photo Proof Uploads & Explicit Completion Action
router.post('/jobs/:id/report', submitWorkReport);
router.post('/jobs/:id/photos', photoUpload.array('photos', 5), uploadCompletionPhotos);
router.put('/jobs/:id/complete', markJobComplete);

// View completion evidence (report, photos, materials)
router.get('/jobs/:id/completion-evidence', getJobCompletionEvidence);
router.get('/jobs/:id/completion', getJobCompletionEvidence);

// Edit completion evidence for an already-completed job (own jobs only)
router.put(
  '/jobs/:id/completion-evidence',
  authorizeRoles('MAINTENANCE_STAFF'),
  upload.fields([{ name: 'beforePhotos' }, { name: 'afterPhotos' }, { name: 'receipts' }]),
  updateCompletedJobEvidence
);

// Delete completed job completion media item
router.delete(
  '/media/:mediaId',
  authorizeRoles('MAINTENANCE_STAFF'),
  deleteCompletionMedia
);

// Inventory picker for technician materials selection
router.get('/inventory', authorizeRoles('MAINTENANCE_STAFF', 'OFFICE_ADMIN'), getStaffInventoryItems);

module.exports = {
  staffCompletionRouter: router,
  getJobCompletionEvidence,
};
