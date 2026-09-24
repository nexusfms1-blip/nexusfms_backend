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

async function runPhase3DTests() {
  console.log('=======================================================');
  console.log('🌐 Running Automated Test Suite: Phase 3D (Public Resident Links)');
  console.log('=======================================================');

  let passedTests = 0;
  let totalTests = 7;

  let adminToken = null;
  let createdJobId = null;
  let quoteToken = null;
  let bookingToken = null;

  try {
    // Setup 1: Login Admin
    const adminLogin = await makeRequest('POST', '/auth/login', { email: 'admin@nexusfms.com', password: 'Password123!' });
    adminToken = adminLogin.body.token;

    // Setup 2: Create a Work Order for Public Link Generation
    const createJobRes = await makeRequest('POST', '/jobs', {
      title: 'AC Condenser Unit Inspection & Service',
      resident_name: 'Public Test Resident',
      contact_phone: '+1 (555) 777-8888',
      property_address: '500 Palm Boulevard, Suite 10',
      description: 'Customer requested public quote link.',
      section: 'Quotes',
    }, adminToken);
    createdJobId = createJobRes.body.data.id;

    // Test 1: Admin generates Public Quote Request Link (32-byte token)
    console.log('\n[Test 1/7] Admin generating Public Quote Link (32-byte token)...');
    const genQuoteLinkRes = await makeRequest('POST', `/public/jobs/${createdJobId}/generate-link`, {
      type: 'QUOTE_UPLOAD',
    }, adminToken);

    if (genQuoteLinkRes.status === 201 && genQuoteLinkRes.body.success && genQuoteLinkRes.body.data.secureToken) {
      quoteToken = genQuoteLinkRes.body.data.secureToken;
      console.log('  ✅ Generate Public Quote Link PASSED!');
      console.log('     - Token:', quoteToken, `(Length: ${quoteToken.length})`);
      console.log('     - Link URL:', genQuoteLinkRes.body.data.linkUrl);
      passedTests++;
    } else {
      console.error('  ❌ Generate Public Quote Link FAILED:', genQuoteLinkRes.body);
    }

    // Test 2: Resident opens Public Quote Link without login (Unauthenticated)
    console.log('\n[Test 2/7] Resident opening Public Quote Link without login...');
    const getPublicQuoteRes = await makeRequest('GET', `/public/request/${quoteToken}`);

    if (getPublicQuoteRes.status === 200 && getPublicQuoteRes.body.success && getPublicQuoteRes.body.type === 'QUOTE_UPLOAD') {
      console.log('  ✅ Unauthenticated Resident Link View PASSED!');
      console.log('     - Title:', getPublicQuoteRes.body.data.title);
      console.log('     - Resident Name:', getPublicQuoteRes.body.data.residentName);
      console.log('     - Status:', getPublicQuoteRes.body.data.status);
      passedTests++;
    } else {
      console.error('  ❌ Unauthenticated Resident Link View FAILED:', getPublicQuoteRes.body);
    }

    // Test 3: Resident submits Quote Upload Description without login
    console.log('\n[Test 3/7] Resident submitting Quote Upload Notes without login...');
    const submitQuoteRes = await makeRequest('POST', `/public/quote-request/${quoteToken}/upload`, {
      resident_notes: 'Attached photo of cracked condenser pipe and vibrating fan motor.',
    });

    if (submitQuoteRes.status === 200 && submitQuoteRes.body.success) {
      console.log('  ✅ Unauthenticated Quote Upload Submission PASSED!');
      console.log('     - Message:', submitQuoteRes.body.message);
      passedTests++;
    } else {
      console.error('  ❌ Unauthenticated Quote Upload Submission FAILED:', submitQuoteRes.body);
    }

    // Test 4: Admin generates Public Booking Link
    console.log('\n[Test 4/7] Admin generating Public Slot Booking Link...');
    const genBookingLinkRes = await makeRequest('POST', `/public/jobs/${createdJobId}/generate-link`, {
      type: 'BOOKING',
    }, adminToken);

    if (genBookingLinkRes.status === 201 && genBookingLinkRes.body.success && genBookingLinkRes.body.data.secureToken) {
      bookingToken = genBookingLinkRes.body.data.secureToken;
      console.log('  ✅ Generate Public Booking Link PASSED!');
      console.log('     - Booking Token:', bookingToken);
      console.log('     - Booking Link URL:', genBookingLinkRes.body.data.linkUrl);
      passedTests++;
    } else {
      console.error('  ❌ Generate Public Booking Link FAILED:', genBookingLinkRes.body);
    }

    // Test 5: Resident opens Public Booking Link without login
    console.log('\n[Test 5/7] Resident opening Public Booking Link without login...');
    const getPublicBookingRes = await makeRequest('GET', `/public/request/${bookingToken}`);

    if (getPublicBookingRes.status === 200 && getPublicBookingRes.body.success && getPublicBookingRes.body.type === 'BOOKING') {
      console.log('  ✅ Unauthenticated Resident Booking View PASSED!');
      passedTests++;
    } else {
      console.error('  ❌ Unauthenticated Resident Booking View FAILED:', getPublicBookingRes.body);
    }

    // Test 6: Resident submits Booking Confirmation without login
    console.log('\n[Test 6/7] Resident confirming Slot Booking without login...');
    const confirmBookingRes = await makeRequest('POST', `/public/booking/${bookingToken}/confirm`, {
      booking_date: '2026-08-25',
      time_slot: '10:00 - 12:00',
    });

    if (confirmBookingRes.status === 200 && confirmBookingRes.body.success && confirmBookingRes.body.data.stage === 'Jobs') {
      console.log('  ✅ Unauthenticated Booking Confirmation PASSED!');
      console.log('     - Scheduled Date:', confirmBookingRes.body.data.scheduledDate);
      console.log('     - Scheduled Time Slot:', confirmBookingRes.body.data.scheduledTimeSlot);
      console.log('     - Updated Pipeline Stage:', confirmBookingRes.body.data.stage);
      passedTests++;
    } else {
      console.error('  ❌ Unauthenticated Booking Confirmation FAILED:', confirmBookingRes.body);
    }

    // Test 7: Cleanup created work order and public links
    console.log('\n[Test 7/7] Cleaning up created test work order & public links...');
    const delJobRes = await makeRequest('DELETE', `/jobs/${createdJobId}`, null, adminToken);

    if (delJobRes.status === 200 && delJobRes.body.success) {
      console.log('  ✅ Cleanup PASSED! Public test work order deleted cleanly.');
      passedTests++;
    } else {
      console.error('  ❌ Cleanup FAILED:', delJobRes.body);
    }

    console.log('\n=======================================================');
    if (passedTests === totalTests) {
      console.log(`🎉 [ALL PHASE 3D PUBLIC LINK TESTS PASSED] (${passedTests}/${totalTests})`);
    } else {
      console.error(`❌ [SOME TESTS FAILED] (${passedTests}/${totalTests})`);
    }
    console.log('=======================================================');

  } catch (err) {
    console.error('❌ Test Execution Error:', err.message);
  }
}

runPhase3DTests();
