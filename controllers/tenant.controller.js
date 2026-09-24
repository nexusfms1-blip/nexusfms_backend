const { pool } = require('../config/db');
const notificationService = require('../services/notification.service');
const { uploadMediaFile } = require('../services/cloudinary.service');
const { sendSms } = require('../services/notification/providers/sms.provider');
const { sendEmail } = require('../services/notification/providers/email.provider');
const { dispatchN8NWebhook } = require('../services/webhook.service');
const { normalizePhoneNumber } = require('../utils/phoneNormalizer');

// @desc    Get all residents / tenants (supports optional search filter)
// @route   GET /api/v1/tenants
// @access  Private (JWT Required)
const getTenants = async (req, res, next) => {
  try {
    const { search } = req.query;
    let sql = 'SELECT id, full_name, phone, email, address, notes, avatar_url, document_url, created_at, updated_at FROM residents';
    const queryParams = [];

    if (search && search.trim() !== '') {
      const term = `%${search.trim()}%`;
      sql += ' WHERE full_name LIKE ? OR phone LIKE ? OR email LIKE ? OR address LIKE ?';
      queryParams.push(term, term, term, term);
    }

    sql += ' ORDER BY created_at DESC';

    const [rows] = await pool.query(sql, queryParams);

    res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get single resident by ID
// @route   GET /api/v1/tenants/:id
// @access  Private (JWT Required)
const getTenantById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      'SELECT id, full_name, phone, email, address, notes, avatar_url, document_url, created_at, updated_at FROM residents WHERE id = ?',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Resident not found with ID ${id}`,
      });
    }

    res.status(200).json({
      success: true,
      data: rows[0],
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Create new resident / tenant
// @route   POST /api/v1/tenants
// @access  Private (Office Admin & Staff)
const createTenant = async (req, res, next) => {
  try {
    const { full_name, name, phone, email, address, notes } = req.body;
    
    // Support both full_name and name keys from frontend
    const residentName = (full_name || name || '').trim();
    const rawPhone = (phone || '').trim();
    const residentPhone = normalizePhoneNumber(rawPhone);
    const residentAddress = (address || '').trim();
    const residentEmail = email && email.trim() !== '' ? email.trim() : null;
    const residentNotes = notes && notes.trim() !== '' ? notes.trim() : null;

    // Contact Validation: Full Name, Phone, and Address are STRICTLY REQUIRED
    if (!residentName) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Full Name is required.',
      });
    }

    if (!residentPhone) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Phone Number is required.',
      });
    }

    if (!residentAddress) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Property Address is required.',
      });
    }

    let avatarPath = req.body.avatarUrl || req.body.avatar_url || null;
    if (req.files?.avatar?.[0]) {
      const upRes = await uploadMediaFile(req.files.avatar[0], 'avatars');
      avatarPath = upRes?.url || `/uploads/${req.files.avatar[0].filename}`;
    }

    let documentPath = req.body.documentUrl || req.body.document_url || null;
    if (req.files?.document?.[0]) {
      const upRes = await uploadMediaFile(req.files.document[0], 'documents');
      documentPath = upRes?.url || `/uploads/${req.files.document[0].filename}`;
    }

    const [result] = await pool.query(
      'INSERT INTO residents (full_name, phone, email, address, notes, avatar_url, document_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [residentName, residentPhone, residentEmail, residentAddress, residentNotes, avatarPath, documentPath]
    );

    const [newResidentRows] = await pool.query(
      'SELECT id, full_name, phone, email, address, notes, avatar_url, document_url, created_at, updated_at FROM residents WHERE id = ?',
      [result.insertId]
    );

    // 1. Notify Admins in-app
    try {
      const [adminRows] = await pool.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
      for (const admin of adminRows) {
        await notificationService.createNotification({
          recipientUserId: admin.id,
          type: 'NEW_TENANT',
          title: 'New Resident Added',
          message: `Resident "${residentName}" has been added to the directory.`,
          relatedEntityType: 'residents',
          relatedEntityId: result.insertId,
          actionUrl: '/admin/tenants',
          skipWebhook: true,
        });
      }
    } catch (notifErr) {
      console.error('[Notification] Failed to notify on tenant creation:', notifErr);
    }

    // 2. Send Registration Confirmation SMS & Email to the newly registered Resident
    try {
      const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
      const residentSmsText = `Hello ${residentName}, welcome to Nexus FMS! You have been registered for property maintenance services at ${residentAddress}. For any maintenance requests, contact us or visit ${frontendBase}. Nexus Facility Management.`;
      const emailSubject = 'Welcome to Nexus FMS - Resident Registration Confirmation';
      const emailBody = `Dear ${residentName},\n\nYou have been successfully registered in the Nexus FMS Resident Directory for property:\n${residentAddress}\n\nPhone: ${residentPhone}\n${residentEmail ? `Email: ${residentEmail}\n` : ''}\nWhenever a maintenance request is scheduled for your property, you will receive real-time updates and scheduling links directly via SMS and Email.\n\nThank you,\nNexus FMS Operations Team`;

      // Dispatch SMS directly via sms provider (forwards to N8N_SMS_WEBHOOK_URL)
      if (residentPhone) {
        sendSms({ to: residentPhone, message: residentSmsText }).catch(err => {
          console.warn('[TenantRegistration] SMS delivery warning:', err.message);
        });
      }

      // Dispatch Email directly via email provider if email is provided
      if (residentEmail) {
        sendEmail({ to: residentEmail, subject: emailSubject, body: emailBody }).catch(err => {
          console.warn('[TenantRegistration] Email delivery warning:', err.message);
        });
      }

      // Dispatch N8N Webhook for TENANT_REGISTRATION event
      dispatchN8NWebhook('TENANT_REGISTRATION', {
        event: 'TENANT_REGISTRATION',
        type: 'TENANT_REGISTRATION',
        residentId: result.insertId,
        name: residentName,
        residentName: residentName,
        recipientName: residentName,
        phone: residentPhone,
        residentPhone: residentPhone,
        contactPhone: residentPhone,
        to: residentPhone,
        email: residentEmail,
        residentEmail: residentEmail,
        contactEmail: residentEmail,
        address: residentAddress,
        propertyAddress: residentAddress,
        subject: emailSubject,
        message: residentSmsText,
        emailBody: emailBody,
        actionUrl: frontendBase,
      }).catch(err => {
        console.warn('[TenantRegistration] N8N Webhook dispatch warning:', err.message);
      });
    } catch (msgErr) {
      console.warn('[TenantRegistration] Notification dispatch error:', msgErr.message);
    }

    res.status(201).json({
      success: true,
      message: 'Resident created successfully.',
      data: newResidentRows[0],
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Update existing resident
// @route   PUT /api/v1/tenants/:id
// @access  Private (Office Admin & Staff)
const updateTenant = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { full_name, name, phone, email, address, notes } = req.body;

    const [existing] = await pool.query('SELECT id, avatar_url, document_url FROM residents WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Resident not found with ID ${id}`,
      });
    }

    const residentName = (full_name || name || '').trim();
    const rawPhone = (phone || '').trim();
    const residentPhone = normalizePhoneNumber(rawPhone);
    const residentAddress = (address || '').trim();
    const residentEmail = email && email.trim() !== '' ? email.trim() : null;
    const residentNotes = notes && notes.trim() !== '' ? notes.trim() : null;
    let avatarPath = req.body.avatarUrl !== undefined || req.body.avatar_url !== undefined
      ? (req.body.avatarUrl || req.body.avatar_url || '')
      : existing[0].avatar_url;
    if (req.files?.avatar?.[0]) {
      const upRes = await uploadMediaFile(req.files.avatar[0], 'avatars');
      avatarPath = upRes?.url || `/uploads/${req.files.avatar[0].filename}`;
    }

    let documentPath = req.body.documentUrl !== undefined || req.body.document_url !== undefined
      ? (req.body.documentUrl || req.body.document_url || '')
      : existing[0].document_url;
    if (req.files?.document?.[0]) {
      const upRes = await uploadMediaFile(req.files.document[0], 'documents');
      documentPath = upRes?.url || `/uploads/${req.files.document[0].filename}`;
    }

    if (!residentName || !residentPhone || !residentAddress) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Full Name, Phone, and Address are required fields.',
      });
    }

    await pool.query(
      'UPDATE residents SET full_name = ?, phone = ?, email = ?, address = ?, notes = ?, avatar_url = ?, document_url = ? WHERE id = ?',
      [residentName, residentPhone, residentEmail, residentAddress, residentNotes, avatarPath, documentPath, id]
    );

    const [updatedRows] = await pool.query(
      'SELECT id, full_name, phone, email, address, notes, avatar_url, document_url, created_at, updated_at FROM residents WHERE id = ?',
      [id]
    );

    res.status(200).json({
      success: true,
      message: 'Resident updated successfully.',
      data: updatedRows[0],
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Delete resident
// @route   DELETE /api/v1/tenants/:id
// @access  Private (Office Admin Only)
const deleteTenant = async (req, res, next) => {
  try {
    const { id } = req.params;
    const [existing] = await pool.query('SELECT id FROM residents WHERE id = ?', [id]);
    
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Resident not found with ID ${id}`,
      });
    }

    await pool.query('DELETE FROM residents WHERE id = ?', [id]);

    res.status(200).json({
      success: true,
      message: `Resident ID ${id} deleted successfully.`,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getTenants,
  getTenantById,
  createTenant,
  updateTenant,
  deleteTenant,
};
