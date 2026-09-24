const request = require('supertest');
const jwt = require('jsonwebtoken');

// We use fetch to avoid needing to boot the express app inside the test if it's already running.
// Assuming the backend is running on https://nexusfmsbackednshrikant-production.up.railway.app or the railway production URL.
const API_URL = 'https://nexusfmsbackednshrikant-production.up.railway.app/api/v1';

async function runTests() {
  console.log("=== AUTHENTICATION & RBAC AUTOMATED TEST SUITE ===");

  async function doFetch(path, method, token, body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API_URL}${path}`, opts);
    let data;
    try { data = await res.json(); } catch (e) { data = null; }
    return { status: res.status, data };
  }

  try {
    // 1. Admin login
    console.log("\n1. Testing Admin Login...");
    const adminLogin = await doFetch('/auth/login', 'POST', null, { email: 'test_office_admin@nexus.com', password: 'password123' });
    if (adminLogin.status === 200 && adminLogin.data.token) console.log("✅ Admin login succeeds.");
    else throw new Error("Admin login failed");
    const adminToken = adminLogin.data.token;

    // 2. Office Team login
    console.log("2. Testing Office Team Login...");
    const officeLogin = await doFetch('/auth/login', 'POST', null, { email: 'test_office_team@nexus.com', password: 'password123' });
    if (officeLogin.status === 200 && officeLogin.data.token) console.log("✅ Office Team login succeeds.");
    else throw new Error("Office Team login failed");
    const officeToken = officeLogin.data.token;

    // 3. Maintenance Technician login
    console.log("3. Testing Maintenance Technician Login...");
    const techLogin = await doFetch('/auth/login', 'POST', null, { email: 'test_maintenance_staff@nexus.com', password: 'password123' });
    if (techLogin.status === 200 && techLogin.data.token) console.log("✅ Maintenance Technician login succeeds.");
    else throw new Error("Maintenance Tech login failed");
    const techToken = techLogin.data.token;

    // 4. Invalid credentials fail
    console.log("4. Testing Invalid Credentials...");
    const invalidLogin = await doFetch('/auth/login', 'POST', null, { email: 'test_office_admin@nexus.com', password: 'wrongpassword' });
    if (invalidLogin.status === 401) console.log("✅ Invalid credentials correctly rejected (401).");
    else throw new Error("Invalid credentials were not rejected");

    // 5. /auth/me returns correct role
    console.log("5. Testing /auth/me...");
    const meRes = await doFetch('/auth/me', 'GET', officeToken);
    if (meRes.status === 200 && meRes.data && meRes.data.user && meRes.data.user.role === 'OFFICE_TEAM') console.log("✅ /auth/me returns correct role for Office Team.");
    else throw new Error("/auth/me returned wrong role or failed");

    // 6. Admin can access Admin routes
    console.log("6. Testing Admin access to Admin routes...");
    const adminInv = await doFetch('/inventory', 'GET', adminToken);
    if (adminInv.status === 200) console.log("✅ Admin can access /inventory.");
    else throw new Error("Admin denied from /inventory");

    // 7. Office Team cannot access Admin routes
    console.log("7. Testing Office Team blocked from Admin routes...");
    const officeInv = await doFetch('/inventory', 'GET', officeToken);
    if (officeInv.status === 403) console.log("✅ Office Team correctly blocked from /inventory (403).");
    else throw new Error("Office Team was not blocked from /inventory");

    // 8. Maintenance cannot access Admin routes
    console.log("8. Testing Maintenance blocked from Admin routes...");
    const techInv = await doFetch('/inventory', 'GET', techToken);
    if (techInv.status === 403) console.log("✅ Maintenance correctly blocked from /inventory (403).");
    else throw new Error("Maintenance was not blocked from /inventory");

    // 9. Maintenance cannot access Office Team routes (Calendar dispatch)
    console.log("9. Testing Maintenance blocked from Office Team routes...");
    const techCal = await doFetch('/calendar/dispatch', 'POST', techToken, { jobId: 1, staffId: 1, date: '2030-01-01', timeSlot: '09:00 AM' });
    if (techCal.status === 403) console.log("✅ Maintenance correctly blocked from /calendar/dispatch (403).");
    else throw new Error("Maintenance was not blocked from calendar dispatch");

    // 12. Expired/invalid token redirects to login (401)
    console.log("12. Testing Invalid Token rejection...");
    const invalidToken = await doFetch('/auth/me', 'GET', 'invalid.jwt.token');
    if (invalidToken.status === 403 || invalidToken.status === 401) console.log("✅ Invalid token correctly rejected.");
    else throw new Error("Invalid token accepted!");

    console.log("\n✅ ALL TESTS PASSED!");
  } catch (err) {
    console.error("❌ TEST FAILED:", err.message);
  }
}

runTests();
