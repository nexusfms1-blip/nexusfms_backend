/**
 * N8N & External Automation Webhook Dispatcher
 * Dispatches event payloads to N8N.cloud workflows
 */

const { normalizePhoneNumber } = require('../utils/phoneNormalizer');

const getFrontendBaseUrl = () => {
  const url = process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app';
  return url.replace(/\/$/, '');
};

const recentTaskAssignedEvents = new Map();

const dispatchN8NWebhook = async (eventType, payload) => {
  const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;

  let formattedPayload = payload ? { ...payload } : {};

  if (eventType === 'TASK_ASSIGNED') {
    const frontendBase = getFrontendBaseUrl();
    const workOrderId = formattedPayload.workOrderId || formattedPayload.entityId || formattedPayload.relatedEntityId || null;
    const techRecipient = formattedPayload.technicianPhone || formattedPayload.technicianEmail || formattedPayload.contactPhone || formattedPayload.contactEmail || formattedPayload.to || formattedPayload.email || '';
    const dedupKey = `${workOrderId}_${techRecipient}`;
    const now = Date.now();

    // 5-second in-memory deduplication to prevent double SMS/Emails to technician on job assignment
    if (workOrderId && techRecipient && recentTaskAssignedEvents.has(dedupKey) && (now - recentTaskAssignedEvents.get(dedupKey) < 5000)) {
      console.log(`[N8N_WEBHOOK] ⚡ Duplicate TASK_ASSIGNED webhook suppressed for ${dedupKey}`);
      return { success: true, deduplicated: true };
    }
    if (workOrderId && techRecipient) {
      recentTaskAssignedEvents.set(dedupKey, now);
      if (recentTaskAssignedEvents.size > 500) {
        for (const [k, t] of recentTaskAssignedEvents.entries()) {
          if (now - t > 10000) recentTaskAssignedEvents.delete(k);
        }
      }
    }

    // 1. Direct frontend URL where technician can open their task portal (Screenshot 2: /maintenance/my-tasks)
    formattedPayload.actionUrl = `${frontendBase}/maintenance/my-tasks${workOrderId ? `?jobId=${workOrderId}` : ''}`;

    // 2. Ensure entityId and workOrderId
    if (workOrderId) {
      formattedPayload.entityId = formattedPayload.entityId || workOrderId;
      formattedPayload.workOrderId = formattedPayload.workOrderId || workOrderId;
    }

    // 3. Ensure technicianName & technicianPhone
    formattedPayload.technicianName = formattedPayload.technicianName || formattedPayload.technician?.name || null;
    formattedPayload.technicianPhone = formattedPayload.technicianPhone || formattedPayload.technician?.phone || formattedPayload.contactPhone || null;

    // 4. Ensure propertyAddress
    formattedPayload.propertyAddress = formattedPayload.propertyAddress || formattedPayload.address || null;

    // 5. Ensure title
    formattedPayload.title = formattedPayload.title || 'New task assigned';

    // 6. Ensure scheduledDate & scheduledTime / scheduledTimeSlot are resolved from DB if missing
    let schedDate = formattedPayload.scheduledDate || formattedPayload.date || formattedPayload.data?.scheduledDate || formattedPayload.data?.scheduled_date || formattedPayload.data?.date || null;
    let schedTime = formattedPayload.scheduledTime || formattedPayload.scheduledTimeSlot || formattedPayload.time || formattedPayload.timeSlot || formattedPayload.data?.scheduledTime || formattedPayload.data?.scheduled_time || formattedPayload.data?.scheduledTimeSlot || formattedPayload.data?.scheduled_time_slot || formattedPayload.data?.time || formattedPayload.data?.timeSlot || null;

    if ((!schedDate || !schedTime || !formattedPayload.propertyAddress) && workOrderId) {
      try {
        const { pool } = require('../config/db');
        const [woRows] = await pool.query(
          'SELECT scheduled_date, scheduled_time_slot, property_address, title, job_number FROM work_orders WHERE id = ?',
          [workOrderId]
        );
        if (woRows.length > 0) {
          if (!schedDate && woRows[0].scheduled_date) {
            const raw = woRows[0].scheduled_date;
            schedDate = raw instanceof Date ? raw.toISOString().substring(0, 10) : String(raw).substring(0, 10);
          }
          if (!schedTime && woRows[0].scheduled_time_slot) {
            schedTime = woRows[0].scheduled_time_slot;
          }
          if (!formattedPayload.propertyAddress && woRows[0].property_address) {
            formattedPayload.propertyAddress = woRows[0].property_address;
          }
          if (!formattedPayload.jobNumber && woRows[0].job_number) {
            formattedPayload.jobNumber = woRows[0].job_number;
          }
        }
      } catch (e) {
        console.warn('[N8N_WEBHOOK] Could not fetch work_order schedule info:', e.message);
      }
    }

    // Set all date and time synonyms on both top-level and data object
    formattedPayload.scheduledDate = schedDate;
    formattedPayload.scheduled_date = schedDate;
    formattedPayload.date = schedDate;
    formattedPayload.scheduledTime = schedTime;
    formattedPayload.scheduled_time = schedTime;
    formattedPayload.scheduledTimeSlot = schedTime;
    formattedPayload.scheduled_time_slot = schedTime;
    formattedPayload.time = schedTime;
    formattedPayload.timeSlot = schedTime;

    // Ensure technician phone and email are set as the recipient for TASK_ASSIGNED
    formattedPayload.contactPhone = formattedPayload.contactPhone || formattedPayload.technicianPhone || formattedPayload.technician?.phone || null;
    formattedPayload.contactEmail = formattedPayload.contactEmail || formattedPayload.technicianEmail || formattedPayload.technician?.email || null;
    formattedPayload.to = formattedPayload.to || formattedPayload.contactPhone;
    formattedPayload.email = formattedPayload.email || formattedPayload.contactEmail;
    formattedPayload.phone = formattedPayload.phone || formattedPayload.contactPhone;

    if (formattedPayload.data && typeof formattedPayload.data === 'object') {
      formattedPayload.data.scheduledDate = schedDate;
      formattedPayload.data.scheduled_date = schedDate;
      formattedPayload.data.date = schedDate;
      formattedPayload.data.scheduledTime = schedTime;
      formattedPayload.data.scheduled_time = schedTime;
      formattedPayload.data.scheduledTimeSlot = schedTime;
      formattedPayload.data.scheduled_time_slot = schedTime;
      formattedPayload.data.time = schedTime;
      formattedPayload.data.timeSlot = schedTime;
      formattedPayload.data.actionUrl = formattedPayload.actionUrl;
      formattedPayload.data.propertyAddress = formattedPayload.propertyAddress;
      formattedPayload.data.contactPhone = formattedPayload.contactPhone;
      formattedPayload.data.contactEmail = formattedPayload.contactEmail;
      formattedPayload.data.technicianPhone = formattedPayload.technicianPhone;
      formattedPayload.data.technicianEmail = formattedPayload.technicianEmail;
      formattedPayload.data.to = formattedPayload.to;
      formattedPayload.data.email = formattedPayload.email;
      formattedPayload.data.phone = formattedPayload.phone;
    }


    // 7. Ensure message
    if (!formattedPayload.message) {
      const jobDesc = formattedPayload.title || `Work Order #${workOrderId || ''}`;
      const addrDesc = formattedPayload.propertyAddress ? ` at ${formattedPayload.propertyAddress}` : '';
      const timeDesc = schedDate ? ` scheduled for ${schedDate}${schedTime ? ` (${schedTime})` : ''}` : '';
      formattedPayload.message = `New task assigned: ${jobDesc}${addrDesc}${timeDesc}`;
    }
  }

  if (eventType === 'TASK_REASSIGNED' || eventType === 'TASK_UNASSIGNED') {
    const frontendBase = getFrontendBaseUrl();
    const workOrderId = formattedPayload.workOrderId || formattedPayload.entityId || formattedPayload.relatedEntityId || null;

    if (workOrderId) {
      formattedPayload.entityId = formattedPayload.entityId || workOrderId;
      formattedPayload.workOrderId = formattedPayload.workOrderId || workOrderId;
    }
    if (!formattedPayload.actionUrl) {
      formattedPayload.actionUrl = `${frontendBase}/maintenance/my-tasks`;
    }

    formattedPayload.technicianName = formattedPayload.technicianName || formattedPayload.technician?.name || formattedPayload.previousTechnician?.name || null;
    formattedPayload.technicianPhone = formattedPayload.technicianPhone || formattedPayload.technician?.phone || formattedPayload.previousTechnician?.phone || formattedPayload.contactPhone || null;
    formattedPayload.propertyAddress = formattedPayload.propertyAddress || formattedPayload.address || null;
    formattedPayload.title = formattedPayload.title || 'Task Reassigned to Another Technician';

    let schedDate = formattedPayload.scheduledDate || formattedPayload.date || formattedPayload.data?.scheduledDate || null;
    let schedTime = formattedPayload.scheduledTime || formattedPayload.scheduledTimeSlot || formattedPayload.time || formattedPayload.data?.scheduledTime || null;

    if ((!schedDate || !schedTime) && workOrderId) {
      try {
        const { pool } = require('../config/db');
        const [woRows] = await pool.query(
          'SELECT scheduled_date, scheduled_time_slot, property_address, job_number FROM work_orders WHERE id = ?',
          [workOrderId]
        );
        if (woRows.length > 0) {
          if (!schedDate && woRows[0].scheduled_date) {
            const raw = woRows[0].scheduled_date;
            schedDate = raw instanceof Date ? raw.toISOString().substring(0, 10) : String(raw).substring(0, 10);
          }
          if (!schedTime && woRows[0].scheduled_time_slot) {
            schedTime = woRows[0].scheduled_time_slot;
          }
          if (!formattedPayload.propertyAddress && woRows[0].property_address) {
            formattedPayload.propertyAddress = woRows[0].property_address;
          }
        }
      } catch (e) {}
    }

    formattedPayload.scheduledDate = schedDate;
    formattedPayload.scheduled_date = schedDate;
    formattedPayload.date = schedDate;
    formattedPayload.scheduledTime = schedTime;
    formattedPayload.scheduled_time = schedTime;
    formattedPayload.scheduledTimeSlot = schedTime;
    formattedPayload.scheduled_time_slot = schedTime;
    formattedPayload.time = schedTime;
    formattedPayload.timeSlot = schedTime;

    if (formattedPayload.data && typeof formattedPayload.data === 'object') {
      formattedPayload.data.scheduledDate = schedDate;
      formattedPayload.data.scheduled_date = schedDate;
      formattedPayload.data.date = schedDate;
      formattedPayload.data.scheduledTime = schedTime;
      formattedPayload.data.scheduled_time = schedTime;
      formattedPayload.data.scheduledTimeSlot = schedTime;
      formattedPayload.data.scheduled_time_slot = schedTime;
      formattedPayload.data.time = schedTime;
      formattedPayload.data.timeSlot = schedTime;
      formattedPayload.data.actionUrl = formattedPayload.actionUrl;
    }

    if (!formattedPayload.message) {
      const jobDesc = formattedPayload.jobNumber ? `Job #${formattedPayload.jobNumber}` : (formattedPayload.title || `Work Order #${workOrderId || ''}`);
      const addrDesc = formattedPayload.propertyAddress ? ` at ${formattedPayload.propertyAddress}` : '';
      formattedPayload.message = `${jobDesc}${addrDesc} has been reassigned to another technician. You are relieved from this task.`;
    }
  }

  if (eventType === 'TASK_SCHEDULE_CHANGED') {
    const frontendBase = getFrontendBaseUrl();
    const workOrderId = formattedPayload.workOrderId || formattedPayload.entityId || formattedPayload.relatedEntityId || null;
    const techRecipient = formattedPayload.technicianPhone || formattedPayload.technicianEmail || formattedPayload.contactPhone || formattedPayload.contactEmail || formattedPayload.to || formattedPayload.email || '';
    const dedupKey = `SCHED_${workOrderId}_${techRecipient}`;
    const now = Date.now();

    // 5-second in-memory deduplication to prevent double SMS/Emails to technician on schedule update
    if (workOrderId && techRecipient && recentTaskAssignedEvents.has(dedupKey) && (now - recentTaskAssignedEvents.get(dedupKey) < 5000)) {
      console.log(`[N8N_WEBHOOK] ⚡ Duplicate TASK_SCHEDULE_CHANGED webhook suppressed for ${dedupKey}`);
      return { success: true, deduplicated: true };
    }
    if (workOrderId && techRecipient) {
      recentTaskAssignedEvents.set(dedupKey, now);
      if (recentTaskAssignedEvents.size > 500) {
        for (const [k, t] of recentTaskAssignedEvents.entries()) {
          if (now - t > 10000) recentTaskAssignedEvents.delete(k);
        }
      }
    }

    formattedPayload.actionUrl = `${frontendBase}/maintenance/my-tasks${workOrderId ? `?jobId=${workOrderId}` : ''}`;

    if (workOrderId) {
      formattedPayload.entityId = formattedPayload.entityId || workOrderId;
      formattedPayload.workOrderId = formattedPayload.workOrderId || workOrderId;
    }

    formattedPayload.technicianName = formattedPayload.technicianName || formattedPayload.technician?.name || null;
    formattedPayload.technicianPhone = formattedPayload.technicianPhone || formattedPayload.technician?.phone || formattedPayload.contactPhone || null;
    formattedPayload.propertyAddress = formattedPayload.propertyAddress || formattedPayload.address || null;
    formattedPayload.title = formattedPayload.title || 'Job Schedule Updated';

    let schedDate = formattedPayload.scheduledDate || formattedPayload.scheduled_date || formattedPayload.date || formattedPayload.data?.scheduledDate || formattedPayload.data?.scheduled_date || formattedPayload.data?.date || null;
    let schedTime = formattedPayload.scheduledTime || formattedPayload.scheduledTimeSlot || formattedPayload.scheduled_time || formattedPayload.scheduled_time_slot || formattedPayload.time || formattedPayload.timeSlot || formattedPayload.data?.scheduledTime || formattedPayload.data?.scheduled_time || formattedPayload.data?.scheduledTimeSlot || formattedPayload.data?.scheduled_time_slot || formattedPayload.data?.time || formattedPayload.data?.timeSlot || null;

    if ((!schedDate || !schedTime || !formattedPayload.propertyAddress || !formattedPayload.technicianName) && workOrderId) {
      try {
        const { pool } = require('../config/db');
        const [woRows] = await pool.query(
          `SELECT w.scheduled_date, w.scheduled_time_slot, w.property_address, w.title, w.job_number, w.assigned_staff_id,
                  u.full_name as staff_name, u.phone as staff_phone, u.email as staff_email
           FROM work_orders w
           LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
           LEFT JOIN users u ON sp.user_id = u.id
           WHERE w.id = ?`,
          [workOrderId]
        );
        if (woRows.length > 0) {
          const r = woRows[0];
          if (!schedDate && r.scheduled_date) {
            const raw = r.scheduled_date;
            schedDate = raw instanceof Date ? raw.toISOString().substring(0, 10) : String(raw).substring(0, 10);
          }
          if (!schedTime && r.scheduled_time_slot) {
            schedTime = r.scheduled_time_slot;
          }
          if (!formattedPayload.propertyAddress && r.property_address) {
            formattedPayload.propertyAddress = r.property_address;
          }
          if (!formattedPayload.jobNumber && r.job_number) {
            formattedPayload.jobNumber = r.job_number;
          }
          if (!formattedPayload.technicianName && r.staff_name) {
            formattedPayload.technicianName = r.staff_name;
          }
          if (!formattedPayload.technicianPhone && r.staff_phone) {
            formattedPayload.technicianPhone = r.staff_phone;
          }
          if (!formattedPayload.technicianEmail && r.staff_email) {
            formattedPayload.technicianEmail = r.staff_email;
          }
        }
      } catch (e) {
        console.warn('[N8N_WEBHOOK] Could not fetch work_order schedule info for TASK_SCHEDULE_CHANGED:', e.message);
      }
    }

    // Set all date and time synonyms on both top-level and data object
    formattedPayload.scheduledDate = schedDate;
    formattedPayload.scheduled_date = schedDate;
    formattedPayload.date = schedDate;
    formattedPayload.scheduledTime = schedTime;
    formattedPayload.scheduled_time = schedTime;
    formattedPayload.scheduledTimeSlot = schedTime;
    formattedPayload.scheduled_time_slot = schedTime;
    formattedPayload.time = schedTime;
    formattedPayload.timeSlot = schedTime;

    // Contact and recipient details
    formattedPayload.contactPhone = formattedPayload.contactPhone || formattedPayload.technicianPhone || formattedPayload.technician?.phone || null;
    formattedPayload.contactEmail = formattedPayload.contactEmail || formattedPayload.technicianEmail || formattedPayload.technician?.email || null;
    formattedPayload.to = formattedPayload.to || formattedPayload.contactPhone;
    formattedPayload.email = formattedPayload.email || formattedPayload.contactEmail;
    formattedPayload.phone = formattedPayload.phone || formattedPayload.contactPhone;

    if (!formattedPayload.data || typeof formattedPayload.data !== 'object') {
      formattedPayload.data = {};
    }
    formattedPayload.data.scheduledDate = schedDate;
    formattedPayload.data.scheduled_date = schedDate;
    formattedPayload.data.date = schedDate;
    formattedPayload.data.scheduledTime = schedTime;
    formattedPayload.data.scheduled_time = schedTime;
    formattedPayload.data.scheduledTimeSlot = schedTime;
    formattedPayload.data.scheduled_time_slot = schedTime;
    formattedPayload.data.time = schedTime;
    formattedPayload.data.timeSlot = schedTime;
    formattedPayload.data.actionUrl = formattedPayload.actionUrl;
    formattedPayload.data.propertyAddress = formattedPayload.propertyAddress;
    formattedPayload.data.contactPhone = formattedPayload.contactPhone;
    formattedPayload.data.contactEmail = formattedPayload.contactEmail;
    formattedPayload.data.technicianPhone = formattedPayload.technicianPhone;
    formattedPayload.data.technicianEmail = formattedPayload.technicianEmail;
    formattedPayload.data.technicianName = formattedPayload.technicianName;
    formattedPayload.data.to = formattedPayload.to;
    formattedPayload.data.email = formattedPayload.email;
    formattedPayload.data.phone = formattedPayload.phone;

    if (!formattedPayload.message) {
      const jobDesc = formattedPayload.jobNumber ? `Job #${formattedPayload.jobNumber}` : (formattedPayload.title || `Work Order #${workOrderId || ''}`);
      const addrDesc = formattedPayload.propertyAddress ? ` at ${formattedPayload.propertyAddress}` : '';
      const timeDesc = schedDate ? ` updated to ${schedDate}${schedTime ? ` (${schedTime})` : ''}` : '';
      formattedPayload.message = `Your maintenance schedule has been updated: ${jobDesc}${addrDesc}${timeDesc}. View details: ${formattedPayload.actionUrl}`;
    }
  }

  if (eventType === 'JOB_COMPLETED') {
    const frontendBase = getFrontendBaseUrl();
    const workOrderId = formattedPayload.workOrderId || formattedPayload.entityId || formattedPayload.relatedEntityId || null;

    if (workOrderId) {
      formattedPayload.entityId = formattedPayload.entityId || workOrderId;
      formattedPayload.workOrderId = formattedPayload.workOrderId || workOrderId;
      formattedPayload.reference = formattedPayload.reference || `work_orders #${workOrderId}`;
      const reportUrl = `${frontendBase}/jobs/${workOrderId}/report`;
      formattedPayload.actionUrl = reportUrl;
      formattedPayload.reportUrl = reportUrl;
      formattedPayload.pdfReportUrl = reportUrl;
    }

    formattedPayload.technicianName = formattedPayload.technicianName || formattedPayload.technician?.name || null;
    formattedPayload.technicianPhone = formattedPayload.technicianPhone || formattedPayload.technician?.phone || null;
    formattedPayload.technicianEmail = formattedPayload.technicianEmail || formattedPayload.technician?.email || null;

    formattedPayload.residentName = formattedPayload.residentName || formattedPayload.name || formattedPayload.tenantName || null;
    formattedPayload.residentPhone = formattedPayload.residentPhone || formattedPayload.tenantPhone || null;
    formattedPayload.residentEmail = formattedPayload.residentEmail || formattedPayload.tenantEmail || null;
    formattedPayload.propertyAddress = formattedPayload.propertyAddress || formattedPayload.address || null;

    if ((!formattedPayload.residentName || !formattedPayload.propertyAddress) && workOrderId) {
      try {
        const { pool } = require('../config/db');
        const [woRows] = await pool.query(
          `SELECT w.job_number, w.title, w.property_address, w.resident_name, w.contact_phone, w.contact_email,
                  r.full_name as live_res_name, r.phone as live_res_phone, r.email as live_res_email
           FROM work_orders w
           LEFT JOIN residents r ON w.resident_id = r.id
           WHERE w.id = ?`,
          [workOrderId]
        );
        if (woRows.length > 0) {
          const r = woRows[0];
          formattedPayload.jobNumber = formattedPayload.jobNumber || r.job_number;
          formattedPayload.title = formattedPayload.title || r.title;
          formattedPayload.propertyAddress = formattedPayload.propertyAddress || r.property_address;
          formattedPayload.residentName = formattedPayload.residentName || r.live_res_name || r.resident_name;
          formattedPayload.residentPhone = formattedPayload.residentPhone || r.live_res_phone || r.contact_phone;
          formattedPayload.residentEmail = formattedPayload.residentEmail || r.live_res_email || r.contact_email;
        }
      } catch (e) {
        console.warn('[N8N_WEBHOOK] Could not enrich JOB_COMPLETED info:', e.message);
      }
    }

    // Default recipient name to residentName for tenant completion notification
    formattedPayload.name = formattedPayload.name || formattedPayload.recipientName || formattedPayload.residentName;
    formattedPayload.recipientName = formattedPayload.name;

    formattedPayload.status = 'COMPLETED';
    formattedPayload.pipelineStage = 'Completed Jobs';
    formattedPayload.pipeline_stage = 'Completed Jobs';

    if (!formattedPayload.message) {
      formattedPayload.message = `Work order #${formattedPayload.jobNumber || workOrderId} "${formattedPayload.title || ''}" was completed by ${formattedPayload.technicianName || 'Technician'}`;
    }

    if (formattedPayload.data && typeof formattedPayload.data === 'object') {
      formattedPayload.data.actionUrl = formattedPayload.actionUrl;
      formattedPayload.data.reportUrl = formattedPayload.actionUrl;
      formattedPayload.data.pdfReportUrl = formattedPayload.actionUrl;
      formattedPayload.data.workOrderId = workOrderId;
      formattedPayload.data.reference = formattedPayload.reference;
      formattedPayload.data.name = formattedPayload.name;
      formattedPayload.data.recipientName = formattedPayload.recipientName;
      formattedPayload.data.technicianName = formattedPayload.technicianName;
      formattedPayload.data.technicianPhone = formattedPayload.technicianPhone;
      formattedPayload.data.technicianEmail = formattedPayload.technicianEmail;
      formattedPayload.data.residentName = formattedPayload.residentName;
      formattedPayload.data.residentPhone = formattedPayload.residentPhone;
      formattedPayload.data.residentEmail = formattedPayload.residentEmail;
      formattedPayload.data.propertyAddress = formattedPayload.propertyAddress;
      formattedPayload.data.status = 'COMPLETED';
      formattedPayload.data.pipelineStage = 'Completed Jobs';
    }
  }

  if (eventType === 'QUOTE_PHOTO_REQUEST' || eventType === 'NEW_QUOTE_REQUEST') {
    const frontendBase = getFrontendBaseUrl();
    const workOrderId = formattedPayload.workOrderId || formattedPayload.entityId || formattedPayload.relatedEntityId || null;
    let token = formattedPayload.secureToken || formattedPayload.data?.secure_token || null;

    if (workOrderId) {
      formattedPayload.entityId = formattedPayload.entityId || workOrderId;
      formattedPayload.workOrderId = formattedPayload.workOrderId || workOrderId;
      formattedPayload.reference = formattedPayload.reference || workOrderId;

      if (!formattedPayload.contactPhone || !formattedPayload.propertyAddress || !formattedPayload.residentName) {
        try {
          const { pool } = require('../config/db');
          const [woRows] = await pool.query(
            `SELECT w.job_number, w.title, w.property_address, w.resident_name, w.contact_phone, w.contact_email,
                    r.full_name as live_res_name, r.phone as live_res_phone, r.email as live_res_email
             FROM work_orders w
             LEFT JOIN residents r ON w.resident_id = r.id
             WHERE w.id = ?`,
            [workOrderId]
          );
          if (woRows.length > 0) {
            const r = woRows[0];
            formattedPayload.jobNumber = formattedPayload.jobNumber || r.job_number;
            formattedPayload.title = formattedPayload.title || r.title;
            formattedPayload.propertyAddress = formattedPayload.propertyAddress || r.property_address;
            formattedPayload.residentName = formattedPayload.residentName || r.live_res_name || r.resident_name;
            formattedPayload.residentPhone = formattedPayload.residentPhone || r.live_res_phone || r.contact_phone;
            formattedPayload.contactPhone = formattedPayload.contactPhone || r.contact_phone || r.live_res_phone;
            formattedPayload.residentEmail = formattedPayload.residentEmail || r.live_res_email || r.contact_email;
            formattedPayload.contactEmail = formattedPayload.contactEmail || r.contact_email || r.live_res_email;
          }
        } catch (e) {
          console.warn('[N8N_WEBHOOK] Could not enrich QUOTE_PHOTO_REQUEST info:', e.message);
        }
      }
    }

    if (!token && workOrderId) {
      try {
        const { pool } = require('../config/db');
        const [qrRows] = await pool.query(
          'SELECT secure_token FROM quote_requests WHERE work_order_id = ? ORDER BY created_at DESC LIMIT 1',
          [workOrderId]
        );
        if (qrRows.length > 0) token = qrRows[0].secure_token;
      } catch (e) {
        // ignore
      }
    }

    if (token) {
      const uploadUrl = `${frontendBase}/quote-request/${token}`;
      formattedPayload.actionUrl = uploadUrl;
      formattedPayload.uploadUrl = uploadUrl;
      formattedPayload.photoUploadLink = uploadUrl;
      formattedPayload.secureToken = token;
      if (formattedPayload.data) {
        formattedPayload.data.actionUrl = uploadUrl;
        formattedPayload.data.uploadUrl = uploadUrl;
        formattedPayload.data.photoUploadLink = uploadUrl;
        formattedPayload.data.uploadLink = uploadUrl;
        formattedPayload.data.secureToken = token;
      }
    }

    formattedPayload.to = formattedPayload.to || formattedPayload.contactPhone || formattedPayload.residentPhone;
    formattedPayload.phone = formattedPayload.phone || formattedPayload.contactPhone || formattedPayload.residentPhone;
    formattedPayload.name = formattedPayload.name || formattedPayload.residentName || formattedPayload.data?.name || formattedPayload.data?.residentName || formattedPayload.data?.resident_name || 'Resident';
    formattedPayload.residentName = formattedPayload.name;
    formattedPayload.recipientName = formattedPayload.name;
    formattedPayload.address = formattedPayload.address || formattedPayload.propertyAddress;
    formattedPayload.email = formattedPayload.email || formattedPayload.contactEmail || formattedPayload.residentEmail;
    formattedPayload.contactEmail = formattedPayload.contactEmail || formattedPayload.email;
    formattedPayload.residentEmail = formattedPayload.residentEmail || formattedPayload.email;
    formattedPayload.contactPhone = formattedPayload.contactPhone || formattedPayload.phone;
    formattedPayload.residentPhone = formattedPayload.residentPhone || formattedPayload.phone;

    if (formattedPayload.data && typeof formattedPayload.data === 'object') {
      formattedPayload.data.to = formattedPayload.to;
      formattedPayload.data.phone = formattedPayload.phone;
      formattedPayload.data.contactPhone = formattedPayload.contactPhone;
      formattedPayload.data.residentPhone = formattedPayload.residentPhone;
      formattedPayload.data.email = formattedPayload.email;
      formattedPayload.data.contactEmail = formattedPayload.contactEmail;
      formattedPayload.data.residentEmail = formattedPayload.residentEmail;
      formattedPayload.data.residentName = formattedPayload.residentName;
      formattedPayload.data.resident_name = formattedPayload.residentName;
      formattedPayload.data.name = formattedPayload.name;
      formattedPayload.data.recipientName = formattedPayload.name;
      formattedPayload.data.propertyAddress = formattedPayload.propertyAddress;
      formattedPayload.data.address = formattedPayload.address;
      formattedPayload.data.title = formattedPayload.title;
      formattedPayload.data.jobNumber = formattedPayload.jobNumber;
    }
  }

  if (eventType === 'BOOKING_CONFIRMED') {
    const frontendBase = getFrontendBaseUrl();
    const workOrderId = formattedPayload.workOrderId || formattedPayload.entityId || formattedPayload.relatedEntityId || null;
    let token = formattedPayload.secureToken || formattedPayload.data?.token || formattedPayload.data?.secure_token || null;

    if (!token && workOrderId) {
      try {
        const { pool } = require('../config/db');
        const [bRows] = await pool.query(
          'SELECT secure_token FROM booking_requests WHERE work_order_id = ? ORDER BY created_at DESC LIMIT 1',
          [workOrderId]
        );
        if (bRows.length > 0) token = bRows[0].secure_token;
      } catch (e) {}
    }

    const bookingUrl = token ? `${frontendBase}/booking/${token}` : `${frontendBase}/maintenance/my-tasks`;
    formattedPayload.actionUrl = bookingUrl;
    formattedPayload.bookingUrl = bookingUrl;
    formattedPayload.bookingLink = bookingUrl;

    const dataObj = formattedPayload.data || {};
    const resName = formattedPayload.residentName || formattedPayload.name || dataObj.resident_name || dataObj.residentName || null;
    const propAddr = formattedPayload.propertyAddress || formattedPayload.property || dataObj.property_address || dataObj.property || dataObj.address || null;
    const dateVal = formattedPayload.scheduledDate || formattedPayload.date || dataObj.scheduled_date || dataObj.date || null;
    const timeVal = formattedPayload.scheduledTimeSlot || formattedPayload.timeSlot || formattedPayload.time || dataObj.scheduled_time_slot || dataObj.time_slot || dataObj.timeSlot || null;
    const techName = formattedPayload.technicianName || dataObj.technician_name || null;

    formattedPayload.reference = workOrderId;
    formattedPayload.workOrderId = workOrderId;
    formattedPayload.entityId = workOrderId;
    formattedPayload.name = resName;
    formattedPayload.residentName = resName;
    formattedPayload.property = propAddr;
    formattedPayload.propertyAddress = propAddr;
    formattedPayload.date = dateVal;
    formattedPayload.scheduledDate = dateVal;
    formattedPayload.time = timeVal;
    formattedPayload.timeSlot = timeVal;
    formattedPayload.scheduledTimeSlot = timeVal;
    formattedPayload.technicianName = techName;

    if (formattedPayload.data && typeof formattedPayload.data === 'object') {
      formattedPayload.data.actionUrl = bookingUrl;
      formattedPayload.data.bookingUrl = bookingUrl;
      formattedPayload.data.bookingLink = bookingUrl;
      formattedPayload.data.reference = workOrderId;
      formattedPayload.data.name = resName;
      formattedPayload.data.residentName = resName;
      formattedPayload.data.property = propAddr;
      formattedPayload.data.propertyAddress = propAddr;
      formattedPayload.data.date = dateVal;
      formattedPayload.data.scheduledDate = dateVal;
      formattedPayload.data.time = timeVal;
      formattedPayload.data.timeSlot = timeVal;
      formattedPayload.data.scheduledTimeSlot = timeVal;
    }
  }

  if (eventType === 'BOOKING_REQUEST') {
    const frontendBase = getFrontendBaseUrl();
    const workOrderId = formattedPayload.workOrderId || formattedPayload.entityId || formattedPayload.relatedEntityId || null;
    let token = formattedPayload.bookingToken || formattedPayload.secureToken || formattedPayload.data?.bookingToken || formattedPayload.data?.secure_token || null;

    if (workOrderId) {
      formattedPayload.entityId = formattedPayload.entityId || workOrderId;
      formattedPayload.workOrderId = formattedPayload.workOrderId || workOrderId;
      formattedPayload.reference = formattedPayload.reference || workOrderId;

      if (!formattedPayload.contactPhone || !formattedPayload.propertyAddress || !formattedPayload.residentName) {
        try {
          const { pool } = require('../config/db');
          const [woRows] = await pool.query(
            `SELECT w.job_number, w.title, w.property_address, w.resident_name, w.contact_phone, w.contact_email,
                    r.full_name as live_res_name, r.phone as live_res_phone, r.email as live_res_email
             FROM work_orders w
             LEFT JOIN residents r ON w.resident_id = r.id
             WHERE w.id = ?`,
            [workOrderId]
          );
          if (woRows.length > 0) {
            const r = woRows[0];
            formattedPayload.jobNumber = formattedPayload.jobNumber || r.job_number;
            formattedPayload.title = formattedPayload.title || r.title;
            formattedPayload.propertyAddress = formattedPayload.propertyAddress || r.property_address;
            formattedPayload.residentName = formattedPayload.residentName || r.live_res_name || r.resident_name;
            formattedPayload.residentPhone = formattedPayload.residentPhone || r.live_res_phone || r.contact_phone;
            formattedPayload.contactPhone = formattedPayload.contactPhone || r.contact_phone || r.live_res_phone;
            formattedPayload.residentEmail = formattedPayload.residentEmail || r.live_res_email || r.contact_email;
            formattedPayload.contactEmail = formattedPayload.contactEmail || r.contact_email || r.live_res_email;
          }
        } catch (e) {
          console.warn('[N8N_WEBHOOK] Could not enrich BOOKING_REQUEST info:', e.message);
        }
      }
    }

    if (!token && workOrderId) {
      try {
        const { pool } = require('../config/db');
        const [bRows] = await pool.query(
          'SELECT secure_token FROM booking_requests WHERE work_order_id = ? ORDER BY created_at DESC LIMIT 1',
          [workOrderId]
        );
        if (bRows.length > 0) token = bRows[0].secure_token;
      } catch (e) {}
    }

    if (token) {
      const bookingUrl = `${frontendBase}/booking/${token}`;
      formattedPayload.actionUrl = bookingUrl;
      formattedPayload.bookingUrl = bookingUrl;
      formattedPayload.bookingLink = bookingUrl;
      if (formattedPayload.data && typeof formattedPayload.data === 'object') {
        formattedPayload.data.actionUrl = bookingUrl;
        formattedPayload.data.bookingUrl = bookingUrl;
        formattedPayload.data.bookingLink = bookingUrl;
      }
    }

    const dataObj = formattedPayload.data || {};
    const resName = formattedPayload.residentName || formattedPayload.name || dataObj.resident_name || dataObj.residentName || null;
    const propAddr = formattedPayload.propertyAddress || formattedPayload.property || dataObj.property_address || dataObj.property || dataObj.address || null;

    formattedPayload.reference = workOrderId;
    formattedPayload.workOrderId = workOrderId;
    formattedPayload.name = resName;
    formattedPayload.residentName = resName;
    formattedPayload.property = propAddr;
    formattedPayload.propertyAddress = propAddr;
    formattedPayload.to = formattedPayload.to || formattedPayload.contactPhone || formattedPayload.residentPhone;
    formattedPayload.phone = formattedPayload.phone || formattedPayload.contactPhone || formattedPayload.residentPhone;

    if (formattedPayload.data && typeof formattedPayload.data === 'object') {
      formattedPayload.data.to = formattedPayload.to;
      formattedPayload.data.contactPhone = formattedPayload.contactPhone;
      formattedPayload.data.residentPhone = formattedPayload.residentPhone;
      formattedPayload.data.contactEmail = formattedPayload.contactEmail;
      formattedPayload.data.residentEmail = formattedPayload.residentEmail;
      formattedPayload.data.residentName = formattedPayload.residentName;
      formattedPayload.data.propertyAddress = formattedPayload.propertyAddress;
    }
  }

  if (eventType === 'ADMIN_OFFICE_ALERT') {
    const frontendBase = getFrontendBaseUrl();
    const workOrderId = formattedPayload.workOrderId || formattedPayload.entityId || formattedPayload.relatedEntityId || null;

    if (workOrderId && !formattedPayload.actionUrl) {
      if (formattedPayload.alertType === 'QUOTE_PHOTOS_UPLOADED') {
        formattedPayload.actionUrl = `${frontendBase}/admin/pipeline?stage=READY_TO_QUOTE`;
      } else if (formattedPayload.alertType === 'BOOKING_CONFIRMED') {
        formattedPayload.actionUrl = `${frontendBase}/admin/calendar`;
      } else if (formattedPayload.alertType === 'JOB_COMPLETED') {
        formattedPayload.actionUrl = `${frontendBase}/jobs/${workOrderId}/report`;
      } else {
        formattedPayload.actionUrl = `${frontendBase}/admin/pipeline`;
      }
    }

    // Ensure recipientEmail is formatted as a single clean comma-separated string (no array)
    let recipientStr = formattedPayload.recipientEmail || '';
    if (Array.isArray(recipientStr)) {
      recipientStr = recipientStr.join(', ');
    }
    if (!recipientStr || recipientStr.trim() === '') {
      recipientStr = 'admin@nexusfms.com';
    }
    formattedPayload.recipientEmail = recipientStr;

    // Fallback standard keys for email nodes that accept 'to' or 'email'
    formattedPayload.to = recipientStr;
    formattedPayload.email = recipientStr;

    // Ensure subject and headline are always populated
    formattedPayload.subject = formattedPayload.subject || `[Nexus FMS] Alert: ${formattedPayload.alertType || 'Operational Update'}`;
    formattedPayload.headline = formattedPayload.headline || formattedPayload.title || 'Operational Notification';
    formattedPayload.message = formattedPayload.message || formattedPayload.description || '';

    if (formattedPayload.data && typeof formattedPayload.data === 'object') {
      formattedPayload.data.alertType = formattedPayload.alertType;
      formattedPayload.data.recipientEmail = formattedPayload.recipientEmail;
      formattedPayload.data.to = formattedPayload.to;
      formattedPayload.data.email = formattedPayload.email;
      formattedPayload.data.subject = formattedPayload.subject;
      formattedPayload.data.headline = formattedPayload.headline;
      formattedPayload.data.message = formattedPayload.message;
      formattedPayload.data.actionUrl = formattedPayload.actionUrl;
    }
  }

  if (eventType === 'TENANT_REGISTRATION' || eventType === 'RESIDENT_REGISTRATION') {
    const frontendBase = getFrontendBaseUrl();
    const residentName = formattedPayload.residentName || formattedPayload.name || formattedPayload.full_name || 'Resident';
    const residentPhone = formattedPayload.residentPhone || formattedPayload.phone || formattedPayload.contactPhone || null;
    const residentEmail = formattedPayload.residentEmail || formattedPayload.email || formattedPayload.contactEmail || null;
    const residentAddress = formattedPayload.residentAddress || formattedPayload.address || formattedPayload.propertyAddress || '';

    formattedPayload.name = residentName;
    formattedPayload.residentName = residentName;
    formattedPayload.recipientName = residentName;
    formattedPayload.phone = residentPhone;
    formattedPayload.contactPhone = residentPhone;
    formattedPayload.residentPhone = residentPhone;
    formattedPayload.to = formattedPayload.to || residentPhone;
    formattedPayload.email = residentEmail;
    formattedPayload.contactEmail = residentEmail;
    formattedPayload.residentEmail = residentEmail;
    formattedPayload.address = residentAddress;
    formattedPayload.propertyAddress = residentAddress;
    formattedPayload.actionUrl = formattedPayload.actionUrl || frontendBase;
    formattedPayload.subject = formattedPayload.subject || 'Welcome to Nexus FMS - Resident Registration Confirmation';
    if (!formattedPayload.message) {
      formattedPayload.message = `Hello ${residentName}, welcome to Nexus FMS! You have been registered for property maintenance services at ${residentAddress}. For any maintenance requests, contact us or visit ${frontendBase}. Nexus Facility Management.`;
    }

    if (formattedPayload.data && typeof formattedPayload.data === 'object') {
      formattedPayload.data.name = residentName;
      formattedPayload.data.residentName = residentName;
      formattedPayload.data.recipientName = residentName;
      formattedPayload.data.phone = residentPhone;
      formattedPayload.data.email = residentEmail;
      formattedPayload.data.address = residentAddress;
      formattedPayload.data.subject = formattedPayload.subject;
      formattedPayload.data.message = formattedPayload.message;
      formattedPayload.data.actionUrl = formattedPayload.actionUrl;
    }
  }

  if (eventType === 'STAFF_REGISTRATION' || eventType === 'TECHNICIAN_REGISTRATION') {
    const frontendBase = getFrontendBaseUrl();
    const staffName = formattedPayload.staffName || formattedPayload.technicianName || formattedPayload.name || 'Technician';
    const staffPhone = formattedPayload.staffPhone || formattedPayload.technicianPhone || formattedPayload.phone || formattedPayload.contactPhone || null;
    const staffEmail = formattedPayload.staffEmail || formattedPayload.technicianEmail || formattedPayload.email || formattedPayload.contactEmail || null;
    const staffCode = formattedPayload.staffCode || formattedPayload.technicianCode || '';
    const plainPassword = formattedPayload.password || formattedPayload.plainPassword || 'Password123!';
    const portalUrl = `${frontendBase}/maintenance/my-tasks`;

    formattedPayload.name = staffName;
    formattedPayload.technicianName = staffName;
    formattedPayload.recipientName = staffName;
    formattedPayload.phone = staffPhone;
    formattedPayload.contactPhone = staffPhone;
    formattedPayload.technicianPhone = staffPhone;
    formattedPayload.to = formattedPayload.to || staffPhone;
    formattedPayload.email = staffEmail;
    formattedPayload.contactEmail = staffEmail;
    formattedPayload.technicianEmail = staffEmail;
    formattedPayload.staffCode = staffCode;
    formattedPayload.actionUrl = portalUrl;
    formattedPayload.portalUrl = portalUrl;
    formattedPayload.subject = formattedPayload.subject || 'Welcome to Nexus FMS - Technician Account Details';
    if (!formattedPayload.message) {
      formattedPayload.message = `Hello ${staffName}, welcome to Nexus FMS! Your technician account has been created.\nStaff ID: ${staffCode}\nPortal: ${portalUrl}\nEmail: ${staffEmail}\nPassword: ${plainPassword}\nPlease log in to view and manage your assigned tasks.`;
    }

    if (formattedPayload.data && typeof formattedPayload.data === 'object') {
      formattedPayload.data.name = staffName;
      formattedPayload.data.technicianName = staffName;
      formattedPayload.data.recipientName = staffName;
      formattedPayload.data.phone = staffPhone;
      formattedPayload.data.email = staffEmail;
      formattedPayload.data.staffCode = staffCode;
      formattedPayload.data.password = plainPassword;
      formattedPayload.data.portalUrl = portalUrl;
      formattedPayload.data.actionUrl = portalUrl;
      formattedPayload.data.subject = formattedPayload.subject;
      formattedPayload.data.message = formattedPayload.message;
    }
  }

  // Auto-normalize all phone number fields to international E.164 format (+91 / +44)
  const phoneFields = ['to', 'phone', 'contactPhone', 'technicianPhone', 'residentPhone', 'tenantPhone'];
  for (const f of phoneFields) {
    if (formattedPayload[f]) {
      formattedPayload[f] = normalizePhoneNumber(formattedPayload[f]);
    }
    if (formattedPayload.data && formattedPayload.data[f]) {
      formattedPayload.data[f] = normalizePhoneNumber(formattedPayload.data[f]);
    }
  }

  const eventData = {
    event: eventType,
    timestamp: new Date().toISOString(),
    source: 'nexus_fms_backend',
    ...formattedPayload,
    data: formattedPayload,
  };

  if (!n8nWebhookUrl) {
    console.log(`[N8N_WEBHOOK_DEV] 📡 Event "${eventType}" ready. (Set N8N_WEBHOOK_URL in .env to dispatch live)`);
    return { success: true, mode: 'mock', event: eventType };
  }

  try {
    console.log(`[N8N_WEBHOOK] 🚀 Dispatching "${eventType}" to ${n8nWebhookUrl}`);
    
    const response = await fetch(n8nWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Nexus-Event': eventType,
        'X-Nexus-Secret': process.env.WEBHOOK_SECRET_KEY || 'nexus-secret',
      },
      body: JSON.stringify(eventData),
    });

    if (!response.ok) {
      console.warn(`[N8N_WEBHOOK] ⚠ N8N returned status ${response.status}`);
      return { success: false, status: response.status };
    }

    const resJson = await response.json().catch(() => ({}));
    console.log(`[N8N_WEBHOOK] ✓ Event "${eventType}" successfully delivered to N8N`);
    return { success: true, data: resJson };
  } catch (err) {
    console.error(`[N8N_WEBHOOK_ERROR] ❌ Failed to send webhook for "${eventType}":`, err.message);
    return { success: false, error: err.message };
  }
};

