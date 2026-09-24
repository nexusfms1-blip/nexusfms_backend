require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const { pool } = require('./config/db');
const { runPhotoReminderJob } = require('./scheduler/photoReminderJob');

const BASE_URL = process.env.VITE_API_URL || 'https://nexusfmsbackednshrikant-production.up.railway.app/api/v1';

async function runPhase7Tests() {
  console.log("=== STARTING PHASE 7 TESTS ===");
  let adminToken;
  let testJobId;
  let secureToken;

  try {
    // 1. Login as Admin
    const loginRes = await axios.post(`${BASE_URL}/auth/login`, {
      email: 'test_office_admin@nexus.com',
      password: 'password123'
    });
    adminToken = loginRes.data.token;
    console.log("✅ Admin logged in");

    // 2. Create Job in Quotes Stage
    const jobData = {
      title: 'Phase 7 Test Job',
      tenantId: 32,
      tenantName: 'Test Tenant',
      contactPhone: '1234567890',
      address: '123 Phase 7 Ave',
      description: 'Needs quoting',
      section: 'Quotes'
    };
    const createJobRes = await axios.post(`${BASE_URL}/jobs`, jobData, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    testJobId = createJobRes.data.data.id;
    console.log(`✅ Job created in Quotes stage (ID: ${testJobId})`);

    // 3. Verify Auto Quote Request Creation
    const [qrRows] = await pool.query('SELECT secure_token, status, photo_reminder_count FROM quote_requests WHERE work_order_id = ?', [testJobId]);
    if (qrRows.length === 0) throw new Error("Auto quote request was not created!");
    secureToken = qrRows[0].secure_token;
    console.log(`✅ Auto quote request generated (Token: ${secureToken.substring(0, 8)}...)`);

    // 4. Test Public Upload
    fs.writeFileSync('dummy7.jpg', 'fake image data');
    const form = new FormData();
    form.append('userNotes', 'Here are the photos');
    form.append('mediaFiles', fs.createReadStream('dummy7.jpg'));

    console.log("Submitting public photo upload...");
    const uploadRes = await axios.post(`${BASE_URL}/public/quote-request/${secureToken}/upload`, form, {
      headers: { ...form.getHeaders() }
    });
    if (!uploadRes.data.success) throw new Error("Public upload failed!");
    console.log("✅ Public upload succeeded");

    // 5. Verify State Changes (COMPLETED and Completed Quotes)
    const [checkQr] = await pool.query('SELECT status FROM quote_requests WHERE work_order_id = ?', [testJobId]);
    if (checkQr[0].status !== 'COMPLETED') throw new Error(`QR status is ${checkQr[0].status}, expected COMPLETED`);
    console.log("✅ quote_requests status updated to COMPLETED");

    const [checkJob] = await pool.query('SELECT pipeline_stage FROM work_orders WHERE id = ?', [testJobId]);
    if (checkJob[0].pipeline_stage !== 'Completed Quotes') throw new Error(`Job stage is ${checkJob[0].pipeline_stage}, expected Completed Quotes`);
    console.log("✅ work_orders stage updated to Completed Quotes");

    // 6. Test Scheduler Limits
    console.log("Testing scheduler with mocked dates...");

    let mockJobId;
    try {
      const mockJobNumber = 'JOB-TEST-' + Math.floor(Math.random() * 1000000);
      const mockToken = 'dummy_tok_' + Math.random().toString(36).substring(2) + Date.now();
      const [mockJobRes] = await pool.query(
        "INSERT INTO work_orders (job_number, title, pipeline_stage, resident_name, contact_phone, property_address, secure_token) VALUES (?, 'Mock Schedule Test', 'Quotes', 'Mock Resident', '123', 'Mock Address', ?)",
        [mockJobNumber, mockToken]
      );
      mockJobId = mockJobRes.insertId;
      console.log('✅ Mock Job created (ID: ' + mockJobId + ')');
    } catch (err) {
      throw new Error("Failed to insert mock job: " + err.message);
    }

    // Insert pending QR created 4 days ago
    try {
      const pastDateStr = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      const futureDateStr = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      await pool.query(
        "INSERT INTO quote_requests (work_order_id, secure_token, status, created_at, expires_at, photo_reminder_count) VALUES (?, ?, 'PENDING', ?, ?, 0)",
        [mockJobId, 'mock_tok_123', pastDateStr, futureDateStr]
      );
      console.log('✅ Mock Quote Request inserted');
    } catch (err) {
      throw new Error("Failed to insert mock quote request: " + err.message);
    }

    // Run scheduler
    await runPhotoReminderJob();

    // Verify reminder count incremented
    const [mockQrRes1] = await pool.query("SELECT photo_reminder_count, last_photo_reminder_at FROM quote_requests WHERE work_order_id = ?", [mockJobId]);
    if (mockQrRes1[0].photo_reminder_count !== 1) throw new Error("Scheduler failed to send first reminder");
    console.log("✅ Scheduler correctly sent first reminder for 4-day old request");

    // Run scheduler again immediately (should NOT send because <72h since last reminder)
    await runPhotoReminderJob();
    const [mockQrRes2] = await pool.query("SELECT photo_reminder_count FROM quote_requests WHERE work_order_id = ?", [mockJobId]);
    if (mockQrRes2[0].photo_reminder_count !== 1) throw new Error("Scheduler incorrectly sent duplicate reminder within 72h window");
    console.log("✅ Scheduler correctly blocked duplicate reminder inside 72-hour window");

    console.log("🎉 ALL PHASE 7 TESTS PASSED SUCCESSFULLY");

  } catch (err) {
    console.error("❌ TEST FAILED:", err.message);
    if (err.response) console.error(err.response.data);
    process.exit(1);
  } finally {
    if (fs.existsSync('dummy7.jpg')) fs.unlinkSync('dummy7.jpg');
    process.exit(0);
  }
}

runPhase7Tests();
