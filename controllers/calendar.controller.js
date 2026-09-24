const { pool } = require('../config/db');
const { calculateStaffAvailableSlots, calculateMultiStaffAvailableSlots, timeToMinutes } = require('../services/availability.service');
const notificationService = require('../services/notification.service');
const { dispatchN8NWebhook } = require('../services/webhook.service');

// Helper to resolve staff profile ID from logged in user ID
const getStaffProfileId = async (userId) => {
  const [rows] = await pool.query('SELECT id FROM staff_profiles WHERE user_id = ?', [userId]);
  return rows.length > 0 ? rows[0].id : null;
};

// Helper to format any date input to strict YYYY-MM-DD
const formatDateToISO = (d) => {
  if (!d) return null;
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const dateObj = new Date(d);
  if (isNaN(dateObj.getTime())) {
    const match = String(d).match(/(\d{4})-(\d{2})-(\d{2})/);
    return match ? match[0] : null;
  }
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Helper to format raw database row to Frontend job object
const formatJobRow = (r, role) => {
  let parsedStaffIds = [];
  if (r.assigned_staff_ids) {
    try {
      parsedStaffIds = typeof r.assigned_staff_ids === 'string'
        ? JSON.parse(r.assigned_staff_ids)
        : r.assigned_staff_ids;
    } catch {
      parsedStaffIds = [];
    }
  }
  if (parsedStaffIds.length === 0 && r.assigned_staff_id) {
    parsedStaffIds = [r.assigned_staff_id];
  }

  const job = {
    id: r.id,
    jobNumber: r.job_number,
    section: r.pipeline_stage,
    title: r.title,
    tenantId: r.resident_id || null,
    tenantName: r.live_resident_name || r.resident_name,
    contactPhone: r.live_contact_phone || r.contact_phone,
    contactEmail: r.live_contact_email || r.contact_email || '',
    address: r.live_property_address || r.property_address,
    description: r.description || '',
    durationHours: parseFloat(r.duration_hours || 1.5),
    assignedStaffId: r.assigned_staff_id || null,
    assignedStaffIds: parsedStaffIds,
    assignedStaffCode: r.staff_code || (r.assigned_staff_id ? `STF-${100 + r.assigned_staff_id}` : null),
    assignedStaffName: r.staff_name || null,
    assignedStaffColor: r.staff_color || '#009bf2',
    quoteAmount: r.quote_amount ? parseFloat(r.quote_amount) : null,
    scheduledDate: formatDateToISO(r.scheduled_date),
    scheduledTimeSlot: r.scheduled_time_slot || null,
    priority: r.priority || 'NORMAL',
    secureToken: r.secure_token,
    createdAt: formatDateToISO(r.created_at),
  };

  if (role === 'OFFICE_TEAM' || role === 'MAINTENANCE_STAFF') {
    delete job.quoteAmount;
  }
  return job;
};

// @desc    Get calendar grid dispatches & dynamic staff list
// @route   GET /api/v1/calendar
// @access  Private (Office Admin & Maintenance Staff)
const getCalendar = async (req, res, next) => {
  try {
    const { start, end, staffId } = req.query;
    const staffProfileId = await getStaffProfileId(req.user.id);

    // 1. Strict Authorization Check for Maintenance Staff
    if (req.user.role === 'MAINTENANCE_STAFF') {
      if (staffId) {
        const cleanRequestedStaffId = parseInt(String(staffId).replace(/^(stf-|usr-)/, ''), 10);
        if (cleanRequestedStaffId !== staffProfileId) {
          return res.status(403).json({
            success: false,
            message: 'Forbidden. Maintenance Staff can only view their own calendar schedule.',
          });
        }
      }
    }

    // 2. Build Work Orders Query
    let sql = `
      SELECT 
        w.*,
        r.full_name as live_resident_name,
        r.phone as live_contact_phone,
        r.email as live_contact_email,
        r.address as live_property_address,
        u.full_name as staff_name,
        sp.color_hex as staff_color,
        sp.staff_code
      FROM work_orders w
      LEFT JOIN residents r ON w.resident_id = r.id
      LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
      LEFT JOIN users u ON sp.user_id = u.id
      WHERE w.scheduled_date IS NOT NULL
    `;

    const queryParams = [];

    // Filter by Staff ID
    if (req.user.role === 'MAINTENANCE_STAFF') {
      sql += ' AND (w.assigned_staff_id = ? OR (w.assigned_staff_ids IS NOT NULL AND JSON_CONTAINS(w.assigned_staff_ids, CAST(? AS JSON), "$")))';
      queryParams.push(staffProfileId, staffProfileId);
    } else if (staffId && staffId !== 'ALL') {
      const cleanId = parseInt(String(staffId).replace(/^(stf-|usr-)/, ''), 10);
      sql += ' AND (w.assigned_staff_id = ? OR (w.assigned_staff_ids IS NOT NULL AND JSON_CONTAINS(w.assigned_staff_ids, CAST(? AS JSON), "$")))';
      queryParams.push(cleanId, cleanId);
    }

    // Filter by Date Range
    if (start && start.trim() !== '') {
      sql += ' AND w.scheduled_date >= ?';
      queryParams.push(start.trim());
    }
    if (end && end.trim() !== '') {
      sql += ' AND w.scheduled_date <= ?';
      queryParams.push(end.trim());
    }

    sql += ' ORDER BY w.scheduled_date ASC, w.scheduled_time_slot ASC';

    // 3. Parallel Query Execution for Staff and Jobs
    const [[staffRows], [jobRows]] = await Promise.all([
      pool.query(`
        SELECT 
          COALESCE(sp.id, u.id) as profile_id,
          COALESCE(sp.staff_code, CONCAT('STF-', 100 + u.id)) as staff_code,
          COALESCE(sp.role_title, 'Maintenance Technician') as role_title,
          COALESCE(sp.color_hex, '#009bf2') as color_hex,
          sp.working_days_json,
          sp.work_start_time,
          sp.work_end_time,
          sp.break_start_time,
          sp.break_end_time,
          u.full_name as name,
          u.email
        FROM users u
        LEFT JOIN staff_profiles sp ON u.id = sp.user_id
        WHERE u.role = 'MAINTENANCE_STAFF'
        ORDER BY sp.created_at ASC
      `),
      pool.query(sql, queryParams)
    ]);

    const staffList = staffRows.map(s => {
      let days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
      if (s.working_days_json) {
        try {
          days = typeof s.working_days_json === 'string' ? JSON.parse(s.working_days_json) : s.working_days_json;
        } catch {
          days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
        }
      }
      return {
        id: s.profile_id,
        staffCode: s.staff_code,
        name: s.name,
        email: s.email,
        role: s.role_title,
        color: s.color_hex,
        workingDays: Array.isArray(days) ? days : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        workingHours: {
          start: s.work_start_time ? String(s.work_start_time).substring(0, 5) : '08:00',
          end: s.work_end_time ? String(s.work_end_time).substring(0, 5) : '17:00',
        },
        breakTime: {
          start: s.break_start_time ? String(s.break_start_time).substring(0, 5) : '12:00',
          end: s.break_end_time ? String(s.break_end_time).substring(0, 5) : '13:00',
        },
      };
    });

    const calendarJobs = jobRows.map(r => formatJobRow(r, req.user ? req.user.role : null));

    res.status(200).json({
      success: true,
      staffCount: staffList.length,
      staff: staffList,
      count: calendarJobs.length,
      data: calendarJobs,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get Public Booking Available Slots by Secure Token (TOKEN-SCOPED)
// @route   GET /api/v1/public/booking/:token/available-slots
// @access  Public (No Auth Token Required)
const getPublicBookingAvailableSlots = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Target date query parameter (?date=YYYY-MM-DD) is required.',
      });
    }

    // 1. Resolve Work Order & Assigned / Preferred Technician from Token
    const [bookingRows] = await pool.query(
      `SELECT b.id as request_id, b.work_order_id, b.assignment_preference_staff_id, w.assigned_staff_id, w.duration_hours, w.title, w.description, w.resident_name, w.property_address
       FROM booking_requests b
       JOIN work_orders w ON b.work_order_id = w.id
       WHERE b.secure_token = ?`,
      [token]
    );

    let workOrderId = null;
    let staffProfileId = null;
    let durationHours = 1.5;
    let jobDetails = {};

    if (bookingRows.length > 0) {
      const b = bookingRows[0];
      workOrderId = b.work_order_id;
      staffProfileId = b.assigned_staff_id || b.assignment_preference_staff_id;
      durationHours = parseFloat(b.duration_hours || 1.5);
      jobDetails = {
        title: b.title,
        description: b.description,
        property_address: b.property_address,
        resident_name: b.resident_name,
      };
    } else {
      const [jobRows] = await pool.query(
        'SELECT id, assigned_staff_id, duration_hours, title, description, property_address, resident_name FROM work_orders WHERE secure_token = ?',
        [token]
      );
      if (jobRows.length > 0) {
        const j = jobRows[0];
        workOrderId = j.id;
        staffProfileId = j.assigned_staff_id;
        durationHours = parseFloat(j.duration_hours || 1.5);
        jobDetails = {
          title: j.title,
          description: j.description,
          property_address: j.property_address,
          resident_name: j.resident_name,
        };
      }
    }

    if (!workOrderId) {
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired secure booking token.',
      });
    }

    // 2. Calculate Available Slots for the Assigned/Eligible Technician(s)
    let availabilityResult;
    if (staffProfileId) {
      const singleRes = await calculateStaffAvailableSlots(staffProfileId, date, durationHours);
      if (singleRes.availableSlots && singleRes.availableSlots.length > 0) {
        availabilityResult = singleRes;
      } else {
        // Fallback to multi-staff calculation if assigned staff is off or busy on this date
        availabilityResult = await calculateMultiStaffAvailableSlots(date, durationHours, staffProfileId, jobDetails);
      }
    } else {
      // Dynamic multi-staff calculation across all active technicians
      availabilityResult = await calculateMultiStaffAvailableSlots(date, durationHours, null, jobDetails);
    }

    res.status(200).json({
      success: true,
      workOrderId,
      durationHours,
      availability: availabilityResult,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Dispatch / Reschedule Work Order on Technician Calendar (WITH DOUBLE-BOOKING LOCK)
// @route   POST /api/v1/calendar/dispatch
// @access  Private (Office Admin & Staff)
const dispatchJob = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const {
      workOrderId, id, jobId, work_order_id,
      assignedStaffId, staffId, assigned_staff_id,
      scheduledDate, date, scheduled_date,
      scheduledTimeSlot, timeSlot, time_slot, scheduled_time_slot,
      durationHours, duration_hours
    } = req.body;

    const targetJobId = workOrderId || id || jobId || work_order_id;
    let targetStaffId = assignedStaffId || staffId || assigned_staff_id;
    const targetDate = String(scheduledDate || date || scheduled_date || '').trim();
    const targetSlot = String(scheduledTimeSlot || timeSlot || time_slot || scheduled_time_slot || '').trim();


    if (!targetJobId || !targetDate || !targetSlot) {
      connection.release();
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Work Order ID, Scheduled Date, and Scheduled Time Slot are required.',
      });
    }

    if (targetStaffId && typeof targetStaffId === 'string') {
      targetStaffId = parseInt(targetStaffId.replace(/^(stf-|usr-)/, ''), 10);
    }

    await connection.beginTransaction();

    // 1. Lock Target Work Order Row (SELECT ... FOR UPDATE)
    const [jobRows] = await connection.query(
      'SELECT id, assigned_staff_id, duration_hours FROM work_orders WHERE id = ? FOR UPDATE',
      [targetJobId]
    );

    if (jobRows.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${targetJobId}`,
      });
    }

    const job = jobRows[0];
    const finalStaffId = targetStaffId || job.assigned_staff_id;
    const finalDuration = durationHours ? parseFloat(durationHours) : parseFloat(job.duration_hours || 1.5);

    if (!finalStaffId) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Assigned Technician ID is required for calendar dispatch.',
      });
    }

    // 2. Validate Slot Availability & Overlap Protection
    const availabilityResult = await calculateStaffAvailableSlots(finalStaffId, targetDate, finalDuration, connection);

    if (!availabilityResult.success) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({
        success: false,
        message: `Booking Rejected: ${availabilityResult.reason}`,
      });
    }

    // Check if targetSlot exists in calculated valid slots
    const isSlotValid = availabilityResult.availableSlots.some(s => s.timeSlot === targetSlot || s.startTime === targetSlot);

    if (!isSlotValid) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({
        success: false,
        message: `Booking Rejected: Slot '${targetSlot}' is unavailable for technician ID ${finalStaffId} on ${targetDate} (Outside shift, during break, or overlapping existing job).`,
      });
    }

    // 3. Commit Dispatch / Booking Update
    await connection.query(
      `UPDATE work_orders SET 
        assigned_staff_id = ?,
        scheduled_date = ?,
        scheduled_time_slot = ?,
        pipeline_stage = 'Jobs'
       WHERE id = ?`,
      [finalStaffId, targetDate, targetSlot, targetJobId]
    );

    // Stop reminders if this job had a booking request
    await connection.query(
      "UPDATE booking_requests SET status = 'BOOKED', booked_at = NOW() WHERE work_order_id = ? AND status = 'WAITING_FOR_BOOKING'",
      [targetJobId]
    );

    await connection.commit();
    connection.release();

    const [updatedRows] = await pool.query(
      `SELECT 
        w.*,
        r.full_name as live_resident_name,
        r.phone as live_contact_phone,
        r.email as live_contact_email,
        r.address as live_property_address,
        u.full_name as staff_name,
        sp.color_hex as staff_color,
        sp.staff_code
       FROM work_orders w
       LEFT JOIN residents r ON w.resident_id = r.id
       LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
       LEFT JOIN users u ON sp.user_id = u.id
       WHERE w.id = ?`,
      [targetJobId]
    );

    const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
    const jobNum = updatedRows[0]?.job_number || `JOB-${targetJobId}`;
    const directJobActionUrl = `${frontendBase}/maintenance/my-tasks?jobId=${targetJobId}`;

    // 1. If reassigned from a different staff, notify previous staff
    if (job.assigned_staff_id && job.assigned_staff_id !== finalStaffId) {
      try {
        const [prevStaffRows] = await pool.query(
          "SELECT sp.id, sp.user_id, u.full_name, u.phone as staff_phone, u.phone as user_phone, u.email FROM staff_profiles sp JOIN users u ON sp.user_id = u.id WHERE sp.id = ?",
          [job.assigned_staff_id]
        );
        if (prevStaffRows.length > 0) {
          const prevStaff = prevStaffRows[0];
          const reassignedMsg = `Work Order #${jobNum} (${updatedRows[0]?.title || 'Task'}) at ${updatedRows[0]?.live_property_address || updatedRows[0]?.property_address || ''} has been reassigned to another technician. You are relieved from this task.`;
          await notificationService.createNotification({
            recipientUserId: prevStaff.user_id,
            recipientRole: 'MAINTENANCE_STAFF',
            type: 'TASK_REASSIGNED',
            title: 'Task Reassigned to Another Staff',
            message: reassignedMsg,
            relatedEntityType: 'work_orders',
            relatedEntityId: parseInt(targetJobId, 10),
            actionUrl: `${frontendBase}/maintenance/my-tasks`,
            contactPhone: prevStaff.staff_phone || prevStaff.user_phone,
            contactEmail: prevStaff.email,
            technicianName: prevStaff.full_name,
            technicianPhone: prevStaff.staff_phone || prevStaff.user_phone,
            propertyAddress: updatedRows[0]?.live_property_address || updatedRows[0]?.property_address,
            channels: ['IN_APP', 'SMS', 'EMAIL'],
          });

          dispatchN8NWebhook('TASK_REASSIGNED', {
            event: 'TASK_REASSIGNED',
            type: 'TASK_REASSIGNED',
            entityId: parseInt(targetJobId, 10),
            workOrderId: parseInt(targetJobId, 10),
            jobNumber: jobNum,
            title: updatedRows[0]?.title,
            propertyAddress: updatedRows[0]?.live_property_address || updatedRows[0]?.property_address,
            scheduledDate: targetDate,
            scheduledTimeSlot: targetSlot,
            previousTechnician: {
              id: prevStaff.id,
              name: prevStaff.full_name,
              phone: prevStaff.staff_phone || prevStaff.user_phone,
              email: prevStaff.email,
            },
            technicianName: prevStaff.full_name,
            technicianPhone: prevStaff.staff_phone || prevStaff.user_phone,
            technicianEmail: prevStaff.email,
            contactPhone: prevStaff.staff_phone || prevStaff.user_phone,
            contactEmail: prevStaff.email,
            message: reassignedMsg,
            actionUrl: `${frontendBase}/maintenance/my-tasks`,
            reassignedBy: req.user?.full_name || 'Office Admin',
          }).catch(err => console.warn('[N8N] Reassignment webhook warn:', err.message));
        }
      } catch (prevErr) {
        console.warn('[Calendar] Failed to notify previous staff on reassignment:', prevErr.message);
      }
    }

    // 2. Create Notification & Webhook for the newly assigned staff
    try {
      const [staffUserRows] = await pool.query(
        "SELECT sp.id, sp.user_id, u.full_name, u.phone as staff_phone, u.phone as user_phone, u.email FROM staff_profiles sp JOIN users u ON sp.user_id = u.id WHERE sp.id = ?",
        [finalStaffId]
      );
      
      if (staffUserRows.length > 0) {
        const staff = staffUserRows[0];
        const newAssignMsg = `You have been assigned to Job #${jobNum}: ${updatedRows[0]?.title || 'Maintenance Task'} at ${updatedRows[0]?.live_property_address || updatedRows[0]?.property_address || ''} on ${targetDate} (${targetSlot}). View task: ${directJobActionUrl}`;

        await notificationService.createNotification({
          recipientUserId: staff.user_id,
          recipientRole: 'MAINTENANCE_STAFF',
          type: 'TASK_ASSIGNED',
          title: 'New Task Assigned',
          message: newAssignMsg,
          relatedEntityType: 'work_orders',
          relatedEntityId: parseInt(targetJobId, 10),
          actionUrl: directJobActionUrl,
          technicianName: staff.full_name,
          technicianPhone: staff.staff_phone || staff.user_phone,
          contactPhone: staff.staff_phone || staff.user_phone,
          contactEmail: staff.email,
          propertyAddress: updatedRows[0]?.live_property_address || updatedRows[0]?.property_address,
          channels: ['IN_APP', 'SMS', 'EMAIL'],
          skipWebhook: true,
        });

        dispatchN8NWebhook('TASK_ASSIGNED', {
          event: 'TASK_ASSIGNED',
          type: 'TASK_ASSIGNED',
          entityId: parseInt(targetJobId, 10),
          workOrderId: parseInt(targetJobId, 10),
          jobNumber: jobNum,
          title: updatedRows[0]?.title,
          message: newAssignMsg,
          scheduledDate: targetDate,
          scheduled_date: targetDate,
          date: targetDate,
          scheduledTime: targetSlot,
          scheduled_time: targetSlot,
          scheduledTimeSlot: targetSlot,
          scheduled_time_slot: targetSlot,
          time: targetSlot,
          timeSlot: targetSlot,
          priority: updatedRows[0]?.priority || 'NORMAL',
          propertyAddress: updatedRows[0]?.live_property_address || updatedRows[0]?.property_address,
          residentName: updatedRows[0]?.live_resident_name || updatedRows[0]?.resident_name,
          residentPhone: updatedRows[0]?.live_contact_phone || updatedRows[0]?.contact_phone,
          residentEmail: updatedRows[0]?.live_contact_email || updatedRows[0]?.contact_email,
          residentNotes: updatedRows[0]?.description || '',
          technicianName: staff.full_name,
          technicianEmail: staff.email,
          technicianPhone: staff.staff_phone || staff.user_phone,
          technician: {
            id: staff.id,
            name: staff.full_name,
            email: staff.email,
            phone: staff.staff_phone || staff.user_phone,
          },
          contactPhone: staff.staff_phone || staff.user_phone,
          contactEmail: staff.email,
          assignmentType: (job.assigned_staff_id && job.assigned_staff_id !== finalStaffId) ? 'REASSIGNMENT' : 'CALENDAR_DISPATCH',
          actionUrl: directJobActionUrl,
        }).catch(err => console.warn('[N8N] Dispatch webhook warn:', err.message));
      }
    } catch (notifErr) {
      console.error('[Notification] Failed to notify on job dispatch:', notifErr);
    }

    // 3. Additive notification to original work-order sender on schedule update / reschedule (Rule 4 & P0-5)
    try {
      const origSenderEmail = updatedRows[0]?.original_sender_email || updatedRows[0]?.manager_email;
      if (origSenderEmail) {
        const staffName = updatedRows[0]?.staff_name || 'Assigned Technician';
        const jTitle = updatedRows[0]?.title || 'Maintenance Task';
        const pAddr = updatedRows[0]?.live_property_address || updatedRows[0]?.property_address || '';
        const rName = updatedRows[0]?.live_resident_name || updatedRows[0]?.resident_name || 'Resident';

        await notificationService.dispatch({
          recipientUserId: null,
          recipientRole: 'OFFICE_ADMIN',
          type: 'SENDER_APPOINTMENT_RESCHEDULED',
          title: `Appointment Rescheduled: Job #${jobNum} - ${jTitle}`,
          messageTemplate: `Dear Requester,\n\nPlease note that the appointment for "${jTitle}" at ${pAddr} (Resident: ${rName}) has been scheduled/rescheduled.\n\nNew Scheduled Date: ${targetDate}\nNew Time Slot: ${targetSlot}\nAssigned Staff: ${staffName}\n\nThank you,\nNexus FMS Team`,
          structuredData: {
            job_number: jobNum,
            title: jTitle,
            property_address: pAddr,
            resident_name: rName,
            scheduled_date: targetDate,
            scheduled_time_slot: targetSlot,
            technician_name: staffName
          },
          actionUrl: `/admin/calendar`,
          relatedEntityType: 'work_orders',
          relatedEntityId: parseInt(targetJobId, 10),
          channels: ['EMAIL'],
          contactEmail: origSenderEmail,
        }).catch(err => console.warn('[Calendar] Failed to notify original sender of reschedule:', err.message));
      }
    } catch (senderErr) {
      console.warn('[Calendar] Failed to query/notify original sender on reschedule:', senderErr.message);
    }

    res.status(200).json({
      success: true,
      message: `Work order ID ${targetJobId} dispatched successfully for ${targetDate} (${targetSlot}).`,
      data: formatJobRow(updatedRows[0], req.user ? req.user.role : null),
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    next(err);
  }
};

module.exports = {
  getCalendar,
  getPublicBookingAvailableSlots,
  dispatchJob,
};
