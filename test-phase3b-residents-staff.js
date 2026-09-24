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

async function runPhase3BTests() {
  console.log('=======================================================');
  console.log('🧪 Running Automated Test Suite: Phase 3B (Residents & Staff APIs)');
  console.log('=======================================================');

  let passedTests = 0;
  let totalTests = 8;
  let adminToken = null;
  let staffToken = null;
  let createdTenantId = null;
  let createdStaffId = null;

  try {
    // Setup: Login Admin and Staff
    const adminLogin = await makeRequest('POST', '/auth/login', { email: 'admin@nexusfms.com', password: 'Password123!' });
    adminToken = adminLogin.body.token;

    const staffLogin = await makeRequest('POST', '/auth/login', { email: 'staff@nexusfms.com', password: 'Password123!' });
    staffToken = staffLogin.body.token;

    // Test 1: GET Residents (Authenticated)
    console.log('\n[Test 1/8] Testing GET /api/v1/tenants (Authenticated)...');
    const getTenantsRes = await makeRequest('GET', '/tenants', null, adminToken);
    if (getTenantsRes.status === 200 && getTenantsRes.body.success && Array.isArray(getTenantsRes.body.data)) {
      console.log(`  ✅ GET /tenants PASSED! Count: ${getTenantsRes.body.count}`);
      passedTests++;
    } else {
      console.error('  ❌ GET /tenants FAILED:', getTenantsRes.body);
    }

    // Test 2: Create Resident (Admin User)
    console.log('\n[Test 2/8] Testing POST /api/v1/tenants (Create Resident)...');
    const createTenantRes = await makeRequest('POST', '/tenants', {
      full_name: 'Test Resident John',
      phone: '+1 (555) 999-1111',
      email: 'john.test@example.com',
      address: '100 Test Street, Unit 4A',
      notes: 'Test resident notes for phase 3B verification.',
    }, adminToken);

    if (createTenantRes.status === 201 && createTenantRes.body.success && createTenantRes.body.data.id) {
      createdTenantId = createTenantRes.body.data.id;
      console.log('  ✅ Create Resident PASSED! Created ID:', createdTenantId, 'Name:', createTenantRes.body.data.full_name);
      passedTests++;
    } else {
      console.error('  ❌ Create Resident FAILED:', createTenantRes.body);
    }

    // Test 3: Contact Validation Enforcement (Missing Full Name/Phone/Address)
    console.log('\n[Test 3/8] Testing POST /api/v1/tenants Validation (Missing Required Phone)...');
    const invalidTenantRes = await makeRequest('POST', '/tenants', {
      full_name: 'Invalid Resident No Phone',
      address: '123 Missing Phone St',
    }, adminToken);

    if (invalidTenantRes.status === 400 && !invalidTenantRes.body.success) {
      console.log('  ✅ Required Field Validation PASSED! Blocked with error:', invalidTenantRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Required Field Validation FAILED:', invalidTenantRes.body);
    }

    // Test 4: GET Staff (Authenticated)
    console.log('\n[Test 4/8] Testing GET /api/v1/staff (Authenticated)...');
    const getStaffRes = await makeRequest('GET', '/staff', null, adminToken);
    if (getStaffRes.status === 200 && getStaffRes.body.success && Array.isArray(getStaffRes.body.data)) {
      console.log(`  ✅ GET /staff PASSED! Count: ${getStaffRes.body.count}`);
      passedTests++;
    } else {
      console.error('  ❌ GET /staff FAILED:', getStaffRes.body);
    }

    // Test 5: Create Staff Member (Admin User)
    console.log('\n[Test 5/8] Testing POST /api/v1/staff (Create Technician)...');
    const createStaffRes = await makeRequest('POST', '/staff', {
      full_name: 'Test Technician Mark',
      phone: '+1 (555) 888-2222',
      email: 'tech.mark.test@nexusfms.com',
      role_title: 'HVAC & Plumbing Specialist',
      color: '#10b981',
      workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    }, adminToken);

    if (createStaffRes.status === 201 && createStaffRes.body.success && createStaffRes.body.data.id) {
      createdStaffId = createStaffRes.body.data.id;
      console.log('  ✅ Create Staff Member PASSED! Created ID:', createdStaffId, 'Code:', createStaffRes.body.data.staffCode);
      passedTests++;
    } else {
      console.error('  ❌ Create Staff Member FAILED:', createStaffRes.body);
    }

    // Test 6: Authentication Protection (No Token)
    console.log('\n[Test 6/8] Testing GET /api/v1/tenants without JWT Token...');
    const noTokenRes = await makeRequest('GET', '/tenants');
    if (noTokenRes.status === 401 && !noTokenRes.body.success) {
      console.log('  ✅ Unauthenticated Protection PASSED! Message:', noTokenRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Unauthenticated Protection FAILED:', noTokenRes.body);
    }

    // Test 7: Role Authorization (Staff User trying to Create Resident)
    console.log('\n[Test 7/8] Testing Role Authorization (Staff token trying to POST /tenants)...');
    const forbiddenRes = await makeRequest('POST', '/tenants', {
      full_name: 'Forbidden Resident',
      phone: '+1 (555) 000-0000',
      address: 'Forbidden St',
    }, staffToken);

    if (forbiddenRes.status === 403 && !forbiddenRes.body.success) {
      console.log('  ✅ Role Authorization PASSED! Blocked with 403 Forbidden:', forbiddenRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Role Authorization FAILED:', forbiddenRes.body);
    }

    // Test 8: Cleanup Test Data
    console.log('\n[Test 8/8] Cleaning up created test entities...');
    let cleanupSuccess = true;

    if (createdTenantId) {
      const delTenantRes = await makeRequest('DELETE', `/tenants/${createdTenantId}`, null, adminToken);
      if (delTenantRes.status !== 200) cleanupSuccess = false;
    }

    if (createdStaffId) {
      const delStaffRes = await makeRequest('DELETE', `/staff/${createdStaffId}`, null, adminToken);
      if (delStaffRes.status !== 200) cleanupSuccess = false;
    }

    if (cleanupSuccess) {
      console.log('  ✅ Cleanup PASSED! Test resident and staff records removed cleanly.');
      passedTests++;
    } else {
      console.error('  ❌ Cleanup FAILED.');
    }

    console.log('\n=======================================================');
    if (passedTests === totalTests) {
      console.log(`🎉 [ALL PHASE 3B TESTS PASSED] (${passedTests}/${totalTests})`);
    } else {
      console.error(`❌ [SOME TESTS FAILED] (${passedTests}/${totalTests})`);
    }
    console.log('=======================================================');

  } catch (err) {
    console.error('❌ Test Execution Error:', err.message);
  }
}

runPhase3BTests();
