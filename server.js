// Set UK Timezone for all date calculations and schedulers
process.env.TZ = process.env.TZ || 'Europe/London';
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const { testDbConnection } = require('./config/db');

// Load Environment Variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware Configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'Range', 'Cache-Control'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
}));
app.options('*', cors());

// Route-specific high-limit body parser for inbound webhooks (supports Base64 email attachments)
app.use('/api/v1/webhooks', express.json({ limit: '50mb' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static uploads directory for media/photos
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads', 'customer_media')));
app.use('/uploads/customer_media', express.static(path.join(__dirname, 'uploads', 'customer_media')));

// Dedicated fallback for missing static upload files (e.g. legacy files before Cloudinary CDN migration)
app.use('/uploads', (req, res) => {
  const isImageReq = req.path.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i) || (req.headers.accept && req.headers.accept.includes('image'));
  if (isImageReq) {
    const svgPlaceholder = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400" fill="#f8fafc">
  <rect width="600" height="400" fill="#f1f5f9"/>
  <rect x="20" y="20" width="560" height="360" rx="12" fill="#ffffff" stroke="#cbd5e1" stroke-width="2" stroke-dasharray="6 6"/>
  <circle cx="300" cy="155" r="42" fill="#fee2e2"/>
  <path d="M285 155 L300 135 L315 155" stroke="#ef4444" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="315" cy="140" r="4" fill="#ef4444"/>
  <text x="300" y="235" font-family="system-ui, -apple-system, sans-serif" font-size="19" font-weight="bold" fill="#0f172a" text-anchor="middle">Photo File Unavailable</text>
  <text x="300" y="265" font-family="system-ui, -apple-system, sans-serif" font-size="13" fill="#64748b" text-anchor="middle">This photo was uploaded locally prior to Cloud CDN migration.</text>
  <text x="300" y="290" font-family="system-ui, -apple-system, sans-serif" font-size="12" fill="#94a3b8" text-anchor="middle">All new photos are permanently stored on Cloudinary CDN.</text>
</svg>`;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(404).send(svgPlaceholder);
  }

  res.status(404).json({
    success: false,
    error: 'MEDIA_NOT_FOUND',
    message: `The requested media file was not found on the server (${req.originalUrl}). Photos uploaded prior to Cloud CDN migration were stored on ephemeral server storage.`,
  });
});

// Import Routes
const authRoutes = require('./routes/auth.routes');
const tenantRoutes = require('./routes/tenant.routes');
const staffRoutes = require('./routes/staff.routes');
const jobRoutes = require('./routes/job.routes');
const publicRoutes = require('./routes/public.routes');
const calendarRoutes = require('./routes/calendar.routes');
const quoteRequestRoutes = require('./routes/quoteRequest.routes');
const bookingLinkRoutes = require('./routes/bookingLink.routes');
const notificationRoutes = require('./routes/notification.routes');
const { staffCompletionRouter } = require('./routes/staffCompletion.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const settingsRoutes = require('./routes/settings.routes');
const inventoryRoutes = require('./routes/inventory.routes');
const webhookRoutes = require('./routes/webhook.routes');
const aiRoutes = require('./routes/ai.routes');
const mapsRoutes = require('./routes/maps.routes');
const workOrderTemplateRoutes = require('./routes/workOrderTemplate.routes');

// Health Check Endpoint (Phase 1)
app.get('/api/v1/health', async (req, res) => {
  const isDbConnected = await testDbConnection();
  res.status(200).json({
    status: 'online',
    service: 'Nexus FMS Backend API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    database: isDbConnected ? 'connected' : 'disconnected (pending phpMyAdmin startup)',
  });
});

// API v1 Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/tenants', tenantRoutes);
app.use('/api/v1/staff', staffCompletionRouter);
app.use('/api/v1/staff', staffRoutes);
app.use('/api/v1/jobs', jobRoutes);
app.use('/api/v1/public', publicRoutes);
app.use('/api/v1/calendar', calendarRoutes);
app.use('/api/v1/quote-requests', quoteRequestRoutes);
app.use('/api/v1/booking-links', bookingLinkRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/settings', settingsRoutes);
app.use('/api/v1/inventory', inventoryRoutes);
app.use('/api/v1/webhooks', webhookRoutes);
app.use('/api/v1/ai', aiRoutes);
app.use('/api/v1/maps', mapsRoutes);
app.use('/api/v1/work-order-templates', workOrderTemplateRoutes);

// Global 404 Route Handler
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    message: `API Route Not Found: [${req.method}] ${req.originalUrl}`,
  });
});

// Global Error Handler Middleware
app.use((err, req, res, next) => {
  const isMulterOrFileValidationError = err.message && (
    err.message.includes('Invalid file type') ||
    err.message.includes('File too large') ||
    err.name === 'MulterError'
  );

  const statusCode = isMulterOrFileValidationError ? 400 : (err.status || 500);

  if (!isMulterOrFileValidationError) {
    console.error('[Global Server Error]:', err.stack || err.message);
  }

  res.status(statusCode).json({
    success: false,
    message: err.message || 'Internal Server Error',
  });
});

// Start Express Server & Test DB Connection
app.listen(PORT, async () => {
  console.log(`=======================================================`);
  console.log(`🚀 Nexus FMS Backend Server running on http://localhost:${PORT}`);
  console.log(`📡 Health Check URL: http://localhost:${PORT}/api/v1/health`);
  console.log(`=======================================================`);
  await testDbConnection();
  
  // Apply safe, automatic database schema migrations (e.g. pipeline_stage VARCHAR support)
  const { runAutoMigrations } = require('./config/autoMigrate');
  await runAutoMigrations();
  
  // Initialize Background Schedulers
  const { initScheduler } = require('./scheduler/photoReminderJob');
  const { initBookingScheduler } = require('./scheduler/bookingReminderJob');
  const { initTenantNoReplyScheduler } = require('./scheduler/tenantNoReplyEscalationJob');
  initScheduler();
  initBookingScheduler();
  initTenantNoReplyScheduler();
  const { initContractorPhotoReminderScheduler } = require('./scheduler/contractorPhotoReminderJob');
  initContractorPhotoReminderScheduler();
});
