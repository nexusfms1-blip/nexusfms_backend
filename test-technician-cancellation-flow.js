const request = require('supertest');

// We use fetch against the Railway backend API URL.
const API_URL = 'https://nexusfmsbackednshrikant-production.up.railway.app/api/v1';

async function runTests() {
  console.log("=== PHASE 5: TECHNICIAN CANCELLATION FLOW TESTS ===");

  async function doFetch(path, method, token, body = null, isFormData = false) {
    const opts = { method, headers: {} };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (body) {
      if (isFormData) {
        opts.body = body; // FormData
      } else {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }
    const res = await fetch(`${API_URL}${path}`, opts);
    let data;
    try { data = await res.json(); } catch(e) { data = null; }
    return { status: res.status, data };
  }

  try {
    console.log("\n1. Logging in as roles...");
    const adminLogin = await doFetch('/auth/login', 'POST', null, { email: 'test_office_admin@nexus.com', password: 'password123' });
    const adminToken = adminLogin.data.token;
    console.log("✅ Admin logged in.");

    const techLogin = await doFetch('/auth/login', 'POST', null, { email: 'test_maintenance_staff@nexus.com', password: 'password123' });
    const techToken = techLogin.data.token;
    const techId = techLogin.data.user.id;
    console.log("✅ Technician logged in.");

    const officeLogin = await doFetch('/auth/login', 'POST', null, { email: 'test_office_team@nexus.com', password: 'password123' });
    const officeToken = officeLogin.data.token;
    console.log("✅ Office Team logged in.");

    // Create a mock job for the technician to cancel
    console.log("\n2. Creating a test job to cancel...");
    // Let's create a job as admin
    const createJobRes = await doFetch('/jobs', 'POST', adminToken, {
      title: "Test Cancellation Job",
      tenantName: "John Doe",
      contactPhone: "1234567890",
      address: "123 Cancel St",
      assignedStaffId: `usr-${techId}`, // Assign to the logged in tech
      scheduledDate: "2030-10-10",
      scheduledTimeSlot: "10:00 - 11:30"
    });
    
    if (createJobRes.status !== 201) {
      throw new Error("Failed to create test job: " + JSON.stringify(createJobRes.data));
    }
    const testJobId = createJobRes.data.data.id;
    console.log(`✅ Created test job #${testJobId} assigned to technician.`);

    console.log("\n3. Testing 48-hour boundary (Outside 48h -> allowed)");
    // 2030 is outside 48 hours, should be allowed.
    const cancelBody = new FormData();
    cancelBody.append('cancellationType', 'TECHNICIAN_CANCELLED');
    cancelBody.append('reason', 'Test tech cancel reason');

    const cancelRes = await doFetch(`/jobs/${testJobId}/cancel`, 'POST', techToken, cancelBody, true);
    if (cancelRes.status === 200) {
      console.log("✅ Technician cancellation outside 48h succeeded.");
    } else {
      throw new Error("Cancellation failed: " + JSON.stringify(cancelRes.data));
    }

    console.log("\n4. Verifying job state updates...");
    const checkJobRes = await doFetch(`/jobs/${testJobId}`, 'GET', adminToken);
    const jobData = checkJobRes.data.data;
    if (jobData.section === 'Jobs Waiting Booking' && !jobData.scheduledDate) {
      console.log("✅ Job moved back to Jobs Waiting Booking and slot cleared.");
    } else {
      throw new Error("Job not properly cleared: " + JSON.stringify(jobData));
    }

    console.log("\n5. Testing Security: Tech cannot cancel another tech's job");
    // Attempting to cancel another job (create one assigned to no one or someone else)
    const anotherJobRes = await doFetch('/jobs', 'POST', adminToken, {
      title: "Another Job", tenantName: "Jane", contactPhone: "123", address: "abc",
    });
    const anotherJobId = anotherJobRes.data.data.id;
    const anotherCancelRes = await doFetch(`/jobs/${anotherJobId}/cancel`, 'POST', techToken, cancelBody, true);
    if (anotherCancelRes.status === 403) {
      console.log("✅ Technician blocked from cancelling another tech's job.");
    } else {
      throw new Error("Technician was allowed to cancel another job!");
    }

    console.log("\n6. Testing 48-hour boundary (Inside 48h -> rejected)");
    // Create a job for exactly right now
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const hrs = String(now.getHours()).padStart(2, '0');
    const slot = `${hrs}:00 - ${hrs}:30`;
    
    const nearJobRes = await doFetch('/jobs', 'POST', adminToken, {
      title: "Near Job", tenantName: "Jane", contactPhone: "123", address: "abc",
      assignedStaffId: `usr-${techId}`, scheduledDate: today, scheduledTimeSlot: slot
    });
    const nearJobId = nearJobRes.data.data.id;
    
    const nearCancelRes = await doFetch(`/jobs/${nearJobId}/cancel`, 'POST', techToken, cancelBody, true);
    if (nearCancelRes.status === 403 && nearCancelRes.data.code === 'CANCELLATION_WINDOW_RESTRICTED') {
      console.log("✅ Technician correctly blocked from cancelling within 48 hours.");
    } else {
      throw new Error("Technician was NOT blocked from 48-hour rule! " + JSON.stringify(nearCancelRes.data));
    }

    console.log("\n✅ ALL TESTS PASSED!");
  } catch (err) {
    console.error("❌ TEST FAILED:", err.message);
  }
}

runTests();
