const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5000;
const BASE_URL = `http://localhost:${PORT}/api/v1`;

function makeRequest(method, reqPath, body = null, token = null, isMultipart = false, multipartData = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${reqPath}`);
    const headers = {};

    if (token) headers['Authorization'] = `Bearer ${token}`;

    let payload = null;
    if (isMultipart && multipartData) {
      headers['Content-Type'] = `multipart/form-data; boundary=${multipartData.boundary}`;
      payload = multipartData.buffer;
    } else if (body) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const options = { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

function createMultipartBuffer(fieldName, fileName, mimeType, fileBuffer) {
  const boundary = `----WebKitFormBoundary${Math.random().toString(16).substring(2)}`;
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  return { boundary, buffer: Buffer.concat([Buffer.from(header, 'utf-8'), fileBuffer, Buffer.from(footer, 'utf-8')]) };
}

async function runPhase3GFinalAudit() {
  console.log('=======================================================');
  console.log('🛡️  Running Automated Master Audit Suite: Phase 3G');
  console.log('=======================================================');

  let passed = 0;
  const total = 12;

  let adminToken, staffAToken, staffBToken;
  let staffAProfileId, staffBProfileId;
  let jobAId, bookingToken;

  const testMonday = '2026-08-24'; // A working Monday

  try {
    // ── Setup ────────────────────────────────────────────────────────────────
    console.log('\n[SETUP] Admin login & creating test technicians...');
    const adminLogin = await makeRequest('POST', '/auth/login', { email: 'admin@nexusfms.com', password: 'Password123!' });
    adminToken = adminLogin.body.token;
    if (!adminToken) throw new Error('Admin login failed');

    const cA = await makeRequest('POST', '/staff', { full_name: 'Audit Tech A', email: 'staffA.audit@nexusfms.com', phone: '+15550001111', role_title: 'HVAC' }, adminToken);
    staffAProfileId = cA.body.data.profileId;

    const cB = await makeRequest('POST', '/staff', { full_name: 'Audit Tech B', email: 'staffB.audit@nexusfms.com', phone: '+15550002222', role_title: 'Electrician' }, adminToken);
    staffBProfileId = cB.body.data.profileId;

    staffAToken = (await makeRequest('POST', '/auth/login', { email: 'staffA.audit@nexusfms.com', password: 'Password123!' })).body.token;
    staffBToken = (await makeRequest('POST', '/auth/login', { email: 'staffB.audit@nexusfms.com', password: 'Password123!' })).body.token;

    // Create test work order (3 hour job assigned to Staff A)
    const cJob = await makeRequest('POST', '/jobs', { title: 'Audit HVAC Overhaul', resident_name: 'Audit Resident', contact_phone: '+15559999999', property_address: '400 Audit St', assigned_staff_id: staffAProfileId, duration_hours: 3.0, section: 'Jobs Waiting Booking' }, adminToken);
    jobAId = cJob.body.data.id;

    const genLink = await makeRequest('POST', `/public/jobs/${jobAId}/generate-link`, { type: 'BOOKING' }, adminToken);
    bookingToken = genLink.body.data.secureToken;

    console.log(`  Setup complete. Staff A Profile: ${staffAProfileId}, Job: ${jobAId}`);

    // ── Test 1: Authentication & /auth/me validation ──────────────────────────
    console.log('\n[Test 1/12] Authentication — /auth/me returns actual MySQL record...');
    const meRes = await makeRequest('GET', '/auth/me', null, adminToken);
    const meNoToken = await makeRequest('GET', '/auth/me', null, null);
    const meBadToken = await makeRequest('GET', '/auth/me', null, 'bearer_garbage_token');

    if (meRes.body.user && meRes.body.user.email === 'admin@nexusfms.com' && meNoToken.status === 401 && meBadToken.status === 401) {
      console.log(`  ✅ Auth /me PASSED! email=${meRes.body.user.email}, no-token=401, bad-token=401`);
      passed++;
    } else {
      console.error('  ❌ Auth /me FAILED', { meEmail: meRes.body.user?.email, noToken: meNoToken.status, badToken: meBadToken.status });
    }

    // ── Test 2: Dynamic Job Duration Slot Calculation (1.0h, 1.5h, 3.0h) ─────
    console.log('\n[Test 2/12] Calendar — Dynamic duration slot calculation (3h job, working Monday)...');
    const slots = await makeRequest('GET', `/public/booking/${bookingToken}/available-slots?date=${testMonday}`);
    const slotList = slots.body.availability ? slots.body.availability.availableSlots : [];
    const sunday = await makeRequest('GET', `/public/booking/${bookingToken}/available-slots?date=2026-08-23`);
    const sundaySlots = sunday.body.availability ? sunday.body.availability.availableSlots : ['err'];

    if (slots.status === 200 && slotList.length > 0 && slots.body.durationHours === 3.0 && sundaySlots.length === 0) {
      console.log(`  ✅ Duration Slot Calc PASSED! Slots (3h) on Monday: ${slotList.length}, Sample: ${slotList[0].timeSlot}, Sunday: 0 slots`);
      passed++;
    } else {
      console.error('  ❌ Duration Slot Calc FAILED', { slotsLen: slotList.length, dur: slots.body.durationHours, sunday: sundaySlots.length });
    }

    // ── Test 3: Break-time exclusion ──────────────────────────────────────────
    console.log('\n[Test 3/12] Calendar — Break-time slots excluded (12:00–13:00 break)...');
    const breakOverlap = slotList.filter(s => {
      const sm = parseInt(s.startTime.split(':')[0], 10) * 60 + parseInt(s.startTime.split(':')[1], 10);
      const em = sm + 3 * 60;
      return sm < 13 * 60 && em > 12 * 60;
    });

    if (breakOverlap.length === 0) {
      console.log('  ✅ Break-time Exclusion PASSED! No 3h slot crosses the 12:00–13:00 break window.');
      passed++;
    } else {
      console.error('  ❌ Break-time Exclusion FAILED. Overlapping slots:', breakOverlap);
    }

    // ── Test 4: Concurrent Race-Condition Double Booking ─────────────────────
    console.log('\n[Test 4/12] Double-Booking — Concurrent conflicting booking race condition...');
    const targetSlot = slotList[0].timeSlot; // e.g. "08:00 - 11:00"
    const [r1, r2] = await Promise.all([
      makeRequest('POST', `/public/booking/${bookingToken}/confirm`, { booking_date: testMonday, time_slot: targetSlot }),
      makeRequest('POST', `/public/booking/${bookingToken}/confirm`, { booking_date: testMonday, time_slot: targetSlot }),
    ]);
    const sortedStatuses = [r1.status, r2.status].sort();

    if (sortedStatuses[0] === 200 && sortedStatuses[1] === 400) {
      console.log(`  ✅ Race-Condition Protection PASSED! One confirmed (200), one rejected (400).`);
      passed++;
    } else {
      console.error(`  ❌ Race-Condition Protection FAILED. Statuses: ${r1.status}, ${r2.status}`);
    }

    // ── Test 5: Token security (invalid / mismatched type) ───────────────────
    console.log('\n[Test 5/12] Token Security — Invalid token & wrong-type token tests...');
    const invalidTok = await makeRequest('GET', '/public/booking/TOTALLY_FAKE_TOKEN/available-slots?date=2026-08-24');
    const quoteUploadWithBookTok = await makeRequest('POST', `/public/quote-request/${bookingToken}/upload`, { resident_notes: 'x' });
    const deletedJobTok = await makeRequest('GET', `/public/request/TOK_NONEXISTENT_JOB`);

    if (invalidTok.status === 404 && quoteUploadWithBookTok.status === 404 && deletedJobTok.status === 404) {
      console.log('  ✅ Token Security PASSED! All invalid/mismatched tokens → HTTP 404.');
      passed++;
    } else {
      console.error('  ❌ Token Security FAILED', { invalidTok: invalidTok.status, wrongType: quoteUploadWithBookTok.status, deleted: deletedJobTok.status });
    }

    // ── Test 6: Staff ownership — Staff A cannot access Staff B's job ─────────
    console.log('\n[Test 6/12] RBAC Ownership — Staff A cannot view/modify Staff B job...');
    const jobB = await makeRequest('POST', '/jobs', { title: 'Staff B Elec Job', resident_name: 'B Resident', contact_phone: '+15558887777', property_address: '200 B St', assigned_staff_id: staffBProfileId, section: 'Jobs' }, adminToken);
    const jobBId = jobB.body.data.id;

    const viewBFromA = await makeRequest('GET', `/staff/my-jobs/${jobBId}`, null, staffAToken);
    const reportBFromA = await makeRequest('POST', `/staff/jobs/${jobBId}/report`, { work_performed: 'Hack' }, staffAToken);

    // Use valid JPEG so MIME check passes, ownership check (403) fires
    const validJpegCross = Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0x01,0x01,0x00,0x60,0x00,0x60,0x00,0x00,0xff,0xd9]);
    const mpCross = createMultipartBuffer('photos', 'proof.jpeg', 'image/jpeg', validJpegCross);
    const photoBFromA = await makeRequest('POST', `/staff/jobs/${jobBId}/photos`, null, staffAToken, true, mpCross);

    await makeRequest('DELETE', `/jobs/${jobBId}`, null, adminToken); // cleanup

    if (viewBFromA.status === 403 && reportBFromA.status === 403 && photoBFromA.status === 403) {
      console.log('  ✅ Staff RBAC Ownership PASSED! All cross-staff actions returned HTTP 403.');
      passed++;
    } else {
      console.error('  ❌ Staff RBAC Ownership FAILED', { view: viewBFromA.status, report: reportBFromA.status, photo: photoBFromA.status });
    }

    // ── Test 7: Upload security (invalid MIME rejection) ──────────────────────
    console.log('\n[Test 7/12] Upload Security — Invalid MIME type rejection...');
    const exeBuf = Buffer.from('#!/bin/sh\nrm -rf /', 'utf-8');
    const badMp = createMultipartBuffer('photos', 'evil.sh', 'application/x-sh', exeBuf);
    const badUpload = await makeRequest('POST', `/staff/jobs/${jobAId}/photos`, null, staffAToken, true, badMp);

    // verify no orphan file left
    const uploadsDir = path.join(__dirname, 'uploads');
    const orphans = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).filter(f => f.endsWith('.sh')) : [];

    if (badUpload.status === 400 && !badUpload.body.success && orphans.length === 0) {
      console.log(`  ✅ Upload Security PASSED! .sh file rejected (HTTP 400), 0 orphan files on disk.`);
      passed++;
    } else {
      console.error('  ❌ Upload Security FAILED', { status: badUpload.status, orphans });
    }

    // ── Test 8: Mandatory completion requirements (report + photo) ────────────
    console.log('\n[Test 8/12] Completion Requirements — Report + Photo both required...');
    // Submit report but NO photo, try to complete
    await makeRequest('POST', `/staff/jobs/${jobAId}/report`, { work_performed: 'Audit work report complete' }, staffAToken);
    const completeNoPhoto = await makeRequest('PUT', `/staff/jobs/${jobAId}/complete`, null, staffAToken);

    // Now upload a valid JPEG and try again
    const jpegBuf = Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0x01,0x01,0x00,0x60,0x00,0x60,0x00,0x00,0xff,0xd9]);
    const goodMp = createMultipartBuffer('photos', 'proof.jpeg', 'image/jpeg', jpegBuf);
    await makeRequest('POST', `/staff/jobs/${jobAId}/photos`, null, staffAToken, true, goodMp);
    const completeWithPhoto = await makeRequest('PUT', `/staff/jobs/${jobAId}/complete`, null, staffAToken);

    if (completeNoPhoto.status === 400 && completeWithPhoto.status === 200 && completeWithPhoto.body.data.section === 'Completed Jobs') {
      console.log(`  ✅ Completion Requirements PASSED! No-photo → 400, With-photo → 200, Stage: ${completeWithPhoto.body.data.section}`);
      passed++;
    } else {
      console.error('  ❌ Completion Requirements FAILED', { noPhoto: completeNoPhoto.status, withPhoto: completeWithPhoto.status });
    }

    // ── Test 9: Admin retrieves evidence; Staff B blocked ────────────────────
    console.log('\n[Test 9/12] Evidence Retrieval — Admin reads evidence, Staff B blocked...');
    const adminEvidence = await makeRequest('GET', `/jobs/${jobAId}/completion-evidence`, null, adminToken);
    const staffBEvidence = await makeRequest('GET', `/jobs/${jobAId}/completion-evidence`, null, staffBToken);

    if (adminEvidence.status === 200 && adminEvidence.body.data.report && adminEvidence.body.data.photos.length > 0 && staffBEvidence.status === 403) {
      console.log(`  ✅ Evidence RBAC PASSED! Admin sees report+${adminEvidence.body.data.photos.length} photo(s). Staff B: 403.`);
      passed++;
    } else {
      console.error('  ❌ Evidence RBAC FAILED', { adminStatus: adminEvidence.status, staffBStatus: staffBEvidence.status });
    }

    // ── Test 10: Public Quote upload does NOT move stage ─────────────────────
    console.log('\n[Test 10/12] Quote Workflow — Resident upload keeps stage in Quotes...');
    const quoteJob = await makeRequest('POST', '/jobs', { title: 'Quote Workflow Test', resident_name: 'Quote Resident', contact_phone: '+15557776666', property_address: '300 Quote Ave', section: 'Quotes' }, adminToken);
    const quoteJobId = quoteJob.body.data.id;
    const qLink = await makeRequest('POST', `/public/jobs/${quoteJobId}/generate-link`, { type: 'QUOTE_UPLOAD' }, adminToken);
    const qTok = qLink.body.data.secureToken;
    await makeRequest('POST', `/public/quote-request/${qTok}/upload`, { resident_notes: 'My AC is broken.' });
    const quoteAfterUpload = await makeRequest('GET', `/jobs/${quoteJobId}`, null, adminToken);
    await makeRequest('DELETE', `/jobs/${quoteJobId}`, null, adminToken);

    if (quoteAfterUpload.body.data.section === 'Quotes') {
      console.log(`  ✅ Quote Stage Regression PASSED! Stage remains 'Quotes' after resident upload.`);
      passed++;
    } else {
      console.error(`  ❌ Quote Stage Regression FAILED. Stage: ${quoteAfterUpload.body.data.section}`);
    }

    // ── Test 11: Calendar RBAC & dynamic staff count ──────────────────────────
    console.log('\n[Test 11/12] Calendar RBAC — Staff A cannot query Staff B calendar...');
    const adminCal = await makeRequest('GET', '/calendar', null, adminToken);
    const staffACal = await makeRequest('GET', '/calendar', null, staffAToken);
    const staffAQueryB = await makeRequest('GET', `/calendar?staffId=${staffBProfileId}`, null, staffAToken);

    if (adminCal.status === 200 && adminCal.body.staffCount >= 2 && staffACal.status === 200 && staffAQueryB.status === 403) {
      console.log(`  ✅ Calendar RBAC PASSED! Admin staffCount=${adminCal.body.staffCount}, Staff A own calendar OK, cross-staff → 403`);
      passed++;
    } else {
      console.error('  ❌ Calendar RBAC FAILED', { adminStatus: adminCal.status, staffCount: adminCal.body.staffCount, crossStaff: staffAQueryB.status });
    }

    // ── Test 12: Final teardown ───────────────────────────────────────────────
    console.log('\n[Test 12/12] Final Teardown — Deleting all test entities & uploaded files...');
    let ok = true;

    const dJob = await makeRequest('DELETE', `/jobs/${jobAId}`, null, adminToken);
    if (dJob.status !== 200) ok = false;

    const dA = await makeRequest('DELETE', `/staff/${staffAProfileId}`, null, adminToken);
    if (dA.status !== 200) ok = false;

    const dB = await makeRequest('DELETE', `/staff/${staffBProfileId}`, null, adminToken);
    if (dB.status !== 200) ok = false;

    // Wipe uploads dir of test files
    if (fs.existsSync(uploadsDir)) {
      fs.readdirSync(uploadsDir).forEach(f => {
        if (f.startsWith('proof-') || f.startsWith('file-')) fs.unlinkSync(path.join(uploadsDir, f));
      });
    }

    if (ok) {
      console.log('  ✅ Teardown PASSED! All temporary entities and uploaded files removed.');
      passed++;
    } else {
      console.error('  ❌ Teardown FAILED.');
    }

    console.log('\n=======================================================');
    if (passed === total) {
      console.log(`🎉 [ALL PHASE 3G AUDIT CHECKS PASSED] (${passed}/${total})`);
    } else {
      console.error(`❌ [SOME AUDIT CHECKS FAILED] (${passed}/${total})`);
    }
    console.log('=======================================================');

  } catch (err) {
    console.error('\n❌ Audit Execution Error:', err.message);
    console.error(err.stack);
  }
}

runPhase3GFinalAudit();
