const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const {
  uploadSamplePdf,
  getTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  testParse,
  createJobFromPdf,
} = require('../controllers/workOrderTemplate.controller');

const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');

// Configure Multer storage for PDF uploads
const uploadDir = path.join(__dirname, '../uploads/templates');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `template-${uniqueSuffix}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
    cb(null, true);
  } else {
    cb(new Error('Only PDF files are supported for work order templates.'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB max limit
});

// Protect all template routes: JWT + Office Admin only
router.use(authenticateToken);
router.use(authorizeRoles('OFFICE_ADMIN'));

// Wraps multer so upload errors (wrong type / too large) return a clean 400 instead of a 500
const handleUpload = (req, res, next) => {
  upload.single('pdf')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'PDF is too large (max 25 MB).' : err.message;
      return res.status(400).json({ success: false, message });
    }
    next();
  });
};

// PDF Upload & Extraction operations (declared before /:id routes)
router.post('/upload-sample', handleUpload, uploadSamplePdf);
router.post('/test-parse', handleUpload, testParse);
router.post('/create-job', createJobFromPdf);

// Template CRUD
router.get('/', getTemplates);
router.get('/:id', getTemplateById);
router.post('/', createTemplate);
router.put('/:id', updateTemplate);
router.delete('/:id', deleteTemplate);

module.exports = router;
