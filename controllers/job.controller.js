const crypto = require('crypto');
const { pool } = require('../config/db');
const notificationService = require('../services/notification.service');
const QuoteRequestService = require('../services/quoteRequest.service');
const BookingRequestService = require('../services/bookingRequest.service');
const { uploadMediaFile } = require('../services/cloudinary.service');
const { dispatchN8NWebhook, getAdminAndOfficeRecipientEmail } = require('../services/webhook.service');
const { createWorkOrderEntity } = require('../services/workOrder.service');


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
  const assignedStaffIds = r.assigned_staff_ids 
    ? (typeof r.assigned_staff_ids === 'string' ? JSON.parse(r.assigned_staff_ids) : r.assigned_staff_ids) 
    : (r.assigned_staff_id ? [r.assigned_staff_id] : []);

  const job = {
    id: r.id,
    jobNumber: r.job_number,
    section: r.pipeline_stage, // Maps to 5 Kanban stages
    title: r.title,
    tenantId: r.resident_id || null,
    tenantName: r.live_resident_name || r.resident_name,
    contactPhone: r.live_contact_phone || r.contact_phone,
    contactEmail: r.live_contact_email || r.contact_email || '',
    address: r.live_property_address || r.property_address,
    description: r.description || '',
    durationHours: parseFloat(r.duration_hours || 1.5),
    assignedStaffId: r.assigned_staff_id || null,
    assignedStaffIds: assignedStaffIds,
    assignedStaffNames: r.assigned_staff_names ? (typeof r.assigned_staff_names === 'string' ? JSON.parse(r.assigned_staff_names) : r.assigned_staff_names) : (r.staff_name ? [r.staff_name] : []),
    priority: r.priority || 'NORMAL',
    latitude: r.latitude || null,
    longitude: r.longitude || null,
    assignedStaffCode: r.staff_code || (r.assigned_staff_id ? `STF-${100 + r.assigned_staff_id}` : null),
    assignedStaffName: r.staff_name || null,
    assignedStaffColor: r.staff_color || '#009bf2',
    managerName: r.manager_name || null,
    quoteAmount: r.quote_amount ? parseFloat(r.quote_amount) : null,
    scheduledDate: formatDateToISO(r.scheduled_date || r.booked_date || r.appointment_date),
    scheduledTimeSlot: r.scheduled_time_slot || r.booked_time_slot || r.time_slot || null,
    secureToken: r.secure_token,
    createdAt: formatDateToISO(r.created_at),
    bookingStatus: r.booking_status || null,
    
    // Cancellation Properties
    cancellationType: r.cancellation_type || null,
    cancellationReason: r.cancellation_reason || null,
    cancelledBy: r.cancelled_by || null,
    cancellerName: r.canceller_name || null,
    cancelledAt: r.cancelled_at || null,
    previousAppointmentDate: formatDateToISO(r.previous_appointment_date),
    previousAppointmentTime: r.previous_appointment_time || null,
  };

  // Financials
  const quoteAmount = r.quote_amount ? parseFloat(r.quote_amount) : 0;
  const totalMaterialCost = r.total_material_cost ? parseFloat(r.total_material_cost) : 0;
  
  job.quoteAmount = quoteAmount;
  job.totalMaterialCost = totalMaterialCost;
  job.revenue = quoteAmount;
  job.totalJobCost = totalMaterialCost;
  job.profit = job.revenue - job.totalJobCost;
  job.profitMargin = job.revenue > 0 ? ((job.profit / job.revenue) * 100).toFixed(2) + '%' : '0%';

  if (role === 'OFFICE_TEAM') {
    delete job.quoteAmount;
    delete job.totalMaterialCost;
    delete job.revenue;
    delete job.totalJobCost;
    delete job.profit;
    delete job.profitMargin;
  }

  if (role === 'MAINTENANCE_STAFF') {
    delete job.quoteAmount;
    // They CAN see totalMaterialCost (as they entered it), but not revenue/profit
    delete job.revenue;
    delete job.totalJobCost;
    delete job.profit;
    delete job.profitMargin;
  }
  
  return job;
};

