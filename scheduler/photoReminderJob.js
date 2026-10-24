const { pool } = require('../config/db');
const NotificationService = require('../services/notification.service');
const QuoteRequestService = require('../services/quoteRequest.service');

const MAX_REMINDERS = parseInt(process.env.QUOTE_PHOTO_MAX_REMINDERS || '14', 10);
const REMINDER_INTERVAL_HOURS = parseInt(process.env.PHOTO_REMINDER_INTERVAL_HOURS || '24', 10); // 24 hours (1 day daily reminder)

const runPhotoReminderJob = async () => {
  console.log(`[PhotoReminderJob] Starting check for pending quote photo requests...`);
  try {
    // ── Self-Healing Reconciliation Step ──────────────────────────────────────────
    // Automatically detect any work order in 'Quotes' stage (e.g. from CSV import
    // or manual creation) that is missing a quote_request entry, and generate it.
    const [unlinkedQuotes] = await pool.query(
      `SELECT w.id, w.job_number, w.title
       FROM work_orders w
       LEFT JOIN quote_requests qr ON w.id = qr.work_order_id
       WHERE w.pipeline_stage = 'Quotes'
         AND qr.id IS NULL`
    );

    if (unlinkedQuotes.length > 0) {
      console.log(`[PhotoReminderJob] 🔄 Detected ${unlinkedQuotes.length} quotes without active photo requests. Reconciling...`);
      for (const q of unlinkedQuotes) {
        try {
          await QuoteRequestService.triggerAutoPhotoRequest(q.id);
          console.log(`[PhotoReminderJob] ✓ Reconciled photo request & dispatched link for Quote #${q.job_number || q.id}`);
        } catch (qErr) {
          console.error(`[PhotoReminderJob] ❌ Failed to auto-generate photo request for Quote #${q.id}:`, qErr.message);
        }
      }
    }

    const [pendingRequests] = await pool.query(
      `SELECT qr.id, qr.work_order_id, qr.status, qr.last_photo_reminder_at, qr.photo_reminder_count, qr.created_at, qr.secure_token,
              w.title, w.resident_name as fallback_resident_name, w.contact_phone as fallback_resident_phone,
              r.id as resident_id, r.full_name as resident_name, r.email as resident_email, r.phone as resident_phone
       FROM quote_requests qr
       JOIN work_orders w ON qr.work_order_id = w.id
       LEFT JOIN residents r ON w.resident_id = r.id
       WHERE qr.status IN ('PENDING', 'PHOTO_REQUEST_PENDING') 
         AND qr.photo_reminder_count < ?`,
      [MAX_REMINDERS]
    );

    let remindersSent = 0;
    const now = new Date();

    for (const req of pendingRequests) {
      const createdAt = new Date(req.created_at);
      const lastReminderAt = req.last_photo_reminder_at ? new Date(req.last_photo_reminder_at) : null;
      
      const hoursSinceCreation = (now - createdAt) / (1000 * 60 * 60);
      const hoursSinceLastReminder = lastReminderAt ? (now - lastReminderAt) / (1000 * 60 * 60) : null;

      // Rule: At least 24h since creation AND (no reminder sent OR at least 24h since last reminder)
      if (hoursSinceCreation >= REMINDER_INTERVAL_HOURS) {
        if (!lastReminderAt || hoursSinceLastReminder >= REMINDER_INTERVAL_HOURS) {
          
          const connection = await pool.getConnection();
          try {
            await connection.beginTransaction();

            // Lock the specific quote request row to prevent concurrent scheduler race conditions
            const [lockedRows] = await connection.query(
              `SELECT id, photo_reminder_count, last_photo_reminder_at FROM quote_requests WHERE id = ? FOR UPDATE`,
              [req.id]
            );

            if (lockedRows.length === 0) {
              await connection.rollback();
              continue; // Deleted or missing
            }

            const lockedReq = lockedRows[0];
            const lockedLastReminder = lockedReq.last_photo_reminder_at ? new Date(lockedReq.last_photo_reminder_at) : null;
            const lockedHoursSince = lockedLastReminder ? (now - lockedLastReminder) / (1000 * 60 * 60) : null;

            // Re-check conditions inside lock
            if (lockedReq.photo_reminder_count >= MAX_REMINDERS || (lockedLastReminder && lockedHoursSince < REMINDER_INTERVAL_HOURS)) {
              await connection.rollback();
              continue; // Another process already sent it
            }

            // Update DB safely first (Commit intent)
            await connection.query(
              `UPDATE quote_requests 
               SET last_photo_reminder_at = NOW(), 
                   photo_reminder_count = photo_reminder_count + 1 
               WHERE id = ?`,
              [req.id]
            );

            // Send notification through central dispatcher
            const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
            const uploadLink = `${frontendBase}/quote-request/${req.secure_token}`;

            const dispatcher = require('../services/notification.service');
            
            const resName = req.resident_name || req.fallback_resident_name || 'Resident';
            const resPhone = req.resident_phone || req.fallback_resident_phone || null;

            if (resPhone || req.resident_id) {
               await dispatcher.dispatch({
                 recipientUserId: req.resident_id || null,
                 recipientRole: 'TENANT',
                 type: 'QUOTE_PHOTO_REMINDER',
                 title: 'Reminder: Photos Required for Your Quote',
                 messageTemplate: `Hi {{resident_name}},\n\nThis is a reminder that we are still waiting for the requested photos/details to prepare the quote for your maintenance request ({{title}}).\n\nPlease use the secure link below to upload the requested photos/details:\n{{uploadLink}}\n\nThank you.`,
                 structuredData: {
                    resident_name: resName,
                    title: req.title,
                    uploadLink
                 },
                 actionUrl: uploadLink,
                 relatedEntityType: 'work_orders',
                 relatedEntityId: req.work_order_id,
                 channels: ['SMS'],
                 contactEmail: null,
                 contactPhone: resPhone,
                 connection // Pass transaction
               });
            }

            await connection.commit();
            console.log(`[PhotoReminderJob] Reminder #${lockedReq.photo_reminder_count + 1} sent safely for Work Order #${req.work_order_id}`);
            remindersSent++;

          } catch (txErr) {
            await connection.rollback();
            console.error(`[PhotoReminderJob] Transaction error for request #${req.id}:`, txErr);
          } finally {
            connection.release();
          }
        }
      }
    }

    console.log(`[PhotoReminderJob] Completed check. Sent ${remindersSent} reminders.`);
  } catch (error) {
    console.error(`[PhotoReminderJob] Error during execution:`, error);
  }
};

const initScheduler = () => {
  // Run immediately on startup, then every 1 hour (3600000 ms)
  runPhotoReminderJob();
  setInterval(runPhotoReminderJob, 60 * 60 * 1000);
  console.log(`[PhotoReminderJob] Scheduler initialized. Checking every 1 hour.`);
};

module.exports = {
  initScheduler,
  runPhotoReminderJob // exported for testing
};
