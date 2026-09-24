require('dotenv').config();
const { pool } = require('./config/db');
const axios = require('axios');
const assert = require('assert');
const jwt = require('jsonwebtoken');

const API_BASE = process.env.TEST_API_URL || 'http://localhost:5000/api/v1';
let authToken = '';
let testStaffId = null;
let testResidentId = null;
let testWorkOrderId = null;
let secureToken = null;

async function setupTestData() {
  console.log('--- Setting up Test Data ---');

  // Create an admin JWT directly
  const [adminRows] = await pool.query('SELECT id, role FROM users WHERE role="OFFICE_ADMIN" LIMIT 1');
  const adminId = adminRows[0].id;
  authToken = jwt.sign({ id: adminId, role: 'OFFICE_ADMIN' }, process.env.JWT_SECRET || 'supersecret_nexus_fms_key_2026', { expiresIn: '1h' });

  // Get a staff member
  const staffRes = await axios.get(`${API_BASE}/staff`, {
    headers: { Authorization: `Bearer ${authToken}` }
  });
  testStaffId = staffRes.data.data[0].id; // staff_profiles.id

  // Create a resident
  const [[resExists]] = await pool.query("SELECT id FROM residents LIMIT 1");
  testResidentId = resExists.id;

  console.log(`Staff ID: ${testStaffId}, Resident ID: ${testResidentId}`);
}

async function testTriggerBookingRequest() {
  console.log('--- Testing Booking Request Trigger ---');
  // Create a Quote job
  const createRes = await axios.post(`${API_BASE}/jobs`, {
    title: 'Test Booking Job',
    description: 'Leaky pipe',
    duration_hours: 1.5,
    resident_id: testResidentId,
    assigned_staff_id: testStaffId,
    pipeline_stage: 'Quotes',
    priority: 'NORMAL'
  }, {
    headers: { Authorization: `Bearer ${authToken}` }
  });

  testWorkOrderId = createRes.data.data.id;
  console.log(`Created Job #${testWorkOrderId} in Quotes`);

  // Move to Jobs
  await axios.put(`${API_BASE}/jobs/${testWorkOrderId}/stage`, {
    pipeline_stage: 'Jobs'
  }, {
    headers: { Authorization: `Bearer ${authToken}` }
  });
  console.log(`Moved Job #${testWorkOrderId} to Jobs`);

  // Wait 1s for async service
  await new Promise(r => setTimeout(r, 1000));

  const [brRows] = await pool.query('SELECT * FROM booking_requests WHERE work_order_id = ?', [testWorkOrderId]);
  assert.strictEqual(brRows.length, 1, 'Booking request not created!');
  assert.strictEqual(brRows[0].status, 'WAITING_FOR_BOOKING', 'Incorrect status');

  secureToken = brRows[0].secure_token;
  console.log(`✅ Booking request automatically created. Token: ${secureToken}`);

  // Test duplicate trigger (idempotency)
  await axios.put(`${API_BASE}/jobs/${testWorkOrderId}/stage`, {
    pipeline_stage: 'Completed Quotes'
  }, { headers: { Authorization: `Bearer ${authToken}` } });

  await axios.put(`${API_BASE}/jobs/${testWorkOrderId}/stage`, {
    pipeline_stage: 'Jobs'
  }, { headers: { Authorization: `Bearer ${authToken}` } });

  await new Promise(r => setTimeout(r, 1000));
  const [brRows2] = await pool.query('SELECT id FROM booking_requests WHERE work_order_id = ?', [testWorkOrderId]);
  assert.strictEqual(brRows2.length, 1, 'Idempotency failed: multiple booking requests created!');
  console.log('✅ Duplicate trigger ignored.');
}

