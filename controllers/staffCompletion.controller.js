const { pool } = require('../config/db');
const notificationService = require('../services/notification.service');
const { uploadMediaFile } = require('../services/cloudinary.service');
const { dispatchN8NWebhook, getAdminAndOfficeRecipientEmail } = require('../services/webhook.service');


// Helper to resolve staff profile ID from logged in user ID
const getStaffProfileId = async (userId) => {
  const [rows] = await pool.query('SELECT id FROM staff_profiles WHERE user_id = ?', [userId]);
  if (rows.length > 0) return rows[0].id;
  
  const [uRows] = await pool.query('SELECT id FROM users WHERE id = ?', [userId]);
  if (uRows.length > 0) {
    const [res] = await pool.query(
      'INSERT INTO staff_profiles (user_id, staff_code, role_title, color_hex) VALUES (?, ?, ?, ?)',
      [userId, `STF-${100 + Number(userId)}`, 'Maintenance Specialist', '#009bf2']
    );
    return res.insertId;
  }
  return null;
};


// Helper to format static media paths to absolute URLs
const formatMediaUrl = (url) => {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  const backendBase = (process.env.BACKEND_URL || process.env.API_BASE_URL || 'https://nexus-fms-backend-production.up.railway.app').replace(/\/$/, '').replace(/\/api\/v1\/?$/, '');
  const cleanPath = url.startsWith('/') ? url : `/${url}`;
  return `${backendBase}${cleanPath}`;
};

// Helper to format raw database row to Frontend job object
const formatJobRow = (r, mediaList = []) => ({
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
  assignedStaffIds: r.assigned_staff_ids ? (typeof r.assigned_staff_ids === 'string' ? JSON.parse(r.assigned_staff_ids) : r.assigned_staff_ids) : [],
  assignedStaffCode: r.staff_code || (r.assigned_staff_id ? `STF-${100 + r.assigned_staff_id}` : null),
  assignedStaffName: r.staff_name || null,
  assignedStaffColor: r.staff_color || '#009bf2',
  scheduledDate: r.scheduled_date ? String(r.scheduled_date).substring(0, 10) : null,
  scheduledTimeSlot: r.scheduled_time_slot || null,
  secureToken: r.secure_token,
  createdAt: r.created_at ? String(r.created_at).substring(0, 10) : null,
  residentPhotos: mediaList.map(m => ({
    id: m.id,
    fileName: m.file_name,
    filePath: formatMediaUrl(m.file_path),
    mediaType: m.media_type || 'PHOTO',
    createdAt: m.created_at
  })),
  photoUrls: mediaList.map(m => formatMediaUrl(m.file_path))
});

