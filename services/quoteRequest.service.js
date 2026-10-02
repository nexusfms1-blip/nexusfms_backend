const { pool } = require('../config/db');
const crypto = require('crypto');
const NotificationService = require('./notification.service');

const triggerAutoPhotoRequest = async (workOrderId) => {
  try {
    // 1. Fetch Work Order and resident info (fallback to work_orders columns if residents table has null or unlinked)
    const [jobRows] = await pool.query(
      `SELECT 
        w.id, w.job_number, w.title, w.resident_name, w.contact_phone, w.contact_email, w.property_address,
        w.manager_email,
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

    // FIX: Sirf residents table ka email use karo (live_resident_email).
    // work_orders.contact_email mein Property Manager ka email bhi ho sakta hai.
    // Photo request KABHI BHI Property Manager ko nahi jaani chahiye - sirf Tenant ko.
    const residentEmail = job.live_resident_email || null;

    // Property Manager ka email alag rakho - future reference ke liye
    const managerEmail = job.manager_email || job.contact_email || null;

    const propertyAddress = job.property_address || '';

    // 2. Generate secure token or fetch existing token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    let finalToken = token;
    const [existingQr] = await pool.query(
      'SELECT secure_token FROM quote_requests WHERE work_order_id = ? ORDER BY id DESC LIMIT 1',
      [workOrderId]
    );

    if (existingQr.length > 0 && existingQr[0].secure_token) {
      finalToken = existingQr[0].secure_token;
    } else {
      try {
        await pool.query(
          `INSERT INTO quote_requests (work_order_id, secure_token, status, expires_at)
           VALUES (?, ?, 'PENDING', ?)
           ON DUPLICATE KEY UPDATE secure_token = secure_token`,
          [workOrderId, token, expiresAt]
        );
      } catch (dbErr) {
        if (dbErr.code !== 'ER_DUP_ENTRY') throw dbErr;
      }
    }

    // 3. Prepare upload link
    const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
    const uploadLink = `${frontendBase}/quote-request/${finalToken}`;

    const dispatcher = require('./notification.service');
    
    const messageTemplate = `Hi {{resident_name}},\n\nWe require photos/details to prepare the quote for your maintenance request "${job.title || 'Maintenance Work'}".\n\nPlease use the link below to upload photos:\n{{uploadLink}}\n\nThank you,\nNexus Maintenance Team`;

    await dispatcher.dispatch({
      recipientUserId: null,
      recipientRole: 'TENANT',
      type: 'QUOTE_PHOTO_REQUEST',
      title: 'Photos Required for Your Maintenance Quote',
      messageTemplate,
      name: residentName,
      residentName: residentName,
      recipientName: residentName,
      structuredData: {
        name: residentName,
        resident_name: residentName,
        residentName: residentName,
        recipientName: residentName,
        title: job.title,
        jobNumber: job.job_number,
        propertyAddress,
        uploadLink,
        actionUrl: uploadLink,
        secure_token: finalToken,
        secureToken: finalToken
      },
      actionUrl: uploadLink,
      relatedEntityType: 'work_orders',
      relatedEntityId: workOrderId,
      // FIX (BUG #1): Pehle channels: ['EMAIL', 'SMS'] tha jo galat tha.
      // Photo request SIRF Tenant ke PHONE NUMBER par SMS ke zariye jaani chahiye.
      // Email channel isliye HATA diya - kyunki contact_email mein Property Manager
      // ka email bhi ho sakta hai, aur unhe 'Photos Required' message NAHI jaana chahiye.
      channels: ['SMS'],
      contactEmail: null,       // Email bilkul nahi bhejna - intentional
      contactPhone: residentPhone,
      propertyAddress
    });

    // Agar manager ko koi notification deni ho toh alag se aur alag event se bhejna
    // jaise 'ADMIN_OFFICE_ALERT' - yahan nahi.
    console.log(`[QuoteRequestService] Photo request SMS dispatched to Tenant phone: ${residentPhone || 'N/A'} (Manager email NOT notified: ${managerEmail || 'N/A'})`,);
    
    console.log(`[QuoteRequestService] Auto photo request generated and dispatched for Job #${workOrderId} to ${residentPhone || 'N/A'}`);

    return {
      success: true,
      token: finalToken,
      uploadLink,
      residentPhone,
      residentEmail
    };

  } catch (err) {
    console.error(`[QuoteRequestService] Error triggering auto photo request for Job #${workOrderId}:`, err);
    throw err;
  }
};

module.exports = {
  triggerAutoPhotoRequest
};