// @desc    Get all work orders / jobs (supports section, search, and staff filters)
// @route   GET /api/v1/jobs
// @access  Private (JWT Required)
const getJobs = async (req, res, next) => {
  try {
    const { section, search, staffId } = req.query;

    let sql = `
      SELECT 
        w.*,
        COALESCE(w.scheduled_date, b.booked_date) as scheduled_date,
        COALESCE(w.scheduled_time_slot, b.booked_time_slot) as scheduled_time_slot,
        b.booked_date,
        b.booked_time_slot,
        (SELECT SUM(total_cost) FROM job_material_costs jmc WHERE jmc.work_order_id = w.id) AS total_material_cost,
        r.full_name as live_resident_name,
        r.phone as live_contact_phone,
        r.email as live_contact_email,
        r.address as live_property_address,
        u.full_name as staff_name,
        sp.color_hex as staff_color,
        b.status as booking_status,
        u_cancel.full_name as canceller_name
      FROM work_orders w
      LEFT JOIN residents r ON w.resident_id = r.id
      LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
      LEFT JOIN users u ON sp.user_id = u.id
      LEFT JOIN booking_requests b ON w.id = b.work_order_id
      LEFT JOIN users u_cancel ON w.cancelled_by = u_cancel.id
      WHERE 1=1
    `;

    const queryParams = [];

    if (section && section.trim() !== '') {
      const trimmedSection = section.trim();
      if (trimmedSection === 'Invoiced' || trimmedSection === 'Invoice') {
        sql += " AND w.pipeline_stage IN ('Invoiced', 'Invoice')";
      } else {
        sql += ' AND w.pipeline_stage = ?';
        queryParams.push(trimmedSection);
      }
    }

    // Role-based data isolation
    if (req.user && req.user.role === 'MAINTENANCE_STAFF') {
      if (req.user.staffProfileId) {
        sql += ' AND (w.assigned_staff_id = ? OR (w.assigned_staff_ids IS NOT NULL AND JSON_CONTAINS(w.assigned_staff_ids, CAST(? AS JSON), "$")))';
        queryParams.push(req.user.staffProfileId, req.user.staffProfileId);
      } else {
        // If they have no profile yet, they shouldn't see any jobs
        sql += ' AND w.assigned_staff_id = -1';
      }
    } else if (staffId && staffId.trim() !== '' && staffId !== 'ALL') {
      const cleanStaffId = parseInt(staffId.replace(/^(stf-|usr-)/, ''), 10);
      sql += ' AND (w.assigned_staff_id = ? OR (w.assigned_staff_ids IS NOT NULL AND JSON_CONTAINS(w.assigned_staff_ids, CAST(? AS JSON), "$")))';
      queryParams.push(cleanStaffId, cleanStaffId);
    }

    if (search && search.trim() !== '') {
      const term = `%${search.trim()}%`;
      sql += ' AND (w.title LIKE ? OR w.resident_name LIKE ? OR r.full_name LIKE ? OR w.contact_phone LIKE ? OR w.property_address LIKE ? OR w.job_number LIKE ?)';
      queryParams.push(term, term, term, term, term, term);
    }

    sql += ' ORDER BY w.created_at DESC';

    const [rows] = await pool.query(sql, queryParams);

    const jobIds = rows.map(r => r.id);
    let mediaByJob = {};
    let reportByJob = {};
    let customerMediaByJob = {};
    if (jobIds.length > 0) {
      try {
        const [[mediaRows], [reportRows], [customerMediaRows]] = await Promise.all([
          pool.query(
            'SELECT id, work_order_id, file_name, file_path, file_size_bytes, mime_type, media_type, created_at FROM staff_completion_media WHERE work_order_id IN (?)',
            [jobIds]
          ),
          pool.query(
            'SELECT id, work_order_id, staff_id, work_report_summary, materials_used, completion_status, completed_at FROM staff_job_completions WHERE work_order_id IN (?)',
            [jobIds]
          ),
          pool.query(
            'SELECT id, work_order_id, quote_request_id, file_name, file_path, file_size_bytes, media_type, created_at FROM customer_media_uploads WHERE work_order_id IN (?)',
            [jobIds]
          ).catch(err => {
            console.warn('[job.controller] Error fetching customer media:', err.message);
            return [[]];
          })
        ]);
        mediaRows.forEach(m => {
          if (!mediaByJob[m.work_order_id]) mediaByJob[m.work_order_id] = [];
          mediaByJob[m.work_order_id].push({
            id: m.id,
            fileName: m.file_name,
            filePath: m.file_path,
            fileSize: m.file_size_bytes,
            mimeType: m.mime_type,
            mediaType: m.media_type,
            uploadedAt: m.created_at,
          });
        });

        reportRows.forEach(r => {
          reportByJob[r.work_order_id] = {
            id: r.id,
            workReportSummary: r.work_report_summary,
            materialsUsed: r.materials_used,
            completionStatus: r.completion_status,
            completedAt: r.completed_at,
          };
        });

        customerMediaRows.forEach(cm => {
          if (!customerMediaByJob[cm.work_order_id]) customerMediaByJob[cm.work_order_id] = [];
          customerMediaByJob[cm.work_order_id].push({
            id: cm.id,
            quoteRequestId: cm.quote_request_id,
            fileName: cm.file_name,
            filePath: cm.file_path,
            fileSize: cm.file_size_bytes,
            mediaType: cm.media_type,
            uploadedAt: cm.created_at,
          });
        });
      } catch (err) {
        console.warn('[job.controller] Error fetching media/reports:', err.message);
      }
    }

    const jobs = rows.map(r => {
      const formatted = formatJobRow(r, req.user ? req.user.role : null);
      formatted.completionPhotos = mediaByJob[r.id] || [];
      formatted.completionReport = reportByJob[r.id] || null;
      formatted.customerPhotos = customerMediaByJob[r.id] || [];
      formatted.customerPhotosCount = (customerMediaByJob[r.id] || []).length;
      return formatted;
    });

    res.status(200).json({
      success: true,
      count: jobs.length,
      data: jobs,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get single work order by ID
// @route   GET /api/v1/jobs/:id
// @access  Private (JWT Required)
const getJobById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.query(
      `SELECT 
        w.*,
        COALESCE(w.scheduled_date, b.booked_date) as scheduled_date,
        COALESCE(w.scheduled_time_slot, b.booked_time_slot) as scheduled_time_slot,
        b.booked_date,
        b.booked_time_slot,
        (SELECT SUM(total_cost) FROM job_material_costs jmc WHERE jmc.work_order_id = w.id) AS total_material_cost,
        r.full_name as live_resident_name,
        r.phone as live_contact_phone,
        r.email as live_contact_email,
        r.address as live_property_address,
        u.full_name as staff_name,
        sp.color_hex as staff_color,
        b.status as booking_status,
        u_cancel.full_name as canceller_name
      FROM work_orders w
      LEFT JOIN residents r ON w.resident_id = r.id
      LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
      LEFT JOIN users u ON sp.user_id = u.id
      LEFT JOIN booking_requests b ON w.id = b.work_order_id
      LEFT JOIN users u_cancel ON w.cancelled_by = u_cancel.id
      WHERE w.id = ? OR w.job_number = ? OR w.secure_token = ?`,
      [id, id, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with identifier '${id}'`,
      });
    }

    let completionPhotos = [];
    let completionReport = null;
    let customerPhotos = [];
    try {
      const [[mediaRows], [reportRows], [customerMediaRows]] = await Promise.all([
        pool.query(
          'SELECT id, work_order_id, file_name, file_path, file_size_bytes, mime_type, media_type, created_at FROM staff_completion_media WHERE work_order_id = ?',
          [rows[0].id]
        ),
        pool.query(
          'SELECT id, work_order_id, staff_id, work_report_summary, materials_used, completion_status, completed_at FROM staff_job_completions WHERE work_order_id = ?',
          [rows[0].id]
        ),
        pool.query(
          'SELECT id, work_order_id, quote_request_id, file_name, file_path, file_size_bytes, media_type, created_at FROM customer_media_uploads WHERE work_order_id = ?',
          [rows[0].id]
        ).catch(err => {
          console.warn('[job.controller] Error fetching customer media for single job:', err.message);
          return [[]];
        })
      ]);

      completionPhotos = mediaRows.map(m => ({
        id: m.id,
        fileName: m.file_name,
        filePath: m.file_path,
        fileSize: m.file_size_bytes,
        mimeType: m.mime_type,
        mediaType: m.media_type,
        uploadedAt: m.created_at,
      }));

      customerPhotos = customerMediaRows.map(cm => ({
        id: cm.id,
        quoteRequestId: cm.quote_request_id,
        fileName: cm.file_name,
        filePath: cm.file_path,
        fileSize: cm.file_size_bytes,
        mediaType: cm.media_type,
        uploadedAt: cm.created_at,
      }));

      if (reportRows.length > 0) {
        completionReport = {
          id: reportRows[0].id,
          workReportSummary: reportRows[0].work_report_summary,
          materialsUsed: reportRows[0].materials_used,
          completionStatus: reportRows[0].completion_status,
          completedAt: reportRows[0].completed_at,
        };
      }
    } catch (e) {
      console.warn('[job.controller] Error fetching completion media for single job:', e.message);
    }

    const formatted = formatJobRow(rows[0], req.user ? req.user.role : null);
    formatted.completionPhotos = completionPhotos;
    formatted.completionReport = completionReport;
    formatted.customerPhotos = customerPhotos;
    formatted.customerPhotosCount = customerPhotos.length;

    res.status(200).json({
      success: true,
      data: formatted,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Create new work order (Contact Search / Auto-fill or Manual Resident Entry)
// @route   POST /api/v1/jobs
// @access  Private (Office Admin & Staff)
const createJob = async (req, res, next) => {
  try {
    const creationResult = await createWorkOrderEntity(req.body, req.user);

    // P0-1: Photo request triggered AFTER the service returns.
    // createWorkOrderEntity uses pool (auto-commit per statement), so the work order
    // is already persisted at this point — safe to send the SMS/email now.
    if (creationResult.shouldTriggerPhotoRequest) {
      QuoteRequestService.triggerAutoPhotoRequest(creationResult.workOrderId).catch(err => {
        console.error('[createJob] Error triggering auto photo request:', err.message);
      });
    }

    res.status(201).json({
      success: true,
      message: 'Work order created successfully.',
      data: formatJobRow(creationResult.jobRow, req.user ? req.user.role : null),
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Update work order pipeline stage (Drag & Drop Kanban movement)
// @route   PUT /api/v1/jobs/:id/stage
// @access  Private (Office Admin & Staff)
const moveJobStage = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { section, pipeline_stage } = req.body;
    const newStage = pipeline_stage || section;

    const allowedStages = ['Quotes', 'Ready to Quote', 'READY_TO_QUOTE', 'Completed Quotes', 'Jobs', 'Completed Jobs', 'Jobs Waiting Booking', 'Invoiced', 'Invoice'];
    if (!newStage || !allowedStages.includes(newStage)) {
      return res.status(400).json({
        success: false,
        message: `Invalid stage. Must be one of: ${allowedStages.join(', ')}`,
      });
    }

    let normalizedStage = newStage === 'Invoice' ? 'Invoiced' : newStage;
    if (normalizedStage === 'Ready to Quote') {
      normalizedStage = 'READY_TO_QUOTE';
    }

    const [existing] = await pool.query('SELECT id, assigned_staff_id, pipeline_stage FROM work_orders WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    // Maintenance Staff Ownership Check: Staff can ONLY move jobs assigned to them
    if (req.user.role === 'MAINTENANCE_STAFF') {
      const [userStaffProfile] = await pool.query('SELECT id FROM staff_profiles WHERE user_id = ?', [req.user.id]);
      const currentStaffProfileId = userStaffProfile.length > 0 ? userStaffProfile[0].id : null;

      if (!currentStaffProfileId || existing[0].assigned_staff_id !== currentStaffProfileId) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden. Maintenance Staff can only move work orders assigned to them.',
        });
      }
    }

    try {
      await pool.query('UPDATE work_orders SET pipeline_stage = ? WHERE id = ?', [normalizedStage, id]);
    } catch (dbErr) {
      if (dbErr.message && (dbErr.message.includes('Data truncated') || dbErr.code === 'WARN_DATA_TRUNCATED' || dbErr.errno === 1265)) {
        console.warn('[moveJobStage] Data truncation on pipeline_stage. Altering column to VARCHAR(100)...');
        await pool.query("ALTER TABLE work_orders MODIFY COLUMN pipeline_stage VARCHAR(100) NOT NULL DEFAULT 'Quotes'");
        await pool.query('UPDATE work_orders SET pipeline_stage = ? WHERE id = ?', [normalizedStage, id]);
      } else {
        throw dbErr;
      }
    }

    if (normalizedStage === 'Quotes' && existing[0].pipeline_stage !== 'Quotes') {
      await QuoteRequestService.triggerAutoPhotoRequest(id).catch(err => {
        console.error('[moveJobStage] Error triggering auto photo request:', err.message);
      });
    }

    // When admin moves quote to Completed Quotes: trigger single booking request to resident (if not already sent)
    if (normalizedStage === 'Completed Quotes' && existing[0].pipeline_stage !== 'Completed Quotes') {
      const [existingBooking] = await pool.query(
        'SELECT id, status FROM booking_requests WHERE work_order_id = ?',
        [id]
      );
      if (existingBooking.length === 0 || existingBooking[0].status === 'EXPIRED') {
        await BookingRequestService.triggerAutoBookingRequest(id).catch(err => {
          console.error('[moveJobStage] Error triggering auto booking request on Completed Quotes:', err.message);
        });
      } else {
        console.log(`[moveJobStage] Booking request already exists for work order #${id} (status: ${existingBooking[0].status}), skipping duplicate trigger.`);
      }
    }

    if (normalizedStage === 'Jobs' && existing[0].pipeline_stage !== 'Jobs') {
      const [existingBooking] = await pool.query(
        'SELECT id, status FROM booking_requests WHERE work_order_id = ?',
        [id]
      );
      if (existingBooking.length === 0) {
        await BookingRequestService.triggerAutoBookingRequest(id).catch(err => {
          console.error('[moveJobStage] Error triggering auto booking request:', err.message);
        });
      }
    }

    const [updatedRows] = await pool.query(
      `SELECT 
        w.*,
        (SELECT SUM(total_cost) FROM job_material_costs jmc WHERE jmc.work_order_id = w.id) AS total_material_cost,
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
      [id]
    );

    // Create Notification for Pipeline Update (Internal in-app notification only; never send external SMS/Email to tenant)
    try {
      const [adminRows] = await pool.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
      for (const admin of adminRows) {
        await notificationService.createNotification({
          recipientUserId: admin.id,
          recipientRole: 'OFFICE_ADMIN',
          type: 'PIPELINE_UPDATE',
          title: 'Pipeline Stage Updated',
          message: `Work Order #${id} moved to "${newStage}".`,
          relatedEntityType: 'work_orders',
          relatedEntityId: parseInt(id, 10),
          actionUrl: '/admin/pipeline',
          channels: ['IN_APP'],
          skipWebhook: true
        });
      }
    } catch (notifErr) {
      console.error('[Notification] Failed to notify on pipeline update:', notifErr);
    }

    // If stage moved to Completed Jobs, notify Tenant and Staff as well as N8N
    if (normalizedStage === 'Completed Jobs' && existing[0].pipeline_stage !== 'Completed Jobs') {
      try {
        const row = updatedRows[0];
        const tName = row?.live_resident_name || row?.resident_name || 'Resident';
        const tPhone = row?.live_contact_phone || row?.contact_phone || null;
        const tEmail = row?.live_contact_email || row?.contact_email || null;
        const pAddress = row?.live_property_address || row?.property_address || '';
        const jNum = row?.job_number || id;
        const techStaffName = row?.staff_name || 'Technician';
        const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
        const completionReportUrl = `${frontendBase}/jobs/${id}/report`;

        // Notify Tenant (Mukul) - in-app record only, dedicated single N8N webhook handles SMS/Email
        notificationService.createNotification({
          recipientRole: 'TENANT',
          recipientUserId: null,
          type: 'JOB_COMPLETED',
          title: `Repair Job Completed: #${jNum}`,
          message: `Dear ${tName}, your repair job #${jNum} ("${row?.title}") at ${pAddress} has been completed by technician ${techStaffName}. Thank you!`,
          contactPhone: tPhone,
          contactEmail: tEmail,
          technicianName: techStaffName,
          name: tName,
          propertyAddress: pAddress,
          relatedEntityType: 'work_orders',
          relatedEntityId: parseInt(id, 10),
          channels: ['IN_APP'],
          skipWebhook: true,
          data: {
            workOrderId: parseInt(id, 10),
            jobNumber: jNum,
            title: row?.title,
            residentName: tName,
            name: tName,
            recipientName: tName,
            residentPhone: tPhone,
            residentEmail: tEmail,
            technicianName: techStaffName,
            propertyAddress: pAddress,
            status: 'COMPLETED'
          }
        }).catch(err => console.warn('[JOB_COMPLETED_NOTIF_WARN] Tenant notification failed:', err.message));

        // Dispatch single authoritative N8N Webhook with PDF report link
        dispatchN8NWebhook('JOB_COMPLETED', {
          event: 'JOB_COMPLETED',
          type: 'JOB_COMPLETED',
          entityId: parseInt(id, 10),
          workOrderId: parseInt(id, 10),
          jobNumber: jNum,
          title: row?.title,
          message: `Job #${jNum} ("${row?.title}") completed by ${techStaffName} for resident ${tName}`,
          residentName: tName,
          name: tName,
          recipientName: tName,
          residentPhone: tPhone,
          residentEmail: tEmail,
          contactPhone: tPhone,
          contactEmail: tEmail,
          to: tPhone,
          phone: tPhone,
          email: tEmail,
          technicianName: techStaffName,
          propertyAddress: pAddress,
          status: 'COMPLETED',
          completedAt: new Date().toISOString(),
          actionUrl: completionReportUrl,
          reportUrl: completionReportUrl,
          pdfReportUrl: completionReportUrl
        }).catch(err => console.warn('[N8N_DISPATCH_WARN] Failed to dispatch JOB_COMPLETED webhook:', err.message));

        // Asynchronously dispatch ADMIN_OFFICE_ALERT to n8n for Admin and Office Team email notifications
        getAdminAndOfficeRecipientEmail(pool)
          .then((recipientEmail) => {
            return dispatchN8NWebhook('ADMIN_OFFICE_ALERT', {
              alertType: 'JOB_COMPLETED',
              recipientEmail,
              workOrderId: parseInt(id, 10),
              jobNumber: jNum,
              jobTitle: row?.title,
              propertyAddress: pAddress,
              technicianName: techStaffName,
              residentName: tName,
              residentPhone: tPhone,
              actionUrl: completionReportUrl,
              subject: `[Nexus FMS] Job Completed: #${jNum || id} by ${techStaffName}`,
              headline: 'Work Order Completed by Technician',
              message: `Technician ${techStaffName} has completed work order #${jNum || id} ("${row?.title}") at ${pAddress}.`,
            });
          })
          .catch((err) => {
            console.warn('[N8N_WEBHOOK] Failed to dispatch JOB_COMPLETED admin alert:', err.message);
          });
      } catch (e) {
        console.warn('[moveJobStage] Error dispatching completed job events:', e.message);
      }
    }

    res.status(200).json({
      success: true,
      message: `Work order moved to stage '${newStage}'.`,
      data: formatJobRow(updatedRows[0], req.user ? req.user.role : null),
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Update work order status, quote amount, or assigned staff
// @route   PUT /api/v1/jobs/:id/status
// @access  Private (Office Admin & Staff)
const updateJobStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      pipeline_stage, section,
      assigned_staff_id, assignedStaffId,
      assigned_staff_ids, assignedStaffIds,
      quote_amount, quoteAmount,
      scheduled_date, scheduledDate,
      scheduled_time_slot, scheduledTimeSlot,
      title, description, duration_hours, durationHours,
      property_address, address, priority,
      resident_id, residentId, resident_name, tenantName,
      contact_phone, contactPhone, contact_email, contactEmail,
    } = req.body;

    const [existing] = await pool.query(
      'SELECT id, job_number, title, description, property_address, pipeline_stage, assigned_staff_id, assigned_staff_ids, scheduled_date, scheduled_time_slot, resident_name, contact_phone, contact_email, priority FROM work_orders WHERE id = ?',
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    let staffIdsArr = assigned_staff_ids || assignedStaffIds;
    let staffIdsJson = undefined;
    if (staffIdsArr !== undefined) {
      if (Array.isArray(staffIdsArr)) {
        staffIdsJson = staffIdsArr.length > 0 ? JSON.stringify(staffIdsArr) : null;
      }
    }

    let rawStaffId = assigned_staff_id || assignedStaffId;
    if (rawStaffId && typeof rawStaffId === 'string') {
      rawStaffId = rawStaffId.replace(/^(stf-|usr-)/, '');
    }

    // Sync rawStaffId with first element in staffIdsArr if rawStaffId is not passed
    if (rawStaffId === undefined && staffIdsArr !== undefined) {
      rawStaffId = staffIdsArr.length > 0 ? staffIdsArr[0] : null;
    }

    // Strict Role-Based Field Filtering
    // Only OFFICE_ADMIN can update quote amount
    let quoteVal = quote_amount || quoteAmount;
    if (req.user.role !== 'OFFICE_ADMIN') {
      quoteVal = undefined; // Strip it out for OFFICE_TEAM and MAINTENANCE_STAFF
    }

    // Maintenance Staff Ownership Check: Staff can ONLY update jobs assigned to them
    if (req.user.role === 'MAINTENANCE_STAFF') {
      const [userStaffProfile] = await pool.query('SELECT id FROM staff_profiles WHERE user_id = ?', [req.user.id]);
      const currentStaffProfileId = userStaffProfile.length > 0 ? userStaffProfile[0].id : null;

      // Check both primary assigned_staff_id and the multi-select assigned_staff_ids JSON array
      let isOwner = (existing[0].assigned_staff_id === currentStaffProfileId);
      if (!isOwner && existing[0].assigned_staff_ids) {
        const multiIds = typeof existing[0].assigned_staff_ids === 'string'
          ? JSON.parse(existing[0].assigned_staff_ids)
          : existing[0].assigned_staff_ids;
        if (Array.isArray(multiIds) && multiIds.includes(currentStaffProfileId)) {
          isOwner = true;
        }
      }

      if (!currentStaffProfileId || !isOwner) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden. Maintenance Staff can only update work orders assigned to them.',
        });
      }

      // Staff cannot reassign jobs to another technician
      if (rawStaffId && rawStaffId != currentStaffProfileId) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden. Maintenance Staff cannot reassign work orders to another technician.',
        });
      }
    }

    const rawNewStage = pipeline_stage || section;
    let newStage = rawNewStage;
    if (rawNewStage === 'Ready to Quote') newStage = 'READY_TO_QUOTE';
    if (rawNewStage === 'Invoice') newStage = 'Invoiced';
    const schedDate = scheduled_date !== undefined ? scheduled_date : scheduledDate;
    const schedSlot = scheduled_time_slot !== undefined ? scheduled_time_slot : scheduledTimeSlot;

    const updates = [];
    const values = [];

    if (newStage !== undefined) {
      updates.push('pipeline_stage = ?');
      values.push(newStage);
    }
    if (rawStaffId !== undefined) {
      updates.push('assigned_staff_id = ?');
      values.push(rawStaffId);
    }
    if (staffIdsJson !== undefined) {
      updates.push('assigned_staff_ids = ?');
      values.push(staffIdsJson);
    }
    if (quoteVal !== undefined) {
      updates.push('quote_amount = ?');
      values.push(quoteVal);
    }
    if (schedDate !== undefined) {
      updates.push('scheduled_date = ?');
      values.push(schedDate);
    }
    if (schedSlot !== undefined) {
      updates.push('scheduled_time_slot = ?');
      values.push(schedSlot);
    }
    if (title !== undefined) {
      updates.push('title = ?');
      values.push(title);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }
    const durVal = duration_hours !== undefined ? duration_hours : durationHours;
    if (durVal !== undefined) {
      updates.push('duration_hours = ?');
      values.push(parseFloat(durVal) || 1.5);
    }
    const addrVal = property_address !== undefined ? property_address : address;
    if (addrVal !== undefined) {
      updates.push('property_address = ?');
      values.push(addrVal);
    }
    if (priority !== undefined) {
      updates.push('priority = ?');
      values.push(priority);
    }
    const resIdVal = resident_id !== undefined ? resident_id : residentId;
    if (resIdVal !== undefined) {
      updates.push('resident_id = ?');
      values.push(resIdVal);
    }
    const resNameVal = resident_name !== undefined ? resident_name : tenantName;
    if (resNameVal !== undefined) {
      updates.push('resident_name = ?');
      values.push(resNameVal);
    }
    const phoneVal = contact_phone !== undefined ? contact_phone : contactPhone;
    if (phoneVal !== undefined) {
      updates.push('contact_phone = ?');
      values.push(phoneVal);
    }
    const emailVal = contact_email !== undefined ? contact_email : contactEmail;
    if (emailVal !== undefined) {
      updates.push('contact_email = ?');
      values.push(emailVal);
    }

    if (updates.length > 0) {
      let updateSql = `UPDATE work_orders SET ${updates.join(', ')} WHERE id = ?`;
      values.push(id);
      try {
        await pool.query(updateSql, values);
      } catch (dbErr) {
        if (dbErr.message && (dbErr.message.includes('Data truncated') || dbErr.code === 'WARN_DATA_TRUNCATED' || dbErr.errno === 1265)) {
          console.warn('[updateJobStatus] Data truncation on pipeline_stage. Altering column to VARCHAR(100)...');
          await pool.query("ALTER TABLE work_orders MODIFY COLUMN pipeline_stage VARCHAR(100) NOT NULL DEFAULT 'Quotes'");
          await pool.query(updateSql, values);
        } else {
          throw dbErr;
        }
      }
    }

    // Notification Triggers
    const existingJob = existing[0];
    const prevStaffId = existingJob.assigned_staff_id;
    const prevSchedDate = existingJob.scheduled_date ? String(existingJob.scheduled_date).substring(0, 10) : null;
    const prevSchedSlot = existingJob.scheduled_time_slot;

    let targetStaffId = rawStaffId !== undefined ? (rawStaffId === null ? null : parseInt(rawStaffId, 10)) : prevStaffId;

    const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
    const jobNum = existingJob.job_number || `JOB-${id}`;
    const directJobActionUrl = `${frontendBase}/maintenance/my-tasks?jobId=${id}`;
    const targetSchedDate = schedDate !== undefined ? (schedDate === null ? null : String(schedDate).substring(0, 10)) : prevSchedDate;
    const targetSchedSlot = schedSlot !== undefined ? (schedSlot === null ? null : schedSlot) : prevSchedSlot;

    if (rawStaffId !== undefined && targetStaffId !== prevStaffId) {
      // 1. Notify previous technician that job was reassigned away from them
      if (prevStaffId !== null && prevStaffId !== undefined) {
        const [spUser] = await pool.query(
          'SELECT sp.id, sp.user_id, u.full_name, u.phone, u.email FROM staff_profiles sp JOIN users u ON sp.user_id = u.id WHERE sp.id = ?',
          [prevStaffId]
        );
        if (spUser.length > 0) {
          const prevStaff = spUser[0];
          const reassignedMsg = `Work order #${jobNum} (${existingJob.title}) at ${existingJob.property_address || 'Property'} has been reassigned to another technician. You are relieved from this task.`;

          await notificationService.createNotification({
            recipientUserId: prevStaff.user_id,
            recipientRole: 'MAINTENANCE_STAFF',
            type: 'TASK_REASSIGNED',
            title: 'Task Reassigned to Another Staff',
            message: reassignedMsg,
            relatedEntityType: 'work_orders',
            relatedEntityId: id,
            actionUrl: `${frontendBase}/maintenance/my-tasks`,
            contactPhone: prevStaff.phone,
            contactEmail: prevStaff.email,
            technicianName: prevStaff.full_name,
            technicianPhone: prevStaff.phone,
            propertyAddress: existingJob.property_address,
            channels: ['IN_APP', 'SMS', 'EMAIL'],
          });

          const reassignedPayload = {
            event: 'TASK_REASSIGNED',
            type: 'TASK_REASSIGNED',
            entityId: id,
            workOrderId: id,
            jobNumber: jobNum,
            title: existingJob.title,
            propertyAddress: existingJob.property_address,
            scheduledDate: targetSchedDate || existingJob.scheduled_date,
            scheduledTimeSlot: targetSchedSlot || existingJob.scheduled_time_slot,
            previousTechnician: {
              id: prevStaff.id,
              name: prevStaff.full_name,
              phone: prevStaff.phone,
              email: prevStaff.email,
            },
            technicianName: prevStaff.full_name,
            technicianPhone: prevStaff.phone,
            technicianEmail: prevStaff.email,
            contactPhone: prevStaff.phone,
            contactEmail: prevStaff.email,
            message: reassignedMsg,
            reassignedBy: req.user?.full_name || 'Office Admin',
            actionUrl: `${frontendBase}/maintenance/my-tasks`,
          };

          dispatchN8NWebhook('TASK_REASSIGNED', reassignedPayload).catch(err => {
            console.warn('[N8N_DISPATCH_WARN] Failed to dispatch TASK_REASSIGNED webhook:', err.message);
          });
        }
      }

      // 2. Notify newly assigned technician with direct job link
      if (targetStaffId !== null && targetStaffId !== undefined) {
        const [spUser] = await pool.query(
          'SELECT sp.id, sp.user_id, u.full_name, u.phone as staff_phone, u.phone as user_phone, u.email FROM staff_profiles sp JOIN users u ON sp.user_id = u.id WHERE sp.id = ?',
          [targetStaffId]
        );
        if (spUser.length > 0) {
          const staff = spUser[0];
          const effectiveDate = targetSchedDate || existingJob.scheduled_date;
          const effectiveSlot = targetSchedSlot || existingJob.scheduled_time_slot;
          const newAssignMsg = `You have been assigned to Job #${jobNum}: ${existingJob.title} at ${existingJob.property_address || ''} scheduled for ${effectiveDate || 'TBD'} (${effectiveSlot || 'TBD'}). View task: ${directJobActionUrl}`;

          await notificationService.createNotification({
            recipientUserId: staff.user_id,
            recipientRole: 'MAINTENANCE_STAFF',
            type: 'TASK_ASSIGNED',
            title: 'New Task Assigned',
            message: newAssignMsg,
            relatedEntityType: 'work_orders',
            relatedEntityId: id,
            actionUrl: directJobActionUrl,
            contactPhone: staff.staff_phone || staff.user_phone,
            contactEmail: staff.email,
            technicianName: staff.full_name,
            technicianPhone: staff.staff_phone || staff.user_phone,
            propertyAddress: existingJob.property_address,
            channels: ['IN_APP', 'SMS', 'EMAIL'],
            skipWebhook: true,
          });

          const assignedPayload = {
            event: 'TASK_ASSIGNED',
            type: 'TASK_ASSIGNED',
            entityId: id,
            workOrderId: id,
            jobNumber: jobNum,
            title: existingJob.title,
            message: newAssignMsg,
            scheduledDate: effectiveDate,
            scheduled_date: effectiveDate,
            date: effectiveDate,
            scheduledTime: effectiveSlot,
            scheduled_time: effectiveSlot,
            scheduledTimeSlot: effectiveSlot,
            scheduled_time_slot: effectiveSlot,
            time: effectiveSlot,
            timeSlot: effectiveSlot,
            priority: existingJob.priority || 'NORMAL',
            propertyAddress: existingJob.property_address,
            residentName: existingJob.resident_name || resNameVal || 'Resident',
            residentPhone: existingJob.contact_phone || phoneVal,
            residentEmail: existingJob.contact_email || emailVal,
            residentNotes: existingJob.description || '',
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
            assignmentType: (prevStaffId !== null && prevStaffId !== undefined) ? 'REASSIGNMENT' : 'MANUAL_ADMIN',
            actionUrl: directJobActionUrl,
          };

          dispatchN8NWebhook('TASK_ASSIGNED', assignedPayload).catch(err => {
            console.warn('[N8N_DISPATCH_WARN] Failed to dispatch TASK_ASSIGNED webhook:', err.message);
          });
        }

        // Audit log for manual assignment / reassignment
        const assignType = (prevStaffId !== null && prevStaffId !== undefined) ? 'REASSIGNMENT' : 'MANUAL_ADMIN';
        const reasonText = (prevStaffId !== null && prevStaffId !== undefined)
          ? `Manually reassigned from Staff ID #${prevStaffId} by ${req.user?.full_name || 'Office Admin'}`
          : `Manually assigned by ${req.user?.full_name || 'Office Admin'}`;

        await pool.query(
          `INSERT INTO job_assignment_logs 
            (work_order_id, staff_id, assigned_by, assignment_type, trade_category, match_score, selection_reason)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
          [
            id,
            targetStaffId,
            req.user?.full_name || 'Office Admin',
            assignType,
            existingJob.detected_category || null,
            reasonText,
          ]
        ).catch((logErr) => console.warn('[AuditLog] Failed to log manual assignment:', logErr.message));
      }
    }

    if (targetStaffId && (targetSchedDate !== prevSchedDate || targetSchedSlot !== prevSchedSlot)) {
      const [spUser] = await pool.query(
        'SELECT sp.id, sp.user_id, u.full_name, u.phone, u.email FROM staff_profiles sp JOIN users u ON sp.user_id = u.id WHERE sp.id = ?',
        [targetStaffId]
      );
      if (spUser.length > 0) {
        const staff = spUser[0];
        const scheduleChangedMsg = `Job #${jobNum} (${existingJob.title}) schedule updated to ${targetSchedDate || 'TBD'} (${targetSchedSlot || 'TBD'}). View task: ${directJobActionUrl}`;
        await notificationService.createNotification({
          recipientUserId: staff.user_id,
          recipientRole: 'MAINTENANCE_STAFF',
          type: 'TASK_SCHEDULE_CHANGED',
          title: 'Job Schedule Updated',
          message: scheduleChangedMsg,
          relatedEntityType: 'work_orders',
          relatedEntityId: id,
          actionUrl: directJobActionUrl,
          contactPhone: staff.phone,
          contactEmail: staff.email,
          technicianName: staff.full_name,
          technicianPhone: staff.phone,
          propertyAddress: existingJob.property_address,
          channels: ['IN_APP', 'SMS', 'EMAIL'],
          skipWebhook: true,
        });

        dispatchN8NWebhook('TASK_SCHEDULE_CHANGED', {
          event: 'TASK_SCHEDULE_CHANGED',
          type: 'TASK_SCHEDULE_CHANGED',
          entityId: id,
          workOrderId: id,
          jobNumber: jobNum,
          title: existingJob.title,
          scheduledDate: targetSchedDate,
          scheduled_date: targetSchedDate,
          date: targetSchedDate,
          scheduledTime: targetSchedSlot,
          scheduled_time: targetSchedSlot,
          scheduledTimeSlot: targetSchedSlot,
          scheduled_time_slot: targetSchedSlot,
          time: targetSchedSlot,
          timeSlot: targetSchedSlot,
          propertyAddress: existingJob.property_address,
          technicianName: staff.full_name,
          technicianPhone: staff.phone,
          technicianEmail: staff.email,
          contactPhone: staff.phone,
          contactEmail: staff.email,
          to: staff.phone,
          phone: staff.phone,
          email: staff.email,
          actionUrl: directJobActionUrl,
          data: {
            date: targetSchedDate,
            scheduledDate: targetSchedDate,
            scheduled_date: targetSchedDate,
            time: targetSchedSlot,
            timeSlot: targetSchedSlot,
            scheduledTime: targetSchedSlot,
            scheduledTimeSlot: targetSchedSlot,
            scheduled_time: targetSchedSlot,
            scheduled_time_slot: targetSchedSlot,
            propertyAddress: existingJob.property_address,
            technicianName: staff.full_name,
            technicianPhone: staff.phone,
            actionUrl: directJobActionUrl,
          },
        }).catch(err => console.warn('[N8N_DISPATCH_WARN] Failed to dispatch schedule changed webhook:', err.message));
      }
    }

    if (newStage === 'Quotes' && existingJob.pipeline_stage !== 'Quotes') {
      await QuoteRequestService.triggerAutoPhotoRequest(id).catch(err => {
        console.error('[updateJob] Error triggering auto photo request:', err.message);
      });
    }

    if (newStage === 'Jobs' && existingJob.pipeline_stage !== 'Jobs') {
      const [existingBooking] = await pool.query(
        'SELECT id, status FROM booking_requests WHERE work_order_id = ?',
        [id]
      );
      if (existingBooking.length === 0) {
        await BookingRequestService.triggerAutoBookingRequest(id).catch(err => {
          console.error('[updateJob] Error triggering auto booking request:', err.message);
        });
      }
    }

    if (newStage === 'Completed Quotes' && existingJob.pipeline_stage !== 'Completed Quotes') {
      const [existingBooking] = await pool.query(
        'SELECT id, status FROM booking_requests WHERE work_order_id = ?',
        [id]
      );
      if (existingBooking.length === 0 || existingBooking[0].status === 'EXPIRED') {
        await BookingRequestService.triggerAutoBookingRequest(id).catch(err => {
          console.error('[updateJobStatus] Error triggering auto booking request on Completed Quotes:', err.message);
        });
      } else {
        console.log(`[updateJobStatus] Booking request already exists for work order #${id} (status: ${existingBooking[0].status}), skipping duplicate trigger.`);
      }

      const [admins] = await pool.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
      for (const admin of admins) {
        await notificationService.createNotification({
          recipientUserId: admin.id,
          type: 'QUOTE_APPROVED',
          title: 'Quote approved and ready for booking',
          message: `Quote for ${existingJob.title} is approved.`,
          relatedEntityType: 'work_orders',
          relatedEntityId: id,
          actionUrl: `/admin/pipeline?stage=Completed Quotes`
        });
      }
    }

    const [updatedRows] = await pool.query(
      `SELECT 
        w.*,
        (SELECT SUM(total_cost) FROM job_material_costs jmc WHERE jmc.work_order_id = w.id) AS total_material_cost,
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
      [id]
    );

    res.status(200).json({
      success: true,
      message: 'Work order updated successfully.',
      data: formatJobRow(updatedRows[0], req.user ? req.user.role : null),
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Delete work order
// @route   DELETE /api/v1/jobs/:id
// @access  Private (Office Admin Only)
const deleteJob = async (req, res, next) => {
  try {
    const { id } = req.params;

    const [existing] = await pool.query('SELECT id FROM work_orders WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    await pool.query('DELETE FROM work_orders WHERE id = ?', [id]);

    res.status(200).json({
      success: true,
      message: `Work order ID ${id} deleted successfully.`,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Cancel or reschedule a job by technician
// @route   POST /api/v1/jobs/:id/cancel
// @access  Private (Maintenance Staff Only)
const cancelJob = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const { cancellationType, reason, notes } = req.body;
    const hasProof = !!req.file;
    const hasReason = !!(reason && reason.trim());

    // Type-specific validation — do NOT use a generic proof-replaces-reason rule
    if (cancellationType === 'TENANT_CANCELLED') {
      // Tenant: proof OR reason required
      if (!hasProof && !hasReason) {
        connection.release();
        return res.status(400).json({
          success: false,
          message: 'Tenant cancellation requires either a proof screenshot or a written reason.',
        });
      }
    } else if (cancellationType === 'TECHNICIAN_CANCELLED') {
      // Technician: reason is ALWAYS mandatory regardless of proof
      if (!hasReason) {
        connection.release();
        return res.status(400).json({
          success: false,
          message: 'Technician cancellation requires a written reason. Proof alone is not sufficient.',
        });
      }
    } else {
      // Unsupported cancellation type
      connection.release();
      return res.status(400).json({
        success: false,
        message: `Unsupported cancellation type: '${cancellationType}'. Use TENANT_CANCELLED or TECHNICIAN_CANCELLED.`,
      });
    }

    // 1. Validate Job & Staff Ownership
    const [existing] = await connection.query(
      'SELECT id, assigned_staff_id, assigned_staff_ids, scheduled_date, scheduled_time_slot, pipeline_stage, title, resident_name FROM work_orders WHERE id = ?',
      [id]
    );

    if (existing.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Job not found' });
    }

    const job = existing[0];

    if (job.pipeline_stage === 'Completed Jobs') {
      connection.release();
      return res.status(400).json({ success: false, message: 'Cannot cancel an already completed job.' });
    }

    if (req.user.role === 'MAINTENANCE_STAFF') {
      const [userStaffProfile] = await connection.query('SELECT id FROM staff_profiles WHERE user_id = ?', [req.user.id]);
      const currentStaffProfileId = userStaffProfile.length > 0 ? userStaffProfile[0].id : null;

      let isAssigned = (job.assigned_staff_id === currentStaffProfileId);
      if (!isAssigned && job.assigned_staff_ids) {
        const ids = typeof job.assigned_staff_ids === 'string' ? JSON.parse(job.assigned_staff_ids) : job.assigned_staff_ids;
        if (Array.isArray(ids) && ids.includes(currentStaffProfileId)) {
          isAssigned = true;
        }
      }

      if (!currentStaffProfileId || !isAssigned) {
        connection.release();
        return res.status(403).json({
          success: false,
          message: 'Forbidden. Maintenance Staff can only cancel work orders assigned to them.',
        });
      }
    }

    // 2. Validate 48-Hour Rule
    const { validateCancellationWindow } = require('../services/cancellation.service');
    let schedDate = null;
    if (job.scheduled_date) {
      if (job.scheduled_date instanceof Date) {
        const y = job.scheduled_date.getFullYear();
        const m = String(job.scheduled_date.getMonth() + 1).padStart(2, '0');
        const d = String(job.scheduled_date.getDate()).padStart(2, '0');
        schedDate = `${y}-${m}-${d}`;
      } else {
        schedDate = String(job.scheduled_date).substring(0, 10);
      }
    }
    
    if (schedDate && job.scheduled_time_slot) {
      try {
        validateCancellationWindow(schedDate, job.scheduled_time_slot);
      } catch (err) {
        connection.release();
        return res.status(err.status || 403).json({
          success: false,
          message: err.message,
          code: err.code
        });
      }
    }

    await connection.beginTransaction();

    // 3. Update Work Order
    const newStage = 'Jobs Waiting Booking'; // Put back in booking queue
    const priority = cancellationType === 'TECHNICIAN_CANCELLED' ? 'URGENT' : 'NORMAL';

    await connection.query(
      `UPDATE work_orders SET 
        cancellation_type = ?, 
        cancellation_reason = ?, 
        cancelled_by = ?, 
        cancelled_at = NOW(),
        previous_appointment_date = scheduled_date,
        previous_appointment_time = scheduled_time_slot,
        scheduled_date = NULL,
        scheduled_time_slot = NULL,
        pipeline_stage = ?,
        priority = IF(? = 'URGENT', 'URGENT', priority)
       WHERE id = ?`,
      [cancellationType, reason, req.user.id, newStage, priority, id]
    );

    // 4. Create Appointment & Cancellation History Records
    const [historyResult] = await connection.query(
      `INSERT INTO appointment_history (
        work_order_id, action_type, previous_date, previous_time,
        cancellation_type, reason, performed_by, performed_by_role, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, 'CANCELLATION', schedDate, job.scheduled_time_slot,
        cancellationType, reason, req.user.id, req.user.role, notes || null
      ]
    );

    let proofPath = null;
    if (req.file) {
      const uploadRes = await uploadMediaFile(req.file, 'cancellations');
      proofPath = uploadRes?.url || `/uploads/${req.file.filename}`;
    }

    await connection.query(
      `INSERT INTO cancellation_history (
        work_order_id, cancelled_by_user_id, cancellation_type, reason, notes, proof_url
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, cancellationType, reason || 'No reason specified', notes || null, proofPath]
    );

    // 5. Handle File Upload if Tenant Cancelled
    if (req.file) {
       await connection.query(
        `INSERT INTO cancellation_media_uploads (
          work_order_id, appointment_history_id, file_name, file_path, mime_type, file_size_bytes, uploaded_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, historyResult.insertId, req.file.originalname, proofPath, req.file.mimetype, req.file.size, req.user.id]
      );
    }

    // 6. Stop old booking reminder workflow
    await connection.query(
      `UPDATE booking_requests SET status = 'CANCELLED' WHERE work_order_id = ? AND status = 'WAITING_FOR_BOOKING'`,
      [id]
    );

    // 7. Notify Office Team and Admin using the central dispatcher
    const [officeUsers] = await connection.query("SELECT id, role FROM users WHERE role IN ('OFFICE_ADMIN', 'OFFICE_TEAM')");
    const dispatcher = require('../services/notification.service');
    
    const notificationType = cancellationType === 'TECHNICIAN_CANCELLED' ? 'TECHNICIAN_CANCELLED' : 'TENANT_CANCELLED';
    const notificationTitle = cancellationType === 'TECHNICIAN_CANCELLED' ? 'Urgent: Tech Cancelled Job' : 'Job Cancelled by Tenant';
    const messageTemplate = `Job #{{id}} ({{title}}) cancelled. Reason: {{reason}}. Rebooking required.`;

    for (const u of officeUsers) {
      await dispatcher.dispatch({
        recipientUserId: u.id,
        recipientRole: u.role,
        type: notificationType,
        title: notificationTitle,
        messageTemplate,
        structuredData: {
          id,
          title: job.title,
          reason
        },
        relatedEntityType: 'work_orders',
        relatedEntityId: id,
        actionUrl: `/admin/pipeline`,
        channels: ['IN_APP'], // Internal operational notification
        connection
      });
    }

    // Optionally notify Tenant (via central dispatcher)
    if (cancellationType === 'TECHNICIAN_CANCELLED' && job.resident_name) {
       const [residentRows] = await connection.query('SELECT email, phone FROM residents WHERE full_name = ? LIMIT 1', [job.resident_name]);
       const residentEmail = residentRows.length > 0 ? residentRows[0].email : null;
       const residentPhone = residentRows.length > 0 ? residentRows[0].phone : null;

       await dispatcher.dispatch({
         recipientUserId: null,
         recipientRole: 'TENANT',
         type: 'TECHNICIAN_CANCELLED',
         title: 'Appointment Update — New Appointment Required',
         messageTemplate: `Hi {{resident_name}},\n\nWe sincerely apologize, but your upcoming maintenance appointment has been cancelled. Please select a new appointment time using the booking link we will send you shortly.`,
         structuredData: { resident_name: job.resident_name },
         channels: ['EMAIL', 'SMS'],
         contactEmail: residentEmail,
         contactPhone: residentPhone,
         connection
       });
    }

    // Additive notification to original work-order sender — DEFERRED until after commit (P0-3).
    // senderData is read inside the open transaction (dirty-read within same session is intentional
    // and correct for InnoDB), but the actual dispatch occurs after connection.commit() below.
    let deferredSenderDispatch = null;
    try {
      const [senderRows] = await connection.query(
        'SELECT original_sender_email, manager_email, job_number, title, property_address, resident_name FROM work_orders WHERE id = ?',
        [id]
      );
      const origSenderEmail = senderRows[0]?.original_sender_email || senderRows[0]?.manager_email;
      if (origSenderEmail) {
        const jNum = senderRows[0]?.job_number || id;
        const jTitle = senderRows[0]?.title || 'Maintenance';
        const pAddr = senderRows[0]?.property_address || '';
        const rName = senderRows[0]?.resident_name || 'Resident';
        // Capture payload; dispatch happens only after successful commit (P0-3).
        deferredSenderDispatch = {
          recipientUserId: null,
          recipientRole: 'OFFICE_ADMIN',
          type: 'SENDER_APPOINTMENT_CANCELLED',
          title: `Appointment Cancelled: Job #${jNum} - ${jTitle}`,
          messageTemplate: `Dear Requester,\n\nPlease be advised that the maintenance appointment for "${jTitle}" at ${pAddr} (Resident: ${rName}) has been cancelled.\nReason: ${reason || 'Operational update'}.\n\nA new booking request has been sent to the resident to reschedule.\n\nThank you,\nNexus FMS Team`,
          structuredData: {
            job_number: jNum,
            title: jTitle,
            property_address: pAddr,
            resident_name: rName,
            reason: reason || 'Operational update'
          },
          channels: ['EMAIL'],
          contactEmail: origSenderEmail,
        };
      }
    } catch (senderErr) {
      console.warn('[cancelJob] Failed to query original sender for cancellation notice:', senderErr.message);
    }

    await connection.commit();
    connection.release();

    // P0-3: Dispatch sender cancellation email ONLY after commit succeeds.
    // If commit had failed and rolled back, this code would never be reached.
    if (deferredSenderDispatch) {
      dispatcher.dispatch(deferredSenderDispatch)
        .catch(err => console.warn('[cancelJob] Error notifying original sender:', err.message));
    }

    // 8. Generate a new booking/rebooking request
    const { triggerAutoBookingRequest } = require('../services/bookingRequest.service');
    await triggerAutoBookingRequest(id);

    res.status(200).json({
      success: true,
      message: 'Job cancelled successfully.',
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    next(err);
  }
};

