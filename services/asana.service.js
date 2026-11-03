const axios = require('axios');
const { pool } = require('../config/db');

// Section mapping cache
const SECTION_GIDS = {
  'Quotes': '1220123955322179',
  'Ready to Quote': '1220123955322181',
  'READY_TO_QUOTE': '1220123955322181',
  'Completed Quotes': '1220123955322183',
  'Jobs Waiting Booking': '1220127285574634',
  'Jobs Awaiting Booking': '1220127285574634',
  'Waiting Job Booking': '1220127285574634',
  'Jobs': '1220127270824054',
  'Active Jobs': '1220127270824054',
  'Completed Jobs': '1220127285686143',
  'Invoiced': '1220127138699530',
  'Invoice': '1220127138699530'
};

const getAsanaConfig = () => {
  return {
    token: process.env.ASANA_ACCESS_TOKEN || '',
    workspaceId: process.env.ASANA_WORKSPACE_ID || '1220123038326695',
    projectId: process.env.ASANA_PROJECT_ID || '1220121091344689',
    enabled: process.env.ENABLE_ASANA_SYNC !== 'false'
  };
};

/**
 * Synchronize a single work order to Asana project board.
 * Runs non-blocking (never throws to caller or halts primary DB operation).
 */
const syncWorkOrderToAsana = async (workOrderId) => {
  try {
    const config = getAsanaConfig();
    if (!config.enabled || !config.token || !config.projectId) {
      return { success: false, reason: 'Asana sync disabled or missing credentials' };
    }

    const [rows] = await pool.query(`
      SELECT w.*, 
             r.full_name as live_resident_name, r.phone as live_resident_phone, r.email as live_resident_email,
             u.full_name as staff_name
      FROM work_orders w
      LEFT JOIN residents r ON w.resident_id = r.id
      LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
      LEFT JOIN users u ON sp.user_id = u.id
      WHERE w.id = ?
    `, [workOrderId]);

    if (rows.length === 0) return { success: false, reason: 'Work order not found' };

    const job = rows[0];
    const resident = job.live_resident_name || job.resident_name || 'N/A';
    const phone = job.live_resident_phone || job.contact_phone || 'N/A';
    const email = job.live_resident_email || job.contact_email || 'N/A';
    const staff = job.staff_name || 'Unassigned';
    
    let schedDate = null;
    if (job.scheduled_date) {
      schedDate = job.scheduled_date instanceof Date 
        ? job.scheduled_date.toISOString().substring(0, 10) 
        : String(job.scheduled_date).substring(0, 10);
    }

    const taskName = `${job.job_number ? '#' + job.job_number + ' - ' : ''}${job.title || 'Work Order'}`;
    const taskNotes = `📋 WORK ORDER DETAILS:
• Stage: ${job.pipeline_stage}
• Property: ${job.property_address || 'N/A'}
• Resident: ${resident} (Phone: ${phone} | Email: ${email})
• Assigned Technician: ${staff}
• Scheduled Date: ${schedDate || 'Unscheduled'} ${job.scheduled_time_slot ? '(' + job.scheduled_time_slot + ')' : ''}
• Priority: ${job.priority || 'NORMAL'}

📝 Scope / Description:
${job.description || 'No description provided.'}

🔗 Nexus Portal Link:
https://www.nexusfms.com/admin/pipeline?jobId=${job.id}`;

    const stageKey = job.pipeline_stage || 'Quotes';
    const targetSectionGid = SECTION_GIDS[stageKey] || SECTION_GIDS['Quotes'];

    const client = axios.create({
      baseURL: 'https://app.asana.com/api/1.0',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    let asanaTaskId = job.asana_task_id;

    if (asanaTaskId) {
      // 1. Update Existing Task in Asana
      try {
        await client.put(`/tasks/${asanaTaskId}`, {
          data: {
            name: taskName,
            notes: taskNotes,
            due_on: schedDate || null
          }
        });

        // 2. Move to target section if changed
        if (targetSectionGid) {
          await client.post(`/sections/${targetSectionGid}/addTask`, {
            data: { task: asanaTaskId }
          });
        }

        return { success: true, asanaTaskId, action: 'updated' };
      } catch (updateErr) {
        // If task was deleted from Asana, recreate it
        if (updateErr.response?.status === 404) {
          asanaTaskId = null;
        } else {
          console.warn(`[AsanaService] Failed to update task ${asanaTaskId}:`, updateErr.message);
          return { success: false, error: updateErr.message };
        }
      }
    }

    // 3. Create New Task in Asana
    if (!asanaTaskId) {
      const createRes = await client.post('/tasks', {
        data: {
          workspace: config.workspaceId,
          projects: [config.projectId],
          name: taskName,
          notes: taskNotes,
          due_on: schedDate || undefined
        }
      });

      asanaTaskId = createRes.data.data.gid;

      // Move into target pipeline stage section
      if (targetSectionGid) {
        await client.post(`/sections/${targetSectionGid}/addTask`, {
          data: { task: asanaTaskId }
        }).catch(err => console.warn('[AsanaService] Could not move to section:', err.message));
      }

      // Persist asana_task_id to database
      await pool.query('UPDATE work_orders SET asana_task_id = ? WHERE id = ?', [asanaTaskId, workOrderId]);
      console.log(`[AsanaService] Synced Job #${workOrderId} to Asana Task GID: ${asanaTaskId}`);

      return { success: true, asanaTaskId, action: 'created' };
    }

  } catch (err) {
    console.warn(`[AsanaService] Error syncing work order #${workOrderId} to Asana:`, err.message);
    return { success: false, error: err.message };
  }
};

/**
 * Delete a task from Asana when permanently removed from system
 */
const deleteAsanaTask = async (asanaTaskId) => {
  if (!asanaTaskId) return;
  try {
    const config = getAsanaConfig();
    if (!config.enabled || !config.token) return;
    await axios.delete(`https://app.asana.com/api/1.0/tasks/${asanaTaskId}`, {
      headers: { Authorization: `Bearer ${config.token}` },
      timeout: 10000
    });
  } catch (err) {
    console.warn(`[AsanaService] Could not delete Asana task ${asanaTaskId}:`, err.message);
  }
};

module.exports = {
  syncWorkOrderToAsana,
  deleteAsanaTask,
  SECTION_GIDS
};

