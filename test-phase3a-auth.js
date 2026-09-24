const http = require('http');

const PORT = 5000;
const BASE_URL = `http://localhost:${PORT}/api/v1/auth`;

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
      path: url.pathname,
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

async function runAuthTests() {
  console.log('=======================================================');
  console.log('🧪 Running Automated Test Suite: Phase 3A (Auth & Authorization)');
  console.log('=======================================================');

  let passedTests = 0;
  let totalTests = 7;
  let adminToken = null;
  let staffToken = null;

  try {
    // Test 1: Admin Login
    console.log('\n[Test 1/7] Testing Admin Login (admin@nexusfms.com)...');
    const adminRes = await makeRequest('POST', '/login', {
      email: 'admin@nexusfms.com',
      password: 'Password123!',
    });

    if (adminRes.status === 200 && adminRes.body.success && adminRes.body.token) {
      adminToken = adminRes.body.token;
      console.log('  ✅ Admin Login PASSED! Received JWT token for role:', adminRes.body.user.role);
      passedTests++;
    } else {
      console.error('  ❌ Admin Login FAILED:', adminRes.body);
    }

    // Test 2: Staff Login
    console.log('\n[Test 2/7] Testing Staff Login (staff@nexusfms.com)...');
    const staffRes = await makeRequest('POST', '/login', {
      email: 'staff@nexusfms.com',
      password: 'Password123!',
    });

    if (staffRes.status === 200 && staffRes.body.success && staffRes.body.token) {
      staffToken = staffRes.body.token;
      console.log('  ✅ Staff Login PASSED! Received JWT token for role:', staffRes.body.user.role);
      passedTests++;
    } else {
      console.error('  ❌ Staff Login FAILED:', staffRes.body);
    }

    // Test 3: Invalid Password
    console.log('\n[Test 3/7] Testing Invalid Password (admin@nexusfms.com + WrongPass!)...');
    const wrongPassRes = await makeRequest('POST', '/login', {
      email: 'admin@nexusfms.com',
      password: 'WrongPassword999!',
    });

    if (wrongPassRes.status === 401 && !wrongPassRes.body.success) {
      console.log('  ✅ Invalid Password test PASSED! Blocked with message:', wrongPassRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Invalid Password test FAILED:', wrongPassRes.body);
    }

    // Test 4: Invalid Email
    console.log('\n[Test 4/7] Testing Invalid Email (unknown@nexusfms.com)...');
    const wrongEmailRes = await makeRequest('POST', '/login', {
      email: 'unknown@nexusfms.com',
      password: 'Password123!',
    });

    if (wrongEmailRes.status === 401 && !wrongEmailRes.body.success) {
      console.log('  ✅ Invalid Email test PASSED! Blocked with message:', wrongEmailRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Invalid Email test FAILED:', wrongEmailRes.body);
    }

    // Test 5: /auth/me with Valid JWT (Admin & Staff)
    console.log('\n[Test 5/7] Testing GET /auth/me with valid Admin & Staff JWTs...');
    const adminMeRes = await makeRequest('GET', '/me', null, adminToken);
    const staffMeRes = await makeRequest('GET', '/me', null, staffToken);

    console.log('  📌 Raw Admin /auth/me Response:', JSON.stringify(adminMeRes.body, null, 2));
    console.log('  📌 Raw Staff /auth/me Response:', JSON.stringify(staffMeRes.body, null, 2));

    if (
      adminMeRes.status === 200 && adminMeRes.body.user.email === 'admin@nexusfms.com' &&
      staffMeRes.status === 200 && staffMeRes.body.user.email === 'staff@nexusfms.com'
    ) {
      console.log('  ✅ /auth/me with valid JWTs PASSED! Both Admin and Staff returned live MySQL records.');
      passedTests++;
    } else {
      console.error('  ❌ /auth/me with valid JWT FAILED:', { adminMeRes, staffMeRes });
    }

    // Test 6: /auth/me without JWT
    console.log('\n[Test 6/7] Testing GET /auth/me without JWT token...');
    const noTokenRes = await makeRequest('GET', '/me');

    if (noTokenRes.status === 401 && !noTokenRes.body.success) {
      console.log('  ✅ /auth/me without JWT test PASSED! Blocked with message:', noTokenRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ /auth/me without JWT test FAILED:', noTokenRes.body);
    }

    // Test 7: Role Authorization Middleware
    console.log('\n[Test 7/7] Testing Role Authorization (Admin vs Staff access to /admin-only-test)...');
    const adminAccess = await makeRequest('GET', '/admin-only-test', null, adminToken);
    const staffAccess = await makeRequest('GET', '/admin-only-test', null, staffToken);

    if (adminAccess.status === 200 && staffAccess.status === 403) {
      console.log('  ✅ Role Authorization test PASSED!');
      console.log('     - Admin Access (HTTP 200):', adminAccess.body.message);
      console.log('     - Staff Access Blocked (HTTP 403):', staffAccess.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Role Authorization test FAILED:', { adminAccess, staffAccess });
    }

    console.log('\n=======================================================');
    if (passedTests === totalTests) {
      console.log(`🎉 [ALL PHASE 3A AUTH TESTS PASSED] (${passedTests}/${totalTests})`);
    } else {
      console.error(`❌ [SOME TESTS FAILED] (${passedTests}/${totalTests})`);
    }
    console.log('=======================================================');

  } catch (err) {
    console.error('❌ Test Execution Error:', err.message);
  }
}

runAuthTests();
