const { pool } = require('../config/db');
const notificationService = require('../services/notification.service');

const ESCALATION_DELAY_HOURS = parseInt(process.env.TENANT_NO_REPLY_DELAY_HOURS || '72', 10); // 3 days (72 hours)

/**
 * 3-Day Tenant No-Reply Email Automation Job
 * 
 * Rules:
 * 1. Checks every hour for work orders where 72h have elapsed since tenant was contacted.
 * 2. ONLY triggers if the property is occupied with valid tenant details (resident_name & contact_phone).
 * 3. Separate dedicated templates for Quotes and Jobs.
 * 4. Strictly prevents duplicate emails by checking pm_no_reply_escalated_at IS NULL.
 */
const runTenantNoReplyEscalationJob = async () => {
  console.log('[TenantNoReplyJob] 🔍 Checking for work orders pending tenant response > 72h...');
  try {
    const [pendingOrders] = await pool.query(
      `SELECT 
        w.id,
        w.job_number,
        w.title,
        w.description,
        w.property_address,
        w.pipeline_stage,
        w.resident_name,
        w.contact_phone,
        w.contact_email,
        w.manager_name,
        w.manager_email,
        w.original_sender_email,
        w.work_order_reference,
        w.tenant_contacted_at,
        w.pm_no_reply_escalated_at,
        COALESCE(w.tenant_contacted_at, br.created_at, qr.created_at, w.created_at) as effective_contacted_at,
        br.status as booking_status,
        qr.status as quote_status
      FROM work_orders w
      LEFT JOIN booking_requests br ON w.id = br.work_order_id
      LEFT JOIN quote_requests qr ON w.id = qr.work_order_id
      WHERE w.pm_no_reply_escalated_at IS NULL
        AND (
          (w.pipeline_stage IN ('Quotes', 'READY_TO_QUOTE', 'Ready to Quote') AND (qr.status IS NULL OR qr.status != 'SUBMITTED'))
          OR
          (w.pipeline_stage IN ('Jobs Waiting Booking', 'Jobs Awaiting Booking', 'Waiting Job Booking') AND (br.status IS NULL OR br.status != 'BOOKED'))
        )
        -- Condition: Strictly only properties with active tenants and contact details
        AND w.resident_name IS NOT NULL AND TRIM(w.resident_name) != ''
        AND w.contact_phone IS NOT NULL AND TRIM(w.contact_phone) != ''
        -- Must have a destination manager email
        AND (
          (w.manager_email IS NOT NULL AND TRIM(w.manager_email) != '')
          OR (w.original_sender_email IS NOT NULL AND TRIM(w.original_sender_email) != '')
        )
        -- 3 Days (72 Hours) passed since tenant contact
        AND TIMESTAMPDIFF(HOUR, COALESCE(w.tenant_contacted_at, br.created_at, qr.created_at, w.created_at), NOW()) >= ?`,
      [ESCALATION_DELAY_HOURS]
    );

    if (pendingOrders.length === 0) {
      console.log('[TenantNoReplyJob] ✓ No overdue tenant responses found.');
      return;
    }

    console.log(`[TenantNoReplyJob] ⚠️ Found ${pendingOrders.length} work orders requiring escalation to Property Managers.`);

    let escalatedCount = 0;

    for (const wo of pendingOrders) {
      const targetManagerEmail = (wo.manager_email || wo.original_sender_email || '').trim();
      if (!targetManagerEmail) continue;

      const mgrName = (wo.manager_name || 'Property Manager').trim();
      const jobRef = wo.work_order_reference || wo.job_number || `#${wo.id}`;
      const resName = wo.resident_name || 'Resident';
      const resPhone = wo.contact_phone || 'N/A';
      const address = wo.property_address || 'Property';
      const description = wo.description || wo.title || 'Maintenance Request';

      const isQuoteStage = ['Quotes', 'READY_TO_QUOTE', 'Ready to Quote'].includes(wo.pipeline_stage);

      let emailSubject = '';
      let emailBody = '';
      let escalationCategory = '';

      if (isQuoteStage) {
        // TEMPLATE 1: For Quotes
        escalationCategory = 'QUOTE';
        emailSubject = `URGENT: No Tenant Response for Quote Access (3 Days Overdue) - Ref: ${jobRef} - ${address}`;
        emailBody = `Dear ${mgrName},

We have attempted to contact the resident over the last 3 days regarding the quote inspection for the following property, but have received no response:

• Property Address: ${address}
• Work Order Ref: ${jobRef}
• Scope of Works: ${description}
• Tenant Name: ${resName}
• Tenant Contact Phone: ${resPhone}

Proof of Contact:
Our system issued the quote access requests over the last 3 days to the contact number provided above, but no response or access booking has been confirmed by the tenant.

Please follow up with the tenant directly or let us know if you would like us to arrange alternative access.

Thank you,
Nexus FMS Team`;
      } else {
        // TEMPLATE 2: For Jobs
        escalationCategory = 'JOB';
        emailSubject = `ACTION REQUIRED: Tenant Has Not Booked Maintenance Appointment (3 Days Overdue) - Ref: ${jobRef} - ${address}`;
        emailBody = `Dear ${mgrName},

We issued an appointment scheduling request to the tenant 3 days ago for the following approved maintenance job, but no appointment has been booked yet:

• Property Address: ${address}
• Work Order Ref: ${jobRef}
• Job Description: ${description}
• Tenant Name: ${resName}
• Tenant Contact Phone: ${resPhone}

Proof of Contact:
The resident was contacted with our live self-booking link 3 days ago, but has not yet chosen an available calendar slot to allow contractor access.

Please advise if we should re-attempt contact or if you have alternative contact instructions for this property.

Thank you,
Nexus FMS Team`;
      }

      try {
        await notificationService.dispatch({
          recipientUserId: null,
          recipientRole: 'PROPERTY_MANAGER',
          type: 'TENANT_NO_REPLY_ESCALATION',
          title: emailSubject,
          messageTemplate: emailBody,
          structuredData: {
            manager_name: mgrName,
            job_number: wo.job_number,
            work_order_reference: jobRef,
            resident_name: resName,
            contact_phone: resPhone,
            property_address: address,
            category: escalationCategory,
            stage: wo.pipeline_stage,
            subject: emailSubject,
            message: emailBody,
            to: targetManagerEmail,
            email: targetManagerEmail,
            contactEmail: targetManagerEmail,
          },
          actionUrl: `/admin/pipeline`,
          relatedEntityType: 'work_orders',
          relatedEntityId: wo.id,
          channels: ['EMAIL'],
          contactEmail: targetManagerEmail
        });

        // Record timestamp in DB so it never sends duplicate escalation emails
        await pool.query(
          'UPDATE work_orders SET pm_no_reply_escalated_at = NOW() WHERE id = ?',
          [wo.id]
        );

        escalatedCount++;
        console.log(`[TenantNoReplyJob] ✓ Escalation email sent to ${targetManagerEmail} for ${escalationCategory} Job #${wo.id} (${jobRef})`);
      } catch (sendErr) {
        console.error(`[TenantNoReplyJob] ❌ Failed to escalate Job #${wo.id}:`, sendErr.message);
      }
    }

    console.log(`[TenantNoReplyJob] Completed check. Sent ${escalatedCount} escalation alerts to Property Managers.`);
  } catch (error) {
    console.error('[TenantNoReplyJob] Error during escalation job execution:', error);
  }
};

const initTenantNoReplyScheduler = () => {
  // Run on startup, then every 1 hour (3600000 ms)
  runTenantNoReplyEscalationJob();
  setInterval(runTenantNoReplyEscalationJob, 60 * 60 * 1000);
  console.log('[TenantNoReplyJob] Scheduler initialized. Checking every 1 hour for 3-day overdue tenant responses.');
};

module.exports = {
  initTenantNoReplyScheduler,
  runTenantNoReplyEscalationJob
};