// @desc    Get all work orders assigned to the authenticated technician
// @route   GET /api/v1/staff/my-jobs
// @access  Private (Maintenance Staff)
const getMyAssignedJobs = async (req, res, next) => {
  try {
    const staffProfileId = await getStaffProfileId(req.user.id);

    if (!staffProfileId && req.user.role !== 'OFFICE_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. No staff profile associated with this account.',
      });
    }

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
    `;

    const queryParams = [];

    // Office Admin views all, Staff views ONLY assigned jobs
    if (req.user.role === 'MAINTENANCE_STAFF') {
      sql += ' WHERE (w.assigned_staff_id = ? OR (w.assigned_staff_ids IS NOT NULL AND JSON_CONTAINS(w.assigned_staff_ids, CAST(? AS JSON), "$")))';
      queryParams.push(staffProfileId, staffProfileId);
    }

    sql += ' ORDER BY w.created_at DESC';

    const [rows] = await pool.query(sql, queryParams);

    // Batch query customer_media_uploads for all jobs
    let mediaByJob = {};
    if (rows.length > 0) {
      const jobIds = rows.map(r => r.id);
      const [mediaRows] = await pool.query(
        `SELECT id, work_order_id, file_name, file_path, media_type, created_at 
         FROM customer_media_uploads 
         WHERE work_order_id IN (?)`,
        [jobIds]
      );
      for (const m of mediaRows) {
        if (!mediaByJob[m.work_order_id]) mediaByJob[m.work_order_id] = [];
        mediaByJob[m.work_order_id].push(m);
      }
    }

    const jobs = rows.map(r => formatJobRow(r, mediaByJob[r.id] || []));

    res.status(200).json({
      success: true,
      count: jobs.length,
      data: jobs,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get single assigned work order by ID (with strict ownership check)
// @route   GET /api/v1/staff/my-jobs/:id
// @access  Private (Maintenance Staff & Office Admin)
const getMyAssignedJobById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const staffProfileId = await getStaffProfileId(req.user.id);

    const [rows] = await pool.query(
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
      WHERE w.id = ? OR w.job_number = ?`,
      [id, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    const job = rows[0];

    // Strict Ownership Enforcement: Maintenance Staff can ONLY view their assigned job
    let isAssigned = (job.assigned_staff_id === staffProfileId);
    if (!isAssigned && job.assigned_staff_ids) {
      const ids = typeof job.assigned_staff_ids === 'string' ? JSON.parse(job.assigned_staff_ids) : job.assigned_staff_ids;
      if (Array.isArray(ids) && ids.includes(staffProfileId)) {
        isAssigned = true;
      }
    }
    if (req.user.role === 'MAINTENANCE_STAFF' && !isAssigned) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. You are not authorized to view another technician’s assigned work order.',
      });
    }

    const [mediaRows] = await pool.query(
      `SELECT id, work_order_id, file_name, file_path, media_type, created_at 
       FROM customer_media_uploads 
       WHERE work_order_id = ?`,
      [job.id]
    );

    res.status(200).json({
      success: true,
      data: formatJobRow(job, mediaRows),
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Submit Staff Work / Completion Report for Assigned Job
// @route   POST /api/v1/staff/jobs/:id/report
// @access  Private (Maintenance Staff & Office Admin)
const submitWorkReport = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { work_performed, work_report_summary, report_text, workReport, work_report, materials_used } = req.body;

    const reportSummary = (work_performed || work_report_summary || report_text || workReport || work_report || '').trim();

    const materials = (materials_used || '').trim() || null;

    // Reject empty reports
    if (!reportSummary) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Work report summary text cannot be empty.',
      });
    }

    const staffProfileId = await getStaffProfileId(req.user.id);

    const [jobRows] = await pool.query('SELECT id, assigned_staff_id, assigned_staff_ids FROM work_orders WHERE id = ?', [id]);
    if (jobRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    const job = jobRows[0];

    // Strict Ownership Check
    let isAssigned = (job.assigned_staff_id === staffProfileId);
    if (!isAssigned && job.assigned_staff_ids) {
      const ids = typeof job.assigned_staff_ids === 'string' ? JSON.parse(job.assigned_staff_ids) : job.assigned_staff_ids;
      if (Array.isArray(ids) && ids.includes(staffProfileId)) {
        isAssigned = true;
      }
    }
    if (req.user.role === 'MAINTENANCE_STAFF' && !isAssigned) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. You cannot submit a work report for another technician’s job.',
      });
    }

    const targetStaffId = staffProfileId || job.assigned_staff_id;

    // Duplicate Completion Protection: Update existing report if already present for this job
    const [existingReport] = await pool.query(
      'SELECT id FROM staff_job_completions WHERE work_order_id = ?',
      [id]
    );

    let completionId = null;

    if (existingReport.length > 0) {
      completionId = existingReport[0].id;
      await pool.query(
        `UPDATE staff_job_completions SET 
          work_report_summary = ?,
          materials_used = ?,
          staff_id = ?,
          updated_at = NOW()
         WHERE id = ?`,
        [reportSummary, materials, targetStaffId, completionId]
      );
    } else {
      const [insertRes] = await pool.query(
        `INSERT INTO staff_job_completions 
          (work_order_id, staff_id, work_report_summary, materials_used, completion_status, completed_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [id, targetStaffId, reportSummary, materials, 'IN_PROGRESS']
      );
      completionId = insertRes.insertId;
    }

    const [savedReport] = await pool.query('SELECT * FROM staff_job_completions WHERE id = ?', [completionId]);

    res.status(200).json({
      success: true,
      message: 'Work completion report submitted successfully.',
      data: savedReport[0],
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Upload Proof Photos for Assigned Job
// @route   POST /api/v1/staff/jobs/:id/photos
// @access  Private (Maintenance Staff & Office Admin)
const uploadCompletionPhotos = async (req, res, next) => {
  try {
    const { id } = req.params;
    const staffProfileId = await getStaffProfileId(req.user.id);

    const [jobRows] = await pool.query('SELECT id, assigned_staff_id, assigned_staff_ids FROM work_orders WHERE id = ?', [id]);
    if (jobRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    const job = jobRows[0];

    // Strict Ownership Check
    let isAssigned = (job.assigned_staff_id === staffProfileId);
    if (!isAssigned && job.assigned_staff_ids) {
      const ids = typeof job.assigned_staff_ids === 'string' ? JSON.parse(job.assigned_staff_ids) : job.assigned_staff_ids;
      if (Array.isArray(ids) && ids.includes(staffProfileId)) {
        isAssigned = true;
      }
    }
    if (req.user.role === 'MAINTENANCE_STAFF' && !isAssigned) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. You cannot upload completion photos for another technician’s job.',
      });
    }

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Please select at least one photo to upload.',
      });
    }

    const targetStaffId = staffProfileId || job.assigned_staff_id;

    // Ensure staff_job_completions record exists to link completion_id
    const [existingReport] = await pool.query('SELECT id FROM staff_job_completions WHERE work_order_id = ?', [id]);
    let completionId = null;

    if (existingReport.length > 0) {
      completionId = existingReport[0].id;
    } else {
      const [insertRes] = await pool.query(
        `INSERT INTO staff_job_completions 
          (work_order_id, staff_id, work_report_summary, completion_status, completed_at)
         VALUES (?, ?, ?, ?, NOW())`,
        [id, targetStaffId, 'Initial photo upload', 'IN_PROGRESS']
      );
      completionId = insertRes.insertId;
    }

    const savedPhotos = [];

    for (const file of files) {
      const uploadRes = await uploadMediaFile(file, 'completion');
      const fileUrl = uploadRes?.url || `/uploads/${file.filename}`;
      const [mediaRes] = await pool.query(
        `INSERT INTO staff_completion_media 
          (completion_id, work_order_id, file_name, file_path, file_size_bytes, mime_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [completionId, id, file.originalname, fileUrl, file.size, file.mimetype]
      );

      savedPhotos.push({
        id: mediaRes.insertId,
        fileName: file.originalname,
        filePath: fileUrl,
        fileSize: file.size,
        mimeType: file.mimetype,
      });
    }

    res.status(200).json({
      success: true,
      message: 'Completion proof photos uploaded successfully.',
      data: {
        workOrderId: id,
        completionId,
        photosUploaded: savedPhotos.length,
        photos: savedPhotos,
      },
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Explicitly Mark Work Order as Complete (Moves Stage to 'Completed Jobs')
// @route   PUT /api/v1/staff/jobs/:id/complete
// @access  Private (Maintenance Staff & Office Admin)
const markJobComplete = async (req, res, next) => {
  try {
    const { id } = req.params;
    const staffProfileId = await getStaffProfileId(req.user.id);

    const [jobRows] = await pool.query('SELECT id, assigned_staff_id, assigned_staff_ids, pipeline_stage, duration_hours FROM work_orders WHERE id = ?', [id]);
    if (jobRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    const job = jobRows[0];

    // Strict Ownership Check
    let isAssigned = (job.assigned_staff_id === staffProfileId);
    if (!isAssigned && job.assigned_staff_ids) {
      const ids = typeof job.assigned_staff_ids === 'string' ? JSON.parse(job.assigned_staff_ids) : job.assigned_staff_ids;
      if (Array.isArray(ids) && ids.includes(staffProfileId)) {
        isAssigned = true;
      }
    }
    if (req.user.role === 'MAINTENANCE_STAFF' && !isAssigned) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. You cannot complete another technician’s work order.',
      });
    }

    // Verify Work Report has been submitted prior to completion
    const [reportRows] = await pool.query(
      'SELECT id, work_report_summary FROM staff_job_completions WHERE work_order_id = ? AND work_report_summary IS NOT NULL',
      [id]
    );

    if (reportRows.length === 0 || !reportRows[0].work_report_summary) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Please submit a work report summary before completing the job.',
      });
    }

    // Verify at least one Completion Proof Photo has been uploaded prior to completion
    const [photoRows] = await pool.query(
      'SELECT COUNT(*) as photoCount FROM staff_completion_media WHERE work_order_id = ?',
      [id]
    );

    if (photoRows[0].photoCount === 0) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error: At least one completion proof photo must be uploaded before completing the job.',
      });
    }

    // Update staff_job_completions status
    await pool.query(
      "UPDATE staff_job_completions SET completion_status = 'COMPLETED', completed_at = NOW() WHERE work_order_id = ?",
      [id]
    );

    // Update work_orders pipeline stage to 'Completed Jobs'
    await pool.query(
      "UPDATE work_orders SET pipeline_stage = 'Completed Jobs' WHERE id = ?",
      [id]
    );

    const [woRows] = await pool.query("SELECT title, assigned_staff_id, assigned_staff_ids, duration_hours, resident_id, property_address FROM work_orders WHERE id = ?", [id]);
    const jobTitle = woRows[0]?.title || 'Repair Job';
    const assignedStaffId = woRows[0]?.assigned_staff_id;
    const durationHours = parseFloat(woRows[0]?.duration_hours || 1.5);
    const residentId = woRows[0]?.resident_id;
    const propertyAddress = woRows[0]?.property_address;

    // ==========================================
    // KPI POINTS CALCULATION
    // ==========================================
    const pointsEarned = Math.floor(durationHours * 10);
    
    let staffIdsToReward = [];
    if (woRows[0]?.assigned_staff_ids) {
      staffIdsToReward = typeof woRows[0].assigned_staff_ids === 'string' 
        ? JSON.parse(woRows[0].assigned_staff_ids) 
        : woRows[0].assigned_staff_ids;
    } else if (assignedStaffId) {
      staffIdsToReward = [assignedStaffId];
    }

    for (const sId of staffIdsToReward) {
      await pool.query(
        "UPDATE staff_profiles SET jobs_completed = jobs_completed + 1, kpi_score = kpi_score + ? WHERE id = ?",
        [pointsEarned, sId]
      );

      // ── Revisit Detection ─────────────────────────────────────────────────
      // A revisit is when the same technician has already completed a prior job
      // for the same resident or property address (excluding the current job).
      try {
        let revisitQuery;
        let revisitParams;
        if (residentId) {
          revisitQuery = `
            SELECT COUNT(*) as cnt FROM work_orders w
            WHERE w.pipeline_stage = 'Completed Jobs'
              AND w.id != ?
              AND w.resident_id = ?
              AND (w.assigned_staff_id = ? OR (w.assigned_staff_ids IS NOT NULL AND JSON_CONTAINS(w.assigned_staff_ids, CAST(? AS JSON), '$')))
          `;
          revisitParams = [id, residentId, sId, sId];
        } else if (propertyAddress) {
          revisitQuery = `
            SELECT COUNT(*) as cnt FROM work_orders w
            WHERE w.pipeline_stage = 'Completed Jobs'
              AND w.id != ?
              AND w.property_address = ?
              AND (w.assigned_staff_id = ? OR (w.assigned_staff_ids IS NOT NULL AND JSON_CONTAINS(w.assigned_staff_ids, CAST(? AS JSON), '$')))
          `;
          revisitParams = [id, propertyAddress, sId, sId];
        }
        if (revisitQuery) {
          const [[revisitRows]] = await pool.query(revisitQuery, revisitParams);
          if (revisitRows.cnt > 0) {
            await pool.query(
              "UPDATE staff_profiles SET revisits = revisits + 1 WHERE id = ?",
              [sId]
            );
          }
        }
      } catch (revisitErr) {
        console.warn('[KPI] Revisit detection failed (non-fatal):', revisitErr.message);
      }
      // ─────────────────────────────────────────────────────────────────────
    }
    // ==========================================

    let techName = 'Technician';
    if (assignedStaffId) {
      const [techUser] = await pool.query("SELECT u.full_name FROM staff_profiles sp JOIN users u ON sp.user_id = u.id WHERE sp.id = ?", [assignedStaffId]);
      if (techUser.length > 0) techName = techUser[0].full_name;
    }

    const [updatedJobRows] = await pool.query(
      `SELECT 
        w.*,
        r.full_name as live_resident_name,
        r.phone as live_contact_phone,
        r.email as live_contact_email,
        r.address as live_property_address,
        u.id as staff_user_id,
        u.full_name as staff_name,
        u.phone as staff_phone,
        u.email as staff_email,
        sp.color_hex as staff_color,
        sp.staff_code
       FROM work_orders w
       LEFT JOIN residents r ON w.resident_id = r.id
       LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
       LEFT JOIN users u ON sp.user_id = u.id
       WHERE w.id = ?`,
      [id]
    );

    const updatedJob = updatedJobRows[0];
    const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
    const tenantName = updatedJob?.live_resident_name || updatedJob?.resident_name || 'Resident';
    const tenantPhone = updatedJob?.live_contact_phone || updatedJob?.contact_phone || null;
    const tenantEmail = updatedJob?.live_contact_email || updatedJob?.contact_email || null;
    const propAddress = updatedJob?.live_property_address || updatedJob?.property_address || '';
    const jobNumber = updatedJob?.job_number || id;
    const finalTechName = updatedJob?.staff_name || techName || 'Technician';
    const techUserId = updatedJob?.staff_user_id || null;
    const techPhone = updatedJob?.staff_phone || null;
    const techEmail = updatedJob?.staff_email || null;

    const completionReportUrl = `${frontendBase}/jobs/${id}/report`;

    // 1. Notify Tenant (Mukul)
    const tenantMessage = `Dear ${tenantName}, your repair job #${jobNumber} ("${jobTitle}") at ${propAddress} has been successfully completed by technician ${finalTechName}. Thank you for choosing Nexus FMS!`;
    await notificationService.createNotification({
      recipientRole: 'TENANT',
      recipientUserId: null,
      type: 'JOB_COMPLETED',
      title: `Repair Job Completed: #${jobNumber}`,
      message: tenantMessage,
      contactPhone: tenantPhone,
      contactEmail: tenantEmail,
      technicianName: finalTechName,
      technicianPhone: techPhone,
      name: tenantName,
      propertyAddress: propAddress,
      relatedEntityType: 'work_orders',
      relatedEntityId: parseInt(id, 10),
      channels: ['IN_APP'], // In-app record only; dedicated single N8N webhook below handles SMS/Email
      skipWebhook: true,
      data: {
        workOrderId: parseInt(id, 10),
        jobNumber: jobNumber,
        title: jobTitle,
        residentName: tenantName,
        name: tenantName,
        residentPhone: tenantPhone,
        residentEmail: tenantEmail,
        technicianName: finalTechName,
        propertyAddress: propAddress,
        status: 'COMPLETED'
      }
    });

    // 2. Notify Staff (Technician e.g. lightlab)
    const staffMessage = `Great work ${finalTechName}! You have successfully completed Job #${jobNumber}: "${jobTitle}" at ${propAddress}. Your work report has been recorded.`;
    if (techUserId) {
      await notificationService.createNotification({
        recipientUserId: techUserId,
        recipientRole: 'MAINTENANCE_STAFF',
        type: 'STAFF_JOB_DONE',
        title: `Job #${jobNumber} Completed`,
        message: staffMessage,
        contactPhone: techPhone,
        contactEmail: techEmail,
        technicianName: finalTechName,
        technicianPhone: techPhone,
        name: finalTechName,
        propertyAddress: propAddress,
        relatedEntityType: 'work_orders',
        relatedEntityId: parseInt(id, 10),
        actionUrl: `/maintenance/my-tasks`,
        channels: ['IN_APP', 'SMS', 'EMAIL'],
        skipWebhook: true,
        data: {
          workOrderId: parseInt(id, 10),
          jobNumber: jobNumber,
          title: jobTitle,
          staffName: finalTechName,
          name: finalTechName,
          recipientName: finalTechName,
          technicianName: finalTechName,
          residentName: finalTechName, // Crucial: prevents template from greeting tenant on staff notifications
          tenantName: tenantName,
          propertyAddress: propAddress,
          status: 'COMPLETED'
        }
      });
    }

    // 3. Notify Admins (Internal in-app only, skip duplicate external webhook)
    const [admins] = await pool.query("SELECT id FROM users WHERE role IN ('OFFICE_ADMIN', 'OFFICE_TEAM')");
    for (const admin of admins) {
      await notificationService.createNotification({
        recipientUserId: admin.id,
        recipientRole: 'OFFICE_ADMIN',
        type: 'JOB_COMPLETED_ADMIN',
        title: 'Technician task completed',
        message: `Task #${jobNumber} "${jobTitle}" was marked completed by ${finalTechName}`,
        relatedEntityType: 'work_orders',
        relatedEntityId: parseInt(id, 10),
        actionUrl: `/admin/pipeline?stage=Completed Jobs`,
        channels: ['IN_APP'],
        skipWebhook: true,
        data: {
          workOrderId: parseInt(id, 10),
          jobNumber: jobNumber,
          title: jobTitle,
          technicianName: finalTechName,
          residentName: tenantName,
          status: 'COMPLETED'
        }
      });
    }

    // 4. Dispatch single dedicated N8N Webhook for Tenant JOB_COMPLETED (Only ONCE to prevent duplicate SMS/email)
    dispatchN8NWebhook('JOB_COMPLETED', {
      event: 'JOB_COMPLETED',
      type: 'JOB_COMPLETED',
      entityId: parseInt(id, 10),
      workOrderId: parseInt(id, 10),
      jobNumber: jobNumber,
      title: jobTitle,
      message: `Job #${jobNumber} ("${jobTitle}") completed by ${finalTechName} for resident ${tenantName}`,
      residentName: tenantName,
      name: tenantName,
      recipientName: tenantName,
      residentPhone: tenantPhone,
      residentEmail: tenantEmail,
      contactPhone: tenantPhone,
      contactEmail: tenantEmail,
      to: tenantPhone,
      phone: tenantPhone,
      email: tenantEmail,
      technicianName: finalTechName,
      technicianPhone: techPhone,
      technicianEmail: techEmail,
      propertyAddress: propAddress,
      status: 'COMPLETED',
      completedAt: new Date().toISOString(),
      actionUrl: completionReportUrl,
      reportUrl: completionReportUrl,
      pdfReportUrl: completionReportUrl
    }).catch(err => console.warn('[N8N_DISPATCH_WARN] Failed to dispatch JOB_COMPLETED webhook:', err.message));

    // 5. Asynchronously dispatch ADMIN_OFFICE_ALERT to n8n for Admin and Office Team email notifications
    getAdminAndOfficeRecipientEmail(pool)
      .then((recipientEmail) => {
        return dispatchN8NWebhook('ADMIN_OFFICE_ALERT', {
          alertType: 'JOB_COMPLETED',
          recipientEmail,
          workOrderId: parseInt(id, 10),
          jobNumber,
          jobTitle,
          propertyAddress: propAddress,
          technicianName: finalTechName,
          residentName: tenantName,
          residentPhone: tenantPhone,
          completionNotes: reportSummary || '',
          actionUrl: completionReportUrl,
          subject: `[Nexus FMS] Job Completed: #${jobNumber || id} by ${finalTechName}`,
          headline: 'Work Order Completed by Technician',
          message: `Technician ${finalTechName} has completed work order #${jobNumber || id} ("${jobTitle}") at ${propAddress}.`,
        });
      })
      .catch((err) => {
        console.warn('[N8N_WEBHOOK] Failed to dispatch JOB_COMPLETED admin alert:', err.message);
      });

    res.status(200).json({
      success: true,
      message: "Work order marked as 'Completed Jobs' successfully.",
      data: formatJobRow(updatedJobRows[0]),
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get Completion Evidence (Report Summary & Photos) for Office Admin / Job View
// @route   GET /api/v1/jobs/:id/completion-evidence
// @access  Private (Office Admin & Assigned Staff)
const getJobCompletionEvidence = async (req, res, next) => {
  try {
    const { id } = req.params;
    const staffProfileId = await getStaffProfileId(req.user.id);

    const [jobRows] = await pool.query('SELECT id, job_number, title, assigned_staff_id, assigned_staff_ids, pipeline_stage FROM work_orders WHERE id = ?', [id]);
    if (jobRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Work order not found with ID ${id}`,
      });
    }

    const job = jobRows[0];

    // Staff Authorization Check: Maintenance Staff can ONLY view evidence for their own assigned job
    let isAssigned = (job.assigned_staff_id === staffProfileId);
    if (!isAssigned && job.assigned_staff_ids) {
      const ids = typeof job.assigned_staff_ids === 'string' ? JSON.parse(job.assigned_staff_ids) : job.assigned_staff_ids;
      if (Array.isArray(ids) && ids.includes(staffProfileId)) {
        isAssigned = true;
      }
    }
    if (req.user.role === 'MAINTENANCE_STAFF' && !isAssigned) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. You are not authorized to view completion evidence for another technician’s work order.',
      });
    }

    // Fetch report, proof photos, and material costs in parallel
    let mediaQuery = 'SELECT id, file_name, file_path, file_size_bytes, mime_type, created_at, media_type FROM staff_completion_media WHERE work_order_id = ?';
    if (req.user.role === 'OFFICE_TEAM') {
      mediaQuery += " AND media_type != 'RECEIPT'"; // Hide financial receipts from OFFICE_TEAM
    }

    const [[reports], [mediaRows], [materialsRows]] = await Promise.all([
      pool.query(
        `SELECT 
          c.*,
          u.full_name as staff_name,
          sp.staff_code,
          sp.role_title
         FROM staff_job_completions c
         LEFT JOIN staff_profiles sp ON c.staff_id = sp.id
         LEFT JOIN users u ON sp.user_id = u.id
         WHERE c.work_order_id = ?`,
        [id]
      ),
      pool.query(mediaQuery, [id]),
      pool.query(
        'SELECT id, inventory_item_id, material_name, quantity, unit_cost, total_cost, receipt_path FROM job_material_costs WHERE work_order_id = ?',
        [id]
      )
    ]);

    const materials = materialsRows.map(m => {
      const mat = {
        id: m.id,
        inventoryItemId: m.inventory_item_id,
        materialName: m.material_name,
        quantity: parseFloat(m.quantity),
      };
      if (req.user.role !== 'OFFICE_TEAM') {
        mat.unitCost = parseFloat(m.unit_cost);
        mat.totalCost = parseFloat(m.total_cost);
        mat.receiptPath = m.receipt_path;
      }
      return mat;
    });

    res.status(200).json({
      success: true,
      data: {
        workOrderId: job.id,
        jobNumber: job.job_number,
        title: job.title,
        pipelineStage: job.pipeline_stage,
        report: reports.length > 0 ? {
          completionId: reports[0].id,
          staffId: reports[0].staff_id,
          staffName: reports[0].staff_name,
          staffCode: reports[0].staff_code,
          workReportSummary: reports[0].work_report_summary,
          materialsUsed: reports[0].materials_used,
          completionStatus: reports[0].completion_status,
          completedAt: reports[0].completed_at,
        } : null,
        photos: mediaRows.map(m => ({
          id: m.id,
          fileName: m.file_name,
          filePath: m.file_path,
          fileSize: m.file_size_bytes,
          mimeType: m.mime_type,
          mediaType: m.media_type,
          uploadedAt: m.created_at,
        })),
        materials,
      },
    });
  } catch (err) {
    next(err);
  }
};

const fs = require('fs');

// @desc    Atomic completion for a job (Report, Photos, Materials)
// @route   POST /api/v1/jobs/:id/complete
// @access  Private (Maintenance Staff)
const completeJobAtomic = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const staffProfileId = await getStaffProfileId(req.user.id);
    const { completion_report, materials } = req.body;

    if (req.user.role !== 'MAINTENANCE_STAFF') {
      if (req.files) Object.values(req.files).flat().forEach(f => fs.unlink(f.path, () => {}));
      connection.release();
      return res.status(403).json({ success: false, message: 'Forbidden. Only Maintenance Staff can complete jobs.' });
    }

    if (!completion_report || !completion_report.trim()) {
      if (req.files) Object.values(req.files).flat().forEach(f => fs.unlink(f.path, () => {}));
      connection.release();
      return res.status(400).json({ success: false, message: 'Validation Error: Completion report is required.' });
    }

    // Process Materials
    let parsedMaterials = [];
    if (materials) {
      try {
        parsedMaterials = JSON.parse(materials);
        if (!Array.isArray(parsedMaterials)) throw new Error('Materials must be an array');
        for (const m of parsedMaterials) {
          if (!m.material_name && m.description) m.material_name = m.description;
          if (!m.material_name || m.material_name.trim() === '') throw new Error('Material name or description is required');
          if (m.unit_cost === undefined && m.price !== undefined) m.unit_cost = m.price;
          if (m.quantity === undefined || isNaN(m.quantity) || Number(m.quantity) <= 0) m.quantity = 1;
          if (isNaN(m.unit_cost) || Number(m.unit_cost) < 0) throw new Error('Unit cost / price must be >= 0');
        }
      } catch (err) {
        if (req.files) Object.values(req.files).flat().forEach(f => fs.unlink(f.path, () => {}));
        connection.release();
        return res.status(400).json({ success: false, message: `Invalid materials JSON: ${err.message}` });
      }
    }

    // Enforce mandatory after-photo upload
    const afterPhotoFiles = req.files && req.files['afterPhotos'] ? req.files['afterPhotos'] : [];
    if (afterPhotoFiles.length === 0) {
      if (req.files) Object.values(req.files).flat().forEach(f => require('fs').unlink(f.path, () => {}));
      connection.release();
      return res.status(400).json({ success: false, message: 'Validation Error: At least one after-photo is required to complete the job.' });
    }

    // Process & Upload Media Files first (outside DB transaction to prevent holding DB locks during slow network uploads)
    const uploadedMediaList = [];
    if (req.files) {
      const categories = ['beforePhotos', 'afterPhotos', 'receipts'];
      for (const cat of categories) {
        if (req.files[cat]) {
          const type = cat === 'beforePhotos' ? 'BEFORE' : cat === 'afterPhotos' ? 'AFTER' : cat === 'receipts' ? 'RECEIPT' : 'OTHER';
          for (const file of req.files[cat]) {
            try {
              const uploadRes = await uploadMediaFile(file, 'completion');
              const fileUrl = uploadRes?.url || `/uploads/${file.filename}`;
              uploadedMediaList.push({
                file,
                fileUrl,
                type,
              });
            } catch (mediaErr) {
              console.warn('[StaffCompletion] Media upload warning, falling back to local file:', mediaErr.message);
              uploadedMediaList.push({
                file,
                fileUrl: `/uploads/${file.filename}`,
                type,
              });
            }
          }
        }
      }
    }

    await connection.beginTransaction();

    const [jobRows] = await connection.query(
      `SELECT w.id, w.job_number, w.title, w.description, w.property_address, w.pipeline_stage, 
              w.assigned_staff_id, w.assigned_staff_ids, w.resident_id, w.resident_name, 
              w.contact_phone, w.contact_email,
              r.full_name as live_resident_name, r.phone as live_contact_phone, r.email as live_contact_email, r.address as live_property_address
       FROM work_orders w
       LEFT JOIN residents r ON w.resident_id = r.id
       WHERE w.id = ? FOR UPDATE`,
      [id]
    );
    if (jobRows.length === 0) {
      throw { status: 404, message: `Work order not found with ID ${id}` };
    }
    const job = jobRows[0];

    // Strict Ownership Check
    let isAssigned = (job.assigned_staff_id === staffProfileId);
    if (!isAssigned && job.assigned_staff_ids) {
      const ids = typeof job.assigned_staff_ids === 'string' ? JSON.parse(job.assigned_staff_ids) : job.assigned_staff_ids;
      if (Array.isArray(ids) && ids.includes(staffProfileId)) {
        isAssigned = true;
      }
    }
    if (job.assigned_staff_id !== staffProfileId && !isAssigned) {
      throw { status: 403, message: 'Forbidden. You can only complete your own assigned work order.' };
    }

    if (job.pipeline_stage === 'Completed Jobs') {
      throw { status: 400, message: 'Job is already completed.' };
    }

    // Insert staff_job_completions
    const [existingReport] = await connection.query('SELECT id FROM staff_job_completions WHERE work_order_id = ?', [id]);
    let completionId = null;
    if (existingReport.length > 0) {
      completionId = existingReport[0].id;
      await connection.query(
        "UPDATE staff_job_completions SET work_report_summary = ?, staff_id = ?, completion_status = 'COMPLETED', completed_at = NOW() WHERE id = ?",
        [completion_report.trim(), staffProfileId, completionId]
      );
    } else {
      const [insertRes] = await connection.query(
        "INSERT INTO staff_job_completions (work_order_id, staff_id, work_report_summary, completion_status, completed_at) VALUES (?, ?, ?, 'COMPLETED', NOW())",
        [id, staffProfileId, completion_report.trim()]
      );
      completionId = insertRes.insertId;
    }

    // Insert pre-uploaded media records instantly
    for (const item of uploadedMediaList) {
      await connection.query(
        "INSERT INTO staff_completion_media (completion_id, work_order_id, file_name, file_path, file_size_bytes, mime_type, media_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [completionId, id, item.file.originalname, item.fileUrl, item.file.size, item.file.mimetype, item.type]
      );
    }

    // Insert Materials + deduct linked inventory stock
    if (parsedMaterials.length > 0) {
      for (const m of parsedMaterials) {
        const qty = Number(m.quantity);
        const uCost = Number(m.unit_cost);
        const tCost = qty * uCost;
        const invItemId = m.inventory_item_id ? Number(m.inventory_item_id) : null;

        const [materialInsert] = await connection.query(
          'INSERT INTO job_material_costs (work_order_id, technician_id, material_name, quantity, unit_cost, total_cost, inventory_item_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, staffProfileId, m.material_name, qty, uCost, tCost, invItemId]
        );

        // Deduct inventory if linked to a warehouse item
        if (invItemId) {
          const [invRows] = await connection.query(
            'SELECT id, item_name, current_quantity FROM inventory_items WHERE id = ? AND status = ? FOR UPDATE',
            [invItemId, 'ACTIVE']
          );
          if (invRows.length === 0) {
            throw { status: 400, message: `Inventory item #${invItemId} not found or inactive.` };
          }
          const prevQty = invRows[0].current_quantity;
          const newQty = prevQty - qty;
          if (newQty < 0) {
            throw {
              status: 400,
              message: `Insufficient inventory for "${invRows[0].item_name}". Available: ${prevQty}, Requested: ${qty}`
            };
          }
          await connection.query('UPDATE inventory_items SET current_quantity = ? WHERE id = ?', [newQty, invItemId]);
          await connection.query(
            'INSERT INTO inventory_transactions (inventory_item_id, user_id, transaction_type, quantity_change, previous_quantity, new_quantity, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [invItemId, req.user.id, 'CONSUMED', -qty, prevQty, newQty, `Job #${id} completion — ${m.material_name}`]
          );
        }
      }
    }

    // Update Work Order
    await connection.query(
      "UPDATE work_orders SET pipeline_stage = 'Completed Jobs', scheduled_date = NULL, scheduled_time_slot = NULL WHERE id = ?",
      [id]
    );

    // Provide KPI points
    await connection.query("UPDATE staff_profiles SET jobs_completed = jobs_completed + 1 WHERE id = ?", [staffProfileId]);

    await connection.commit();
    connection.release();

    // Notifications to Tenant, Staff, and Admins
    try {
      const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
      const tenantName = job.live_resident_name || job.resident_name || 'Resident';
      const tenantPhone = job.live_contact_phone || job.contact_phone || null;
      const tenantEmail = job.live_contact_email || job.contact_email || null;
      const propertyAddress = job.live_property_address || job.property_address || '';
      const jobNumber = job.job_number || id;
      const techName = req.user?.full_name || 'Technician';
      const techPhone = req.user?.phone || null;
      const techEmail = req.user?.email || null;
      const techUserId = req.user?.id || null;

      // 1. Send SMS / Email to Tenant (e.g. Mukul)
      const tenantMessage = `Dear ${tenantName}, your repair job #${jobNumber} ("${job.title}") at ${propertyAddress} has been successfully completed by technician ${techName}. Thank you for choosing Nexus FMS!`;
      await notificationService.createNotification({
        recipientRole: 'TENANT',
        recipientUserId: null,
        type: 'JOB_COMPLETED',
        title: `Repair Job Completed: #${jobNumber}`,
        message: tenantMessage,
        contactPhone: tenantPhone,
        contactEmail: tenantEmail,
        technicianName: techName,
        technicianPhone: techPhone,
        propertyAddress: propertyAddress,
        relatedEntityType: 'work_orders',
        relatedEntityId: parseInt(id, 10),
        channels: ['IN_APP'], // In-app notification record only; dedicated single N8N webhook below handles SMS/Email to resident
        skipWebhook: true, // Internal notification; dedicated N8N webhook dispatched once below
        data: {
          workOrderId: parseInt(id, 10),
          jobNumber: jobNumber,
          title: job.title,
          residentName: tenantName,
          name: tenantName,
          residentPhone: tenantPhone,
          residentEmail: tenantEmail,
          technicianName: techName,
          technicianPhone: techPhone,
          propertyAddress: propertyAddress,
          completionReport: completion_report ? completion_report.trim() : '',
          status: 'COMPLETED'
        }
      });

      // 2. Send In-App & SMS/Email to Staff (e.g. lightlab)
      const staffMessage = `Great work ${techName}! You have successfully completed Job #${jobNumber}: "${job.title}" at ${propertyAddress}. Your work report and evidence have been recorded.`;
      if (techUserId) {
        await notificationService.createNotification({
          recipientUserId: techUserId,
          recipientRole: 'MAINTENANCE_STAFF',
          type: 'STAFF_JOB_DONE',
          title: `Job #${jobNumber} Completed`,
          message: staffMessage,
          contactPhone: techPhone,
          contactEmail: techEmail,
          technicianName: techName,
          technicianPhone: techPhone,
          name: techName,
          propertyAddress: propertyAddress,
          relatedEntityType: 'work_orders',
          relatedEntityId: parseInt(id, 10),
          actionUrl: `/maintenance/my-tasks`,
          channels: ['IN_APP', 'SMS', 'EMAIL'],
          skipWebhook: true,
          data: {
            workOrderId: parseInt(id, 10),
            jobNumber: jobNumber,
            title: job.title,
            staffName: techName,
            name: techName,
            recipientName: techName,
            technicianName: techName,
            residentName: techName, // Crucial: prevents template from greeting tenant on staff notifications
            tenantName: tenantName,
            propertyAddress: propertyAddress,
            completionReport: completion_report ? completion_report.trim() : '',
            status: 'COMPLETED'
          }
        });
      }

      // 3. Send to Office Admins & Office Team (Internal in-app only, skip external N8N webhook)
      const [admins] = await pool.query("SELECT id FROM users WHERE role IN ('OFFICE_ADMIN', 'OFFICE_TEAM')");
      for (const admin of admins) {
        await notificationService.createNotification({
          recipientUserId: admin.id,
          recipientRole: 'OFFICE_ADMIN',
          type: 'JOB_COMPLETED_ADMIN',
          title: 'Technician task completed',
          message: `Task #${jobNumber} "${job.title}" was marked completed by ${techName}.`,
          relatedEntityType: 'work_orders',
          relatedEntityId: parseInt(id, 10),
          actionUrl: `/admin/pipeline?stage=Completed Jobs`,
          channels: ['IN_APP'],
          skipWebhook: true,
          data: {
            workOrderId: parseInt(id, 10),
            jobNumber: jobNumber,
            title: job.title,
            technicianName: techName,
            residentName: tenantName,
            status: 'COMPLETED'
          }
        });
      }

      // 4. Dispatch dedicated N8N Webhook for JOB_COMPLETED (Only ONCE to prevent duplicate SMS/email)
      const completionReportUrl = `${frontendBase}/jobs/${id}/report`;
      dispatchN8NWebhook('JOB_COMPLETED', {
        event: 'JOB_COMPLETED',
        type: 'JOB_COMPLETED',
        entityId: parseInt(id, 10),
        workOrderId: parseInt(id, 10),
        jobNumber: jobNumber,
        title: job.title,
        message: `Job #${jobNumber} ("${job.title}") completed by ${techName} for resident ${tenantName}`,
        residentName: tenantName,
        name: tenantName,
        recipientName: tenantName,
        residentPhone: tenantPhone,
        residentEmail: tenantEmail,
        contactPhone: tenantPhone,
        contactEmail: tenantEmail,
        to: tenantPhone,
        phone: tenantPhone,
        email: tenantEmail,
        technicianName: techName,
        technicianPhone: techPhone,
        technicianEmail: techEmail,
        propertyAddress: propertyAddress,
        completionReport: completion_report ? completion_report.trim() : '',
        status: 'COMPLETED',
        completedAt: new Date().toISOString(),
        actionUrl: completionReportUrl,
        reportUrl: completionReportUrl,
        pdfReportUrl: completionReportUrl
      }).catch(err => console.warn('[N8N_DISPATCH_WARN] Failed to dispatch JOB_COMPLETED webhook:', err.message));

      // 5. Asynchronously dispatch ADMIN_OFFICE_ALERT to n8n for Admin and Office Team email notifications
      getAdminAndOfficeRecipientEmail(pool)
        .then((recipientEmail) => {
          return dispatchN8NWebhook('ADMIN_OFFICE_ALERT', {
            alertType: 'JOB_COMPLETED',
            recipientEmail,
            workOrderId: parseInt(id, 10),
            jobNumber,
            jobTitle: job.title,
            propertyAddress,
            technicianName: techName,
            residentName: tenantName,
            residentPhone: tenantPhone,
            completionNotes: completion_report ? completion_report.trim() : '',
            actionUrl: completionReportUrl,
            subject: `[Nexus FMS] Job Completed: #${jobNumber || id} by ${techName}`,
            headline: 'Work Order Completed by Technician',
            message: `Technician ${techName} has completed work order #${jobNumber || id} ("${job.title}") at ${propertyAddress}.`,
          });
        })
        .catch((err) => {
          console.warn('[N8N_WEBHOOK] Failed to dispatch JOB_COMPLETED admin alert:', err.message);
        });

    } catch(err) {
      console.error('[JOB_COMPLETION_NOTIFICATIONS_ERROR]', err);
    }

    res.status(200).json({ success: true, message: 'Job completed successfully.' });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    if (req.files) Object.values(req.files).flat().forEach(f => fs.unlink(f.path, () => {}));
    
    if (err.status) {
      res.status(err.status).json({ success: false, message: err.message });
    } else {
      next(err);
    }
  }
};

