const crypto = require('crypto');
const { pool } = require('../config/db');
const notificationService = require('../services/notification.service');
const { autoAssignTechnician, isAutoAssignmentEnabled } = require('../services/autoAssignment.service');
const { dispatchN8NWebhook, getAdminAndOfficeRecipientEmail } = require('../services/webhook.service');
const { uploadMediaFile } = require('../services/cloudinary.service');
const QuoteRequestService = require('../services/quoteRequest.service');
const BookingRequestService = require('../services/bookingRequest.service');


// @desc    Get public request information by secure token (NO LOGIN REQUIRED)
// @route   GET /api/v1/public/request/:token
// @access  Public (No Auth Token Required)
const getPublicRequestByToken = async (req, res, next) => {
  try {
    const { token } = req.params;

    // Parallel lookup across quote_requests, booking_requests, and work_orders
    const [[quoteRows], [bookingRows], [jobRows]] = await Promise.all([
      pool.query(
        `SELECT q.*, w.job_number, w.title, w.resident_name, w.property_address, w.description as job_desc
         FROM quote_requests q
         JOIN work_orders w ON q.work_order_id = w.id
         WHERE q.secure_token = ?`,
        [token]
      ),
      pool.query(
        `SELECT b.*, w.job_number, w.title, w.resident_name, w.property_address, w.description as job_desc, w.duration_hours, w.scheduled_date, w.scheduled_time_slot, w.assigned_staff_id, u.full_name as staff_name
         FROM booking_requests b
         JOIN work_orders w ON b.work_order_id = w.id
         LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
         LEFT JOIN users u ON sp.user_id = u.id
         WHERE b.secure_token = ?`,
        [token]
      ),
      pool.query(
        `SELECT w.*, u.full_name as staff_name 
         FROM work_orders w 
         LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
         LEFT JOIN users u ON sp.user_id = u.id
         WHERE w.secure_token = ?`,
        [token]
      )
    ]);

    if (quoteRows.length > 0) {
      const q = quoteRows[0];
      return res.status(200).json({
        success: true,
        type: 'QUOTE_UPLOAD',
        data: {
          requestId: q.id,
          workOrderId: q.work_order_id,
          jobNumber: q.job_number,
          title: q.title,
          residentName: q.resident_name,
          tenantName: q.resident_name,
          address: q.property_address,
          description: q.job_desc,
          status: q.status,
          expiresAt: q.expires_at,
          secureToken: q.secure_token,
        },
      });
    }

    if (bookingRows.length > 0) {
      const b = bookingRows[0];
      const rawDate = b.booked_date || b.scheduled_date;
      let finalDate = null;
      if (rawDate) {
        finalDate = typeof rawDate === 'string' ? rawDate.split('T')[0] : new Date(rawDate).toISOString().split('T')[0];
      }
      const finalSlot = b.booked_time_slot || b.scheduled_time_slot || null;
      const finalStaff = b.staff_name || 'Assigned Technician';

      return res.status(200).json({
        success: true,
        type: 'BOOKING',
        data: {
          requestId: b.id,
          workOrderId: b.work_order_id,
          jobNumber: b.job_number,
          title: b.title,
          residentName: b.resident_name,
          tenantName: b.resident_name,
          address: b.property_address,
          description: b.job_desc || b.title,
          durationHours: parseFloat(b.duration_hours || 1.5),
          selectedDate: finalDate,
          selectedTimeSlot: finalSlot,
          status: b.status,
          bookingDetails: {
            date: finalDate,
            timeSlot: finalSlot,
            staffName: finalStaff,
          },
          expiresAt: b.expires_at,
          secureToken: b.secure_token,
        },
      });
    }

    if (jobRows.length > 0) {
      const j = jobRows[0];
      const rawDate = j.scheduled_date;
      let finalDate = null;
      if (rawDate) {
        finalDate = typeof rawDate === 'string' ? rawDate.split('T')[0] : new Date(rawDate).toISOString().split('T')[0];
      }
      return res.status(200).json({
        success: true,
        type: 'GENERIC_PORTAL',
        data: {
          workOrderId: j.id,
          jobNumber: j.job_number,
          title: j.title,
          residentName: j.resident_name,
          tenantName: j.resident_name,
          address: j.property_address,
          description: j.description,
          durationHours: parseFloat(j.duration_hours || 1.5),
          scheduledDate: finalDate,
          scheduledTimeSlot: j.scheduled_time_slot,
          bookingDetails: {
            date: finalDate,
            timeSlot: j.scheduled_time_slot,
            staffName: j.staff_name || 'Assigned Technician',
          },
          status: j.pipeline_stage,
          secureToken: j.secure_token,
        },
      });
    }

    res.status(404).json({
      success: false,
      message: 'Invalid or expired secure token link.',
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Submit Resident Photo/Video Uploads & Description (NO LOGIN REQUIRED)
// @route   POST /api/v1/public/quote-request/:token/upload
// @access  Public (No Auth Token Required)
const submitPublicQuoteUpload = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { token } = req.params;
    const { resident_notes, notes, residentComments, comments } = req.body;
    const userNotes = (resident_notes || notes || residentComments || comments || '').trim();
    const noteText = userNotes || 'Resident uploaded photos/videos for review.';


    // Verify secure token in quote_requests or work_orders
    const [quoteRows] = await connection.query(
      `SELECT q.id as request_id, q.work_order_id, q.status 
       FROM quote_requests q WHERE q.secure_token = ?`,
      [token]
    );

    let workOrderId = null;
    let requestId = null;

    if (quoteRows.length > 0) {
      workOrderId = quoteRows[0].work_order_id;
      requestId = quoteRows[0].request_id || quoteRows[0].id;
    } else {
      const [jobRows] = await connection.query(
        'SELECT id FROM work_orders WHERE secure_token = ?',
        [token]
      );
      if (jobRows.length > 0) {
        workOrderId = jobRows[0].id;
        const [existQr] = await connection.query('SELECT id FROM quote_requests WHERE work_order_id = ?', [workOrderId]);
        if (existQr.length > 0) {
          requestId = existQr[0].id;
        } else {
          const [insQr] = await connection.query(
            'INSERT INTO quote_requests (work_order_id, secure_token, status) VALUES (?, ?, ?)',
            [workOrderId, token, 'PENDING']
          );
          requestId = insQr.insertId;
        }
      }
    }


    if (!workOrderId) {
      connection.release();
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired quote request token.',
      });
    }

    const files = req.files || [];
    if (files.length === 0 && !userNotes) {
      connection.release();
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Please upload at least one photo/video or provide a description.',
      });
    }

    await connection.beginTransaction();

    const savedMediaList = [];

    // Save uploaded media files into customer_media_uploads (with Cloudinary cloud storage)
    for (const file of files) {
      const mediaType = file.mimetype.startsWith('video') ? 'VIDEO' : 'PHOTO';
      const uploadResult = await uploadMediaFile(file, 'quotes');
      const fileUrl = uploadResult?.url || `/uploads/${file.filename}`;

      const [mediaRes] = await connection.query(
        `INSERT INTO customer_media_uploads 
          (work_order_id, quote_request_id, media_type, file_path, file_name, file_size_bytes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [workOrderId, requestId, mediaType, fileUrl, file.originalname, file.size]
      );

      savedMediaList.push({
        id: mediaRes.insertId,
        mediaType,
        filePath: fileUrl,
        fileName: file.originalname,
      });
    }

    // Update quote_requests status & report
    if (requestId) {
      await connection.query(
        'UPDATE quote_requests SET status = ?, resident_description_report = ?, submitted_at = NOW() WHERE id = ?',
        ['SUBMITTED', userNotes || null, requestId]
      );
    }

    // Update work order description and transition to READY_TO_QUOTE (Ready to Quote stage in pipeline)
    await connection.query(
      `UPDATE work_orders SET 
        pipeline_stage = 'READY_TO_QUOTE',
        description = CASE 
          WHEN description IS NULL OR description = '' THEN ? 
          ELSE CONCAT(description, '\n\n[Resident Upload Notes]: ', ?) 
        END
       WHERE id = ?`,
      [noteText, noteText, workOrderId]
    );

    const [admins] = await connection.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
    const [woRows] = await connection.query(
      `SELECT id, job_number, title, priority, property_address, resident_name, contact_phone, contact_phone as resident_phone, contact_email, contact_email as resident_email, assigned_staff_id, description 
       FROM work_orders 
       WHERE id = ?`,
      [workOrderId]
    );
    const wo = woRows[0] || {};
    const jobTitle = wo.title || 'Repair Job';
    const resName = wo.resident_name || 'Resident';
    const resAddress = wo.property_address || 'Property';

    // Notify Admins that resident uploaded photos and work order is Ready to Quote
    for (const admin of admins) {
      await notificationService.createNotification({
        recipientUserId: admin.id,
        type: 'QUOTE_PHOTOS_SUBMITTED',
        title: 'Resident submitted quote photos',
        message: `Photos uploaded for ${jobTitle} by ${resName} at ${resAddress}. Work Order is now Ready to Quote.`,
        relatedEntityType: 'work_orders',
        relatedEntityId: workOrderId,
        actionUrl: `/admin/pipeline?stage=READY_TO_QUOTE`
      }, connection);
    }

    // 3. If a technician was already pre-assigned to this job, notify them of newly added photos
    if (wo.assigned_staff_id) {
      const [techUser] = await connection.query(
        `SELECT sp.user_id, u.full_name, u.email, u.phone 
         FROM staff_profiles sp 
         JOIN users u ON sp.user_id = u.id 
         WHERE sp.id = ?`,
        [wo.assigned_staff_id]
      );
      if (techUser.length > 0) {
        await notificationService.createNotification({
          recipientUserId: techUser[0].user_id,
          type: 'TASK_UPDATE',
          title: 'New photos uploaded for assigned task',
          message: `Tenant uploaded ${savedMediaList.length} new photo(s) for task "${jobTitle}" at ${resAddress}.`,
          relatedEntityType: 'work_orders',
          relatedEntityId: workOrderId,
          actionUrl: `/jobs/${workOrderId}`,
        }, connection);
      }
    }

    await connection.commit();
    connection.release();

    // Asynchronously dispatch ADMIN_OFFICE_ALERT to n8n for Admin & Office Team email notification
    const frontendBaseUrl = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
    getAdminAndOfficeRecipientEmail(pool)
      .then((recipientEmail) => {
        return dispatchN8NWebhook('ADMIN_OFFICE_ALERT', {
          alertType: 'QUOTE_PHOTOS_UPLOADED',
          recipientEmail,
          workOrderId,
          jobNumber: wo.job_number || `WO-${workOrderId.substring(0, 6)}`,
          jobTitle,
          propertyAddress: resAddress,
          residentName: resName,
          residentPhone: wo.contact_phone || wo.resident_phone,
          photoCount: savedMediaList.length,
          photoUrls: savedMediaList.map(m => m.url || m.file_path).filter(Boolean),
          subject: `[Nexus FMS] Quote Photos Submitted: #${wo.job_number || workOrderId} - ${jobTitle}`,
          headline: 'New Quote Photos Uploaded',
          message: `Resident ${resName} has uploaded ${savedMediaList.length} photo(s) for quote estimation. Work order #${wo.job_number || workOrderId} is now Ready to Quote.`,
          actionUrl: `${frontendBaseUrl}/admin/pipeline?stage=READY_TO_QUOTE`,
        });
      })
      .catch((err) => {
        console.warn('[N8N_WEBHOOK] Failed to dispatch QUOTE_PHOTOS_UPLOADED admin alert:', err.message);
      });

    res.status(200).json({
      success: true,
      message: 'Photo/Video report submitted successfully. Our team will review and prepare your quote shortly.',
      data: {
        workOrderId,
        filesUploaded: savedMediaList.length,
        media: savedMediaList,
      },
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    next(err);
  }
};

