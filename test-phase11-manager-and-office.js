require('dotenv').config();
const axios = require('axios');
const assert = require('assert');
const { pool } = require('./config/db');

const BASE_URL = 'http://localhost:5000/api/v1';

async function runTests() {
  console.log('=======================================================');
  console.log('🧪 Starting Phase 11 Automated Feature Verification Tests');
  console.log('=======================================================');

  try {
    // 1. Authenticate as OFFICE_TEAM
    console.log('\nStep 1: Logging in as OFFICE_TEAM...');
    let officeToken;
    try {
      const loginRes = await axios.post(`${BASE_URL}/auth/login`, {
        email: 'office@nexusfms.com',
        password: 'admin123'
      });
      officeToken = loginRes.data.token;
      console.log('✅ OFFICE_TEAM logged in successfully.');
    } catch (err) {
      console.log('⚠️ OFFICE_TEAM login failed. (Re-)Seeding test user with bcrypt...');
      const bcrypt = require('bcryptjs');
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash('admin123', salt);
      
      // Ensure test user exists in DB and has the correct bcrypt password
      await pool.query(
        "INSERT INTO users (full_name, email, password_hash, role, is_active) VALUES ('Office Team Test', 'office@nexusfms.com', ?, 'OFFICE_TEAM', 1) ON DUPLICATE KEY UPDATE password_hash = ?, is_active = 1",
        [passwordHash, passwordHash]
      );
      
      const loginRes = await axios.post(`${BASE_URL}/auth/login`, {
        email: 'office@nexusfms.com',
        password: 'admin123'
      });
      officeToken = loginRes.data.token;
      console.log('✅ OFFICE_TEAM logged in successfully after seeding.');
    }

    const authHeaders = { headers: { Authorization: `Bearer ${officeToken}` } };

    // 2. Verify OFFICE_TEAM can access quote photo requests
    console.log('\nStep 2: Testing quote requests read permission...');
    const qrRes = await axios.get(`${BASE_URL}/quote-requests`, authHeaders);
    assert.strictEqual(qrRes.status, 200, 'Expected 200 OK from GET /quote-requests');
    console.log('✅ OFFICE_TEAM successfully retrieved quote requests.');

    // 3. Verify OFFICE_TEAM can access booking requests
    console.log('\nStep 3: Testing booking links read permission...');
    const blRes = await axios.get(`${BASE_URL}/booking-links`, authHeaders);
    assert.strictEqual(blRes.status, 200, 'Expected 200 OK from GET /booking-links');
    console.log('✅ OFFICE_TEAM successfully retrieved booking links.');

    // 4. Verify OFFICE_TEAM can access staff directory (GET /staff)
    console.log('\nStep 4: Testing staff directory read permission...');
    const staffRes = await axios.get(`${BASE_URL}/staff`, authHeaders);
    assert.strictEqual(staffRes.status, 200, 'Expected 200 OK from GET /staff');
    console.log('✅ OFFICE_TEAM successfully retrieved staff directory.');

    // 5. Test Webhook Ingestion & Automated Tenant Photo Request Trigger
    console.log('\nStep 5: Testing webhook work order ingestion & auto photo request...');
    const testRefId = `ref-${Date.now()}`;
    const testMgrEmail = `manager-${Date.now()}@propertygroup.com`;
    const testMgrName = 'Jane Property Manager';

    const webhookRes = await axios.post(`${BASE_URL}/webhooks/quotes`, {
      reference_id: testRefId,
      subject: 'Leaking Radiator in Lounge',
      resident_name: 'David Tenant',
      contact_email: 'david@tenant.com',
      contact_phone: '+447911122233',
      property_address: 'Flat 4, 12 Baker St, London',
      description: 'The radiator has a slow leak causing pressure loss.',
      priority: 'NORMAL',
      manager_name: testMgrName,
      manager_email: testMgrEmail,
      attachments: []
    }, {
      headers: { 'x-api-key': process.env.WEBHOOK_SECRET_KEY || 'test_secret_key_123' }
    });

    assert.strictEqual(webhookRes.status, 201, 'Webhook quote creation should return 201 Created');
    const workOrderId = webhookRes.data.workOrderId;
    console.log(`✅ Webhook quote ingested successfully. Work Order ID: ${workOrderId}`);

    // Verify manager_email exists in DB
    const [woRows] = await pool.query('SELECT manager_name, manager_email, secure_token FROM work_orders WHERE id = ?', [workOrderId]);
    assert.strictEqual(woRows[0].manager_email, testMgrEmail, 'DB manager_email does not match input');
    assert.strictEqual(woRows[0].manager_name, testMgrName, 'DB manager_name does not match input');
    console.log(`✅ Verified manager_email and manager_name saved in database.`);

    // Verify auto photo request is created
    const [qrRows] = await pool.query('SELECT secure_token, status FROM quote_requests WHERE work_order_id = ?', [workOrderId]);
    assert.ok(qrRows.length > 0, 'Auto photo request was not generated in database');
    console.log(`✅ Verified auto quote request created. Status: ${qrRows[0].status}`);

    // 6. Test public booking confirmation sends notification to manager
    console.log('\nStep 6: Testing public booking & manager email dispatch...');
    
    // Setup booking link for this work order
    const bookingToken = `booking-tok-${Date.now()}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO booking_requests (work_order_id, secure_token, status, expires_at) VALUES (?, ?, "WAITING_FOR_BOOKING", ?)',
      [workOrderId, bookingToken, expiresAt]
    );
    console.log('✅ Booking link configured.');

    // Confirm booking
    const confirmRes = await axios.post(`${BASE_URL}/public/booking/${bookingToken}/confirm`, {
      booking_date: '2026-08-25',
      time_slot: '08:00 - 09:30'
    });
    assert.strictEqual(confirmRes.status, 200, 'Public booking confirmation should return 200 OK');
    console.log('✅ Public booking confirmed by tenant.');

    // Verify email log in notification_delivery table
    const [deliveryRows] = await pool.query(
      "SELECT * FROM notification_delivery WHERE recipient = ? AND channel = 'EMAIL' ORDER BY created_at DESC LIMIT 1",
      [testMgrEmail]
    );
    assert.ok(deliveryRows.length > 0, 'No notification_delivery record found for manager email');
    assert.strictEqual(deliveryRows[0].status, 'SENT', 'Email delivery status should be SENT');
    console.log(`✅ Verified manager booking confirmation email logged in notification_delivery. Recipient: ${deliveryRows[0].recipient}`);

    console.log('\n🎉 ALL VERIFICATION TESTS PASSED SUCCESSFULLY! Phase 11 verified.');
    process.exit(0);

  } catch (err) {
    console.error('\n❌ VERIFICATION TEST FAILED:', err.message);
    if (err.response) {
      console.error('Response Status:', err.response.status);
      console.error('Response Data:', err.response.data);
    }
    process.exit(1);
  }
}

runTests();
