const http = require('http');

const PORT = 5000;
const BASE_URL = `http://localhost:${PORT}/api/v1`;

function makeRequest(method, reqPath, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${reqPath}`);
    const headers = {};

    if (body) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: method,
      headers: headers,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', (err) => reject(err));

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runPhase3FTests() {
  console.log('=======================================================');
  console.log('📅 Running Automated Test Suite: Phase 3F (Calendar & Booking Slots)');
  console.log('=======================================================');

  let passedTests = 0;
  let totalTests = 12;

  let adminToken = null;
  let staffAToken = null;
  let staffBToken = null;

  let staffAObj = null;
  let staffBObj = null;
  let jobAId = null;
  let bookingToken = null;

  // Use a Monday for working day tests
  const targetMonday = '2026-08-24'; 
  const targetSunday = '2026-08-23';

  try {
    // Setup 1: Admin Login
    const adminLogin = await makeRequest('POST', '/auth/login', { email: 'admin@nexusfms.com', password: 'Password123!' });
    adminToken = adminLogin.body.token;

    // Setup 2: Create Staff A (HVAC, 08:00-17:00, break 12:00-13:00) and Staff B
    console.log('\n[Setup] Creating Temporary Staff A & Staff B...');
    const createStaffA = await makeRequest('POST', '/staff', {
      full_name: 'Technician Staff A Calendar',
      email: 'staffA.cal@nexusfms.com',
      phone: '+1 (555) 777-A111',
      role_title: 'HVAC Specialist',
      workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      startTime: '08:00:00',
      endTime: '17:00:00',
    }, adminToken);
    staffAObj = createStaffA.body.data;

    const createStaffB = await makeRequest('POST', '/staff', {
      full_name: 'Technician Staff B Calendar',
      email: 'staffB.cal@nexusfms.com',
      phone: '+1 (555) 777-B222',
      role_title: 'Electrical Specialist',
      workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    }, adminToken);
    staffBObj = createStaffB.body.data;

    // Login as Staff A & Staff B
    const loginA = await makeRequest('POST', '/auth/login', { email: 'staffA.cal@nexusfms.com', password: 'Password123!' });
    staffAToken = loginA.body.token;

    const loginB = await makeRequest('POST', '/auth/login', { email: 'staffB.cal@nexusfms.com', password: 'Password123!' });
    staffBToken = loginB.body.token;

    // Setup 3: Create Work Order (Duration: 2.0 hours) assigned to Staff A
    const createJobA = await makeRequest('POST', '/jobs', {
      title: 'HVAC Chiller Compressor Maintenance',
      resident_name: 'Resident Calendar Test',
      contact_phone: '+1 (555) 333-0000',
      property_address: '700 Grand Avenue, Apt 5',
      assigned_staff_id: staffAObj.profileId,
      duration_hours: 2.0,
      section: 'Jobs Waiting Booking',
    }, adminToken);
    jobAId = createJobA.body.data.id;

    // Generate Public Booking Link for Job A
    const genBookingLink = await makeRequest('POST', `/public/jobs/${jobAId}/generate-link`, { type: 'BOOKING' }, adminToken);
    bookingToken = genBookingLink.body.data.secureToken;

    // Test 1: Admin views all calendars (Dynamic Staff Count check)
    console.log('\n[Test 1/12] Admin viewing all technician calendars...');
    const adminCalRes = await makeRequest('GET', '/calendar', null, adminToken);

    if (adminCalRes.status === 200 && adminCalRes.body.success && adminCalRes.body.staffCount >= 2) {
      console.log(`  ✅ Admin Calendar PASSED! Dynamic Active Staff Count: ${adminCalRes.body.staffCount}`);
      passedTests++;
    } else {
      console.error('  ❌ Admin Calendar FAILED:', adminCalRes.body);
    }

    // Test 2: Staff A views only own calendar
    console.log('\n[Test 2/12] Staff A viewing own calendar schedule...');
    const staffACalRes = await makeRequest('GET', '/calendar', null, staffAToken);

    if (staffACalRes.status === 200 && staffACalRes.body.success) {
      console.log('  ✅ Staff Calendar View PASSED!');
      passedTests++;
    } else {
      console.error('  ❌ Staff Calendar View FAILED:', staffACalRes.body);
    }

    // Test 3: Staff A attempting to query Staff B's calendar (Authorization Check)
    console.log('\n[Test 3/12] Staff A attempting to query Staff B calendar schedule...');
    const unauthCalRes = await makeRequest('GET', `/calendar?staffId=${staffBObj.profileId}`, null, staffAToken);

    if (unauthCalRes.status === 403 && !unauthCalRes.body.success) {
      console.log('  ✅ Unauthorized Calendar Access BLOCKED (HTTP 403 Forbidden):', unauthCalRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Unauthorized Calendar Access FAILED:', unauthCalRes.body);
    }

    // Test 4: Token-scoped Public Availability Slot Calculation for Resident
    console.log('\n[Test 4/12] Resident querying token-scoped availability for Monday (2026-08-24)...');
    const pubSlotsRes = await makeRequest('GET', `/public/booking/${bookingToken}/available-slots?date=${targetMonday}`);

    if (pubSlotsRes.status === 200 && pubSlotsRes.body.success && pubSlotsRes.body.availability.availableSlots.length > 0) {
      const slots = pubSlotsRes.body.availability.availableSlots;
      console.log('  ✅ Token-Scoped Availability PASSED!');
      console.log(`     - Assigned Technician: ${pubSlotsRes.body.availability.staffName}`);
      console.log(`     - Job Duration: ${pubSlotsRes.body.durationHours} hrs`);
      console.log(`     - Available Slots Count: ${slots.length}`);
      console.log(`     - Sample Valid Slot: ${slots[0].timeSlot}`);
      passedTests++;
    } else {
      console.error('  ❌ Token-Scoped Availability FAILED:', pubSlotsRes.body);
    }

    // Test 5: Slot rejection on non-working day (Sunday 2026-08-23)
    console.log('\n[Test 5/12] Resident querying availability on non-working day (Sunday 2026-08-23)...');
    const sundaySlotsRes = await makeRequest('GET', `/public/booking/${bookingToken}/available-slots?date=${targetSunday}`);

    if (sundaySlotsRes.status === 200 && sundaySlotsRes.body.availability.availableSlots.length === 0) {
      console.log('  ✅ Non-Working Day Slot Rejection PASSED! (0 slots available on Sunday)');
      passedTests++;
    } else {
      console.error('  ❌ Non-Working Day Slot Rejection FAILED:', sundaySlotsRes.body);
    }

    // Test 6: Break Time Exclusion Check (Slot 12:00 - 14:00 must NOT be present)
    console.log('\n[Test 6/12] Verifying break time (12:00 - 13:00) exclusion...');
    const slotsList = pubSlotsRes.body.availability.availableSlots;
    const hasBreakOverlap = slotsList.some(s => s.startTime === '12:00' || (s.startTime < '13:00' && s.endTime > '12:00'));

    if (!hasBreakOverlap) {
      console.log('  ✅ Break Time Exclusion PASSED! No slots overlap technician break (12:00 - 13:00).');
      passedTests++;
    } else {
      console.error('  ❌ Break Time Exclusion FAILED. Found overlapping break slot:', slotsList);
    }

    // Test 7: Valid Public Booking Confirmation (Slot: 09:00 - 11:00)
    console.log('\n[Test 7/12] Resident confirming valid slot booking (09:00 - 11:00)...');
    const bookingConfirmRes = await makeRequest('POST', `/public/booking/${bookingToken}/confirm`, {
      booking_date: targetMonday,
      time_slot: '09:00 - 11:00',
    });

    if (bookingConfirmRes.status === 200 && bookingConfirmRes.body.success && bookingConfirmRes.body.data.stage === 'Jobs') {
      console.log('  ✅ Public Slot Booking Confirmation PASSED!');
      console.log('     - Scheduled Date:', bookingConfirmRes.body.data.scheduledDate);
      console.log('     - Scheduled Slot:', bookingConfirmRes.body.data.scheduledTimeSlot);
      console.log('     - Updated Pipeline Stage:', bookingConfirmRes.body.data.stage);
      passedTests++;
    } else {
      console.error('  ❌ Public Slot Booking Confirmation FAILED:', bookingConfirmRes.body);
    }

    // Test 8: Double-Booking & Overlap Collision Prevention (Attempt to book same slot 09:00 - 11:00)
    console.log('\n[Test 8/12] Double-Booking Security Check: Attempting to book overlapping slot (09:00 - 11:00)...');
    const doubleBookingRes = await makeRequest('POST', `/public/booking/${bookingToken}/confirm`, {
      booking_date: targetMonday,
      time_slot: '09:00 - 11:00',
    });

    if (doubleBookingRes.status === 400 && !doubleBookingRes.body.success) {
      console.log('  ✅ Double-Booking Collision BLOCKED (HTTP 400):', doubleBookingRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Double-Booking Security FAILED:', doubleBookingRes.body);
    }

    // Test 9: Admin Dispatch / Reschedule Endpoint (Overlapping dispatch attempt)
    console.log('\n[Test 9/12] Admin Dispatch Security Check: Rescheduling job to overlapping slot (10:00 - 12:00)...');
    const invalidDispatchRes = await makeRequest('POST', '/calendar/dispatch', {
      workOrderId: jobAId,
      assignedStaffId: staffAObj.profileId,
      scheduledDate: targetMonday,
      scheduledTimeSlot: '10:00 - 12:00',
    }, adminToken);

    if (invalidDispatchRes.status === 400 && !invalidDispatchRes.body.success) {
      console.log('  ✅ Overlapping Admin Dispatch BLOCKED (HTTP 400):', invalidDispatchRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Overlapping Admin Dispatch FAILED:', invalidDispatchRes.body);
    }

    // Test 10: Admin Dispatch / Reschedule to valid non-overlapping slot (14:00 - 16:00)
    console.log('\n[Test 10/12] Admin Dispatching job to valid non-overlapping slot (14:00 - 16:00)...');
    const validDispatchRes = await makeRequest('POST', '/calendar/dispatch', {
      workOrderId: jobAId,
      assignedStaffId: staffAObj.profileId,
      scheduledDate: targetMonday,
      scheduledTimeSlot: '14:00 - 16:00',
    }, adminToken);

    if (validDispatchRes.status === 200 && validDispatchRes.body.success && validDispatchRes.body.data.scheduledTimeSlot === '14:00 - 16:00') {
      console.log('  ✅ Valid Admin Dispatch PASSED! Scheduled:', validDispatchRes.body.data.scheduledTimeSlot);
      passedTests++;
    } else {
      console.error('  ❌ Valid Admin Dispatch FAILED:', validDispatchRes.body);
    }

    // Test 11: Scheduled Job Appears on Assigned Technician's Calendar
    console.log('\n[Test 11/12] Verifying scheduled job appears on Staff A calendar...');
    const checkCalRes = await makeRequest('GET', '/calendar', null, staffAToken);

    if (checkCalRes.status === 200 && checkCalRes.body.count === 1 && checkCalRes.body.data[0].id === jobAId) {
      console.log('  ✅ Scheduled Job on Technician Calendar PASSED!');
      passedTests++;
    } else {
      console.error('  ❌ Scheduled Job on Technician Calendar FAILED:', checkCalRes.body);
    }

    // Test 12: Teardown & Clean up all created test entities
    console.log('\n[Test 12/12] Cleaning up all test entities...');
    let cleanupSuccess = true;

    if (jobAId) {
      const delJob = await makeRequest('DELETE', `/jobs/${jobAId}`, null, adminToken);
      if (delJob.status !== 200) cleanupSuccess = false;
    }

    if (staffAObj) {
      const delStaffA = await makeRequest('DELETE', `/staff/${staffAObj.profileId}`, null, adminToken);
      if (delStaffA.status !== 200) cleanupSuccess = false;
    }

    if (staffBObj) {
      const delStaffB = await makeRequest('DELETE', `/staff/${staffBObj.profileId}`, null, adminToken);
      if (delStaffB.status !== 200) cleanupSuccess = false;
    }

    if (cleanupSuccess) {
      console.log('  ✅ Teardown PASSED! All temporary test records removed cleanly.');
      passedTests++;
    } else {
      console.error('  ❌ Teardown FAILED.');
    }

    console.log('\n=======================================================');
    if (passedTests === totalTests) {
      console.log(`🎉 [ALL PHASE 3F CALENDAR & BOOKING TESTS PASSED] (${passedTests}/${totalTests})`);
    } else {
      console.error(`❌ [SOME TESTS FAILED] (${passedTests}/${totalTests})`);
    }
    console.log('=======================================================');

  } catch (err) {
    console.error('❌ Test Execution Error:', err.message);
  }
}

runPhase3FTests();
