const express = require('express');
const router = express.Router();
const {
  getJobs,
  getJobById,
  createJob,
  moveJobStage,
  updateJobStatus,
  deleteJob,
  cancelJob,
  getAssignmentHistory,
  resendQuoteRequest,
} = require('../controllers/job.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');

// All work order routes require JWT authentication
router.use(authenticateToken);

const { getJobCompletionEvidence, completeJobAtomic } = require('../controllers/staffCompletion.controller');
const upload = require('../middleware/upload.middleware');

// Read Endpoints (Office Admin, Office Team & Maintenance Staff)
router.get('/', getJobs);
router.get('/:id', getJobById);
router.get('/:id/assignment-history', authorizeRoles('OFFICE_ADMIN', 'OFFICE_TEAM', 'MAINTENANCE_STAFF'), getAssignmentHistory);
router.get('/:id/completion-evidence', authorizeRoles('OFFICE_ADMIN', 'OFFICE_TEAM', 'MAINTENANCE_STAFF'), getJobCompletionEvidence);

// Create Endpoint (Office Admin & Office Team)
router.post('/', authorizeRoles('OFFICE_ADMIN', 'OFFICE_TEAM'), createJob);

// Resend Quote Photo Request (Office Admin & Office Team)
router.post('/:id/resend-quote-request', authorizeRoles('OFFICE_ADMIN', 'OFFICE_TEAM'), resendQuoteRequest);

// Move Stage (Office Admin, Office Team & Maintenance Staff)
router.put('/:id/stage', authorizeRoles('OFFICE_ADMIN', 'OFFICE_TEAM', 'MAINTENANCE_STAFF'), moveJobStage);

// Update Status/Schedule (Office Admin, Office Team & Maintenance Staff)
router.put('/:id/status', updateJobStatus);

// Cancel/Reschedule Endpoint (Maintenance Staff Only)
router.post('/:id/cancel', authorizeRoles('MAINTENANCE_STAFF'), upload.single('proof'), cancelJob);

// Atomic Completion Endpoint (Maintenance Staff Only)
router.post(
  '/:id/complete',
  authorizeRoles('MAINTENANCE_STAFF'),
  upload.fields([{ name: 'beforePhotos' }, { name: 'afterPhotos' }, { name: 'receipts' }]),
  completeJobAtomic
);

// Delete Endpoint (Office Admin & Office Team)
router.delete('/:id', authorizeRoles('OFFICE_ADMIN', 'OFFICE_TEAM'), deleteJob);

module.exports = router;

