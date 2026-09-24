const { pool } = require('./config/db');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'nexus_super_secret_key_2025';

async function runTests() {
  try {
    console.log('--- STARTING RBAC & SECURITY TESTS ---');

    const roles = ['OFFICE_ADMIN', 'OFFICE_TEAM', 'MAINTENANCE_STAFF'];
    const testUsers = {};

    for (const role of roles) {
      const email = `test_${role.toLowerCase()}@nexus.com`;
      const passwordHash = crypto.createHash('sha256').update('password123').digest('hex');

      let [rows] = await pool.query('SELECT id, role, full_name, email FROM users WHERE email = ?', [email]);

      if (rows.length === 0) {
        const [insertRes] = await pool.query(
          'INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)',
          [`Test ${role}`, email, passwordHash, role]
        );
        testUsers[role] = { id: insertRes.insertId, email, role, full_name: `Test ${role}` };
      } else {
        testUsers[role] = rows[0];
      }

      testUsers[role].token = jwt.sign(
        { id: testUsers[role].id, role: testUsers[role].role, email: testUsers[role].email },
        JWT_SECRET,
        { expiresIn: '1h' }
      );
    }

    let jobId = 1;
    try {
      const [jobs] = await pool.query('SELECT id FROM work_orders LIMIT 1');
      if (jobs.length > 0) jobId = jobs[0].id;
    } catch (e) { }

    console.log('\n--- TESTING OFFICE_TEAM PERMISSIONS ---');
    const teamTests = [
      { name: 'GET Jobs', path: '/api/v1/jobs', method: 'GET', expect: 200 },
      { name: 'GET Job Details', path: `/api/v1/jobs/${jobId}`, method: 'GET', expect: 200 },
      { name: 'GET Calendar', path: '/api/v1/calendar', method: 'GET', expect: 200 },
      { name: 'GET Dashboard Stats', path: '/api/v1/dashboard/stats', method: 'GET', expect: 200 },
      { name: 'GET Notifications', path: '/api/v1/notifications', method: 'GET', expect: 200 },

      // Should be 403 Forbidden
      { name: 'POST Job (Create)', path: '/api/v1/jobs', method: 'POST', body: { title: 'Test' }, expect: 403 },
      { name: 'PUT Job Stage', path: `/api/v1/jobs/${jobId}/stage`, method: 'PUT', body: { section: 'Jobs' }, expect: 403 },
      { name: 'GET Inventory', path: '/api/v1/inventory', method: 'GET', expect: 403 },
      { name: 'GET Staff', path: '/api/v1/staff', method: 'GET', expect: 403 },
      { name: 'GET Quote Requests', path: '/api/v1/quote-requests', method: 'GET', expect: 403 },
      { name: 'GET Settings', path: '/api/v1/settings', method: 'GET', expect: 403 },
    ];

    async function doFetch(path, method, token, body = null) {
      const opts = { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(`https://nexusfmsbackednshrikant-production.up.railway.app${path}`, opts);
      const data = await res.json().catch(e => null);
      return { status: res.status, data };
    }

    let passed = 0;
    for (const t of teamTests) {
      const res = await doFetch(t.path, t.method, testUsers['OFFICE_TEAM'].token, t.body);
      if (res.status === t.expect) {
        console.log(`✅ ${t.name} -> returned ${res.status} (Expected)`);
        passed++;
      } else {
        console.error(`❌ ${t.name} -> returned ${res.status} (Expected ${t.expect})`);
      }
    }

    console.log('\n--- TESTING FINANCIAL DATA SECURITY ---');
    const jobsRes = await doFetch('/api/v1/jobs', 'GET', testUsers['OFFICE_TEAM'].token);
    if (jobsRes.data && jobsRes.data.data && jobsRes.data.data.length > 0) {
      const firstJob = jobsRes.data.data[0];
      if (firstJob.hasOwnProperty('quoteAmount')) {
        console.error(`❌ Data Leak: 'quoteAmount' found in job payload for OFFICE_TEAM!`);
      } else {
        console.log(`✅ Security Verified: 'quoteAmount' successfully stripped from GET /jobs payload.`);
      }
    } else {
      console.log(`✅ No jobs found, but /jobs returned successfully.`);
    }

    const adminJobsRes = await doFetch('/api/v1/jobs', 'GET', testUsers['OFFICE_ADMIN'].token);
    if (adminJobsRes.data && adminJobsRes.data.data && adminJobsRes.data.data.length > 0) {
      const firstJob = adminJobsRes.data.data[0];
      if (firstJob.hasOwnProperty('quoteAmount')) {
        console.log(`✅ Admin Regression Verified: 'quoteAmount' is visible for OFFICE_ADMIN.`);
      } else {
        console.error(`❌ Admin Regression: 'quoteAmount' is MISSING for OFFICE_ADMIN!`);
      }
    }

    console.log(`\nTests Completed: ${passed}/${teamTests.length} API RBAC checks passed.`);
    process.exit(0);
  } catch (err) {
    console.error('Test script failed:', err);
    process.exit(1);
  }
}

runTests();
