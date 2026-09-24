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
  initScheduler();
  initBookingScheduler();
});
