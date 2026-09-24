const { pool } = require('../config/db');
const NotificationService = require('../services/notification.service');

const MAX_REMINDERS = parseInt(process.env.BOOKING_MAX_REMINDERS || '3', 10);
const REMINDER_INTERVAL_HOURS = 72; // 3 days

const runBookingReminderJob = async () => {
  console.log(`[BookingReminderJob] Starting check for pending booking requests...`);
  try {
    // We do not use FOR UPDATE on the initial bulk SELECT to avoid locking the entire table unnecessarily
    const [pendingRequests] = await pool.query(
      `SELECT br.id, br.work_order_id, br.status, br.last_reminder_at, br.reminder_count, br.created_at, br.secure_token,
              w.title, r.id as resident_id, r.full_name as resident_name, r.email as resident_email, r.phone as resident_phone
       FROM booking_requests br
       JOIN work_orders w ON br.work_order_id = w.id
       LEFT JOIN residents r ON w.resident_id = r.id
       WHERE br.status = 'WAITING_FOR_BOOKING' 
         AND br.reminder_count < ?`,
      [MAX_REMINDERS]
    );

    let remindersSent = 0;
    const now = new Date();

    for (const req of pendingRequests) {
      const createdAt = new Date(req.created_at);
      const lastReminderAt = req.last_reminder_at ? new Date(req.last_reminder_at) : null;
      
      const hoursSinceCreation = (now - createdAt) / (1000 * 60 * 60);
      const hoursSinceLastReminder = lastReminderAt ? (now - lastReminderAt) / (1000 * 60 * 60) : null;

      // Rule: At least 72h since creation AND (no reminder sent OR at least 72h since last reminder)
      if (hoursSinceCreation >= REMINDER_INTERVAL_HOURS) {
        if (!lastReminderAt || hoursSinceLastReminder >= REMINDER_INTERVAL_HOURS) {
          
          const connection = await pool.getConnection();
          try {
            await connection.beginTransaction();

            // Lock the specific booking request row to prevent concurrent scheduler race conditions
            const [lockedRows] = await connection.query(
              `SELECT id, reminder_count, last_reminder_at FROM booking_requests WHERE id = ? FOR UPDATE`,
              [req.id]
            );

            if (lockedRows.length === 0) {
              await connection.rollback();
              continue; // Deleted or missing
            }

            const lockedReq = lockedRows[0];
            const lockedLastReminder = lockedReq.last_reminder_at ? new Date(lockedReq.last_reminder_at) : null;
            const lockedHoursSince = lockedLastReminder ? (now - lockedLastReminder) / (1000 * 60 * 60) : null;

            // Re-check conditions inside lock
            if (lockedReq.reminder_count >= MAX_REMINDERS || (lockedLastReminder && lockedHoursSince < REMINDER_INTERVAL_HOURS)) {
              await connection.rollback();
              continue; // Another process already sent it
            }

            // Update DB safely first (Commit intent)
            await connection.query(
              `UPDATE booking_requests 
               SET last_reminder_at = NOW(), 
                   reminder_count = reminder_count + 1 
               WHERE id = ?`,
              [req.id]
            );

            // Send notification through central dispatcher
            const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
            const bookingLink = `${frontendBase}/public/book-appointment/${req.secure_token}`;

            const dispatcher = require('../services/notification.service');
            
            // Note: resident might be null, but we dispatch anyway for robustness
            if (req.resident_id) {
               await dispatcher.dispatch({
                 recipientUserId: req.resident_id, // assuming resident acts as user in this context, or maybe we map it?
                 recipientRole: 'TENANT',
                 type: 'BOOKING_REMINDER',
                 title: 'Reminder: Please Book Your Maintenance Appointment',
                 messageTemplate: `Hi {{resident_name}},\n\nWe are still waiting for you to book your maintenance appointment for "{{title}}".\n\nPlease use the link below to select the next available appointment:\n{{bookingLink}}\n\nThank you.`,
                 structuredData: {
                    resident_name: req.resident_name || 'Resident',
                    title: req.title,
                    bookingLink
                 },
                 actionUrl: bookingLink,
                 relatedEntityType: 'work_orders',
                 relatedEntityId: req.work_order_id,
                 channels: ['EMAIL', 'SMS'],
                 contactEmail: req.resident_email,
                 contactPhone: req.resident_phone,
                 connection // Pass transaction
               });
            }

            await connection.commit();
            console.log(`[BookingReminderJob] Reminder #${lockedReq.reminder_count + 1} sent safely for Work Order #${req.work_order_id}`);
            remindersSent++;

          } catch (txErr) {
            await connection.rollback();
            console.error(`[BookingReminderJob] Transaction error for request #${req.id}:`, txErr);
          } finally {
            connection.release();
          }
        }
      }
    }

    console.log(`[BookingReminderJob] Completed check. Sent ${remindersSent} reminders.`);
  } catch (error) {
    console.error(`[BookingReminderJob] Error during execution:`, error);
  }
};

const initBookingScheduler = () => {
  // Run immediately on startup, then every 1 hour (3600000 ms)
  runBookingReminderJob();
  setInterval(runBookingReminderJob, 60 * 60 * 1000);
  console.log(`[BookingReminderJob] Scheduler initialized. Checking every 1 hour.`);
};

module.exports = {
  initBookingScheduler,
  runBookingReminderJob // exported for testing
};
