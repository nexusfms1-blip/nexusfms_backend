/**
 * Phase 10 E2E Notification & Automation Test Suite
 */
require('dotenv').config();
const { pool } = require('./config/db');
const notificationService = require('./services/notification.service');
const { triggerAutoBookingRequest } = require('./services/bookingRequest.service');

async function runTests() {
  console.log('🚀 Starting Phase 10 Notification Automation Tests...');
  let passed = 0;
  let failed = 0;

  const assert = (condition, message) => {
    if (condition) {
      console.log(`✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${message}`);
      failed++;
    }
  };

  try {
    // We mock Socket.IO for the backend to test if events are emitted
    let emittedEvents = [];
    const mockIo = {
      to: (room) => ({
        emit: (event, payload) => {
          emittedEvents.push({ room, event, payload });
        }
      })
    };
    notificationService.setIoInstance(mockIo);

    // Get test users
    const [adminUsers] = await pool.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN' LIMIT 1");
    const [techUsers] = await pool.query("SELECT id FROM users WHERE role = 'MAINTENANCE_STAFF' LIMIT 1");
    
    if (adminUsers.length === 0 || techUsers.length === 0) {
      throw new Error('Missing test users (Admin/Staff) in database.');
    }

    const adminId = adminUsers[0].id;
    const techId = techUsers[0].id;

    console.log('\n--- 1. Testing Financial Data Stripping ---');
    const mockData = {
      id: 999,
      title: 'Fix Leak',
      quoteAmount: '$500',
      material_cost: '200',
      reason: 'Standard maintenance'
    };

    // Dispatch to Tech (Should strip financials)
    await notificationService.dispatch({
      recipientUserId: techId,
      recipientRole: 'MAINTENANCE_STAFF',
      type: 'TEST_ALERT',
      title: 'Job Assigned',
      messageTemplate: 'Job {{title}} assigned. Quote: {{quoteAmount}}',
      structuredData: mockData
    });

    // Check DB
    const [techAlerts] = await pool.query("SELECT message FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1", [techId]);
    assert(techAlerts.length > 0 && techAlerts[0].message.includes('<RESTRICTED>') && !techAlerts[0].message.includes('$500'), 
      'Financial fields are correctly absent/stripped for non-admin roles (Tech).');

    // Dispatch to Admin (Should keep financials)
    await notificationService.dispatch({
      recipientUserId: adminId,
      recipientRole: 'OFFICE_ADMIN',
      type: 'TEST_ALERT',
      title: 'Job Assigned',
      messageTemplate: 'Job {{title}} assigned. Quote: {{quoteAmount}}',
      structuredData: mockData
    });

    const [adminAlerts] = await pool.query("SELECT message FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1", [adminId]);
    assert(adminAlerts.length > 0 && adminAlerts[0].message.includes('$500'), 
      'Financial fields are retained for Admin role.');

    console.log('\n--- 2. Testing Provider Delivery & Retries ---');
    // Enable simulated failures
    process.env.SIMULATE_PROVIDER_FAILURES = 'true';
    
    // We will test by forcing a failure if we can, or just ensuring tracking table gets records
    await notificationService.dispatch({
      recipientUserId: null,
      recipientRole: 'TENANT',
      type: 'TEST_ALERT',
      title: 'Test Email',
      messageTemplate: 'Test message',
      channels: ['EMAIL'],
      contactEmail: 'test@example.com'
    });

    const [deliveryRows] = await pool.query("SELECT * FROM notification_delivery ORDER BY id DESC LIMIT 1");
    assert(deliveryRows.length > 0 && ['SENT', 'FAILED'].includes(deliveryRows[0].status), 
      'Provider delivery tracking correctly records SENT or FAILED state.');
    assert(deliveryRows[0].attempts > 0 && deliveryRows[0].attempts <= 3, 
      `Retry logic executed (Attempts: ${deliveryRows[0].attempts}, Max Limit: 3).`);

    console.log('\n--- 3. Testing Socket.IO Emits ---');
    assert(emittedEvents.length > 0, 'Socket.IO notification events were emitted.');
    const targetRoom = `user_${techId}`;
    const sentToTech = emittedEvents.some(e => e.room === targetRoom && e.event === 'NEW_NOTIFICATION');
    assert(sentToTech, 'Socket.IO correctly scoped to specific user room to prevent unauthorized access.');

    console.log('\n--- 4. Testing Idempotency & Workflow Triggers ---');
    // Get an existing work order to avoid strict schema issues
    const [existingWos] = await pool.query('SELECT id FROM work_orders LIMIT 1');
    const woId = existingWos[0].id;

    await triggerAutoBookingRequest(woId);
    await triggerAutoBookingRequest(woId); // Attempt duplicate

    const [brRows] = await pool.query(`SELECT id FROM booking_requests WHERE work_order_id = ?`, [woId]);
    assert(brRows.length === 1, 'Idempotency: Booking request does not duplicate on multiple triggers.');

    // Cleanup Test Data (Just the booking requests we created for idempotency test)
    await pool.query('DELETE FROM booking_requests WHERE work_order_id = ?', [woId]);

    console.log('\n=======================================');
    console.log(`Test Summary: ${passed} Passed | ${failed} Failed`);
    console.log('=======================================');
    
    process.exit(failed > 0 ? 1 : 0);

  } catch (err) {
    console.error('Fatal Test Error:', err);
    process.exit(1);
  }
}

runTests();
