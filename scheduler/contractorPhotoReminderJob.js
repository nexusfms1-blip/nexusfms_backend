const { pool } = require('../config/db');

/**
 * Contractor Photo / Report Daily Reminder Job
 * --------------------------------------------
 * When office staff click "Remind Contractor" on a job, the work order gets
 * `contractor_reminder_active = 1`. This scheduler then re-sends the reminder
 * once every 24 hours (starting from the booking date) until the contractor has
 * uploaded completion photos AND submitted a work report.
 *
 * Reminders stop automatically when:
 *   - Photos + report are both present (requirement satisfied), or
 *   - The job is moved out of Jobs / Completed Jobs (e.g. rescheduled / invoiced), or
 *   - MAX_REMINDERS is reached (safety cap).
 */

const MAX_REMINDERS = parseInt(process.env.CONTRACTOR_REMINDER_MAX || '30', 10);
const REMINDER_INTERVAL_HOURS = parseInt(process.env.CONTRACTOR_REMINDER_INTERVAL_HOURS || '24', 10);
const ACTIVE_STAGES = ['Jobs', 'Completed Jobs'];

const getTodayStr = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const deactivateReminder = (id) =>
  pool.query('UPDATE work_orders SET contractor_reminder_active = 0 WHERE id = ?', [id]);

const runContractorPhotoReminderJob = async () => {
  console.log('[ContractorPhotoReminderJob] Checking jobs with active contractor reminders...');
  let sent = 0;
  try {
    const [jobs] = await pool.query(
      `SELECT id, job_number, title, property_address, assigned_staff_id, assigned_staff_ids,
              pipeline_stage, scheduled_date, contractor_reminder_count
       FROM work_orders
       WHERE contractor_reminder_active = 1`
    );

    if (jobs.length === 0) {
      console.log('[ContractorPhotoReminderJob] No active contractor reminders.');
      return;
    }

    const todayStr = getTodayStr();
    const dispatcher = require('../services/notification.service');

    for (const wo of jobs) {
      try {
        // 1. Stop if job is no longer in an active stage (rescheduled, invoiced, back to quotes etc.)
        if (!ACTIVE_STAGES.includes(wo.pipeline_stage)) {
          await deactivateReminder(wo.id);
          console.log(`[ContractorPhotoReminderJob] Job #${wo.id} moved to "${wo.pipeline_stage}" - reminder stopped.`);
          continue;
        }

        // 2. Safety cap
        if ((wo.contractor_reminder_count || 0) >= MAX_REMINDERS) {
          await deactivateReminder(wo.id);
          console.log(`[ContractorPhotoReminderJob] Job #${wo.id} reached max reminders (${MAX_REMINDERS}) - reminder stopped.`);
          continue;
        }

        // 3. Only remind from the booking date onwards
        const schedDate = wo.scheduled_date ? String(wo.scheduled_date).substring(0, 10) : null;
        if (schedDate && schedDate > todayStr) continue;

        // 4. Stop if photos AND report are already submitted
        const [mediaRows] = await pool.query(
          'SELECT COUNT(*) AS count FROM staff_completion_media WHERE work_order_id = ?',
          [wo.id]
        );
        const hasMedia = Number(mediaRows[0]?.count || 0) > 0;

        const [compRows] = await pool.query(
          'SELECT work_report_summary FROM staff_job_completions WHERE work_order_id = ? LIMIT 1',
          [wo.id]
        );
        const hasReport = Boolean(compRows[0]?.work_report_summary && String(compRows[0].work_report_summary).trim().length > 0);

        if (hasMedia && hasReport) {
          await deactivateReminder(wo.id);
          console.log(`[ContractorPhotoReminderJob] Job #${wo.id} has photos & report - reminder stopped.`);
          continue;
        }

        // 5. Atomically claim this reminder slot (prevents duplicate sends across instances / restarts)
        const [claim] = await pool.query(
          `UPDATE work_orders
           SET last_contractor_reminder_at = NOW(),
               contractor_reminder_count = IFNULL(contractor_reminder_count, 0) + 1
           WHERE id = ?
             AND contractor_reminder_active = 1
             AND (last_contractor_reminder_at IS NULL
                  OR last_contractor_reminder_at <= DATE_SUB(NOW(), INTERVAL ? HOUR))`,
          [wo.id, REMINDER_INTERVAL_HOURS]
        );
        if (!claim.affectedRows) continue; // Not due yet

        // 6. Resolve assigned contractor(s)
        const staffProfileIds = new Set();
        if (wo.assigned_staff_id) staffProfileIds.add(Number(wo.assigned_staff_id));
        if (wo.assigned_staff_ids) {
          try {
            const parsed = typeof wo.assigned_staff_ids === 'string' ? JSON.parse(wo.assigned_staff_ids) : wo.assigned_staff_ids;
            if (Array.isArray(parsed)) parsed.forEach(sid => staffProfileIds.add(Number(sid)));
          } catch { /* ignore malformed JSON */ }
        }
        if (staffProfileIds.size === 0) {
          await deactivateReminder(wo.id);
          continue;
        }

        const [contractors] = await pool.query(
          `SELECT u.id AS user_id, u.full_name, u.phone
           FROM staff_profiles sp
           JOIN users u ON sp.user_id = u.id
           WHERE sp.id IN (?)`,
          [Array.from(staffProfileIds)]
        );

        const jNum = wo.job_number || `#${wo.id}`;
        const pAddr = wo.property_address || '';
        const missingDesc = !hasMedia && !hasReport
          ? 'proof photos & work completion report'
          : !hasMedia ? 'completion proof photos' : 'work completion report';

        for (const c of contractors) {
          const msg = `Nexus FMS Daily Reminder: Hi ${c.full_name}, please upload your ${missingDesc} for Job ${jNum} (${pAddr}). Please update via your Shift Calendar portal as soon as possible.`;
          await dispatcher.dispatch({
            recipientUserId: c.user_id,
            recipientRole: 'MAINTENANCE_STAFF',
            type: 'CONTRACTOR_PHOTO_REMINDER',
            title: `Daily Reminder: Upload Photos/Report for Job ${jNum}`,
            messageTemplate: msg,
            structuredData: { job_number: jNum, address: pAddr },
            channels: c.phone ? ['SMS', 'IN_APP'] : ['IN_APP'],
            contactPhone: c.phone || null,
            actionUrl: '/maintenance/calendar',
            relatedEntityType: 'work_orders',
            relatedEntityId: wo.id,
          }).catch(e => console.warn(`[ContractorPhotoReminderJob] Failed to notify ${c.full_name}:`, e.message));
        }

        sent++;
        console.log(`[ContractorPhotoReminderJob] Daily reminder #${(wo.contractor_reminder_count || 0) + 1} sent for Job #${wo.id}.`);
      } catch (jobErr) {
        console.error(`[ContractorPhotoReminderJob] Error processing Job #${wo.id}:`, jobErr.message);
      }
    }

    console.log(`[ContractorPhotoReminderJob] Completed. Sent ${sent} reminder(s).`);
  } catch (error) {
    console.error('[ContractorPhotoReminderJob] Error during execution:', error.message);
  }
};

const initContractorPhotoReminderScheduler = () => {
  // Run shortly after startup (allows auto-migrations to finish), then every hour.
  setTimeout(runContractorPhotoReminderJob, 30 * 1000);
  setInterval(runContractorPhotoReminderJob, 60 * 60 * 1000);
  console.log('[ContractorPhotoReminderJob] Scheduler initialized. Checking every 1 hour.');
};

module.exports = {
  initContractorPhotoReminderScheduler,
  runContractorPhotoReminderJob, // exported for testing
};

