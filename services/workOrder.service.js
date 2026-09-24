const crypto = require('crypto');
const { pool } = require('../config/db');
const notificationService = require('./notification.service');
const QuoteRequestService = require('./quoteRequest.service');
const BookingRequestService = require('./bookingRequest.service');

/**
 * Shared service to create a Work Order / Quote entity.
 * Used by both manual admin API (job.controller.js) and inbound email webhook (webhook.controller.js)
 * to ensure 100% consistent business logic, token generation, resident resolution, and notifications.
 */
const createWorkOrderEntity = async (data, user = null, dbConnection = null) => {
  const db = dbConnection || pool;

  const {
    title,
    resident_id, tenantId,
    resident_name, tenantName,
    contact_phone, phone, contactPhone,
    contact_email, email, contactEmail,
    property_address, address,
    description,
    duration_hours, durationHours,
    assigned_staff_id, assignedStaffId,
    manager_name, managerName,
    quote_amount, quoteAmount,
    section, pipeline_stage,
    scheduled_date, scheduledDate,
    scheduled_time_slot, scheduledTimeSlot,
    priority,
    assigned_staff_ids, assignedStaffIds,
    external_reference_id, reference_id,
    original_sender_email,
    actual_manager_email, manager_email,
  } = data;

  let resId = resident_id || tenantId || null;
  let resName = (resident_name || tenantName || '').trim();
  let resPhone = (contact_phone || phone || contactPhone || '').trim();
  let resAddress = (property_address || address || '').trim();
  let resEmail = (contact_email || email || contactEmail || '').trim() || null;

  // Validation
  const jobTitle = (title || '').trim();
  if (!jobTitle) {
    const err = new Error('Validation Error: Work order title is required.');
    err.status = 400;
    throw err;
  }
  if (!resName) {
    const err = new Error('Validation Error: Resident Name is required.');
    err.status = 400;
    throw err;
  }
  if (!resPhone) {
    const err = new Error('Validation Error: Contact Phone Number is required.');
    err.status = 400;
    throw err;
  }
  if (!resAddress) {
    const err = new Error('Validation Error: Property Address is required.');
    err.status = 400;
    throw err;
  }

  // 1. If resident_id is passed, fetch real resident details from residents table
  if (resId) {
    const cleanResId = String(resId).replace(/^(ten-|res-)/, '');
    const [resRows] = await db.query('SELECT * FROM residents WHERE id = ?', [cleanResId]);
    if (resRows.length > 0) {
      const resObj = resRows[0];
      resId = resObj.id;
      resName = resObj.full_name;
      resPhone = resObj.phone;
      resAddress = resObj.address;
      if (resObj.email) resEmail = resObj.email;
    }
  }

  // 2. If resident_id is NOT passed, auto-link or create resident record in residents table
  if (!resId && resName && resPhone && resAddress) {
    const [existingRes] = await db.query('SELECT id FROM residents WHERE phone = ? OR full_name = ?', [resPhone, resName]);
    if (existingRes.length > 0) {
      resId = existingRes[0].id;
    } else {
      const [newResResult] = await db.query(
        'INSERT INTO residents (full_name, phone, email, address) VALUES (?, ?, ?, ?)',
        [resName, resPhone, resEmail, resAddress]
      );
      resId = newResResult.insertId;
    }
  }

  const jobDesc = (description || '').trim() || null;
  const hours = parseFloat(duration_hours || durationHours || 1.5);
  const stage = pipeline_stage || section || 'Quotes';
  const mgrName = (manager_name || managerName || (user ? user.full_name : null) || 'Office Admin').trim();
  const quoteVal = quote_amount || quoteAmount ? parseFloat(quote_amount || quoteAmount) : null;
  const schedDate = scheduled_date || scheduledDate || null;
  const schedSlot = scheduled_time_slot || scheduledTimeSlot || null;
  const jobPriority = priority || 'NORMAL';
  const staffIdsArr = assigned_staff_ids || assignedStaffIds || [];
  const staffIdsJson = staffIdsArr.length > 0 ? JSON.stringify(staffIdsArr) : null;
  const extRefId = (external_reference_id || reference_id || '').trim() || null;
  const origSenderEmail = (original_sender_email || '').trim() || null;
  const actualMgrEmail = (actual_manager_email || manager_email || (user ? user.email : null) || origSenderEmail || null);
  const creatorUserId = user ? user.id : null;

  // Coordinates near London for default mapping
  const mockLat = 51.5074 + (Math.random() - 0.5) * 0.1;
  const mockLng = -0.1278 + (Math.random() - 0.5) * 0.1;

  // Clean & resolve Staff Profile ID (supports profile_id or user_id)
  let rawStaffId = assigned_staff_id || assignedStaffId || (staffIdsArr.length > 0 ? staffIdsArr[0] : null);
  if (rawStaffId) {
    const cleanId = String(rawStaffId).replace(/^(stf-|usr-)/, '');
    const [spRows] = await db.query(
      'SELECT id FROM staff_profiles WHERE id = ? OR user_id = ?',
      [cleanId, cleanId]
    );
    if (spRows.length > 0) {
      rawStaffId = spRows[0].id;
    } else {
      const [uRows] = await db.query('SELECT id FROM users WHERE id = ? AND role = "MAINTENANCE_STAFF"', [cleanId]);
      if (uRows.length > 0) {
        const [insRes] = await db.query(
          'INSERT INTO staff_profiles (user_id, staff_code, role_title, color_hex) VALUES (?, ?, ?, ?)',
          [uRows[0].id, `STF-${100 + Number(uRows[0].id)}`, 'Maintenance Specialist', '#009bf2']
        );
        rawStaffId = insRes.insertId;
      } else {
        rawStaffId = null;
      }
    }
  }

  // Generate unique job number & cryptographically strong 32-byte secure token
  const randomNumber = Math.floor(1000 + Math.random() * 9000);
  const jobNumber = `JOB-2026-${randomNumber}`;
  const secureToken = `tok_${crypto.randomBytes(32).toString('hex')}`;

  const [result] = await db.query(
    `INSERT INTO work_orders (
      job_number, title, resident_id, resident_name, contact_phone, contact_email,
      property_address, description, duration_hours, pipeline_stage,
      assigned_staff_id, assigned_staff_ids, priority, latitude, longitude,
      manager_name, quote_amount, scheduled_date,
      scheduled_time_slot, secure_token, created_by, manager_email,
      external_reference_id, original_sender_email
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jobNumber, jobTitle, resId, resName, resPhone, resEmail,
      resAddress, jobDesc, hours, stage,
      rawStaffId, staffIdsJson, jobPriority, mockLat, mockLng,
      mgrName, quoteVal, schedDate,
      schedSlot, secureToken, creatorUserId, actualMgrEmail,
      extRefId, origSenderEmail
    ]
  );

  const workOrderId = result.insertId;

  // Retrieve new job row
  const [newJobRows] = await db.query(
    `SELECT 
      w.*,
      (SELECT SUM(total_cost) FROM job_material_costs jmc WHERE jmc.work_order_id = w.id) AS total_material_cost,
      r.full_name as live_resident_name,
      r.phone as live_contact_phone,
      r.email as live_contact_email,
      r.address as live_property_address,
      u.full_name as staff_name,
      sp.color_hex as staff_color
     FROM work_orders w
     LEFT JOIN residents r ON w.resident_id = r.id
     LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
     LEFT JOIN users u ON sp.user_id = u.id
     WHERE w.id = ?`,
    [workOrderId]
  );

  // Notification Triggers
  // NOTE (P0-1): triggerAutoPhotoRequest is intentionally NOT called here.
  // When called from webhook.controller.js (inbound email path), a DB transaction
  // is still open at this point. Triggering the photo-request SMS before conn.commit()
  // would send an external notification for a work order that may later be rolled back.
  // Instead, createWorkOrderEntity returns shouldTriggerPhotoRequest: true and the
  // caller is responsible for calling QuoteRequestService.triggerAutoPhotoRequest()
  // ONLY after a successful conn.commit().
  //
  // When called from job.controller.js (manual admin path), no transaction wrapper
  // is used — pool auto-commits each statement — so the caller must also trigger
  // photo request after the service returns (already handled by createJob delegation).
  const shouldTriggerPhotoRequest = (stage === 'Quotes');

  if (stage === 'Quotes') {
    const [admins] = await db.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
    for (const admin of admins) {
      await notificationService.createNotification({
        recipientUserId: admin.id,
        type: 'NEW_QUOTE_REQUEST',
        title: 'New repair request received',
        message: `${jobTitle} for ${resName} at ${resAddress}`,
        relatedEntityType: 'work_orders',
        relatedEntityId: workOrderId,
        actionUrl: `/admin/pipeline?stage=Quotes`
      });
    }
  }

  if (stage === 'Jobs') {
    BookingRequestService.triggerAutoBookingRequest(workOrderId);
  }

  if (rawStaffId) {
    const [spUser] = await db.query(
      'SELECT sp.id, sp.user_id, u.full_name, u.phone as staff_phone, u.phone as user_phone, u.email FROM staff_profiles sp JOIN users u ON sp.user_id = u.id WHERE sp.id = ?',
      [rawStaffId]
    );
    if (spUser.length > 0) {
      const staff = spUser[0];
      const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
      const directJobActionUrl = `${frontendBase}/maintenance/my-tasks?jobId=${workOrderId}`;
      const newAssignMsg = `You have been assigned to Job #${jobNumber}: ${jobTitle} at ${resAddress}. Open task portal: ${directJobActionUrl}`;

      await notificationService.createNotification({
        recipientUserId: staff.user_id,
        recipientRole: 'MAINTENANCE_STAFF',
        type: 'TASK_ASSIGNED',
        title: 'New Task Assigned',
        message: newAssignMsg,
        relatedEntityType: 'work_orders',
        relatedEntityId: workOrderId,
        actionUrl: directJobActionUrl,
        technicianName: staff.full_name,
        technicianPhone: staff.staff_phone || staff.user_phone,
        contactPhone: staff.staff_phone || staff.user_phone,
        contactEmail: staff.email,
        propertyAddress: resAddress,
      }).catch(err => console.error('[workOrderService] Error notifying assigned staff:', err.message));

      // Audit log for manual assignment upon creation
      await db.query(
        `INSERT INTO job_assignment_logs 
          (work_order_id, staff_id, assigned_by, assignment_type, trade_category, match_score, selection_reason)
         VALUES (?, ?, ?, 'MANUAL_ADMIN', NULL, 0, ?)`,
        [
          workOrderId,
          rawStaffId,
          user?.full_name || 'Office Admin',
          `Manually assigned by ${user?.full_name || 'Office Admin'} upon creation`,
        ]
      ).catch((logErr) => console.warn('[workOrderService] Failed to log assignment:', logErr.message));
    }
  }

  // Create Notification for new job to all admins
  try {
    const [adminRows] = await db.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
    for (const admin of adminRows) {
      await notificationService.createNotification({
        recipientUserId: admin.id,
        type: 'NEW_JOB',
        title: 'New Maintenance Job Created',
        message: `Job #${jobNumber} (${jobTitle}) has been created in ${stage}.`,
        relatedEntityType: 'work_orders',
        relatedEntityId: workOrderId,
        actionUrl: '/admin/pipeline'
      }).catch(() => {});
    }
  } catch (notifErr) {
    console.warn('[workOrderService] Failed to notify on job creation:', notifErr.message);
  }

  return {
    workOrderId,
    jobNumber,
    secureToken,
    residentId: resId,
    jobRow: newJobRows[0] || null,
    // P0-1: Caller MUST check this flag and trigger photo request AFTER a successful DB commit.
    // Never trigger inside an open transaction.
    shouldTriggerPhotoRequest,
  };
};

module.exports = {
  createWorkOrderEntity,
};