const { calculateStaffAvailableSlots, calculateMultiStaffAvailableSlots } = require('../services/availability.service');

// @desc    Submit Resident Slot Booking Confirmation (NO LOGIN REQUIRED)
// @route   POST /api/v1/public/booking/:token/confirm
// @access  Public (No Auth Token Required)
const submitPublicBooking = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { token } = req.params;
    const { booking_date, selectedDate, time_slot, selectedTimeSlot } = req.body;

    const dateVal = (booking_date || selectedDate || '').trim();
    const slotVal = (time_slot || selectedTimeSlot || '').trim();

    if (!dateVal || !slotVal) {
      connection.release();
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Booking Date and Time Slot are required.',
      });
    }

    await connection.beginTransaction();

    // Verify token & lock work order row
    const [bookingRows] = await connection.query(
      `SELECT b.id as request_id, b.work_order_id, b.assignment_preference_staff_id, w.assigned_staff_id, w.duration_hours, w.title, w.description, w.property_address 
       FROM booking_requests b
       JOIN work_orders w ON b.work_order_id = w.id
       WHERE b.secure_token = ? FOR UPDATE`,
      [token]
    );

    let workOrderId = null;
    let requestId = null;
    let assignedStaffId = null;
    let durationHours = 1.5;
    let jobDetails = {};

    if (bookingRows.length > 0) {
      const b = bookingRows[0];
      workOrderId = b.work_order_id;
      requestId = b.request_id;
      assignedStaffId = b.assigned_staff_id || b.assignment_preference_staff_id;
      durationHours = parseFloat(b.duration_hours || 1.5);
      jobDetails = {
        title: b.title,
        description: b.description,
        property_address: b.property_address,
      };
    } else {
      const [jobRows] = await connection.query(
        'SELECT id, assigned_staff_id, duration_hours, title, description, property_address FROM work_orders WHERE secure_token = ? FOR UPDATE',
        [token]
      );
      if (jobRows.length > 0) {
        const j = jobRows[0];
        workOrderId = j.id;
        assignedStaffId = j.assigned_staff_id;
        durationHours = parseFloat(j.duration_hours || 1.5);
        jobDetails = {
          title: j.title,
          description: j.description,
          property_address: j.property_address,
        };
      }
    }

    if (!workOrderId) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired booking token.',
      });
    }

    // Extract preferred or selected staff from request body if passed
    const staffIdFromBody = req.body.assignedStaffId || req.body.assigned_staff_id;
    if (staffIdFromBody && staffIdFromBody !== 'ANY') {
      const parsedId = parseInt(String(staffIdFromBody).replace('stf-', ''), 10);
      if (!isNaN(parsedId)) assignedStaffId = parsedId;
    }

    // Auto-assign best available technician for this slot if not pre-assigned
    if (!assignedStaffId) {
      const multiAvail = await calculateMultiStaffAvailableSlots(dateVal, durationHours, null, jobDetails, connection);
      const matchingSlot = multiAvail.availableSlots?.find(s => 
        s.timeSlot === slotVal || 
        s.startTime === slotVal || 
        (s.startTime && slotVal.startsWith(s.startTime))
      );
      if (matchingSlot && matchingSlot.assignedStaffId) {
        assignedStaffId = matchingSlot.assignedStaffId;
      } else if (multiAvail.recommendedStaff) {
        assignedStaffId = multiAvail.recommendedStaff.id;
      }
    }

    if (!assignedStaffId) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({
        success: false,
        message: `Booking Rejected: No technicians are scheduled or available on ${dateVal}. Please choose a working date.`,
      });
    }

    // Validate Slot Availability & Overlapping Booking Prevention
    const availabilityResult = await calculateStaffAvailableSlots(assignedStaffId, dateVal, durationHours, connection);
    const isSlotValid = availabilityResult.availableSlots?.some(s => 
      s.timeSlot === slotVal || 
      s.startTime === slotVal || 
      (s.startTime && slotVal.startsWith(s.startTime))
    );

    if (!isSlotValid) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({
        success: false,
        message: availabilityResult.reason || `Booking Rejected: Time slot '${slotVal}' on ${dateVal} is not available (Outside shift, technician is off, or already booked).`,
      });
    }

    if (requestId) {
      await connection.query(
        'UPDATE booking_requests SET booked_date = ?, booked_time_slot = ?, status = ?, booked_at = NOW() WHERE id = ?',
        [dateVal, slotVal, 'BOOKED', requestId]
      );
    }

    // Update work_orders scheduled date/time, assigned staff, and move stage to 'Jobs'
    const assignedJson = assignedStaffId ? JSON.stringify([assignedStaffId]) : null;
    await connection.query(
      `UPDATE work_orders SET 
        scheduled_date = ?,
        scheduled_time_slot = ?,
        assigned_staff_id = COALESCE(?, assigned_staff_id),
        assigned_staff_ids = COALESCE(?, assigned_staff_ids),
        pipeline_stage = 'Jobs'
       WHERE id = ?`,
      [dateVal, slotVal, assignedStaffId, assignedJson, workOrderId]
    );

    const [woRows] = await connection.query(
      "SELECT title, resident_name, contact_phone, contact_email, property_address, assigned_staff_id, manager_name, manager_email, original_sender_email, job_number, description, priority FROM work_orders WHERE id = ?",
      [workOrderId]
    );

    // Commit DB changes before triggering external HTTP webhooks/notifications
    await connection.commit();
    connection.release();

    const jobTitle = woRows[0]?.title || 'Repair Job';
    const resName = woRows[0]?.resident_name || 'Resident';
    const resAddress = woRows[0]?.property_address || 'Property';
    const targetStaffId = assignedStaffId || woRows[0]?.assigned_staff_id;
    const mgrName = woRows[0]?.manager_name || 'Manager';
    const mgrEmail = woRows[0]?.manager_email;
    const origSenderEmail = woRows[0]?.original_sender_email;
    const jobNum = woRows[0]?.job_number || '';

    // Fetch technician details for notification
    let techName = 'Technician';
    let techEmail = null;
    let techPhone = null;
    let techUserId = null;

    if (targetStaffId) {
      const [techRows] = await pool.query(
        `SELECT sp.id, sp.user_id, u.full_name, u.email, u.phone 
         FROM staff_profiles sp 
         JOIN users u ON sp.user_id = u.id 
         WHERE sp.id = ?`,
        [targetStaffId]
      );
      if (techRows.length > 0) {
        techName = techRows[0].full_name;
        techEmail = techRows[0].email;
        techPhone = techRows[0].phone;
        techUserId = techRows[0].user_id;
      }
    }

    // Fetch tenant uploaded photos for technician evidence
    const [customerMediaRows] = await pool.query(
      'SELECT file_path FROM customer_media_uploads WHERE work_order_id = ?',
      [workOrderId]
    );
    const photoUrls = customerMediaRows.map(m => m.file_path);

    const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
    const directJobActionUrl = `${frontendBase}/maintenance/my-tasks?jobId=${workOrderId}`;

    // 1. Notify Admins (Internal in-app notification only; skip external N8N webhook so tenant doesn't get duplicate empty SMS)
    const [admins] = await pool.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
    for (const admin of admins) {
      await notificationService.createNotification({
        recipientUserId: admin.id,
        recipientRole: 'OFFICE_ADMIN',
        type: 'BOOKING_CONFIRMED_ADMIN',
        title: 'New booking confirmed',
        message: `${jobTitle} booked on ${dateVal} at ${slotVal} for ${resName} (Assigned: ${techName})`,
        relatedEntityType: 'work_orders',
        relatedEntityId: workOrderId,
        actionUrl: `/admin/calendar`,
        channels: ['IN_APP'],
        skipWebhook: true
      }).catch(e => console.warn('[Admin Booking Notification Error]', e.message));
    }

    // 2. Notify assigned technician via SMS, Email, and In-App
    if (techUserId || techEmail || techPhone) {
      await notificationService.dispatch({
        recipientUserId: techUserId,
        recipientRole: 'MAINTENANCE_STAFF',
        type: 'TASK_ASSIGNED',
        title: `New Task Assigned: ${jobTitle}`,
        messageTemplate: `Hi ${techName},\n\nYou have been assigned a new maintenance job:\nJob: ${jobTitle}\nAddress: ${resAddress}\nScheduled: ${dateVal} (${slotVal})\n\nView details & tenant photos: ${directJobActionUrl}`,
        structuredData: {
          technicianName: techName,
          title: jobTitle,
          propertyAddress: resAddress,
          scheduledDate: dateVal,
          scheduledTimeSlot: slotVal,
          actionUrl: directJobActionUrl,
          residentName: resName,
          residentPhone: woRows[0]?.contact_phone,
          photoCount: photoUrls.length,
          photoUrls,
          contactPhone: techPhone,
          contactEmail: techEmail
        },
        actionUrl: directJobActionUrl,
        relatedEntityType: 'work_orders',
        relatedEntityId: workOrderId,
        channels: ['EMAIL', 'SMS', 'IN_APP'],
        contactEmail: techEmail,
        contactPhone: techPhone,
        technicianName: techName,
        technicianPhone: techPhone,
        propertyAddress: resAddress,
        skipWebhook: true,
      }).catch(err => console.error('[Tech Booking Notification Dispatch Error]', err));
    }

    // 3. Send appointment confirmation SMS & Email to Tenant
    const resPhone = woRows[0]?.contact_phone;
    const resEmail = woRows[0]?.contact_email;
    const tenantBookingDetailsUrl = `${frontendBase}/booking/${token}`;
    if (resPhone || resEmail) {
      await notificationService.dispatch({
        recipientUserId: null,
        recipientRole: 'TENANT',
        type: 'BOOKING_CONFIRMED',
        title: 'Maintenance Appointment Confirmed',
        messageTemplate: `Hi ${resName},\n\nYour maintenance appointment for "${jobTitle}" at ${resAddress} is confirmed for ${dateVal} (${slotVal}).\nAssigned Technician: ${techName}.\n\nThank you,\nNexus FMS Team`,
        structuredData: {
          reference: workOrderId,
          workOrderId: workOrderId,
          jobNumber: jobNum,
          name: resName,
          resident_name: resName,
          residentName: resName,
          property: resAddress,
          property_address: resAddress,
          address: resAddress,
          date: dateVal,
          scheduled_date: dateVal,
          scheduledDate: dateVal,
          time: slotVal,
          time_slot: slotVal,
          timeSlot: slotVal,
          scheduled_time_slot: slotVal,
          scheduledTimeSlot: slotVal,
          technician_name: techName,
          technicianName: techName,
          actionUrl: tenantBookingDetailsUrl,
          bookingUrl: tenantBookingDetailsUrl,
          bookingLink: tenantBookingDetailsUrl,
        },
        actionUrl: tenantBookingDetailsUrl,
        bookingUrl: tenantBookingDetailsUrl,
        bookingLink: tenantBookingDetailsUrl,
        relatedEntityType: 'work_orders',
        relatedEntityId: workOrderId,
        channels: ['EMAIL', 'SMS'],
        contactEmail: resEmail,
        contactPhone: resPhone,
        propertyAddress: resAddress
      }).catch(err => console.error('[Tenant Booking Confirmation Notification Error]', err));
    }

    // 4. Email confirmation to the manager / original work-order sender (Rule 4 & P0-5)
    const targetSenderEmail = origSenderEmail || mgrEmail;
    if (targetSenderEmail) {
      const emailSubject = `Booking Confirmed: Job #${jobNum} - ${jobTitle}`;
      const emailBody = `Dear ${mgrName || 'Requester'},\n\nThe resident (${resName}) has scheduled their booking for ${jobTitle} at ${resAddress}.\n\nScheduled Date: ${dateVal}\nTime Slot: ${slotVal}\nAssigned Staff: ${techName}\n\nThank you,\nNexus FMS Team`;

      await notificationService.dispatch({
        recipientUserId: null,
        recipientRole: 'OFFICE_ADMIN',
        type: 'SENDER_BOOKING_CONFIRMATION',
        title: emailSubject,
        messageTemplate: emailBody,
        structuredData: {
          manager_name: mgrName || 'Requester',
          job_number: jobNum,
          scheduled_date: dateVal,
          scheduled_time_slot: slotVal
        },
        actionUrl: `/admin/calendar`,
        relatedEntityType: 'work_orders',
        relatedEntityId: workOrderId,
        channels: ['EMAIL'],
        contactEmail: targetSenderEmail
      }).catch(err => console.error('[Sender Booking Confirmation Email Error]', err));

      if (mgrEmail && origSenderEmail && mgrEmail.toLowerCase() !== origSenderEmail.toLowerCase()) {
        await notificationService.dispatch({
          recipientUserId: null,
          recipientRole: 'OFFICE_ADMIN',
          type: 'MANAGER_BOOKING_CONFIRMATION',
          title: emailSubject,
          messageTemplate: emailBody,
          structuredData: {
            manager_name: mgrName,
            job_number: jobNum,
            scheduled_date: dateVal,
            scheduled_time_slot: slotVal
          },
          actionUrl: `/admin/calendar`,
          relatedEntityType: 'work_orders',
          relatedEntityId: workOrderId,
          channels: ['EMAIL'],
          contactEmail: mgrEmail
        }).catch(err => console.error('[Manager Booking Confirmation Email Error]', err));
      }
    }

    // 5. Dispatch TASK_ASSIGNED webhook to N8N with full technician contact info
    const taskAssignedPayload = {
      event: 'TASK_ASSIGNED',
      type: 'TASK_ASSIGNED',
      entityId: workOrderId,
      workOrderId: workOrderId,
      jobNumber: jobNum,
      title: jobTitle,
      message: `New task assigned: ${jobTitle} at ${resAddress} scheduled for ${dateVal} (${slotVal})`,
      scheduledDate: dateVal,
      scheduled_date: dateVal,
      date: dateVal,
      scheduledTime: slotVal,
      scheduled_time: slotVal,
      scheduledTimeSlot: slotVal,
      scheduled_time_slot: slotVal,
      time: slotVal,
      timeSlot: slotVal,
      priority: woRows[0]?.priority || 'NORMAL',
      propertyAddress: resAddress,
      residentName: resName,
      residentPhone: woRows[0]?.contact_phone,
      residentEmail: woRows[0]?.contact_email,
      residentNotes: woRows[0]?.description || '',
      photoCount: photoUrls.length,
      photoUrls,
      technicianName: techName,
      technicianEmail: techEmail,
      technicianPhone: techPhone,
      contactPhone: techPhone,
      contactEmail: techEmail,
      to: techPhone,
      email: techEmail,
      phone: techPhone,
      technician: {
        id: targetStaffId,
        name: techName,
        email: techEmail,
        phone: techPhone,
      },
      assignmentType: 'TENANT_BOOKING_SLOT_MATCH',
      actionUrl: directJobActionUrl,
    };

    dispatchN8NWebhook('TASK_ASSIGNED', taskAssignedPayload).catch(err => {
      console.warn('[N8N_DISPATCH_WARN] Failed to dispatch TASK_ASSIGNED webhook:', err.message);
    });

    // 6. Asynchronously dispatch ADMIN_OFFICE_ALERT to n8n for Admin and Office Team email notifications
    getAdminAndOfficeRecipientEmail(pool)
      .then((recipientEmail) => {
        return dispatchN8NWebhook('ADMIN_OFFICE_ALERT', {
          alertType: 'BOOKING_CONFIRMED',
          recipientEmail,
          workOrderId,
          jobNumber: jobNum || `WO-${workOrderId.substring(0, 6)}`,
          jobTitle,
          propertyAddress: resAddress,
          residentName: resName,
          residentPhone: woRows[0]?.contact_phone,
          technicianName: techName,
          technicianPhone: techPhone,
          scheduledDate: dateVal,
          scheduledTimeSlot: slotVal,
          subject: `[Nexus FMS] Appointment Confirmed: #${jobNum || workOrderId} - ${dateVal} (${slotVal})`,
          headline: 'Maintenance Appointment Confirmed',
          message: `Resident ${resName} has confirmed the appointment for ${dateVal} during ${slotVal} with technician ${techName}.`,
          actionUrl: `${frontendBase}/admin/calendar`,
        });
      })
      .catch((err) => {
        console.warn('[N8N_WEBHOOK] Failed to dispatch BOOKING_CONFIRMED admin alert:', err.message);
      });

    res.status(200).json({
      success: true,
      message: 'Booking slot confirmed successfully.',
      data: {
        workOrderId,
        scheduledDate: dateVal,
        scheduledTimeSlot: slotVal,
        stage: 'Jobs',
      },
    });
  } catch (err) {
    await connection.rollback().catch(() => {});
    connection.release();
    next(err);
  }
};