async function testPublicEndpoints() {
  console.log('--- Testing Public Endpoints ---');

  // GET request info
  const infoRes = await axios.get(`${API_BASE}/public/request/${secureToken}`);
  assert.strictEqual(infoRes.data.type, 'BOOKING', 'Incorrect public type');
  assert.strictEqual(infoRes.data.data.durationHours, 1.5, 'Missing duration');
  console.log('✅ Public request info fetched successfully');

  let targetDate = null;
  let selectedSlot = null;

  for (let i = 1; i <= 7; i++) {
    const tmr = new Date();
    tmr.setDate(tmr.getDate() + i);
    const candidateDate = tmr.toISOString().split('T')[0];

    const availRes = await axios.get(`${API_BASE}/public/booking/${secureToken}/available-slots?date=${candidateDate}`);
    if (availRes.data.availability.availableSlots.length > 0) {
      targetDate = candidateDate;
      selectedSlot = availRes.data.availability.availableSlots[0].timeSlot;
      break;
    }
  }

  if (!targetDate) {
    console.log('Skipping confirm step because no slots available in the next 7 days.');
    return;
  }

  // POST confirm
  const confirmRes = await axios.post(`${API_BASE}/public/booking/${secureToken}/confirm`, {
    selectedDate: targetDate,
    selectedTimeSlot: selectedSlot
  });

  assert.strictEqual(confirmRes.data.success, true);
  console.log('✅ Booking confirmed successfully!');

  const [brRows] = await pool.query('SELECT status, booked_at FROM booking_requests WHERE work_order_id = ?', [testWorkOrderId]);
  assert.strictEqual(brRows[0].status, 'BOOKED', 'Booking request status not updated to BOOKED');

  const [woRows] = await pool.query('SELECT scheduled_date, scheduled_time_slot, pipeline_stage FROM work_orders WHERE id = ?', [testWorkOrderId]);
  assert.strictEqual(woRows[0].pipeline_stage, 'Jobs');
  console.log(`✅ Database states updated. Scheduled for ${targetDate} at ${selectedSlot}`);
}

async function testConcurrentBookings() {
  console.log('--- Testing Concurrent Bookings ---');
  // Create another job to test double booking protection
  const createRes = await axios.post(`${API_BASE}/jobs`, {
    title: 'Test Concurrent', description: 'Concurrent', duration_hours: 1, resident_id: testResidentId, assigned_staff_id: testStaffId, pipeline_stage: 'Jobs', priority: 'NORMAL'
  }, { headers: { Authorization: `Bearer ${authToken}` } });

  const id2 = createRes.data.data.id;
  await new Promise(r => setTimeout(r, 1000));
  const [brRows] = await pool.query('SELECT secure_token FROM booking_requests WHERE work_order_id = ?', [id2]);
  const token2 = brRows[0].secure_token;

  let targetDate = null;
  let selectedSlot = null;

  for (let i = 1; i <= 7; i++) {
    const tmr = new Date();
    tmr.setDate(tmr.getDate() + i);
    const candidateDate = tmr.toISOString().split('T')[0];

    const availRes = await axios.get(`${API_BASE}/public/booking/${token2}/available-slots?date=${candidateDate}`);
    if (availRes.data.availability.availableSlots.length > 0) {
      targetDate = candidateDate;
      selectedSlot = availRes.data.availability.availableSlots[0].timeSlot;
      break;
    }
  }

  if (!targetDate) return;

  // Try to confirm same slot twice concurrently
  const p1 = axios.post(`${API_BASE}/public/booking/${token2}/confirm`, { selectedDate: targetDate, selectedTimeSlot: selectedSlot });
  const p2 = axios.post(`${API_BASE}/public/booking/${token2}/confirm`, { selectedDate: targetDate, selectedTimeSlot: selectedSlot });

  const results = await Promise.allSettled([p1, p2]);

  let successes = 0;
  let failures = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') successes++;
    else failures++;
  }

  assert.strictEqual(successes, 1, 'Only one booking should succeed');
  assert.strictEqual(failures, 1, 'One booking should fail due to conflict');
  console.log('✅ Concurrent double-booking prevented successfully!');
}

async function runTests() {
  try {
    await setupTestData();
    await testTriggerBookingRequest();
    await testPublicEndpoints();
    await testConcurrentBookings();
    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! 🎉\n');
    process.exit(0);
  } catch (error) {
    console.error('❌ TEST FAILED:', error?.response?.data || error);
    process.exit(1);
  }
}

runTests();