/**
 * Resolves the single active Admin email and single active Office Team email.
 * Formats as a clean comma-separated string: "admin@email.com, office@email.com"
 * If none found, gracefully falls back to system supportEmail or admin@nexusfms.com.
 */
const getAdminAndOfficeRecipientEmail = async (dbPoolOrConnection) => {
  try {
    const db = dbPoolOrConnection || require('../config/db').pool;
    const [adminRows] = await db.query(
      "SELECT email FROM users WHERE role IN ('OFFICE_ADMIN', 'ADMIN') AND is_active = 1 LIMIT 1"
    );
    const [officeRows] = await db.query(
      "SELECT email FROM users WHERE role = 'OFFICE_TEAM' AND is_active = 1 LIMIT 1"
    );

    const adminEmail = adminRows[0]?.email;
    const officeEmail = officeRows[0]?.email;

    const recipients = [adminEmail, officeEmail].filter(Boolean);
    if (recipients.length > 0) {
      return recipients.join(', ');
    }
  } catch (err) {
    console.warn('[N8N_WEBHOOK] Could not resolve admin/office recipient emails from DB:', err.message);
  }
  return 'admin@nexusfms.com';
};

module.exports = {
  dispatchN8NWebhook,
  getAdminAndOfficeRecipientEmail,
};
