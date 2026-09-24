const crypto = require('crypto');
const { pool } = require('../config/db');

// @desc    Get all quote photo requests
// @route   GET /api/v1/quote-requests
// @access  Private (JWT Required)
const getQuoteRequests = async (req, res, next) => {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    // Get all quote requests with work order details
    const [rows] = await pool.query(`
      SELECT 
        q.id,
        q.secure_token as secureToken,
        q.photo_instructions as photoInstructions,
        q.max_photos as maxPhotos,
        q.status,
        q.expires_at as expiresAt,
        q.resident_description_report as residentComments,
        q.submitted_at as submittedAt,
        q.created_at as createdAt,
        q.last_photo_reminder_at as lastPhotoReminderAt,
        q.photo_reminder_count as photoReminderCount,
        w.resident_name as tenantName,
        w.property_address as address,
        w.description as description,
        w.resident_id as tenantId
      FROM quote_requests q
      JOIN work_orders w ON q.work_order_id = w.id
      ORDER BY q.created_at DESC
    `);

    // For each request, fetch its uploaded media files
    const quoteRequests = [];
    for (const row of rows) {
      const [mediaRows] = await pool.query(
        'SELECT id, file_name, file_path, file_size_bytes, media_type FROM customer_media_uploads WHERE quote_request_id = ?',
        [row.id]
      );

      quoteRequests.push({
        ...row,
        photos: mediaRows.map(m => ({
          id: m.id,
          name: m.file_name,
          previewUrl: `${baseUrl}${m.file_path}`,
          sizeMB: m.file_size_bytes ? (m.file_size_bytes / (1024 * 1024)).toFixed(2) : '0',
          type: m.media_type
        }))
      });
    }

    res.status(200).json(quoteRequests);
  } catch (err) {
    next(err);
  }
};

// @desc    Generate a new quote photo/video upload link
// @route   POST /api/v1/quote-requests
// @access  Private (JWT Required)
const generateQuoteRequest = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const {
      tenantId,
      description,
      photoInstructions,
      maxPhotos,
      linkExpiryDays,
      internalNotes
    } = req.body;

    if (!tenantId || !description) {
      connection.release();
      return res.status(400).json({
        success: false,
        message: 'Validation Error: tenantId and description are required.'
      });
    }

    // 1. Fetch resident details
    const [resRows] = await connection.query('SELECT * FROM residents WHERE id = ?', [tenantId]);
    if (resRows.length === 0) {
      connection.release();
      return res.status(404).json({
        success: false,
        message: `Resident not found with ID ${tenantId}`
      });
    }
    const resident = resRows[0];

    // 2. Generate unique job number & secure token
    const randomNumber = Math.floor(1000 + Math.random() * 9000);
    const jobNumber = `JOB-2026-${randomNumber}`;
    const secureToken = `tok_${crypto.randomBytes(16).toString('hex')}`;
    const expiryDays = parseInt(linkExpiryDays || '7', 10);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiryDays);

    await connection.beginTransaction();

    // 3. Create work order
    const [jobResult] = await connection.query(
      `INSERT INTO work_orders (
        job_number, title, resident_id, resident_name, contact_phone, contact_email,
        property_address, description, duration_hours, pipeline_stage,
        secure_token, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobNumber,
        description,
        resident.id,
        resident.full_name,
        resident.phone,
        resident.email,
        resident.address,
        description,
        1.50,
        'Quotes',
        secureToken,
        req.user.id
      ]
    );

    const workOrderId = jobResult.insertId;

    // 4. Create quote request
    const [quoteResult] = await connection.query(
      `INSERT INTO quote_requests (
        work_order_id, secure_token, photo_instructions, max_photos, status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        workOrderId,
        secureToken,
        photoInstructions || 'Please upload clear photos showing the issue.',
        parseInt(maxPhotos || '5', 10),
        'PHOTO_REQUEST_PENDING',
        expiresAt
      ]
    );

    await connection.commit();
    connection.release();

    const { triggerAutoPhotoRequest } = require('../services/quoteRequest.service');
    triggerAutoPhotoRequest(workOrderId).catch(err => {
      console.warn('[generateQuoteRequest] triggerAutoPhotoRequest warn:', err.message);
    });

    const frontendOrigin = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
    const publicUrl = `${frontendOrigin}/quote-request/${secureToken}`;
    const tenantName = resident.full_name;
    const address = resident.address;

    const quoteReqObj = {
      id: quoteResult.insertId,
      secureToken,
      tenantId: resident.id,
      tenantName,
      address,
      description,
      photoInstructions: photoInstructions || 'Please upload clear photos showing the issue.',
      maxPhotos: parseInt(maxPhotos || '5', 10),
      expiresAt: expiresAt.toISOString().split('T')[0],
      status: 'PHOTO_REQUEST_PENDING',
      photos: [],
      residentComments: '',
      createdAt: new Date().toISOString().split('T')[0]
    };

    const smsMessage = `Hi ${tenantName}, please upload photos for your maintenance request "${description}" here: ${publicUrl}`;
    const emailMessage = `Dear ${tenantName},\n\nTo prepare a maintenance quote for your residence at ${address}, please upload photos of the requested work:\n\nJob: ${description}\nInstructions: ${quoteReqObj.photoInstructions}\n\nUpload Photos Link:\n${publicUrl}\n\nThank you,\nAP Maintenance Team`;

    res.status(201).json({
      success: true,
      quoteRequest: quoteReqObj,
      publicUrl,
      smsMessage,
      emailMessage
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    next(err);
  }
};

// @desc    Update quote request status
// @route   PUT /api/v1/quote-requests/:token/status
// @access  Private (JWT Required)
const updateQuoteRequestStatus = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { status } = req.body; // e.g. QUOTE_PENDING, QUOTE_COMPLETED, QUOTE_CANCELLED

    const [quoteRows] = await pool.query('SELECT * FROM quote_requests WHERE secure_token = ?', [token]);
    if (quoteRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Quote request not found.'
      });
    }

    const request = quoteRows[0];

    // Status map if any validation is needed
    await pool.query(
      'UPDATE quote_requests SET status = ? WHERE id = ?',
      [status, request.id]
    );

    res.status(200).json({
      success: true,
      message: 'Quote request status updated successfully.'
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getQuoteRequests,
  generateQuoteRequest,
  updateQuoteRequestStatus
};