// @desc    Generate Cryptographic Public Secure Link (Office Admin Only)
// @route   POST /api/v1/jobs/:id/generate-link
// @access  Private (Office Admin & Staff)
const generatePublicRequestLink = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { type } = req.body; // 'QUOTE_UPLOAD' or 'BOOKING'

    const [jobs] = await pool.query('SELECT id, job_number, resident_name FROM work_orders WHERE id = ?', [id]);
    if (jobs.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    const secureToken = `tok_${crypto.randomBytes(32).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days expiration

    const linkType = type === 'BOOKING' ? 'BOOKING' : 'QUOTE_UPLOAD';

    if (linkType === 'QUOTE_UPLOAD') {
      await pool.query(
        `INSERT INTO quote_requests (work_order_id, secure_token, status, expires_at) 
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE secure_token = ?, status = ?, expires_at = ?`,
        [id, secureToken, 'PENDING', expiresAt, secureToken, 'PENDING', expiresAt]
      );
      await QuoteRequestService.triggerAutoPhotoRequest(id).catch(e => {
        console.warn('[generatePublicRequestLink] Could not trigger auto photo request:', e.message);
      });
    } else {
      await pool.query(
        `INSERT INTO booking_requests (work_order_id, secure_token, status, expires_at) 
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE secure_token = ?, status = ?, expires_at = ?`,
        [id, secureToken, 'WAITING_FOR_BOOKING', expiresAt, secureToken, 'WAITING_FOR_BOOKING', expiresAt]
      );
      await BookingRequestService.triggerAutoBookingRequest(id).catch(e => {
        console.warn('[generatePublicRequestLink] Could not trigger auto booking request:', e.message);
      });
    }

    if (linkType === 'BOOKING') {
      const [admins] = await pool.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
      const residentName = jobs[0].resident_name || 'Resident';
      for (const admin of admins) {
        await notificationService.createNotification({
          recipientUserId: admin.id,
          type: 'BOOKING_LINK_SENT',
          title: 'Booking link sent — waiting for resident',
          message: `Booking link sent to ${residentName} for Job #${jobs[0].job_number}`,
          relatedEntityType: 'work_orders',
          relatedEntityId: id,
          actionUrl: `/admin/booking-links`
        });
      }
    }

    const linkUrl = `/public/${linkType.toLowerCase().replace('_', '-')}/${secureToken}`;

    res.status(201).json({
      success: true,
      message: 'Public secure link generated successfully.',
      data: {
        workOrderId: id,
        type: linkType,
        secureToken,
        expiresAt,
        linkUrl,
      },
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get Public Job Completion Report (Evidence Photos, Staff Work Proof, Materials & Payment)
// @route   GET /api/v1/public/jobs/:id/report
// @access  Public (No Login Required)
const getPublicJobCompletionReport = async (req, res, next) => {
  try {
    const { id } = req.params;

    // 1. Fetch work order details
    const [jobs] = await pool.query(
      `SELECT w.*,
              r.full_name as live_resident_name, r.phone as live_contact_phone, r.email as live_contact_email,
              u.full_name as technician_name, u.phone as technician_phone, u.email as technician_email,
              sp.staff_code, sp.role_title
       FROM work_orders w
       LEFT JOIN residents r ON w.resident_id = r.id
       LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
       LEFT JOIN users u ON sp.user_id = u.id
       WHERE w.id = ?`,
      [id]
    );

    if (jobs.length === 0) {
      return res.status(404).json({ success: false, message: `Work order not found with ID ${id}.` });
    }

    const job = jobs[0];

    // 2. Fetch Completion Report, Media & Materials in parallel
    const [[completionReports], [staffMedia], [customerMedia], [materialsRows]] = await Promise.all([
      pool.query('SELECT * FROM staff_job_completions WHERE work_order_id = ? ORDER BY id DESC LIMIT 1', [id]),
      pool.query('SELECT id, file_name, file_path, media_type, created_at FROM staff_completion_media WHERE work_order_id = ?', [id]),
      pool.query('SELECT id, file_name, file_path, media_type, created_at FROM customer_media_uploads WHERE work_order_id = ?', [id]),
      pool.query('SELECT id, material_name, quantity, unit_cost, total_cost, receipt_path FROM job_material_costs WHERE work_order_id = ?', [id])
    ]);

    const completion = completionReports.length > 0 ? completionReports[0] : null;

    // Filter staff photos into before, after, receipts
    const beforePhotos = staffMedia.filter(m => m.media_type === 'BEFORE');
    const afterPhotos = staffMedia.filter(m => m.media_type === 'AFTER');
    const staffReceipts = staffMedia.filter(m => m.media_type === 'RECEIPT');

    const materials = materialsRows.map(m => ({
      id: m.id,
      materialName: m.material_name,
      quantity: parseFloat(m.quantity) || 1,
      unitCost: parseFloat(m.unit_cost) || 0,
      totalCost: parseFloat(m.total_cost) || 0,
      receiptPath: m.receipt_path
    }));

    const totalMaterialCost = materials.reduce((acc, curr) => acc + curr.totalCost, 0);

    const residentName = job.live_resident_name || job.resident_name || 'Resident';
    const residentPhone = job.live_contact_phone || job.contact_phone || '';
    const residentEmail = job.live_contact_email || job.contact_email || '';

    res.status(200).json({
      success: true,
      data: {
        id: job.id,
        jobNumber: job.job_number || `JOB-${job.id}`,
        title: job.title,
        description: job.description,
        propertyAddress: job.property_address,
        pipelineStage: job.pipeline_stage,
        priority: job.priority,
        scheduledDate: job.scheduled_date,
        scheduledTimeSlot: job.scheduled_time_slot,
        completedAt: completion?.completed_at || job.updated_at,
        resident: {
          name: residentName,
          phone: residentPhone,
          email: residentEmail
        },
        technician: {
          name: job.technician_name || 'Assigned Technician',
          phone: job.technician_phone || '',
          email: job.technician_email || '',
          staffCode: job.staff_code || '',
          roleTitle: job.role_title || 'Maintenance Technician'
        },
        report: completion ? {
          summary: completion.work_report_summary,
          status: completion.completion_status,
          materialsNote: completion.materials_used
        } : null,
        residentPhotos: customerMedia.map(m => ({
          id: m.id,
          fileName: m.file_name,
          filePath: m.file_path,
          mediaType: m.media_type,
          createdAt: m.created_at
        })),
        beforePhotos: beforePhotos.map(m => ({
          id: m.id,
          fileName: m.file_name,
          filePath: m.file_path,
          createdAt: m.created_at
        })),
        afterPhotos: afterPhotos.map(m => ({
          id: m.id,
          fileName: m.file_name,
          filePath: m.file_path,
          createdAt: m.created_at
        })),
        receiptPhotos: staffReceipts.map(m => ({
          id: m.id,
          fileName: m.file_name,
          filePath: m.file_path,
          createdAt: m.created_at
        })),
        materials,
        totalMaterialCost,
        currency: '₹'
      }
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getPublicRequestByToken,
  submitPublicQuoteUpload,
  submitPublicBooking,
  generatePublicRequestLink,
  getPublicJobCompletionReport,
};
