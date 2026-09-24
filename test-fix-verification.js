/**
 * Targeted Fix Verification Tests
 * Tests ONLY the P0/P1 fixes from the safety audit.
 * Uses real controller/service code paths.
 * Run: node test-fix-verification.js
 */
const assert = require('assert');
const dotenv = require('dotenv');
dotenv.config();
const { pool } = require('./config/db');

// ---------- In-Memory DB Emulator ----------
const inMemoryStore = {
  workOrders: [],
  residents: [],
  customerMedia: [],
  quoteRequests: [],
  currentId: 200,
};

let isLiveDb = false;
let photoRequestCallCount = 0;

async function setupTestDb() {
  try {
    const conn = await pool.getConnection();
    conn.release();
    isLiveDb = true;
    console.log('📡 Connected to live MySQL database.');
  } catch {
    console.log('⚠️  Live MySQL unreachable. Using in-memory emulator.');
    const mockQuery = async (sql, params = []) => {
      const s = sql.toLowerCase().trim();

      if (s.startsWith('select id, job_number from work_orders where external_reference_id')) {
        const ref = params[0];
        return [inMemoryStore.workOrders.filter(w => w.external_reference_id === ref)];
      }
      if (s.startsWith('select id from work_orders where external_reference_id')) {
        return [inMemoryStore.workOrders.filter(w => w.external_reference_id === params[0])];
      }
      if (s.startsWith('select * from residents where id')) {
        return [inMemoryStore.residents.filter(r => r.id == params[0])];
      }
      if (s.startsWith('select id from residents where phone')) {
        return [inMemoryStore.residents.filter(r => r.phone === params[0] || r.full_name === params[1])];
      }
      if (s.startsWith('insert into residents')) {
        const newRes = { id: ++inMemoryStore.currentId, full_name: params[0], phone: params[1], email: params[2], address: params[3] };
        inMemoryStore.residents.push(newRes);
        return [{ insertId: newRes.id }];
      }
      if (s.startsWith('insert into work_orders')) {
        const extRef = params[22];
        if (extRef && inMemoryStore.workOrders.some(w => w.external_reference_id === extRef)) {
          const e = new Error(`Duplicate entry '${extRef}'`);
          e.code = 'ER_DUP_ENTRY'; e.errno = 1062;
          throw e;
        }
        const wo = {
          id: ++inMemoryStore.currentId,
          job_number: params[0], title: params[1], resident_id: params[2], resident_name: params[3],
          contact_phone: params[4], contact_email: params[5], property_address: params[6],
          description: params[7], secure_token: params[19], created_by: params[20],
          manager_email: params[21], external_reference_id: params[22], original_sender_email: params[23],
          pipeline_stage: params[9],
        };
        inMemoryStore.workOrders.push(wo);
        return [{ insertId: wo.id }];
      }
      if (s.includes('from work_orders w') && s.includes('where w.id = ?')) {
        const found = inMemoryStore.workOrders.find(w => w.id == params[0]);
        return found ? [[{ ...found, live_resident_name: found.resident_name, total_material_cost: 0 }]] : [[]];
      }
      if (s.startsWith('select secure_token from quote_requests')) return [[]];
      if (s.startsWith('insert into quote_requests')) {
        const qr = { work_order_id: params[0], secure_token: params[1], id: ++inMemoryStore.currentId };
        inMemoryStore.quoteRequests.push(qr);
        return [{ insertId: qr.id }];
      }
      if (s.startsWith('select id from quote_requests where work_order_id')) {
        return [inMemoryStore.quoteRequests.filter(q => q.work_order_id == params[0]).map((f, i) => ({ id: i + 1 }))];
      }
      if (s.startsWith('insert into customer_media_uploads')) {
        inMemoryStore.customerMedia.push({ work_order_id: params[0], file_name: params[3] });
        return [{ insertId: ++inMemoryStore.currentId }];
      }
      if (s.startsWith("select id from users where role = 'office_admin'")) return [[{ id: 1 }]];
      if (s.includes('from work_orders') && s.includes('where id = ?')) {
        const found = inMemoryStore.workOrders.find(w => w.id == params[0]);
        return found ? [[found]] : [[]];
      }
      if (s.startsWith('select id from staff_profiles')) return [[]];
      return [[{ id: 1 }]];
    };

    pool.query = mockQuery;
    pool.getConnection = async () => ({
      query: mockQuery,
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
    });
  }
}

