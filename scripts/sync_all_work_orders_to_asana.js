/**
 * One-Time Bulk Sync Script: Sync all existing database work orders to Asana Board.
 * Matches client requirement: mirror full live pipeline to Asana.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { pool } = require('../config/db');
const { syncWorkOrderToAsana } = require('../services/asana.service');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runBulkSync() {
  console.log('=====================================================');
  console.log('🚀 Starting Full Database to Asana Bulk Synchronization');
  console.log('=====================================================\n');

  try {
    // Select all active work orders ordered by id ASC
    const [orders] = await pool.query(`
      SELECT id, job_number, title, pipeline_stage, asana_task_id
      FROM work_orders
      ORDER BY id ASC
    `);

    console.log(`Found ${orders.length} total work orders in database.`);

    let syncedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (let i = 0; i < orders.length; i++) {
      const wo = orders[i];
      const progress = `[${i + 1}/${orders.length}]`;

      try {
        const result = await syncWorkOrderToAsana(wo.id);
        if (result && result.success) {
          syncedCount++;
          console.log(`${progress} ✅ Synced WO #${wo.id} (${wo.job_number || 'N/A'}) [${wo.pipeline_stage}] -> Asana GID: ${result.asanaTaskId}`);
        } else {
          errorCount++;
          console.warn(`${progress} ⚠️ Failed WO #${wo.id}: ${result?.error || result?.reason || 'Unknown error'}`);
        }
      } catch (err) {
        errorCount++;
        console.error(`${progress} ❌ Error WO #${wo.id}:`, err.message);
      }

      // 350ms delay to safely stay well within Asana API rate limits (150 req/min)
      await sleep(350);
    }

    console.log('\n=====================================================');
    console.log('🎉 Bulk Sync Complete!');
    console.log(`✅ Successfully Synced: ${syncedCount}`);
    console.log(`⚠️ Skipped/Errors:     ${errorCount}`);
    console.log('=====================================================');

  } catch (err) {
    console.error('Fatal Bulk Sync Error:', err);
  } finally {
    process.exit(0);
  }
}

runBulkSync();

