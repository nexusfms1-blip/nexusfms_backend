require('dotenv').config();
const { pool } = require('./config/db');
const axios = require('axios');
const assert = require('assert');
const jwt = require('jsonwebtoken');

const API_BASE = process.env.TEST_API_URL || 'http://localhost:5000/api/v1';

let adminToken = '';
let officeTeamToken = '';
let techToken = '';
let tech2Token = '';

let adminId, officeTeamId, techId, tech2Id;
let testResidentId;
let testStaffProfileId;
let testStaff2ProfileId;

// Helper to wait
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function setupTestData() {
  console.log('--- Setting up Test Data ---');

  // Create / Get users for each role
  const secret = process.env.JWT_SECRET || 'nexus_fms_jwt_secret_key_2026_super_secure';

  const [adminRows] = await pool.query('SELECT id FROM users WHERE role="OFFICE_ADMIN" LIMIT 1');
  adminId = adminRows[0].id;
  adminToken = jwt.sign({ id: adminId, role: 'OFFICE_ADMIN' }, secret, { expiresIn: '1h' });

  let [officeRows] = await pool.query('SELECT id FROM users WHERE role="OFFICE_TEAM" LIMIT 1');
  if (officeRows.length === 0) {
    const [res] = await pool.query('INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)', ['Office Team Test', 'office@test.com', 'hash', 'OFFICE_TEAM']);
    officeTeamId = res.insertId;
  } else {
    officeTeamId = officeRows[0].id;
  }
  officeTeamToken = jwt.sign({ id: officeTeamId, role: 'OFFICE_TEAM' }, secret, { expiresIn: '1h' });

  const [techRows] = await pool.query('SELECT u.id, sp.id as profile_id FROM users u JOIN staff_profiles sp ON u.id = sp.user_id WHERE u.role="MAINTENANCE_STAFF" LIMIT 2');
  if (techRows.length < 2) {
    console.log('Need at least 2 technicians for RBAC tests. Aborting setup.');
    process.exit(1);
  }

  techId = techRows[0].id;
  testStaffProfileId = techRows[0].profile_id;
  techToken = jwt.sign({ id: techId, role: 'MAINTENANCE_STAFF' }, secret, { expiresIn: '1h' });

  tech2Id = techRows[1].id;
  testStaff2ProfileId = techRows[1].profile_id;
  tech2Token = jwt.sign({ id: tech2Id, role: 'MAINTENANCE_STAFF' }, secret, { expiresIn: '1h' });

  const [[resExists]] = await pool.query("SELECT id FROM residents LIMIT 1");
  testResidentId = resExists.id;

  console.log(`Roles setup. Admin: ${adminId}, Office: ${officeTeamId}, Tech1: ${testStaffProfileId}, Tech2: ${testStaff2ProfileId}`);
}