module.exports = {
  getMyAssignedJobs,
  getMyAssignedJobById,
  submitWorkReport,
  uploadCompletionPhotos,
  markJobComplete,
  getJobCompletionEvidence,
  completeJobAtomic,
  updateCompletedJobEvidence,
  getStaffInventoryItems,
  deleteCompletionMedia,
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: helper to reconcile material delta and adjust warehouse stock
// ─────────────────────────────────────────────────────────────────────────────
async function _reconcileInventoryDelta(connection, userId, staffProfileId, jobId, oldMaterials, newMaterials) {
  // Build maps keyed by job_material_costs.id for old materials
  const oldMap = {};
  for (const om of oldMaterials) {
    oldMap[om.id] = om;
  }

  const newByExistingId = {}; // existing records being updated (has id)
  const brandNew = [];       // new rows without an id
  for (const nm of newMaterials) {
    if (nm.id) {
      newByExistingId[nm.id] = nm;
    } else {
      brandNew.push(nm);
    }
  }

  // Process removed materials (in old but not in new)
  for (const om of oldMaterials) {
    if (!newByExistingId[om.id] && om.inventory_item_id) {
      // Restore removed quantity
      const [invRows] = await connection.query('SELECT current_quantity FROM inventory_items WHERE id = ? FOR UPDATE', [om.inventory_item_id]);
      if (invRows.length > 0) {
        const prevQty = invRows[0].current_quantity;
        const newQty = prevQty + Number(om.quantity);
        await connection.query('UPDATE inventory_items SET current_quantity = ? WHERE id = ?', [newQty, om.inventory_item_id]);
        await connection.query(
          'INSERT INTO inventory_transactions (inventory_item_id, user_id, transaction_type, quantity_change, previous_quantity, new_quantity, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [om.inventory_item_id, userId, 'RESTOCK', Number(om.quantity), prevQty, newQty, `Job #${jobId} edit — material removed`]
        );
      }
      await connection.query('DELETE FROM job_material_costs WHERE id = ?', [om.id]);
    }
  }

  // Process updated materials (in both old and new)
  for (const [existingId, nm] of Object.entries(newByExistingId)) {
    const om = oldMap[existingId];
    const newQty = Number(nm.quantity);
    const newUCost = Number(nm.unit_cost);
    await connection.query(
      'UPDATE job_material_costs SET material_name = ?, quantity = ?, unit_cost = ?, total_cost = ? WHERE id = ?',
      [nm.material_name, newQty, newUCost, newQty * newUCost, existingId]
    );
    // Inventory delta — only if old row has a valid inventory_item_id
    if (om && om.inventory_item_id) {
      const delta = newQty - Number(om.quantity);
      if (delta !== 0) {
        const [invRows] = await connection.query('SELECT id, item_name, current_quantity FROM inventory_items WHERE id = ? FOR UPDATE', [om.inventory_item_id]);
        if (invRows.length > 0) {
          const prevStock = invRows[0].current_quantity;
          const newStock = prevStock - delta; // negative delta = restock, positive = consume more
          if (newStock < 0) {
            throw {
              status: 400,
              message: `Insufficient inventory for "${invRows[0].item_name}". Available: ${prevStock}, Additional Requested: ${delta}`
            };
          }
          await connection.query('UPDATE inventory_items SET current_quantity = ? WHERE id = ?', [newStock, om.inventory_item_id]);
          const txType = delta > 0 ? 'CONSUMED' : 'RESTOCK';
          await connection.query(
            'INSERT INTO inventory_transactions (inventory_item_id, user_id, transaction_type, quantity_change, previous_quantity, new_quantity, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [om.inventory_item_id, userId, txType, -delta, prevStock, newStock, `Job #${jobId} edit — quantity adjusted`]
          );
        }
      }
    }
  }

  // Process brand-new materials added during edit
  for (const nm of brandNew) {
    const qty = Number(nm.quantity);
    const uCost = Number(nm.unit_cost);
    const invItemId = nm.inventory_item_id ? Number(nm.inventory_item_id) : null;
    await connection.query(
      'INSERT INTO job_material_costs (work_order_id, technician_id, material_name, quantity, unit_cost, total_cost, inventory_item_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [jobId, staffProfileId, nm.material_name, qty, uCost, qty * uCost, invItemId]
    );
    if (invItemId) {
      const [invRows] = await connection.query('SELECT id, item_name, current_quantity FROM inventory_items WHERE id = ? FOR UPDATE', [invItemId]);
      if (invRows.length > 0) {
        const prevStock = invRows[0].current_quantity;
        const newStock = prevStock - qty;
        if (newStock < 0) {
          throw {
            status: 400,
            message: `Insufficient inventory for "${invRows[0].item_name}". Available: ${prevStock}, Requested: ${qty}`
          };
        }
        await connection.query('UPDATE inventory_items SET current_quantity = ? WHERE id = ?', [newStock, invItemId]);
        await connection.query(
          'INSERT INTO inventory_transactions (inventory_item_id, user_id, transaction_type, quantity_change, previous_quantity, new_quantity, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [invItemId, userId, 'CONSUMED', -qty, prevStock, newStock, `Job #${jobId} edit — material added`]
        );
      }
    }
  }
}

// @desc    Update completion evidence for an already-completed job (technician only)
// @route   PUT /api/v1/staff/jobs/:id/completion-evidence
// @access  Private (Maintenance Staff — own jobs only)
async function updateCompletedJobEvidence(req, res, next) {
  const connection = await pool.getConnection();
  const fs = require('fs');
  try {
    const { id } = req.params;
    const staffProfileId = await getStaffProfileId(req.user.id);
    const { completion_report, materials } = req.body;

    if (req.user.role !== 'MAINTENANCE_STAFF') {
      connection.release();
      return res.status(403).json({ success: false, message: 'Forbidden. Only Maintenance Staff can edit completion evidence.' });
    }

    let parsedMaterials = [];
    if (materials) {
      try {
        parsedMaterials = JSON.parse(materials);
        if (!Array.isArray(parsedMaterials)) throw new Error('Materials must be an array');
        for (const m of parsedMaterials) {
          if (!m.material_name || m.material_name.trim() === '') throw new Error('Material name required');
          if (isNaN(m.quantity) || Number(m.quantity) <= 0) throw new Error('Quantity must be > 0');
          if (isNaN(m.unit_cost) || Number(m.unit_cost) < 0) throw new Error('Unit cost must be >= 0');
        }
      } catch (err) {
        connection.release();
        return res.status(400).json({ success: false, message: `Invalid materials: ${err.message}` });
      }
    }

    await connection.beginTransaction();

    // Verify job is completed and belongs to this technician
    const [jobRows] = await connection.query(
      'SELECT id, assigned_staff_id, assigned_staff_ids, pipeline_stage FROM work_orders WHERE id = ? FOR UPDATE',
      [id]
    );
    if (jobRows.length === 0) throw { status: 404, message: 'Job not found.' };
    const job = jobRows[0];
    if (job.pipeline_stage !== 'Completed Jobs') throw { status: 400, message: 'Job is not in Completed state.' };

    let isOwner = (job.assigned_staff_id === staffProfileId);
    if (!isOwner && job.assigned_staff_ids) {
      const ids = typeof job.assigned_staff_ids === 'string' ? JSON.parse(job.assigned_staff_ids) : job.assigned_staff_ids;
      if (Array.isArray(ids) && ids.includes(staffProfileId)) isOwner = true;
    }
    if (!isOwner) throw { status: 403, message: 'Forbidden. You can only edit your own completed job.' };

    // Update completion report if provided
    if (completion_report && completion_report.trim()) {
      await connection.query(
        'UPDATE staff_job_completions SET work_report_summary = ? WHERE work_order_id = ?',
        [completion_report.trim(), id]
      );
    }

    // Handle photo additions — we only ADD new photos; existing ones remain
    const [completionRow] = await connection.query('SELECT id FROM staff_job_completions WHERE work_order_id = ?', [id]);
    const completionId = completionRow.length > 0 ? completionRow[0].id : null;
    if (completionId && req.files) {
      for (const cat of ['beforePhotos', 'afterPhotos', 'receipts']) {
        if (req.files[cat]) {
          const type = cat === 'beforePhotos' ? 'BEFORE' : cat === 'afterPhotos' ? 'AFTER' : 'RECEIPT';
          for (const file of req.files[cat]) {
            const uploadRes = await uploadMediaFile(file, 'completion');
            const fileUrl = uploadRes?.url || `/uploads/${file.filename}`;
            await connection.query(
              'INSERT INTO staff_completion_media (completion_id, work_order_id, file_name, file_path, file_size_bytes, mime_type, media_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [completionId, id, file.originalname, fileUrl, file.size, file.mimetype, type]
            );
          }
        }
      }
    }

    // Material reconciliation — fetch old materials
    if (materials !== undefined) {
      const [oldMaterials] = await connection.query(
        'SELECT id, material_name, quantity, unit_cost, inventory_item_id FROM job_material_costs WHERE work_order_id = ?',
        [id]
      );
      await _reconcileInventoryDelta(connection, req.user.id, staffProfileId, id, oldMaterials, parsedMaterials);
    }

    await connection.commit();
    connection.release();
    res.status(200).json({ success: true, message: 'Completion evidence updated successfully.' });
  } catch (err) {
    if (connection) { await connection.rollback(); connection.release(); }
    if (req.files) Object.values(req.files).flat().forEach(f => require('fs').unlink(f.path, () => {}));
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    next(err);
  }
}

// @desc    Fetch basic inventory items list for technician materials picker
// @route   GET /api/v1/staff/inventory
// @access  Private (Maintenance Staff)
async function getStaffInventoryItems(req, res, next) {
  try {
    const [rows] = await pool.query(
      "SELECT id, item_name AS itemName, unit FROM inventory_items WHERE status = 'ACTIVE' ORDER BY item_name ASC"
    );
    res.status(200).json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// @desc    Delete completed job completion media item
// @route   DELETE /api/v1/staff/media/:mediaId
// @access  Private (Maintenance Staff)
async function deleteCompletionMedia(req, res, next) {
  try {
    const { mediaId } = req.params;
    const staffProfileId = await getStaffProfileId(req.user.id);

    // Fetch media details
    const [mediaRows] = await pool.query(
      `SELECT m.*, w.assigned_staff_id, w.assigned_staff_ids 
       FROM staff_completion_media m
       JOIN work_orders w ON m.work_order_id = w.id
       WHERE m.id = ?`,
      [mediaId]
    );

    if (mediaRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Media item not found.' });
    }

    const media = mediaRows[0];

    // Ownership check
    let isOwner = (media.assigned_staff_id === staffProfileId);
    if (!isOwner && media.assigned_staff_ids) {
      const ids = typeof media.assigned_staff_ids === 'string' ? JSON.parse(media.assigned_staff_ids) : media.assigned_staff_ids;
      if (Array.isArray(ids) && ids.includes(staffProfileId)) isOwner = true;
    }

    if (req.user.role !== 'OFFICE_ADMIN' && !isOwner) {
      return res.status(403).json({ success: false, message: 'Forbidden. You are not authorized to delete this media item.' });
    }

    // Delete database row
    await pool.query('DELETE FROM staff_completion_media WHERE id = ?', [mediaId]);

    // Optional: unlink file from disk
    const fs = require('fs');
    const path = require('path');
    const fullPath = path.join(__dirname, '..', media.file_path);
    fs.unlink(fullPath, () => {});

    res.status(200).json({ success: true, message: 'Media item deleted successfully.' });
  } catch (err) {
    next(err);
  }
}
