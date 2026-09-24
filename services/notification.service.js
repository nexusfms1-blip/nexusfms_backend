const { pool } = require('../config/db');
const axios = require('axios');
const { sendEmail } = require('./notification/providers/email.provider');
const { sendSms } = require('./notification/providers/sms.provider');
const { dispatchN8NWebhook } = require('./webhook.service');

let ioInstance = null;

const SENSITIVE_FINANCIAL_FIELDS = [
  'quoteAmount', 'quote_amount', 'material_cost', 'material_costs', 
  'total_job_cost', 'revenue', 'profit', 'margin', 'cost'
];

const sanitizePayload = (role, dataPayload) => {
  if (!dataPayload) return null;
  if (role === 'OFFICE_ADMIN') return dataPayload; 
  const sanitized = { ...dataPayload };
  for (const field of SENSITIVE_FINANCIAL_FIELDS) {
    delete sanitized[field];
  }
  return sanitized;
};

const formatMessage = (messageTemplate, structuredData) => {
  if (!structuredData) return messageTemplate;
  // Replace all {{key}} in the template
  return messageTemplate.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    if (structuredData[key] !== undefined) {
      return structuredData[key];
    }
    // If it's a sensitive field that was stripped, hide it
    if (SENSITIVE_FINANCIAL_FIELDS.includes(key)) {
      return '<RESTRICTED>';
    }
    return ''; // Or keep it, but usually we want it blank if missing
  });
};

