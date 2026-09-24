require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.VITE_API_URL || 'https://nexusfmsbackednshrikant-production.up.railway.app/api/v1';

async function runTest() {
  console.log("=== PHASE 6: TECHNICIAN COMPLETION FLOW TESTS ===");

  try {
    // 1. Tech Login
    console.log("Logging in as Maintenance Staff...");
    const loginRes = await axios.post(`${BASE_URL}/auth/login`, {
      email: 'test_maintenance_staff@nexus.com',
      password: 'password123'
    });
    const techToken = loginRes.data.token;
    console.log("✅ Tech logged in");

    // 2. Admin Login
    console.log("Logging in as Office Admin...");
    const adminRes = await axios.post(`${BASE_URL}/auth/login`, {
      email: 'test_office_admin@nexus.com',
      password: 'password123'
    });
    const adminToken = adminRes.data.token;
    console.log("✅ Admin logged in");

    // 3. Office Team Login
    console.log("Logging in as Office Team...");
    const officeRes = await axios.post(`${BASE_URL}/auth/login`, {
      email: 'test_office_team@nexus.com',
      password: 'password123'
    });
    const officeToken = officeRes.data.token;
    console.log("✅ Office Team logged in");

    // 4. Get a job for the tech
    const jobsRes = await axios.get(`${BASE_URL}/staff/my-jobs`, {
      headers: { Authorization: `Bearer ${techToken}` }
    });
    const activeJobs = jobsRes.data.data.filter(j => j.section !== 'Completed Jobs');
    if (activeJobs.length === 0) {
      console.log("⚠️ No active jobs for tech to test completion. Exiting safely.");
      return;
    }
    const targetJob = activeJobs[0];
    console.log(`Target Job ID: ${targetJob.id}`);

    // 5. Test Office Team cannot hit endpoint
    console.log("Test: Office Team cannot complete job");
    try {
      await axios.post(`${BASE_URL}/jobs/${targetJob.id}/complete`, {}, {
        headers: { Authorization: `Bearer ${officeToken}` }
      });
      throw new Error("Failed: Office team was able to call completion");
    } catch(err) {
      if(err.response?.status === 403) console.log("✅ Office Team correctly blocked (403)");
      else throw err;
    }

    // 6. Test Invalid Materials JSON
    console.log("Test: Tech fails with invalid materials");
    try {
      const form = new FormData();
      form.append('completion_report', 'Fixed');
      form.append('materials', JSON.stringify([{ material_name: 'Pipe', quantity: -1, unit_cost: 10 }]));
      await axios.post(`${BASE_URL}/jobs/${targetJob.id}/complete`, form, {
        headers: { Authorization: `Bearer ${techToken}`, ...form.getHeaders() }
      });
      throw new Error("Failed: Negative quantity accepted");
    } catch(err) {
      if(err.response?.status === 400) console.log("✅ Negative quantity correctly blocked (400)");
      else throw err;
    }

    // 7. Successful Atomic Completion
    fs.writeFileSync('dummy.jpg', 'fake image data');
    const formSuccess = new FormData();
    formSuccess.append('completion_report', 'Replaced the PVC pipe and sealed the leak.');
    formSuccess.append('materials', JSON.stringify([{ material_name: 'PVC Pipe', quantity: 2, unit_cost: 15.50 }]));
    formSuccess.append('beforePhotos', fs.createReadStream('dummy.jpg'));
    
    console.log("Test: Atomic Completion");
    const completeRes = await axios.post(`${BASE_URL}/jobs/${targetJob.id}/complete`, formSuccess, {
      headers: { Authorization: `Bearer ${techToken}`, ...formSuccess.getHeaders() }
    });
    console.log("✅ Job completed atomically:", completeRes.data.message);
    
    fs.unlinkSync('dummy.jpg');

    // 8. Verify Job Status and Disappearance
    const jobsResAfter = await axios.get(`${BASE_URL}/staff/my-jobs`, {
      headers: { Authorization: `Bearer ${techToken}` }
    });
    const stillActive = jobsResAfter.data.data.find(j => j.id === targetJob.id && j.section !== 'Completed Jobs');
    if (stillActive) throw new Error("Failed: Job still active in tech queue");
    console.log("✅ Job removed from active technician queue");

    // 9. Verify Financial Isolation for Office Team
    console.log("Test: Financial fields hidden from Office Team");
    const officeJobRes = await axios.get(`${BASE_URL}/jobs/${targetJob.id}`, {
      headers: { Authorization: `Bearer ${officeToken}` }
    });
    const officeJob = officeJobRes.data.data;
    if(officeJob && (officeJob.quoteAmount !== undefined || officeJob.totalMaterialCost !== undefined || officeJob.profit !== undefined)) {
      throw new Error("Failed: Office Team received financial data: " + JSON.stringify(officeJob));
    }
    console.log("✅ Office Team correctly isolated from financials");

    // 10. Verify Admin Financial View
    console.log("Test: Admin sees financial fields");
    const adminJobRes = await axios.get(`${BASE_URL}/jobs/${targetJob.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const adminJob = adminJobRes.data.data;
    if(!adminJob || adminJob.totalMaterialCost === undefined) {
      throw new Error("Failed: Admin did not receive financial data");
    }
    console.log("✅ Admin correctly sees financials. Total Material Cost: £" + adminJob.totalMaterialCost);
    
    console.log("🎉 ALL TESTS PASSED SUCCESSFULLY");

  } catch(err) {
    console.error("❌ TEST FAILED:");
    console.error(err.response?.data || err.message);
    if(fs.existsSync('dummy.jpg')) fs.unlinkSync('dummy.jpg');
    process.exit(1);
  }
}

runTest();
