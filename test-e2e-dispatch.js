const { pool } = require('./config/db');
const request = require('supertest');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'nexus_super_secret_key_2025';

async function runDispatchE2E() {
  console.log('--- E2E AUDIT: APPOINTMENT RESCHEDULING ---');
  try {
    const adminToken = jwt.sign({ id: 1, role: 'OFFICE_ADMIN', email: 'admin@nexus.com' }, JWT_SECRET, { expiresIn: '1h' });

    // We already have test_office_team from test-rbac.js, let's fetch it
    const [teamRows] = await pool.query("SELECT id, role, email FROM users WHERE role = 'OFFICE_TEAM' LIMIT 1");
    if (teamRows.length === 0) throw new Error("No office team user found");
    const teamUser = teamRows[0];
    const teamToken = jwt.sign({ id: teamUser.id, role: teamUser.role, email: teamUser.email }, JWT_SECRET, { expiresIn: '1h' });

    // Fetch a staff member
    const [staffRows] = await pool.query("SELECT id FROM users WHERE role = 'MAINTENANCE_STAFF' LIMIT 1");
    if (staffRows.length === 0) throw new Error("No staff user found");
    const staffId = staffRows[0].id;

    async function doFetch(path, method, token, body = null) {
      const opts = { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(`https://nexusfmsbackednshrikant-production.up.railway.app${path}`, opts);
      const data = await res.json().catch(e => null);
      return { status: res.status, data };
    }

    const createRes = await doFetch('/api/v1/jobs', 'POST', adminToken, {
      title: 'E2E Test Job',
      property_address: '123 Test St',
      duration_hours: 2,
      resident_name: 'Test Resident',
      section: 'Jobs Waiting Booking'
    });
    console.log("Create Res 1:", createRes.status, createRes.data);
    if (!createRes.data || !createRes.data.data) throw new Error("Failed to create job 1");
    const jobId = createRes.data.data.id;

    // TEST 4: Dispatch job as OFFICE_TEAM
    console.log(`\n4. Dispatching Job ${jobId} to Staff ${staffId}...`);
    const dispatchPayload = {
      jobId: jobId,
      staffId: staffId,
      date: '2030-10-15',
      timeSlot: '09:00 AM'
    };

    const dispatchRes = await doFetch('/api/v1/calendar/dispatch', 'POST', teamToken, dispatchPayload);

    if (dispatchRes.status === 200) {
      console.log('✅ API returned 200 Success.');
    } else {
      console.error('❌ API failed:', dispatchRes.status, dispatchRes.data);
    }

    // Verify DB
    const [updatedJob] = await pool.query(`SELECT scheduled_date, scheduled_time_slot, assigned_staff_id, pipeline_stage FROM work_orders WHERE id = ?`, [jobId]);
    if (updatedJob[0].scheduled_date === '2030-10-15' && updatedJob[0].scheduled_time_slot === '09:00 AM' && updatedJob[0].pipeline_stage === 'Jobs') {
      console.log('✅ Database correctly updated (date, time, pipeline_stage moved to "Jobs")');
    } else {
      console.error('❌ Database update mismatch:', updatedJob[0]);
    }

    // TEST 5: Invalid Scheduling (Double Booking)
    console.log(`\n5. Testing Invalid Scheduling (Double Booking)...`);
    const createRes2 = await doFetch('/api/v1/jobs', 'POST', adminToken, {
      title: 'E2E Test Job 2',
      property_address: '456 Test St',
      duration_hours: 2,
      resident_name: 'Test Resident 2',
      section: 'Jobs Waiting Booking'
    });
    console.log("Create Res 2:", createRes2.status, createRes2.data);
    if (!createRes2.data || !createRes2.data.data) throw new Error("Failed to create job 2");
    const jobId2 = createRes2.data.data.id;

    // Try to book at exactly the same time for the same staff
    const conflictRes = await doFetch('/api/v1/calendar/dispatch', 'POST', teamToken, {
      jobId: jobId2,
      staffId: staffId,
      date: '2030-10-15',
      timeSlot: '10:00 AM' // Overlaps with 09:00 AM since duration is 2 hours!
    });

    if (conflictRes.status !== 200) {
      console.log(`✅ API correctly rejected conflict with status ${conflictRes.status} (${conflictRes.data.message})`);
    } else {
      console.error('❌ API incorrectly allowed double booking!', conflictRes.data);
    }

    // Verify job2 was not updated
    const [checkJob2] = await pool.query(`SELECT scheduled_date FROM work_orders WHERE id = ?`, [jobId2]);
    if (!checkJob2[0].scheduled_date) {
      console.log('✅ Database correctly prevented modification of overlapping job.');
    } else {
      console.error('❌ Database incorrectly updated job2.');
    }

    // Cleanup
    await pool.query('DELETE FROM work_orders WHERE id IN (?, ?)', [jobId, jobId2]);
    console.log('\n✅ Cleanup complete.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

runDispatchE2E();