const notificationService = {
  setIoInstance(io) {
    ioInstance = io;
  },

  getIoInstance() {
    return ioInstance;
  },

  /**
   * Backwards compatible method used by existing Phase 1-9 code.
   * Promoted to use the full dispatcher under the hood.
   */
  async createNotification(data, connection = null) {
    // Map old style to new style
    const phone = data.contactPhone || data.technicianPhone || null;
    const email = data.contactEmail || null;
    return this.dispatch({
      recipientUserId: data.recipientUserId,
      recipientRole: data.recipientRole || 'OFFICE_ADMIN', // Default role if unspecified
      type: data.type,
      title: data.title,
      messageTemplate: data.message,
      structuredData: data.data || null,
      relatedEntityType: data.relatedEntityType,
      relatedEntityId: data.relatedEntityId,
      actionUrl: data.actionUrl,
      channels: data.channels || (phone || email ? ['IN_APP', 'SMS', 'EMAIL'] : ['IN_APP']),
      contactEmail: email,
      contactPhone: phone,
      technicianName: data.technicianName || null,
      technicianPhone: data.technicianPhone || null,
      propertyAddress: data.propertyAddress || null,
      skipWebhook: data.skipWebhook || false,
      connection
    });
  },

  async dispatch({
    recipientUserId,
    recipientRole,
    type,
    title,
    messageTemplate,
    structuredData,
    actionUrl,
    relatedEntityType,
    relatedEntityId,
    channels = ['IN_APP'],
    contactEmail = null,
    contactPhone = null,
    technicianName = null,
    technicianPhone = null,
    propertyAddress = null,
    skipWebhook = false,
    connection = null
  }) {
    const db = connection || pool;
    const sanitizedData = sanitizePayload(recipientRole, structuredData);
    const finalMessage = formatMessage(messageTemplate, sanitizedData);
    let notificationId = null;

    try {
      if (channels.includes('IN_APP') && recipientUserId && recipientRole !== 'TENANT') {
        const [userExists] = await db.query('SELECT id FROM users WHERE id = ?', [recipientUserId]);
        if (userExists.length > 0) {
          const [res] = await db.query(
            `INSERT INTO notifications 
              (user_id, notification_type, title, message, related_entity_type, related_entity_id, action_url)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [recipientUserId, type, title, finalMessage, relatedEntityType, relatedEntityId, actionUrl]
          );
          notificationId = res.insertId;

          if (ioInstance) {
             ioInstance.to(`user_${recipientUserId}`).emit('NEW_NOTIFICATION', {
               id: notificationId,
               type,
               title,
               message: finalMessage,
               actionUrl,
               createdAt: new Date().toISOString()
             });
          }
        }
      }

      // Automatic fallback: if contactPhone or contactEmail is missing, resolve directly from work_orders & residents
      if ((!contactPhone || !contactEmail) && relatedEntityType === 'work_orders' && relatedEntityId) {
        try {
          const [woRows] = await db.query(
            `SELECT w.contact_phone, w.contact_email, r.phone as res_phone, r.email as res_email 
             FROM work_orders w 
             LEFT JOIN residents r ON w.resident_id = r.id 
             WHERE w.id = ?`,
            [relatedEntityId]
          );
          if (woRows.length > 0) {
            if (!contactPhone) contactPhone = woRows[0].contact_phone || woRows[0].res_phone || null;
            if (!contactEmail) contactEmail = woRows[0].contact_email || woRows[0].res_email || null;
          }
        } catch (e) {
          console.warn('[NotificationService] Fallback contact info lookup failed:', e.message);
        }
      }

      if (channels.includes('EMAIL') && contactEmail) {
        try {
          await this._processChannelDelivery(db, notificationId, 'EMAIL', contactEmail, async () => {
             return await sendEmail({ to: contactEmail, subject: title, body: finalMessage });
          });
        } catch (e) {
          console.warn('[NotificationService] EMAIL delivery failed:', e.message);
        }
      }

      if (channels.includes('SMS') && contactPhone) {
        try {
          await this._processChannelDelivery(db, notificationId, 'SMS', contactPhone, async () => {
            return await sendSms({ to: contactPhone, message: finalMessage });
          });
        } catch (e) {
          console.warn('[NotificationService] SMS delivery failed:', e.message);
        }
      }

      // Dispatch native mobile push notification if recipient user has registered an Expo push token
      if (recipientUserId) {
        this._dispatchMobilePushNotification(db, recipientUserId, title, finalMessage, {
          jobId: relatedEntityId,
          entityType: relatedEntityType,
          type,
          actionUrl,
        }).catch(e => console.warn('[NotificationService] Mobile push dispatch error:', e.message));
      }

      // Never send external webhooks for internal admin pipeline movements
      if (type === 'PIPELINE_UPDATE' || type === 'PIPELINE_STAGE_UPDATED') {
        skipWebhook = true;
      }

      // Dispatch event to N8N webhook asynchronously without blocking main flow
      if (!skipWebhook) {
        let n8nPayload = {
          notificationId,
          type,
          title,
          message: finalMessage,
          recipientUserId,
          contactEmail,
          contactPhone,
          actionUrl,
          entityType: relatedEntityType,
          entityId: relatedEntityId,
          technicianName,
          technicianPhone,
          propertyAddress,
          data: sanitizedData || structuredData || null,
        };

        if (type === 'TASK_ASSIGNED' || type === 'TASK_REASSIGNED') {
          const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
          const workOrderId = relatedEntityId || n8nPayload.entityId;
          n8nPayload.workOrderId = workOrderId;
          n8nPayload.entityId = workOrderId;
          n8nPayload.actionUrl = `${frontendBase}/maintenance/my-tasks${workOrderId ? `?jobId=${workOrderId}` : ''}`;

          // Fetch technician details if missing
          if (recipientUserId && (!n8nPayload.technicianName || !n8nPayload.technicianPhone)) {
            try {
              const [techRows] = await db.query(
                `SELECT u.full_name, u.phone, u.email 
                 FROM users u 
                 WHERE u.id = ?`,
                [recipientUserId]
              );
              if (techRows.length > 0) {
                n8nPayload.technicianName = n8nPayload.technicianName || techRows[0].full_name;
                n8nPayload.technicianPhone = n8nPayload.technicianPhone || techRows[0].phone;
                n8nPayload.contactPhone = n8nPayload.contactPhone || n8nPayload.technicianPhone;
              }
            } catch (tErr) {
              console.warn('[NotificationService] Could not enrich technician info:', tErr.message);
            }
          }

          // Fetch propertyAddress, jobNumber, date & time if missing
          if (workOrderId) {
            try {
              const [woRows] = await db.query(
                'SELECT property_address, title, job_number, scheduled_date, scheduled_time_slot FROM work_orders WHERE id = ?',
                [workOrderId]
              );
              if (woRows.length > 0) {
                if (!n8nPayload.propertyAddress) n8nPayload.propertyAddress = woRows[0].property_address;
                if (!n8nPayload.jobNumber) n8nPayload.jobNumber = woRows[0].job_number;
                if (!n8nPayload.scheduledDate && woRows[0].scheduled_date) {
                  const raw = woRows[0].scheduled_date;
                  n8nPayload.scheduledDate = raw instanceof Date ? raw.toISOString().substring(0, 10) : String(raw).substring(0, 10);
                }
                if (!n8nPayload.scheduledTimeSlot && woRows[0].scheduled_time_slot) {
                  n8nPayload.scheduledTimeSlot = woRows[0].scheduled_time_slot;
                }
              }
            } catch (wErr) {
              console.warn('[NotificationService] Could not enrich property address/schedule:', wErr.message);
            }
          }

          const dataObj = n8nPayload.data || {};
          const dateVal = n8nPayload.scheduledDate || n8nPayload.date || dataObj.scheduledDate || dataObj.scheduled_date || dataObj.date || null;
          const timeVal = n8nPayload.scheduledTime || n8nPayload.scheduledTimeSlot || n8nPayload.time || n8nPayload.timeSlot || dataObj.scheduledTime || dataObj.scheduled_time || dataObj.scheduledTimeSlot || dataObj.scheduled_time_slot || dataObj.time || null;

          n8nPayload.scheduledDate = dateVal;
          n8nPayload.scheduled_date = dateVal;
          n8nPayload.date = dateVal;
          n8nPayload.scheduledTime = timeVal;
          n8nPayload.scheduled_time = timeVal;
          n8nPayload.scheduledTimeSlot = timeVal;
          n8nPayload.scheduled_time_slot = timeVal;
          n8nPayload.time = timeVal;
          n8nPayload.timeSlot = timeVal;

          if (n8nPayload.data && typeof n8nPayload.data === 'object') {
            n8nPayload.data.scheduledDate = dateVal;
            n8nPayload.data.scheduled_date = dateVal;
            n8nPayload.data.date = dateVal;
            n8nPayload.data.scheduledTime = timeVal;
            n8nPayload.data.scheduled_time = timeVal;
            n8nPayload.data.scheduledTimeSlot = timeVal;
            n8nPayload.data.scheduled_time_slot = timeVal;
            n8nPayload.data.time = timeVal;
            n8nPayload.data.timeSlot = timeVal;
            n8nPayload.data.propertyAddress = n8nPayload.propertyAddress;
            n8nPayload.data.actionUrl = n8nPayload.actionUrl;
          }
        } else if (type === 'QUOTE_PHOTO_REQUEST' || type === 'NEW_QUOTE_REQUEST') {
          const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
          const workOrderId = relatedEntityId || n8nPayload.entityId;
          n8nPayload.workOrderId = workOrderId;
          n8nPayload.entityId = workOrderId;
          n8nPayload.reference = workOrderId;

          // Fetch work order details if missing
          if (workOrderId && (!n8nPayload.contactPhone || !n8nPayload.propertyAddress || !n8nPayload.residentName)) {
            try {
              const [woRows] = await db.query(
                `SELECT w.job_number, w.title, w.property_address, w.resident_name, w.contact_phone, w.contact_email,
                        r.full_name as live_res_name, r.phone as live_res_phone, r.email as live_res_email
                 FROM work_orders w
                 LEFT JOIN residents r ON w.resident_id = r.id
                 WHERE w.id = ?`,
                [workOrderId]
              );
              if (woRows.length > 0) {
                const r = woRows[0];
                n8nPayload.jobNumber = n8nPayload.jobNumber || r.job_number;
                n8nPayload.title = n8nPayload.title || r.title;
                n8nPayload.propertyAddress = n8nPayload.propertyAddress || r.property_address;
                n8nPayload.residentName = n8nPayload.residentName || r.live_res_name || r.resident_name;
                n8nPayload.contactPhone = n8nPayload.contactPhone || r.contact_phone || r.live_res_phone;
                n8nPayload.contactEmail = n8nPayload.contactEmail || r.contact_email || r.live_res_email;
              }
            } catch (e) {}
          }

          // CRITICAL: Ensure tenant name is populated across all fields for N8N template
          const resolvedResidentName = n8nPayload.residentName || n8nPayload.data?.name || n8nPayload.data?.residentName || n8nPayload.data?.resident_name || 'Resident';
          n8nPayload.name = resolvedResidentName;
          n8nPayload.residentName = resolvedResidentName;
          n8nPayload.recipientName = resolvedResidentName;

          // Resolve secure_token from quote_requests
          let token = n8nPayload.data?.secure_token || n8nPayload.data?.token || n8nPayload.secureToken || null;
          if (!token && workOrderId) {
            try {
              const [qrRows] = await db.query(
                'SELECT secure_token FROM quote_requests WHERE work_order_id = ? ORDER BY created_at DESC LIMIT 1',
                [workOrderId]
              );
              if (qrRows.length > 0) token = qrRows[0].secure_token;
            } catch (e) {}
          }

          if (token) {
            const uploadUrl = `${frontendBase}/quote-request/${token}`;
            n8nPayload.actionUrl = uploadUrl;
            n8nPayload.uploadUrl = uploadUrl;
            n8nPayload.photoUploadLink = uploadUrl;
            if (n8nPayload.data) {
              n8nPayload.data.actionUrl = uploadUrl;
              n8nPayload.data.uploadUrl = uploadUrl;
              n8nPayload.data.photoUploadLink = uploadUrl;
              n8nPayload.data.uploadLink = uploadUrl;
              n8nPayload.data.residentName = resolvedResidentName;
              n8nPayload.data.name = resolvedResidentName;
              n8nPayload.data.recipientName = resolvedResidentName;
              n8nPayload.data.resident_name = resolvedResidentName;
              n8nPayload.data.contactPhone = n8nPayload.contactPhone;
              n8nPayload.data.propertyAddress = n8nPayload.propertyAddress;
            }
          }
        } else if (type === 'BOOKING_REQUEST') {
          const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
          const workOrderId = relatedEntityId || n8nPayload.entityId;
          n8nPayload.workOrderId = workOrderId;
          n8nPayload.entityId = workOrderId;

          // Fetch work order details if missing
          if (workOrderId && (!n8nPayload.contactPhone || !n8nPayload.propertyAddress || !n8nPayload.residentName)) {
            try {
              const [woRows] = await db.query(
                `SELECT w.job_number, w.title, w.property_address, w.resident_name, w.contact_phone, w.contact_email,
                        r.full_name as live_res_name, r.phone as live_res_phone, r.email as live_res_email
                 FROM work_orders w
                 LEFT JOIN residents r ON w.resident_id = r.id
                 WHERE w.id = ?`,
                [workOrderId]
              );
              if (woRows.length > 0) {
                const r = woRows[0];
                n8nPayload.jobNumber = n8nPayload.jobNumber || r.job_number;
                n8nPayload.title = n8nPayload.title || r.title;
                n8nPayload.propertyAddress = n8nPayload.propertyAddress || r.property_address;
                n8nPayload.residentName = n8nPayload.residentName || r.live_res_name || r.resident_name;
                n8nPayload.contactPhone = n8nPayload.contactPhone || r.contact_phone || r.live_res_phone;
                n8nPayload.contactEmail = n8nPayload.contactEmail || r.contact_email || r.live_res_email;
              }
            } catch (e) {}
          }

          // Resolve secure_token from booking_requests if missing
          let token = n8nPayload.data?.bookingToken || n8nPayload.data?.secure_token || n8nPayload.secureToken || null;
          if (!token && workOrderId) {
            try {
              const [bRows] = await db.query(
                'SELECT secure_token FROM booking_requests WHERE work_order_id = ? ORDER BY created_at DESC LIMIT 1',
                [workOrderId]
              );
              if (bRows.length > 0) token = bRows[0].secure_token;
            } catch (e) {}
          }

          if (token) {
            const bookingUrl = `${frontendBase}/booking/${token}`;
            n8nPayload.actionUrl = bookingUrl;
            n8nPayload.bookingUrl = bookingUrl;
            n8nPayload.bookingLink = bookingUrl;
            if (n8nPayload.data) {
              n8nPayload.data.actionUrl = bookingUrl;
              n8nPayload.data.bookingUrl = bookingUrl;
              n8nPayload.data.bookingLink = bookingUrl;
              n8nPayload.data.residentName = n8nPayload.residentName;
              n8nPayload.data.contactPhone = n8nPayload.contactPhone;
              n8nPayload.data.propertyAddress = n8nPayload.propertyAddress;
            }
          }

        } else if (type === 'BOOKING_CONFIRMED') {
          const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
          const workOrderId = relatedEntityId || n8nPayload.entityId;
          n8nPayload.workOrderId = workOrderId;
          n8nPayload.entityId = workOrderId;
          n8nPayload.reference = workOrderId;

          // Resolve secure token if missing
          let token = n8nPayload.data?.token || n8nPayload.data?.secure_token || n8nPayload.secureToken || null;
          if (!token && workOrderId) {
            try {
              const [bRows] = await db.query(
                'SELECT secure_token FROM booking_requests WHERE work_order_id = ? ORDER BY created_at DESC LIMIT 1',
                [workOrderId]
              );
              if (bRows.length > 0) token = bRows[0].secure_token;
            } catch (e) {}
          }

          const bookingUrl = token ? `${frontendBase}/booking/${token}` : `${frontendBase}/maintenance/my-tasks`;
          n8nPayload.actionUrl = bookingUrl;
          n8nPayload.bookingUrl = bookingUrl;
          n8nPayload.bookingLink = bookingUrl;

          // Ensure resident name, property address, date and time slot are present at top level
          const dataObj = n8nPayload.data || {};
          const resName = n8nPayload.residentName || n8nPayload.name || dataObj.resident_name || dataObj.residentName || null;
          const propAddr = n8nPayload.propertyAddress || n8nPayload.property || dataObj.address || dataObj.property_address || dataObj.property || null;
          const dateVal = n8nPayload.scheduledDate || n8nPayload.date || dataObj.scheduled_date || dataObj.date || null;
          const timeVal = n8nPayload.scheduledTimeSlot || n8nPayload.timeSlot || n8nPayload.time || dataObj.scheduled_time_slot || dataObj.time_slot || dataObj.timeSlot || null;

          n8nPayload.name = resName;
          n8nPayload.residentName = resName;
          n8nPayload.property = propAddr;
          n8nPayload.propertyAddress = propAddr;
          n8nPayload.date = dateVal;
          n8nPayload.scheduledDate = dateVal;
          n8nPayload.time = timeVal;
          n8nPayload.timeSlot = timeVal;
          n8nPayload.scheduledTimeSlot = timeVal;

          if (n8nPayload.data && typeof n8nPayload.data === 'object') {
            n8nPayload.data.actionUrl = bookingUrl;
            n8nPayload.data.bookingUrl = bookingUrl;
            n8nPayload.data.bookingLink = bookingUrl;
            n8nPayload.data.reference = workOrderId;
            n8nPayload.data.name = resName;
            n8nPayload.data.residentName = resName;
            n8nPayload.data.property = propAddr;
            n8nPayload.data.propertyAddress = propAddr;
            n8nPayload.data.date = dateVal;
            n8nPayload.data.scheduledDate = dateVal;
            n8nPayload.data.time = timeVal;
            n8nPayload.data.timeSlot = timeVal;
            n8nPayload.data.scheduledTimeSlot = timeVal;
          }
        } else if (type === 'JOB_COMPLETED' || type === 'STAFF_JOB_DONE') {
          const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
          const workOrderId = relatedEntityId || n8nPayload.entityId;
          n8nPayload.workOrderId = workOrderId;
          n8nPayload.entityId = workOrderId;
          n8nPayload.reference = workOrderId ? `work_orders #${workOrderId}` : null;
          n8nPayload.actionUrl = workOrderId ? `${frontendBase}/jobs/${workOrderId}/report` : `${frontendBase}/admin/pipeline?stage=Completed Jobs`;
          n8nPayload.reportUrl = n8nPayload.actionUrl;
          n8nPayload.pdfReportUrl = n8nPayload.actionUrl;

          if (workOrderId) {
            try {
              const [woRows] = await db.query(
                `SELECT w.job_number, w.title, w.property_address, w.resident_name, w.contact_phone, w.contact_email,
                        r.full_name as live_res_name, r.phone as live_res_phone, r.email as live_res_email,
                        u.full_name as tech_name, u.phone as tech_phone, u.email as tech_email
                 FROM work_orders w
                 LEFT JOIN residents r ON w.resident_id = r.id
                 LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
                 LEFT JOIN users u ON sp.user_id = u.id
                 WHERE w.id = ?`,
                [workOrderId]
              );
              if (woRows.length > 0) {
                const r = woRows[0];
                n8nPayload.jobNumber = n8nPayload.jobNumber || r.job_number;
                n8nPayload.title = n8nPayload.title || r.title;
                n8nPayload.propertyAddress = n8nPayload.propertyAddress || r.property_address;
                n8nPayload.technicianName = n8nPayload.technicianName || r.tech_name;
                n8nPayload.technicianPhone = n8nPayload.technicianPhone || r.tech_phone;
                n8nPayload.technicianEmail = n8nPayload.technicianEmail || r.tech_email;

                if (recipientRole === 'MAINTENANCE_STAFF') {
                  // CRUCIAL: Staff recipient must be greeted with staff name and routed to staff portal
                  const staffDisplayName = n8nPayload.technicianName || r.tech_name || 'Technician';
                  n8nPayload.name = staffDisplayName;
                  n8nPayload.recipientName = staffDisplayName;
                  n8nPayload.staffName = staffDisplayName;
                  n8nPayload.residentName = staffDisplayName; // Overrides residentName so N8N greeting says 'Dear lightlab'
                  n8nPayload.tenantName = r.live_res_name || r.resident_name;
                  n8nPayload.actionUrl = `${frontendBase}/maintenance/my-tasks`;
                  n8nPayload.reportUrl = `${frontendBase}/maintenance/my-tasks`;
                  n8nPayload.pdfReportUrl = `${frontendBase}/maintenance/my-tasks`;
                } else if (recipientRole === 'OFFICE_ADMIN' || recipientRole === 'OFFICE_TEAM') {
                  n8nPayload.name = 'Admin';
                  n8nPayload.recipientName = 'Admin';
                  n8nPayload.residentName = 'Team';
                  n8nPayload.tenantName = r.live_res_name || r.resident_name;
                } else {
                  n8nPayload.residentName = n8nPayload.residentName || r.live_res_name || r.resident_name;
                  n8nPayload.residentPhone = n8nPayload.residentPhone || r.live_res_phone || r.contact_phone;
                  n8nPayload.residentEmail = n8nPayload.residentEmail || r.live_res_email || r.contact_email;
                  n8nPayload.name = n8nPayload.residentName;
                  n8nPayload.recipientName = n8nPayload.residentName;
                }
              }
            } catch (e) {
              console.warn('[NotificationService] Could not enrich JOB_COMPLETED info:', e.message);
            }
          }

          n8nPayload.status = 'COMPLETED';
          n8nPayload.pipelineStage = 'Completed Jobs';
          n8nPayload.pipeline_stage = 'Completed Jobs';

          if (n8nPayload.data && typeof n8nPayload.data === 'object') {
            n8nPayload.data.workOrderId = workOrderId;
            n8nPayload.data.actionUrl = n8nPayload.actionUrl;
            n8nPayload.data.reportUrl = n8nPayload.actionUrl;
            n8nPayload.data.pdfReportUrl = n8nPayload.actionUrl;
            n8nPayload.data.reference = n8nPayload.reference;
            n8nPayload.data.residentName = n8nPayload.residentName;
            n8nPayload.data.name = n8nPayload.name;
            n8nPayload.data.recipientName = n8nPayload.recipientName;
            n8nPayload.data.staffName = n8nPayload.staffName || n8nPayload.technicianName;
            n8nPayload.data.residentPhone = n8nPayload.residentPhone;
            n8nPayload.data.residentEmail = n8nPayload.residentEmail;
            n8nPayload.data.technicianName = n8nPayload.technicianName;
            n8nPayload.data.technicianPhone = n8nPayload.technicianPhone;
            n8nPayload.data.technicianEmail = n8nPayload.technicianEmail;
            n8nPayload.data.propertyAddress = n8nPayload.propertyAddress;
            n8nPayload.data.status = 'COMPLETED';
            n8nPayload.data.pipelineStage = 'Completed Jobs';
          }
        }

        // Send enriched payload to N8N webhook
        await dispatchN8NWebhook(type, n8nPayload).catch(err => {
          console.warn(`[NotificationService] N8N dispatch failed for ${type}:`, err.message);
        });
      }

    } catch (error) {
      console.error('[NotificationService] Dispatch failed:', error);
      if (connection) throw error; 
    }

  },

  async _processChannelDelivery(db, notificationId, channel, recipient, deliveryFn) {
    let deliveryId = null;
    try {
      const [trackRes] = await db.query(
        `INSERT INTO notification_delivery (notification_id, channel, recipient, status, attempts) VALUES (?, ?, ?, 'PENDING', 0)`,
        [notificationId || null, channel, recipient]
      );
      deliveryId = trackRes.insertId;
    } catch (dbErr) {
      console.warn('[NotificationService] Delivery record insert warning:', dbErr.message);
    }

    let attempt = 1;
    const maxAttempts = 3;
    let success = false;
    let providerRes = null;
    let lastError = null;

    while (attempt <= maxAttempts && !success) {
      try {
        if (deliveryId) {
          await db.query('UPDATE notification_delivery SET attempts = ?, last_attempt_at = NOW() WHERE id = ?', [attempt, deliveryId]).catch(() => {});
        }
        providerRes = await deliveryFn();
        success = true;
        if (deliveryId) {
          await db.query(
            `UPDATE notification_delivery SET status = 'SENT', sent_at = NOW(), provider = ?, provider_message_id = ? WHERE id = ?`,
            [providerRes?.provider || 'EXTERNAL', providerRes?.messageId || null, deliveryId]
          ).catch(() => {});
        }
      } catch (error) {
        lastError = error;
        attempt++;
        if (attempt <= maxAttempts) await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }

    if (!success) {
      if (deliveryId) {
        await db.query(
          `UPDATE notification_delivery SET status = 'FAILED', failed_at = NOW(), error_message = ? WHERE id = ?`,
          [lastError?.message?.substring(0, 500) || 'Unknown error', deliveryId]
        ).catch(() => {});
      }
      console.error(`[NotificationService] Channel ${channel} failed after ${maxAttempts} attempts:`, lastError?.message);
    }
  },

  /**
   * Dispatch native mobile push notification via Expo Push Notification API
   */
  async _dispatchMobilePushNotification(db, userId, title, body, data = {}) {
    try {
      // Check if user has registered an Expo push token
      const [rows] = await db.query('SELECT push_token FROM users WHERE id = ? LIMIT 1', [userId]);
      const pushToken = rows && rows[0]?.push_token;
      if (!pushToken || typeof pushToken !== 'string' || !pushToken.trim()) {
        return; // User has not logged into mobile app or token not registered
      }

      const expoPayload = {
        to: pushToken.trim(),
        sound: 'default',
        title: title || 'Nexus FMS Alert',
        body: body || '',
        data: data,
        priority: 'high',
        channelId: 'nexus-alerts',
      };

      const res = await axios.post('https://exp.host/--/api/v2/push/send', expoPayload, {
        headers: {
          'Accept': 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        timeout: 6000,
      });

      console.log(`[NotificationService] Push notification sent to user ${userId}:`, res.data?.data?.status || 'OK');
    } catch (err) {
      console.warn(`[NotificationService] Push notification dispatch failed for user ${userId}:`, err.message);
    }
  }
};

module.exports = notificationService;

