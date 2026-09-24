const http = require('http');

const PORT = 5000;
const BASE_URL = `http://localhost:${PORT}/api/v1`;

function makeRequest(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${path}`);
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

async function runPhase3CFinalSecurityChecks() {
  console.log('=======================================================');
  console.log('🔒 Running Phase 3C Final Security & Ownership Verification');
  console.log('=======================================================');

  let passedTests = 0;
  let totalTests = 9;

  let adminToken = null;
  let staffAToken = null;
  let staffBToken = null;

  let staffAObj = null;
  let staffBObj = null;
  let createdJobId = null;

  try {
    // Setup 1: Login Admin
    const adminLogin = await makeRequest('POST', '/auth/login', { email: 'admin@nexusfms.com', password: 'Password123!' });
    adminToken = adminLogin.body.token;

    // Setup 2: Create Temporary Staff A and Staff B
    console.log('\n[Setup] Creating Temporary Staff A and Staff B...');
    const createStaffARes = await makeRequest('POST', '/staff', {
      full_name: 'Technician Staff A',
      email: 'staffA.test@nexusfms.com',
      phone: '+1 (555) 111-AAAA',
      role_title: 'Plumbing Specialist',
    }, adminToken);
    staffAObj = createStaffARes.body.data;

    const createStaffBRes = await makeRequest('POST', '/staff', {
      full_name: 'Technician Staff B',
      email: 'staffB.test@nexusfms.com',
      phone: '+1 (555) 222-BBBB',
      role_title: 'Electrical Specialist',
    }, adminToken);
    staffBObj = createStaffBRes.body.data;

    // Login as Staff A and Staff B
    const staffALogin = await makeRequest('POST', '/auth/login', { email: 'staffA.test@nexusfms.com', password: 'Password123!' });
    staffAToken = staffALogin.body.token;

    const staffBLogin = await makeRequest('POST', '/auth/login', { email: 'staffB.test@nexusfms.com', password: 'Password123!' });
    staffBToken = staffBLogin.body.token;

    console.log(`  ✅ Setup Complete! Staff A Profile ID: ${staffAObj.profileId}, Staff B Profile ID: ${staffBObj.profileId}`);

    // Setup 3: Create Work Order Assigned to Staff A
    const createJobRes = await makeRequest('POST', '/jobs', {
      title: 'Water Leak Repair in Apt 3B',
      resident_name: 'Resident Mary',
      contact_phone: '+1 (555) 333-4444',
      property_address: '123 Main St, Apt 3B',
      assigned_staff_id: staffAObj.profileId,
      section: 'Quotes',
    }, adminToken);
    createdJobId = createJobRes.body.data.id;

    // Test 1: Staff ID Consistency Verification (FK profileId vs staffCode)
    console.log('\n[Test 1/9] Staff ID Consistency Verification...');
    const jobData = createJobRes.body.data;
    if (jobData.assignedStaffId === staffAObj.profileId) {
      console.log('  ✅ Staff ID Consistency PASSED!');
      console.log(`     - assignedStaffId (MySQL Foreign Key): ${jobData.assignedStaffId}`);
      console.log(`     - assignedStaffCode (Human Display Code): ${jobData.assignedStaffCode}`);
      passedTests++;
    } else {
      console.error('  ❌ Staff ID Consistency FAILED:', {
        assignedStaffId: jobData.assignedStaffId,
        expectedProfileId: staffAObj.profileId,
        assignedStaffCode: jobData.assignedStaffCode,
      });
    }

    // Test 2: Staff B attempts PUT /jobs/:id/stage on Staff A's assigned job
    console.log('\n[Test 2/9] Security Check: Staff B attempting PUT /jobs/:id/stage on Staff A job...');
    const staffBStageRes = await makeRequest('PUT', `/jobs/${createdJobId}/stage`, {
      section: 'Completed Quotes',
    }, staffBToken);

    if (staffBStageRes.status === 403 && !staffBStageRes.body.success) {
      console.log('  ✅ Unassigned Stage Update BLOCKED (HTTP 403 Forbidden):', staffBStageRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Security Check FAILED: Unassigned staff was allowed to move stage:', staffBStageRes.body);
    }

    // Test 3: Staff B attempts PUT /jobs/:id/status on Staff A's assigned job
    console.log('\n[Test 3/9] Security Check: Staff B attempting PUT /jobs/:id/status on Staff A job...');
    const staffBStatusRes = await makeRequest('PUT', `/jobs/${createdJobId}/status`, {
      quote_amount: 150.00,
    }, staffBToken);

    if (staffBStatusRes.status === 403 && !staffBStatusRes.body.success) {
      console.log('  ✅ Unassigned Status Update BLOCKED (HTTP 403 Forbidden):', staffBStatusRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Security Check FAILED: Unassigned staff was allowed to update status:', staffBStatusRes.body);
    }

    // Test 4: Staff B attempts to reassign job to themselves
    console.log('\n[Test 4/9] Security Check: Staff B attempting to reassign job to Staff B...');
    const staffBReassignRes = await makeRequest('PUT', `/jobs/${createdJobId}/status`, {
      assigned_staff_id: staffBObj.profileId,
    }, staffBToken);

    if (staffBReassignRes.status === 403 && !staffBReassignRes.body.success) {
      console.log('  ✅ Job Reassignment BLOCKED (HTTP 403 Forbidden):', staffBReassignRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Security Check FAILED: Staff was allowed to reassign job:', staffBReassignRes.body);
    }

    // Test 5: Staff A updates their OWN assigned job
    console.log('\n[Test 5/9] Security Check: Staff A updating OWN assigned job...');
    const staffAUpdateRes = await makeRequest('PUT', `/jobs/${createdJobId}/status`, {
      quote_amount: 195.00,
    }, staffAToken);

    if (staffAUpdateRes.status === 200 && staffAUpdateRes.body.success && staffAUpdateRes.body.data.quoteAmount === 195.00) {
      console.log('  ✅ Assigned Staff Update PASSED! Updated Quote Amount: $' + staffAUpdateRes.body.data.quoteAmount);
      passedTests++;
    } else {
      console.error('  ❌ Assigned Staff Update FAILED:', staffAUpdateRes.body);
    }

    // Test 6: Office Admin full authorized access
    console.log('\n[Test 6/9] Security Check: Office Admin full authorized control...');
    const adminStageRes = await makeRequest('PUT', `/jobs/${createdJobId}/stage`, {
      section: 'Completed Quotes',
    }, adminToken);

    if (adminStageRes.status === 200 && adminStageRes.body.success && adminStageRes.body.data.section === 'Completed Quotes') {
      console.log('  ✅ Office Admin Stage Move PASSED! Updated stage:', adminStageRes.body.data.section);
      passedTests++;
    } else {
      console.error('  ❌ Office Admin Stage Move FAILED:', adminStageRes.body);
    }

    // Test 7: Staff member attempting to DELETE a job
    console.log('\n[Test 7/9] Security Check: Staff member attempting DELETE /jobs/:id...');
    const staffDeleteRes = await makeRequest('DELETE', `/jobs/${createdJobId}`, null, staffAToken);

    if (staffDeleteRes.status === 403 && !staffDeleteRes.body.success) {
      console.log('  ✅ Job Deletion BLOCKED for Staff (HTTP 403 Forbidden):', staffDeleteRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Security Check FAILED: Staff was allowed to delete job:', staffDeleteRes.body);
    }

    // Test 8: Office Admin deletes job
    console.log('\n[Test 8/9] Security Check: Office Admin deleting job...');
    const adminDeleteRes = await makeRequest('DELETE', `/jobs/${createdJobId}`, null, adminToken);

    if (adminDeleteRes.status === 200 && adminDeleteRes.body.success) {
      console.log('  ✅ Office Admin Job Deletion PASSED!');
      passedTests++;
    } else {
      console.error('  ❌ Office Admin Job Deletion FAILED:', adminDeleteRes.body);
    }

    // Test 9: Complete Teardown & Database Cleanliness
    console.log('\n[Test 9/9] Cleaning up all temporary test accounts & profiles...');
    let cleanupSuccess = true;

    if (staffAObj) {
      const delA = await makeRequest('DELETE', `/staff/${staffAObj.profileId}`, null, adminToken);
      if (delA.status !== 200) cleanupSuccess = false;
    }

    if (staffBObj) {
      const delB = await makeRequest('DELETE', `/staff/${staffBObj.profileId}`, null, adminToken);
      if (delB.status !== 200) cleanupSuccess = false;
    }

    if (cleanupSuccess) {
      console.log('  ✅ Teardown PASSED! Temporary Staff A and Staff B removed cleanly.');
      passedTests++;
    } else {
      console.error('  ❌ Teardown FAILED.');
    }

    console.log('\n=======================================================');
    if (passedTests === totalTests) {
      console.log(`🎉 [ALL PHASE 3C SECURITY CHECKS PASSED] (${passedTests}/${totalTests})`);
    } else {
      console.error(`❌ [SOME TESTS FAILED] (${passedTests}/${totalTests})`);
    }
    console.log('=======================================================');

  } catch (err) {
    console.error('❌ Test Execution Error:', err.message);
  }
}

runPhase3CFinalSecurityChecks();
