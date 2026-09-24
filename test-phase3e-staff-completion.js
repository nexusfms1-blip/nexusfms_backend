const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5000;
const BASE_URL = `http://localhost:${PORT}/api/v1`;

function makeRequest(method, reqPath, body = null, token = null, isMultipart = false, multipartData = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${reqPath}`);
    const headers = {};

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    let payload = null;

    if (isMultipart && multipartData) {
      headers['Content-Type'] = `multipart/form-data; boundary=${multipartData.boundary}`;
      payload = multipartData.buffer;
    } else if (body) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
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

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function createMultipartBuffer(fieldName, fileName, mimeType, fileBuffer) {
  const boundary = `----WebKitFormBoundary${Math.random().toString(16).substring(2)}`;
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;

  const headBuf = Buffer.from(header, 'utf-8');
  const footBuf = Buffer.from(footer, 'utf-8');

  return {
    boundary,
    buffer: Buffer.concat([headBuf, fileBuffer, footBuf]),
  };
}

async function runPhase3EFinalVerification() {
  console.log('=======================================================');
  console.log('🛠️ Running Final Phase 3E & Upload Security Test Suite');
  console.log('=======================================================');

  let passedTests = 0;
  let totalTests = 12;

  let adminToken = null;
  let staffAToken = null;
  let staffBToken = null;

  let staffAObj = null;
  let staffBObj = null;
  let jobAId = null;
  let jobBId = null;
  let uploadedFilePathOnDisk = null;

  try {
    // Setup 1: Admin Login
    const adminLogin = await makeRequest('POST', '/auth/login', { email: 'admin@nexusfms.com', password: 'Password123!' });
    adminToken = adminLogin.body.token;

    // Setup 2: Create Staff A and Staff B
    console.log('\n[Setup] Creating Temporary Staff A & Staff B...');
    const createStaffA = await makeRequest('POST', '/staff', {
      full_name: 'Technician Staff A Final',
      email: 'staffA.final@nexusfms.com',
      phone: '+1 (555) 999-A111',
      role_title: 'HVAC Specialist',
    }, adminToken);
    staffAObj = createStaffA.body.data;

    const createStaffB = await makeRequest('POST', '/staff', {
      full_name: 'Technician Staff B Final',
      email: 'staffB.final@nexusfms.com',
      phone: '+1 (555) 999-B222',
      role_title: 'Plumbing Specialist',
    }, adminToken);
    staffBObj = createStaffB.body.data;

    // Login as Staff A & Staff B
    const loginA = await makeRequest('POST', '/auth/login', { email: 'staffA.final@nexusfms.com', password: 'Password123!' });
    staffAToken = loginA.body.token;

    const loginB = await makeRequest('POST', '/auth/login', { email: 'staffB.final@nexusfms.com', password: 'Password123!' });
    staffBToken = loginB.body.token;

    // Setup 3: Create Job A (assigned to Staff A) and Job B (assigned to Staff B)
    const createJobA = await makeRequest('POST', '/jobs', {
      title: 'AC Compressor Relay Replacement',
      resident_name: 'Resident Alpha',
      contact_phone: '+1 (555) 111-9999',
      property_address: '100 Alpha St, Apt 1',
      assigned_staff_id: staffAObj.profileId,
      section: 'Jobs',
    }, adminToken);
    jobAId = createJobA.body.data.id;

    const createJobB = await makeRequest('POST', '/jobs', {
      title: 'Sink Main Line Unclogging',
      resident_name: 'Resident Beta',
      contact_phone: '+1 (555) 222-9999',
      property_address: '200 Beta St, Apt 2',
      assigned_staff_id: staffBObj.profileId,
      section: 'Jobs',
    }, adminToken);
    jobBId = createJobB.body.data.id;

    // Test 1: Staff A lists own assigned jobs
    console.log('\n[Test 1/12] Staff A listing own assigned jobs...');
    const getMyJobsRes = await makeRequest('GET', '/staff/my-jobs', null, staffAToken);

    if (getMyJobsRes.status === 200 && getMyJobsRes.body.count === 1 && getMyJobsRes.body.data[0].id === jobAId) {
      console.log('  ✅ Staff List Assigned Jobs PASSED! Found assigned Job A.');
      passedTests++;
    } else {
      console.error('  ❌ Staff List Assigned Jobs FAILED:', getMyJobsRes.body);
    }

    // Test 2: Staff A blocked from accessing Staff B's assigned job
    console.log('\n[Test 2/12] Staff A attempting to view Staff B assigned Job B...');
    const getOtherJobRes = await makeRequest('GET', `/staff/my-jobs/${jobBId}`, null, staffAToken);

    if (getOtherJobRes.status === 403 && !getOtherJobRes.body.success) {
      console.log('  ✅ Unauthorized Job Access BLOCKED (HTTP 403 Forbidden):', getOtherJobRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Unauthorized Job Access FAILED:', getOtherJobRes.body);
    }

    // Test 3: Empty work report submission rejected
    console.log('\n[Test 3/12] Staff A submitting empty work report...');
    const emptyReportRes = await makeRequest('POST', `/staff/jobs/${jobAId}/report`, {
      work_performed: '',
    }, staffAToken);

    if (emptyReportRes.status === 400 && !emptyReportRes.body.success) {
      console.log('  ✅ Empty Report Validation PASSED! Message:', emptyReportRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Empty Report Validation FAILED:', emptyReportRes.body);
    }

    // Test 4: Staff A submits valid work report for Job A
    console.log('\n[Test 4/12] Staff A submitting valid work report for Job A...');
    const submitReportRes = await makeRequest('POST', `/staff/jobs/${jobAId}/report`, {
      work_performed: 'Replaced relay switch and recharged refrigerant R410A.',
      materials_used: '1x Relay Switch, 2lbs Refrigerant',
    }, staffAToken);

    if (submitReportRes.status === 200 && submitReportRes.body.success && submitReportRes.body.data.id) {
      console.log('  ✅ Submit Work Report PASSED! Report ID:', submitReportRes.body.data.id);
      passedTests++;
    } else {
      console.error('  ❌ Submit Work Report FAILED:', submitReportRes.body);
    }

    // Test 5: Invalid File Type Upload Rejection (.txt file)
    console.log('\n[Test 5/12] Upload Security Check: Attempting to upload invalid .txt file...');
    const invalidFileBuf = Buffer.from('console.log("Malicious Executable Script");', 'utf-8');
    const invalidMultipart = createMultipartBuffer('photos', 'malicious.txt', 'text/plain', invalidFileBuf);
    const invalidUploadRes = await makeRequest('POST', `/staff/jobs/${jobAId}/photos`, null, staffAToken, true, invalidMultipart);

    if (invalidUploadRes.status === 400 && !invalidUploadRes.body.success) {
      console.log('  ✅ Invalid File Type Upload BLOCKED (HTTP 400):', invalidUploadRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Invalid File Upload Security FAILED:', invalidUploadRes.body);
    }

    // Test 6: Valid JPEG Photo Upload
    console.log('\n[Test 6/12] Uploading valid JPEG proof photo for Job A...');
    // Small valid JPEG buffer header
    const jpegBuffer = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60,
      0x00, 0x60, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
      0xff, 0xd9
    ]);
    const validMultipart = createMultipartBuffer('photos', 'proof_photo.jpeg', 'image/jpeg', jpegBuffer);
    const validUploadRes = await makeRequest('POST', `/staff/jobs/${jobAId}/photos`, null, staffAToken, true, validMultipart);

    if (validUploadRes.status === 200 && validUploadRes.body.success && validUploadRes.body.data.photosUploaded === 1) {
      const photoObj = validUploadRes.body.data.photos[0];
      uploadedFilePathOnDisk = path.join(__dirname, photoObj.filePath);
      console.log('  ✅ Valid JPEG Photo Upload PASSED!');
      console.log('     - Photo ID:', photoObj.id);
      console.log('     - Generated File Path:', photoObj.filePath);
      console.log('     - MIME Type:', photoObj.mimeType);
      passedTests++;
    } else {
      console.error('  ❌ Valid Photo Upload FAILED:', validUploadRes.body);
    }

    // Test 7: Unauthorized Photo Upload (Staff A uploading to Staff B's Job B)
    console.log('\n[Test 7/12] Staff A attempting to upload completion photo to Staff B Job B...');
    const unauthUploadRes = await makeRequest('POST', `/staff/jobs/${jobBId}/photos`, null, staffAToken, true, validMultipart);

    if (unauthUploadRes.status === 403 && !unauthUploadRes.body.success) {
      console.log('  ✅ Unauthorized Photo Upload BLOCKED (HTTP 403 Forbidden):', unauthUploadRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Unauthorized Photo Upload FAILED:', unauthUploadRes.body);
    }

    // Test 8: Explicit Job Completion Action (Staff A completes Job A)
    console.log('\n[Test 8/12] Staff A explicitly marking Job A as complete...');
    const completeJobRes = await makeRequest('PUT', `/staff/jobs/${jobAId}/complete`, null, staffAToken);

    if (completeJobRes.status === 200 && completeJobRes.body.success && completeJobRes.body.data.section === 'Completed Jobs') {
      console.log('  ✅ Explicit Job Completion PASSED! Pipeline stage:', completeJobRes.body.data.section);
      passedTests++;
    } else {
      console.error('  ❌ Explicit Job Completion FAILED:', completeJobRes.body);
    }

    // Test 9: Admin retrieves completion evidence for Job A
    console.log('\n[Test 9/12] Admin retrieving completion evidence for Job A...');
    const evidenceRes = await makeRequest('GET', `/jobs/${jobAId}/completion-evidence`, null, adminToken);

    if (evidenceRes.status === 200 && evidenceRes.body.success && evidenceRes.body.data.photos.length > 0) {
      console.log('  ✅ Retrieve Completion Evidence PASSED!');
      console.log('     - Report Summary:', evidenceRes.body.data.report.workReportSummary);
      console.log('     - Proof Photos Count:', evidenceRes.body.data.photos.length);
      console.log('     - Photo URL:', evidenceRes.body.data.photos[0].filePath);
      passedTests++;
    } else {
      console.error('  ❌ Retrieve Completion Evidence FAILED:', evidenceRes.body);
    }

    // Test 10: Staff B blocked from viewing Staff A's completion evidence
    console.log('\n[Test 10/12] Staff B attempting to view Staff A completion evidence...');
    const staffBEvidenceRes = await makeRequest('GET', `/jobs/${jobAId}/completion-evidence`, null, staffBToken);

    if (staffBEvidenceRes.status === 403 && !staffBEvidenceRes.body.success) {
      console.log('  ✅ Unauthorized Evidence Access BLOCKED (HTTP 403 Forbidden):', staffBEvidenceRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Unauthorized Evidence Access FAILED:', staffBEvidenceRes.body);
    }

    // Test 11: Phase 3D Regression Check (Public Resident upload leaves stage in Quotes)
    console.log('\n[Test 11/12] Phase 3D Regression Check: Public Resident upload keeps stage in Quotes...');
    const genQuoteLinkRes = await makeRequest('POST', `/public/jobs/${jobBId}/generate-link`, { type: 'QUOTE_UPLOAD' }, adminToken);
    const qToken = genQuoteLinkRes.body.data.secureToken;

    const publicUploadRes = await makeRequest('POST', `/public/quote-request/${qToken}/upload`, {
      resident_notes: 'Public resident notes check.',
    });

    const getJobBRes = await makeRequest('GET', `/jobs/${jobBId}`, null, adminToken);

    if (publicUploadRes.status === 200 && getJobBRes.body.data.section === 'Quotes') {
      console.log('  ✅ Phase 3D Regression Check PASSED! Work order remains in Quotes stage.');
      passedTests++;
    } else {
      console.error('  ❌ Phase 3D Regression Check FAILED:', getJobBRes.body);
    }

    // Test 12: Teardown & Clean up all test entities and disk files
    console.log('\n[Test 12/12] Cleaning up all test entities and uploaded test files...');
    let cleanupSuccess = true;

    if (jobAId) {
      const delA = await makeRequest('DELETE', `/jobs/${jobAId}`, null, adminToken);
      if (delA.status !== 200) cleanupSuccess = false;
    }

    if (jobBId) {
      const delB = await makeRequest('DELETE', `/jobs/${jobBId}`, null, adminToken);
      if (delB.status !== 200) cleanupSuccess = false;
    }

    if (staffAObj) {
      const delStaffA = await makeRequest('DELETE', `/staff/${staffAObj.profileId}`, null, adminToken);
      if (delStaffA.status !== 200) cleanupSuccess = false;
    }

    if (staffBObj) {
      const delStaffB = await makeRequest('DELETE', `/staff/${staffBObj.profileId}`, null, adminToken);
      if (delStaffB.status !== 200) cleanupSuccess = false;
    }

    // Delete uploaded proof photo file from disk if present
    const uploadsDir = path.join(__dirname, 'uploads');
    if (fs.existsSync(uploadsDir)) {
      const filesOnDisk = fs.readdirSync(uploadsDir);
      for (const f of filesOnDisk) {
        if (f.startsWith('proof-') || f.startsWith('file-')) {
          fs.unlinkSync(path.join(uploadsDir, f));
        }
      }
    }

    if (cleanupSuccess) {
      console.log('  ✅ Teardown PASSED! All temporary test records and uploaded files removed cleanly.');
      passedTests++;
    } else {
      console.error('  ❌ Teardown FAILED.');
    }

    console.log('\n=======================================================');
    if (passedTests === totalTests) {
      console.log(`🎉 [ALL PHASE 3E FINAL VERIFICATION TESTS PASSED] (${passedTests}/${totalTests})`);
    } else {
      console.error(`❌ [SOME TESTS FAILED] (${passedTests}/${totalTests})`);
    }
    console.log('=======================================================');

  } catch (err) {
    console.error('❌ Test Execution Error:', err.message);
  }
}

runPhase3EFinalVerification();
