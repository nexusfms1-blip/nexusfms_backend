const { pool } = require('../config/db');
const crypto = require('crypto');
const NotificationService = require('./notification.service');

const triggerAutoBookingRequest = async (workOrderId) => {
  try {
    // 1. Fetch Work Order and resident info
    const [jobRows] = await pool.query(
      `SELECT 
        w.id, w.job_number, w.title, w.resident_name, w.contact_phone, w.contact_email, w.property_address,
        r.full_name as live_resident_name, r.email as live_resident_email, r.phone as live_resident_phone 
       FROM work_orders w
       LEFT JOIN residents r ON w.resident_id = r.id
       WHERE w.id = ?`,
      [workOrderId]
    );

    if (jobRows.length === 0) return;
    const job = jobRows[0];

    const residentName = job.live_resident_name || job.resident_name || 'Resident';
    const residentPhone = job.contact_phone || job.live_resident_phone || null;
    const residentEmail = job.contact_email || job.live_resident_email || null;
    const propertyAddress = job.property_address || '';

    // 2. Generate secure token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days expiry

    // 3. Create or reset booking request with fresh secure token
    await pool.query(
      `INSERT INTO booking_requests (work_order_id, secure_token, status, expires_at, booked_date, booked_time_slot, booked_at)
       VALUES (?, ?, 'WAITING_FOR_BOOKING', ?, NULL, NULL, NULL)
       ON DUPLICATE KEY UPDATE 
         secure_token = VALUES(secure_token),
         status = 'WAITING_FOR_BOOKING',
         expires_at = VALUES(expires_at),
         booked_date = NULL,
         booked_time_slot = NULL,
         booked_at = NULL,
         reminder_count = 0,
         last_reminder_at = NULL`,
      [workOrderId, token, expiresAt]
    );

    // 4. Send Notification
    const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
    const bookingLink = `${frontendBase}/public/book-appointment/${token}`;

    const dispatcher = require('./notification.service');
    
    await dispatcher.dispatch({
      recipientUserId: null,
      recipientRole: 'TENANT',
      type: 'BOOKING_REQUEST',
      title: 'Please Book Your Maintenance Appointment',
      messageTemplate: `Hi {{resident_name}},\n\nPlease book an appointment for your maintenance job using the secure link below:\n{{bookingLink}}\n\nOur team will review your selected appointment.`,
      structuredData: {
        resident_name: residentName,
        residentName,
        title: job.title,
        jobNumber: job.job_number,
        propertyAddress,
        bookingLink,
        actionUrl: bookingLink,
        secure_token: token,
        secureToken: token
      },
      actionUrl: bookingLink,
      relatedEntityType: 'work_orders',
      relatedEntityId: workOrderId,
      channels: ['EMAIL', 'SMS'],
      contactEmail: residentEmail,
      contactPhone: residentPhone,
      propertyAddress
    });
    
    console.log(`[BookingRequestService] Auto booking request generated for Job #${workOrderId} to ${residentPhone || 'N/A'}`);

    return {
      success: true,
      token,
      bookingLink,
      residentPhone,
      residentEmail
    };

  } catch (err) {
    console.error(`[BookingRequestService] Error triggering auto booking request for Job #${workOrderId}:`, err);
    throw err;
  }
};

module.exports = {
  triggerAutoBookingRequest
};