// @desc    Get job assignment audit history
// @route   GET /api/v1/jobs/:id/assignment-history
// @access  Private (Office Admin, Office Team, Maintenance Staff)
const getAssignmentHistory = async (req, res, next) => {
  try {
    const { id } = req.params;

    const [woRows] = await pool.query('SELECT id, job_number, title FROM work_orders WHERE id = ?', [id]);
    if (woRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Job #${id} not found.`,
      });
    }

    const [logs] = await pool.query(
      `SELECT 
        jal.id,
        jal.work_order_id,
        jal.staff_id,
        jal.assigned_by,
        jal.assignment_type,
        jal.trade_category,
        jal.match_score,
        jal.selection_reason,
        jal.assigned_at,
        u.full_name as staff_name,
        u.email as staff_email,
        u.phone as staff_phone,
        sp.role_title
       FROM job_assignment_logs jal
       LEFT JOIN staff_profiles sp ON jal.staff_id = sp.id
       LEFT JOIN users u ON sp.user_id = u.id
       WHERE jal.work_order_id = ?
       ORDER BY jal.assigned_at DESC, jal.id DESC`,
      [id]
    );

    const history = logs.map((log) => ({
      id: log.id,
      workOrderId: log.work_order_id,
      technician: log.staff_id ? {
        staffId: log.staff_id,
        name: log.staff_name || 'Technician',
        email: log.staff_email || null,
        phone: log.staff_phone || null,
        roleTitle: log.role_title || 'Technician',
      } : null,
      assignmentType: log.assignment_type,
      assignedBy: log.assigned_by,
      timestamp: log.assigned_at,
      trade: log.trade_category,
      score: log.match_score,
      reason: log.selection_reason,
    }));

    res.status(200).json({
      success: true,
      data: history,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Resend Quote Photo Request (SMS & Email) to Tenant
// @route   POST /api/v1/jobs/:id/resend-quote-request
// @access  Private (Admin & Office Team)
const resendQuoteRequest = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await QuoteRequestService.triggerAutoPhotoRequest(id);
    return res.status(200).json({
      success: true,
      message: 'Quote photo request notification and SMS sent successfully.',
      data: result,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getJobs,
  getJobById,
  createJob,
  moveJobStage,
  updateJobStatus,
  deleteJob,
  cancelJob,
  getAssignmentHistory,
  resendQuoteRequest,
};