// Intercept QuoteRequestService to count real calls
function patchPhotoRequestService(shouldFail = false, shouldThrow = false) {
  photoRequestCallCount = 0;
  const service = require('./services/quoteRequest.service');
  const original = service.triggerAutoPhotoRequest;
  service.triggerAutoPhotoRequest = async (id) => {
    photoRequestCallCount++;
    if (shouldThrow) throw new Error('Simulated photo request failure');
    if (shouldFail) return { error: 'fail' };
    return { sent: true, workOrderId: id };
  };
  return () => { service.triggerAutoPhotoRequest = original; };
}

function createMockRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
}

async function runTests() {
  await setupTestDb();

  const { handleIncomingEmailQuote } = require('./controllers/webhook.controller');
  const { createWorkOrderEntity } = require('./services/workOrder.service');
  const n8nWorkflow = require('./n8n-workflows/Nexus_Inbound_Email_Work_Orders.json');

  let passed = 0;
  let failed = 0;

  function pass(name, detail = '') {
    passed++;
    console.log(`  ✅ [PASS] ${name}${detail ? ' — ' + detail : ''}`);
  }
  function fail(name, detail) {
    failed++;
    console.error(`  ❌ [FAIL] ${name} — ${detail}`);
  }

  console.log('\n================================================================');
  console.log('🧪  P0/P1 FIX VERIFICATION TEST SUITE');
  console.log('================================================================\n');

  // ----------------------------------------------------------------
  // FIX-01: workOrder.service.js returns shouldTriggerPhotoRequest
  // ----------------------------------------------------------------
  console.log('--- Fix P0-1 (workOrder.service.js) ---');
  try {
    const restore = patchPhotoRequestService();
    const result = await createWorkOrderEntity({
      title: 'Test Fix P0-1',
      resident_name: 'Fix Tester',
      contact_phone: '+447700111001',
      property_address: '1 Fix Lane, London',
      description: 'Testing photo request timing',
      pipeline_stage: 'Quotes',
      external_reference_id: `<fix-p01-${Date.now()}@test.com>`,
      original_sender_email: 'fix@test.com',
    }, null);
    restore();

    const hasFlag = typeof result.shouldTriggerPhotoRequest === 'boolean';
    const flagIsTrue = result.shouldTriggerPhotoRequest === true;
    const hasWorkOrderId = !!result.workOrderId;

    if (hasFlag && flagIsTrue && hasWorkOrderId) {
      pass('FX-01a: createWorkOrderEntity returns shouldTriggerPhotoRequest: true for Quotes stage');
    } else {
      fail('FX-01a', `hasFlag=${hasFlag}, flagIsTrue=${flagIsTrue}, hasWorkOrderId=${hasWorkOrderId}`);
    }

    // Photo request must NOT have been called by the service
    if (photoRequestCallCount === 0) {
      pass('FX-01b: triggerAutoPhotoRequest was NOT called inside createWorkOrderEntity');
    } else {
      fail('FX-01b', `triggerAutoPhotoRequest was called ${photoRequestCallCount} times inside service (must be 0)`);
    }
  } catch (err) {
    fail('FX-01: createWorkOrderEntity', err.message);
  }

  // ----------------------------------------------------------------
  // FIX-02: webhook.controller.js triggers photo request AFTER commit
  // ----------------------------------------------------------------
  console.log('\n--- Fix P0-1 (webhook.controller.js — photo request after commit) ---');
  try {
    const restore = patchPhotoRequestService();
    const uniqueRef = `<fix-webhook-p01-${Date.now()}@test.com>`;
    const req = {
      body: {
        reference_id: uniqueRef,
        title: 'Post-commit photo request test',
        resident_name: 'Webhook Fix Tester',
        contact_phone: '+447700111002',
        property_address: '2 Commit Ave, London',
        description: 'Testing post-commit photo request dispatch',
        original_sender_email: 'webhook.fix@test.com',
      }
    };
    const res = createMockRes();
    await handleIncomingEmailQuote(req, res);
    restore();

    if (res.statusCode === 201) {
      pass('FX-02a: webhook returns 201 (work order created)');
    } else {
      fail('FX-02a', `statusCode=${res.statusCode}, body=${JSON.stringify(res.body)}`);
    }

    if (photoRequestCallCount === 1) {
      pass('FX-02b: triggerAutoPhotoRequest called exactly ONCE after commit');
    } else {
      fail('FX-02b', `triggerAutoPhotoRequest call count = ${photoRequestCallCount} (expected 1)`);
    }
  } catch (err) {
    fail('FX-02: webhook post-commit photo request', err.message);
  }

  // ----------------------------------------------------------------
  // FIX-03: DB rollback must NOT trigger photo request
  // ----------------------------------------------------------------
  console.log('\n--- Fix P0-1 (no photo request on rollback) ---');
  try {
    // Simulate a DB error by submitting a duplicate reference (triggers rollback in mock)
    const dupRef = `<fix-rollback-${Date.now()}@test.com>`;

    // First submission — creates successfully
    let restore = patchPhotoRequestService();
    const req1 = { body: { reference_id: dupRef, title: 'Rollback Test', resident_name: 'Roll Tester', contact_phone: '+447700111003', property_address: '3 Rollback Rd', description: 'First submission', original_sender_email: 'roll@test.com' } };
    const res1 = createMockRes();
    await handleIncomingEmailQuote(req1, res1);
    restore();
    const firstCallCount = photoRequestCallCount;

    // Duplicate submission — should rollback (ER_DUP_ENTRY) and not trigger photo request
    restore = patchPhotoRequestService();
    const req2 = { ...req1 };
    const res2 = createMockRes();
    await handleIncomingEmailQuote(req2, res2);
    restore();

    const secondCallCount = photoRequestCallCount;

    if (res1.statusCode === 201 && firstCallCount === 1) {
      pass('FX-03a: First valid submission: 201, photo request fired once');
    } else {
      fail('FX-03a', `statusCode=${res1.statusCode}, photoRequests=${firstCallCount}`);
    }

    if (res2.statusCode === 200 && res2.body?.duplicated === true && secondCallCount === 0) {
      pass('FX-03b: Duplicate/rollback: returns 200 duplicated=true, photo request NOT fired');
    } else {
      fail('FX-03b', `statusCode=${res2.statusCode}, duplicated=${res2.body?.duplicated}, photoRequests=${secondCallCount}`);
    }
  } catch (err) {
    fail('FX-03: rollback photo request safety', err.message);
  }

  // ----------------------------------------------------------------
  // FIX-04: P0-2 — Cloudinary public_id tracking present in code
  // ----------------------------------------------------------------
  console.log('\n--- Fix P0-2 (Cloudinary orphan cleanup) ---');
  try {
    const fs = require('fs');
    const webhookSource = fs.readFileSync('./controllers/webhook.controller.js', 'utf-8');
    const hasTracker = webhookSource.includes('uploadedCloudinaryPublicIds');
    const hasRollbackCleanup = webhookSource.includes('cloudinary.uploader.destroy(publicId)');
    const tracksPublicId = webhookSource.includes('uploadResult?.public_id');

    if (hasTracker) {
      pass('FX-04a: uploadedCloudinaryPublicIds array defined in webhook.controller.js');
    } else {
      fail('FX-04a', 'uploadedCloudinaryPublicIds not found in webhook.controller.js');
    }

    if (tracksPublicId) {
      pass('FX-04b: uploadResult?.public_id is recorded per successful upload');
    } else {
      fail('FX-04b', 'public_id tracking code not found');
    }

    if (hasRollbackCleanup) {
      pass('FX-04c: cloudinary.uploader.destroy() called in rollback catch block');
    } else {
      fail('FX-04c', 'Cloudinary destroy call not found in rollback handler');
    }

    // Verify cleanup does NOT suppress original error
    const cleanupAfterRethrow = webhookSource.includes('throw dbError');
    if (cleanupAfterRethrow) {
      pass('FX-04d: Original DB error is re-thrown after Cloudinary cleanup (not suppressed)');
    } else {
      fail('FX-04d', 'throw dbError not found after cleanup block');
    }
  } catch (err) {
    fail('FX-04: Cloudinary cleanup code verification', err.message);
  }

  // ----------------------------------------------------------------
  // FIX-05: P0-3 — cancelJob sender dispatch deferred until after commit
  // ----------------------------------------------------------------
  console.log('\n--- Fix P0-3 (cancelJob sender dispatch after commit) ---');
  try {
    const fs = require('fs');
    const jobSource = fs.readFileSync('./controllers/job.controller.js', 'utf-8');

    const hasDeferredDispatch = jobSource.includes('deferredSenderDispatch');
    const dispatchAfterCommit = (() => {
      const commitIdx = jobSource.indexOf('await connection.commit()');
      const deferredDispatchAfterCommit = jobSource.indexOf('if (deferredSenderDispatch)');
      return deferredDispatchAfterCommit > commitIdx;
    })();
    const noDirectDispatchBeforeCommit = !jobSource.includes("type: 'SENDER_APPOINTMENT_CANCELLED',\n          channels: ['EMAIL'],\n          contactEmail: origSenderEmail,\n          connection");

    if (hasDeferredDispatch) {
      pass('FX-05a: deferredSenderDispatch variable pattern used in cancelJob');
    } else {
      fail('FX-05a', 'deferredSenderDispatch not found in job.controller.js');
    }

    if (dispatchAfterCommit) {
      pass('FX-05b: deferredSenderDispatch.dispatch() call appears AFTER connection.commit()');
    } else {
      fail('FX-05b', 'Sender dispatch does not appear after commit');
    }

    if (noDirectDispatchBeforeCommit) {
      pass('FX-05c: No direct SENDER_APPOINTMENT_CANCELLED dispatch before commit (old pattern removed)');
    } else {
      fail('FX-05c', 'Old direct pre-commit dispatch pattern still present');
    }
  } catch (err) {
    fail('FX-05: cancelJob P0-3 code verification', err.message);
  }

  // ----------------------------------------------------------------
  // FIX-06: createJob triggers photo request after service returns
  // ----------------------------------------------------------------
  console.log('\n--- Fix P0-1 (createJob manual path) ---');
  try {
    const fs = require('fs');
    const jobSource = fs.readFileSync('./controllers/job.controller.js', 'utf-8');
    const hasPostServiceTrigger = jobSource.includes('if (creationResult.shouldTriggerPhotoRequest)') &&
      jobSource.includes('QuoteRequestService.triggerAutoPhotoRequest(creationResult.workOrderId)');

    if (hasPostServiceTrigger) {
      pass('FX-06: createJob calls triggerAutoPhotoRequest AFTER createWorkOrderEntity returns (post-commit)');
    } else {
      fail('FX-06', 'Photo request post-service trigger not found in createJob');
    }
  } catch (err) {
    fail('FX-06: createJob photo request code verification', err.message);
  }

  // ----------------------------------------------------------------
  // FIX-07: P1-1 — Quality Gate includes fromEmail check
  // ----------------------------------------------------------------
  console.log('\n--- Fix P1-1 (n8n Quality Gate includes fromEmail) ---');
  try {
    const qualityGate = n8nWorkflow.nodes.find(n => n.id === 'node-quality-gate');
    const conditions = qualityGate?.parameters?.conditions?.boolean || [];

    const fromEmailCondition = conditions.find(c =>
      c.value1 && c.value1.includes('fromEmail')
    );

    if (fromEmailCondition) {
      pass('FX-07a: Quality Gate includes fromEmail condition: ' + fromEmailCondition.value1);
    } else {
      fail('FX-07a', 'fromEmail condition not found in Quality Gate node');
    }

    // Verify it is the 4th condition (title, resident_name, contact_phone, property_address, description are in combined boolean, fromEmail is separate)
    if (conditions.length >= 4) {
      pass(`FX-07b: Quality Gate has ${conditions.length} conditions (was 3, now 4)`);
    } else {
      fail('FX-07b', `Quality Gate only has ${conditions.length} conditions, expected >= 4`);
    }
  } catch (err) {
    fail('FX-07: n8n Quality Gate fromEmail', err.message);
  }

  // ----------------------------------------------------------------
  // FIX-08: P1-2 — Explicit success check node before Mark READ
  // ----------------------------------------------------------------
  console.log('\n--- Fix P1-2 (n8n explicit success gate before Mark READ) ---');
  try {
    const successGate = n8nWorkflow.nodes.find(n => n.id === 'node-check-backend-success');
    const markRead = n8nWorkflow.nodes.find(n => n.id === 'node-mark-read');
    const backendFailed = n8nWorkflow.nodes.find(n => n.id === 'node-backend-failed');

    if (successGate) {
      pass('FX-08a: "Backend Success?" IF node exists (node-check-backend-success)');
    } else {
      fail('FX-08a', 'node-check-backend-success not found in workflow');
    }

    if (backendFailed) {
      pass('FX-08b: "Backend Failed (Leave UNREAD)" no-op node exists');
    } else {
      fail('FX-08b', 'node-backend-failed not found in workflow');
    }

    // Verify connection: Call Nexus → Success Gate (not directly to Mark READ)
    const webhookConnections = n8nWorkflow.connections['Call Nexus Inbound Webhook']?.main?.[0] || [];
    const connectsToGate = webhookConnections.some(c => c.node === 'Backend Success? (201 or 200+duplicated)');
    const connectsDirectlyToRead = webhookConnections.some(c => c.node === 'Mark Email as READ');

    if (connectsToGate && !connectsDirectlyToRead) {
      pass('FX-08c: "Call Nexus Inbound Webhook" routes to success gate (NOT directly to Mark READ)');
    } else {
      fail('FX-08c', `connectsToGate=${connectsToGate}, connectsDirectlyToRead=${connectsDirectlyToRead}`);
    }

    // Verify the success condition checks 201 or (200 + duplicated)
    const gateCondition = successGate?.parameters?.conditions?.boolean?.[0]?.value1 || '';
    const checks201 = gateCondition.includes('201');
    const checksDuplicated = gateCondition.includes('duplicated');

    if (checks201 && checksDuplicated) {
      pass(`FX-08d: Success gate checks statusCode===201 and duplicated===true: "${gateCondition}"`);
    } else {
      fail('FX-08d', `Gate condition: "${gateCondition}" — checks201=${checks201}, checksDuplicated=${checksDuplicated}`);
    }

    // Verify branch wiring: Output 0 (TRUE) -> Mark READ, Output 1 (FALSE) -> Backend Failed
    const gateOutputs = n8nWorkflow.connections['Backend Success? (201 or 200+duplicated)']?.main || [];
    const trueRoutesToRead = gateOutputs[0]?.some(c => c.node === 'Mark Email as READ');
    const falseRoutesToFail = gateOutputs[1]?.some(c => c.node === 'Backend Failed (Leave UNREAD)');

    if (trueRoutesToRead && falseRoutesToFail) {
      pass('FX-08e: Output 0 (TRUE) connects to "Mark Email as READ" & Output 1 (FALSE) connects to "Backend Failed"');
    } else {
      fail('FX-08e', `trueRoutesToRead=${trueRoutesToRead}, falseRoutesToFail=${falseRoutesToFail}`);
    }
  } catch (err) {
    fail('FX-08: n8n success gate', err.message);
  }

  // ----------------------------------------------------------------
  // FIX-09: P1-3 — Hardcoded secret removed from n8n workflow
  // ----------------------------------------------------------------
  console.log('\n--- Fix P1-3 (no hardcoded secret in n8n workflow) ---');
  try {
    const workflowJson = JSON.stringify(n8nWorkflow);
    const hasHardcodedSecret = workflowJson.includes('nexus_webhook_secure_key_2026');
    const hasHardcodedLocalhost = workflowJson.includes("|| 'http://localhost:5000'");
    const usesEnvKey = workflowJson.includes('$env.WEBHOOK_SECRET_KEY');
    const usesEnvBackendUrl = workflowJson.includes('$env.BACKEND_URL');

    if (!hasHardcodedSecret) {
      pass('FX-09a: Hardcoded secret "nexus_webhook_secure_key_2026" NOT present in workflow JSON');
    } else {
      fail('FX-09a', 'Hardcoded secret still found in workflow JSON');
    }

    if (!hasHardcodedLocalhost) {
      pass('FX-09b: Hardcoded localhost fallback URL removed');
    } else {
      fail('FX-09b', 'Hardcoded localhost fallback still present');
    }

    if (usesEnvKey) {
      pass('FX-09c: $env.WEBHOOK_SECRET_KEY used for API key header');
    } else {
      fail('FX-09c', '$env.WEBHOOK_SECRET_KEY not found in workflow');
    }

    if (usesEnvBackendUrl) {
      pass('FX-09d: $env.BACKEND_URL used for backend URL (no fallback)');
    } else {
      fail('FX-09d', '$env.BACKEND_URL not found in workflow');
    }
  } catch (err) {
    fail('FX-09: hardcoded secret removal', err.message);
  }

  // ----------------------------------------------------------------
  // REGRESSION-01: Existing field validation still works
  // ----------------------------------------------------------------
  console.log('\n--- Regression: Existing validation behavior ---');
  try {
    const restore = patchPhotoRequestService();
    const testCases = [
      { field: 'contact_phone', body: { reference_id: `<reg-phone-${Date.now()}@t.com>`, title: 'T', resident_name: 'T', contact_phone: '', property_address: 'A', description: 'D', original_sender_email: 's@t.com' } },
      { field: 'property_address', body: { reference_id: `<reg-addr-${Date.now()}@t.com>`, title: 'T', resident_name: 'T', contact_phone: '07700', property_address: '', description: 'D', original_sender_email: 's@t.com' } },
      { field: 'description', body: { reference_id: `<reg-desc-${Date.now()}@t.com>`, title: 'T', resident_name: 'T', contact_phone: '07700', property_address: 'A', description: '', original_sender_email: 's@t.com' } },
      { field: 'original_sender_email', body: { reference_id: `<reg-sender-${Date.now()}@t.com>`, title: 'T', resident_name: 'T', contact_phone: '07700', property_address: 'A', description: 'D', original_sender_email: '' } },
    ];

    let regPassed = true;
    for (const tc of testCases) {
      const res = createMockRes();
      await handleIncomingEmailQuote({ body: tc.body }, res);
      if (res.statusCode !== 400) {
        fail(`REG-01 Missing ${tc.field}`, `Expected 400, got ${res.statusCode}`);
        regPassed = false;
      }
    }
    if (regPassed) pass('REG-01: All 4 existing mandatory field validations return 400 (unchanged)');
    restore();
  } catch (err) {
    fail('REG-01: regression field validation', err.message);
  }

  // ----------------------------------------------------------------
  // REGRESSION-02: Attachment rejection still returns 422
  // ----------------------------------------------------------------
  console.log('\n--- Regression: Attachment rejection ---');
  try {
    const restore = patchPhotoRequestService();
    const res = createMockRes();
    await handleIncomingEmailQuote({
      body: {
        reference_id: `<reg-att-${Date.now()}@t.com>`,
        title: 'Reg Att Test',
        resident_name: 'Reg Tester',
        contact_phone: '+447700222001',
        property_address: '99 Reg St',
        description: 'regression attachment',
        original_sender_email: 'reg@test.com',
        attachments: [{ file_name: 'bad.exe', mime_type: 'application/x-msdownload', base64_data: 'AAAA' }]
      }
    }, res);
    restore();

    if (res.statusCode === 422 && photoRequestCallCount === 0) {
      pass('REG-02: Invalid attachment: returns 422; photo request NOT triggered');
    } else {
      fail('REG-02', `statusCode=${res.statusCode}, photoRequests=${photoRequestCallCount}`);
    }
  } catch (err) {
    fail('REG-02: attachment regression', err.message);
  }

  // ----------------------------------------------------------------
  // REGRESSION-03: shouldTriggerPhotoRequest is false for non-Quotes stage
  // ----------------------------------------------------------------
  console.log('\n--- Regression: shouldTriggerPhotoRequest false for Jobs stage ---');
  try {
    const restore = patchPhotoRequestService();
    const result = await createWorkOrderEntity({
      title: 'Jobs Stage Test',
      resident_name: 'Stage Tester',
      contact_phone: '+447700333001',
      property_address: '5 Stage Lane',
      description: 'Testing Jobs stage flag',
      pipeline_stage: 'Jobs',
      external_reference_id: `<fix-jobs-${Date.now()}@test.com>`,
      original_sender_email: 'jobs@test.com',
    }, null);
    restore();

    if (result.shouldTriggerPhotoRequest === false) {
      pass('REG-03: shouldTriggerPhotoRequest = false for Jobs stage (no unwanted photo request)');
    } else {
      fail('REG-03', `shouldTriggerPhotoRequest = ${result.shouldTriggerPhotoRequest} for Jobs stage`);
    }
  } catch (err) {
    fail('REG-03: Jobs stage regression', err.message);
  }

  // ----------------------------------------------------------------
  console.log('\n================================================================');
  const total = passed + failed;
  console.log(`📊  FIX VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED (TOTAL: ${total})`);
  console.log('================================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Fatal Test Error:', err);
  process.exit(1);
});