async function testFlowE_FinancialIsolation() {
  console.log('\n--- FLOW E: Financial Isolation ---');

  // 1. Admin creates a job with quote_amount
  const createRes = await axios.post(`${API_BASE}/jobs`, {
    title: 'Financial Isolation Test',
    resident_id: testResidentId,
    assigned_staff_id: testStaffProfileId,
    pipeline_stage: 'Jobs',
    quote_amount: 1500.50
  }, { headers: { Authorization: `Bearer ${adminToken}` } });

  const jobId = createRes.data.data.id;

  // 2. Admin fetches jobs -> sees quoteAmount
  const adminGet = await axios.get(`${API_BASE}/jobs/${jobId}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.strictEqual(adminGet.data.data.quoteAmount, 1500.5, 'Admin cannot see quoteAmount');

  // 3. Office Team fetches job -> MUST NOT see quoteAmount
  const officeGet = await axios.get(`${API_BASE}/jobs/${jobId}`, { headers: { Authorization: `Bearer ${officeTeamToken}` } });
  assert.strictEqual(officeGet.data.data.quoteAmount, undefined, 'Office Team sees quoteAmount!');

  // 4. Tech fetches job -> MUST NOT see quoteAmount
  const techGet = await axios.get(`${API_BASE}/staff/my-jobs/${jobId}`, { headers: { Authorization: `Bearer ${techToken}` } });
  assert.strictEqual(techGet.data.data.quoteAmount, undefined, 'Tech sees quoteAmount!');

  // 5. Office Team attempts to UPDATE quoteAmount
  await axios.put(`${API_BASE}/jobs/${jobId}/status`, {
    quote_amount: 9999
  }, { headers: { Authorization: `Bearer ${officeTeamToken}` } });

  // 6. Verify quoteAmount did not change
  const checkGet = await axios.get(`${API_BASE}/jobs/${jobId}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.strictEqual(checkGet.data.data.quoteAmount, 1500.5, 'Office Team successfully manipulated quoteAmount!');

  console.log('✅ Financial Isolation & Write Protection PASSED.');
}

async function testFlowF_RBACAttacks() {
  console.log('\n--- FLOW F: RBAC Attacks ---');

  const attemptAccess = async (url, token, expectedStatus = 403) => {
    console.log(`Attempting access to ${url} expecting ${expectedStatus}`);
    try {
      await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
      assert.fail(`Expected ${expectedStatus} but request succeeded for ${url}`);
    } catch (err) {
      if (err.name === 'AssertionError') throw err;
      assert.strictEqual(err.response?.status, expectedStatus, `Expected ${expectedStatus} but got ${err.response?.status} for ${url}`);
      console.log(`Got expected ${expectedStatus} for ${url}`);
    }
  };

  // Office Team -> Admin Routes
  await attemptAccess(`${API_BASE}/inventory`, officeTeamToken, 403);
  await attemptAccess(`${API_BASE}/settings`, officeTeamToken, 403);
  await attemptAccess(`${API_BASE}/staff`, officeTeamToken, 403);

  // Tech -> Admin/Office Routes
  await attemptAccess(`${API_BASE}/inventory`, techToken, 403);
  await attemptAccess(`${API_BASE}/settings`, techToken, 403);

  // Tech -> Another tech's job
  // We need a job assigned to tech2
  const createRes = await axios.post(`${API_BASE}/jobs`, {
    title: 'Tech2 Job',
    resident_id: testResidentId,
    assigned_staff_id: testStaff2ProfileId,
    pipeline_stage: 'Jobs',
  }, { headers: { Authorization: `Bearer ${adminToken}` } });
  const tech2JobId = createRes.data.data.id;

  await attemptAccess(`${API_BASE}/staff/my-jobs/${tech2JobId}`, techToken, 403);

  try {
    await axios.put(`${API_BASE}/jobs/${tech2JobId}/stage`, { section: 'Completed Jobs' }, { headers: { Authorization: `Bearer ${techToken}` } });
    assert.fail('Tech1 modified Tech2 job!');
  } catch (err) {
    if (err.name === 'AssertionError') throw err;
    assert.strictEqual(err.response.status, 403);
  }

  console.log('✅ RBAC Attacks Blocked PASSED.');
}

async function testFlowG_DoubleBooking() {
  console.log('\n--- FLOW G: Double Booking Concurrency Test ---');

  // 1. Create a job
  const createRes = await axios.post(`${API_BASE}/jobs`, {
    title: 'Double Booking Test',
    resident_id: testResidentId,
    assigned_staff_id: testStaffProfileId,
    pipeline_stage: 'Jobs',
    duration_hours: 1
  }, { headers: { Authorization: `Bearer ${adminToken}` } });
  const jobId = createRes.data.data.id;

  await wait(1000); // Wait for booking_request trigger

  const [brRows] = await pool.query('SELECT secure_token FROM booking_requests WHERE work_order_id = ?', [jobId]);
  const token = brRows[0].secure_token;

  // 2. Fetch a valid available slot dynamically
  let targetDate = null;
  let selectedSlot = null;

  for (let i = 1; i <= 7; i++) {
    const tmr = new Date();
    tmr.setDate(tmr.getDate() + i);
    const candidateDate = tmr.toISOString().split('T')[0];

    const availRes = await axios.get(`${API_BASE}/public/booking/${token}/available-slots?date=${candidateDate}`);
    if (availRes.data.availability.availableSlots.length > 0) {
      targetDate = candidateDate;
      selectedSlot = availRes.data.availability.availableSlots[0].timeSlot;
      break;
    }
  }

  if (!targetDate) {
    console.log('Skipping Flow G double booking because no slots are available.');
    return;
  }

  // 3. Prepare 2 simultaneous booking requests for the same slot
  const reqPayload = {
    selectedDate: targetDate,
    selectedTimeSlot: selectedSlot,
    durationHours: 1
  };

  const req1 = axios.post(`${API_BASE}/public/booking/${token}/confirm`, reqPayload);
  const req2 = axios.post(`${API_BASE}/public/booking/${token}/confirm`, reqPayload);

  let successCount = 0;
  let failCount = 0;

  const results = await Promise.allSettled([req1, req2]);
  for (const r of results) {
    if (r.status === 'fulfilled') successCount++;
    if (r.status === 'rejected') {
      if (r.reason.response?.status === 409 || r.reason.response?.status === 400) failCount++;
      else console.error('Unexpected failure:', r.reason.message, r.reason.response?.data);
    }
  }

  assert.strictEqual(successCount, 1, `Expected exactly 1 booking to succeed, got ${successCount}`);
  assert.strictEqual(failCount, 1, `Expected exactly 1 booking to fail safely, got ${failCount}`);

  console.log('✅ Double Booking Concurrency Test PASSED.');
}

async function testDuplicateAutomation() {
  console.log('\n--- FLOW H: Duplicate Automation Test ---');
  const createRes = await axios.post(`${API_BASE}/jobs`, {
    title: 'Idempotency Test',
    resident_id: testResidentId,
    assigned_staff_id: testStaffProfileId,
    pipeline_stage: 'Quotes'
  }, { headers: { Authorization: `Bearer ${adminToken}` } });
  const jobId = createRes.data.data.id;

  await wait(1000); // wait for photo trigger

  await axios.put(`${API_BASE}/jobs/${jobId}/stage`, { section: 'Jobs' }, { headers: { Authorization: `Bearer ${adminToken}` } });
  await axios.put(`${API_BASE}/jobs/${jobId}/stage`, { section: 'Quotes' }, { headers: { Authorization: `Bearer ${adminToken}` } });
  await axios.put(`${API_BASE}/jobs/${jobId}/stage`, { section: 'Jobs' }, { headers: { Authorization: `Bearer ${adminToken}` } });

  await wait(1000);

  const [qr] = await pool.query('SELECT COUNT(*) as c FROM quote_requests WHERE work_order_id = ?', [jobId]);
  assert.strictEqual(qr[0].c, 1, 'Duplicate quote requests created!');

  const [br] = await pool.query('SELECT COUNT(*) as c FROM booking_requests WHERE work_order_id = ?', [jobId]);
  assert.strictEqual(br[0].c, 1, 'Duplicate booking requests created!');

  console.log('✅ Duplicate Automation Prevented PASSED.');
}

async function runAll() {
  try {
    await setupTestData();
    await testFlowE_FinancialIsolation();
    await testFlowF_RBACAttacks();
    await testFlowG_DoubleBooking();
    await testDuplicateAutomation();

    console.log('\n✅✅✅ ALL E2E TESTS PASSED SUCCESSFULLY ✅✅✅');
    process.exit(0);
  } catch (err) {
    console.error('❌ TEST FAILED:', err.message);
    if (err.response) {
      console.error('API Response Data:', err.response.data);
    }
    process.exit(1);
  }
}

runAll();
