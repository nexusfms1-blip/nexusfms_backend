const path = require('path');
const fs = require('fs');
const multer = require('multer');

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure Storage Engine
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `file-${uniqueSuffix}${ext}`);
  },
});

// Allowed MIME types including mobile formats and documents (receipts)
const allowedMimeTypes = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/pjpeg',
  'image/x-png',
  'image/bmp',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const allowedExtensions = [
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.bmp',
  '.mp4', '.webm', '.mov', '.avi',
  '.pdf', '.doc', '.docx',
];

// File Filter for Photos, Videos & Receipt Documents
const fileFilter = (req, file, cb) => {
  const mime = (file.mimetype || '').toLowerCase();
  const ext = path.extname(file.originalname || '').toLowerCase();

  // 1. Direct match by MIME (all images, videos, and allowed documents)
  if (mime.startsWith('image/') || mime.startsWith('video/') || allowedMimeTypes.includes(mime)) {
    return cb(null, true);
  }

  // 2. Mobile fallback: If Android sends application/octet-stream or generic type, verify extension
  if (allowedExtensions.includes(ext)) {
    return cb(null, true);
  }

  cb(new Error(`Invalid file type '${file.mimetype}'. Only images, documents (PDF), and videos are permitted.`), false);
};

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
  },
  fileFilter,
});

module.exports = upload;
