const { pool } = require('../config/db');
const { categorizeWorkOrder } = require('./ai.service');
const {
  computeSkillMatchScore,
  computeProximityScore,
  getDayAbbreviation,
} = require('./availability.service');

/**
 * Auto-Assignment Service for Nexus FMS
 *
 * Deterministically assigns the best-matched technician based on:
 * 1. Trade / Skill alignment
 * 2. Active workload balancing (lower active jobs wins)
 * 3. Working-day and duty-status verification
 * 4. Maximum capacity protection
 * 5. Proximity and KPI tie-breaking
 */

const isAutoAssignmentEnabled = () => {
  return process.env.ENABLE_AUTO_ASSIGNMENT !== 'false';
};

/**
 * Automatically evaluates and assigns the best technician to a work order.
 *
 * @param {number} workOrderId
 * @param {object|null} connection - Optional active transaction connection
 * @returns {Promise<object>} Assignment result with full audit details
 */
const autoAssignTechnician = async (workOrderId, connection = null) => {
  const db = connection || pool;

  // 1. Feature Flag Check
  if (!isAutoAssignmentEnabled()) {
    return {
      assigned: false,
      reason: 'Auto-assignment feature disabled via ENABLE_AUTO_ASSIGNMENT=false',
    };
  }

  try {
    // 2. Fetch Work Order Details
    const [woRows] = await db.query(
      `SELECT id, job_number, title, property_address, description, priority, 
              assigned_staff_id, detected_category 
       FROM work_orders 
       WHERE id = ? FOR UPDATE`,
      [workOrderId]
    );

    if (woRows.length === 0) {
      return {
        assigned: false,
        reason: `Work order not found with ID ${workOrderId}`,
      };
    }

    const job = woRows[0];

    // 3. Guard: Never reassign an already-assigned work order
    if (job.assigned_staff_id) {
      return {
        assigned: false,
        alreadyAssigned: true,
        staffId: job.assigned_staff_id,
        reason: `Work order already assigned to technician ID ${job.assigned_staff_id}`,
      };
    }

    // 4. Trade / Issue Classification
    let tradeCategory = job.detected_category;
    if (!tradeCategory) {
      const aiResult = await categorizeWorkOrder(job.description || job.title);
      tradeCategory = aiResult.category || 'General Maintenance';
    }

    // 5. Fetch Active Maintenance Staff
    const [staffRows] = await db.query(
      `SELECT 
        sp.id as staff_id,
        sp.user_id,
        sp.staff_code,
        sp.role_title,
        sp.trades_json,
        sp.max_active_jobs,
        sp.working_days_json,
        sp.work_start_time,
        sp.work_end_time,
        sp.duty_status,
        sp.kpi_score,
        sp.home_address,
        sp.home_postcode,
        u.full_name as staff_name,
        u.email as staff_email,
        u.phone as staff_phone
       FROM staff_profiles sp
       JOIN users u ON sp.user_id = u.id
       WHERE u.role = 'MAINTENANCE_STAFF' AND u.is_active = 1`
    );

    if (staffRows.length === 0) {
      return {
        assigned: false,
        tradeCategory,
        reason: 'No active maintenance staff profiles found in directory',
      };
    }

    // 6. Working Day & Duty Status Validation
    const todayStr = new Date().toISOString().substring(0, 10);
    const dayAbbrev = getDayAbbreviation(todayStr);

    const onDutyStaff = staffRows.filter((tech) => {
      // Check duty status (exclude OFF_DUTY, ON_BREAK, BUSY if explicitly set)
      if (tech.duty_status && tech.duty_status !== 'AVAILABLE') {
        return false;
      }

      // Check working days
      let days = tech.working_days_json;
      if (typeof days === 'string') {
        try {
          days = JSON.parse(days);
        } catch {
          days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
        }
      }
      if (!Array.isArray(days)) {
        days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
      }

      return days.includes(dayAbbrev);
    });

    if (onDutyStaff.length === 0) {
      return {
        assigned: false,
        tradeCategory,
        reason: `No technicians are on duty today (${dayAbbrev})`,
      };
    }

    // 7. Calculate Live Workloads
    const onDutyStaffIds = onDutyStaff.map((s) => s.staff_id);
    const [workloadRows] = await db.query(
      `SELECT assigned_staff_id, COUNT(*) as active_count
       FROM work_orders
       WHERE pipeline_stage IN ('Jobs', 'Jobs Waiting Booking')
         AND assigned_staff_id IN (?)
       GROUP BY assigned_staff_id`,
      [onDutyStaffIds]
    );

    const workloadMap = {};
    for (const row of workloadRows) {
      workloadMap[row.assigned_staff_id] = parseInt(row.active_count, 10) || 0;
    }

    // 8. Filter by Maximum Workload Capacity & Score Candidates
    const scoredCandidates = [];

    for (const tech of onDutyStaff) {
      const activeCount = workloadMap[tech.staff_id] || 0;
      const maxJobs = tech.max_active_jobs ? parseInt(tech.max_active_jobs, 10) : 5;

      // Skip if technician has reached or exceeded max active jobs
      if (activeCount >= maxJobs) {
        continue;
      }

      // Compute Skill Match Score
      let skillScore = 10;
      let explicitTradeMatch = false;

      // Check structured trades_json if available
      if (tech.trades_json) {
        let trades = tech.trades_json;
        if (typeof trades === 'string') {
          try {
            trades = JSON.parse(trades);
          } catch {
            trades = [];
          }
        }
        if (Array.isArray(trades) && trades.some((t) => String(t).toLowerCase() === tradeCategory.toLowerCase())) {
          explicitTradeMatch = true;
          skillScore = 75;
        }
      }

      if (!explicitTradeMatch) {
        skillScore = computeSkillMatchScore(tech.role_title, tradeCategory, job.description || job.title);
      }

      // Workload Penalty: -15 points per active job
      const workloadPenalty = activeCount * 15;

      // Proximity Score (0 - 40 points)
      const proximityScore = computeProximityScore(
        tech.home_address,
        tech.home_postcode,
        job.property_address
      );

      // KPI Bonus (0 - 20 points for high performers)
      const kpiBonus = Math.min(20, Math.round((tech.kpi_score || 0) / 50));

      const totalScore = skillScore - workloadPenalty + proximityScore + kpiBonus;

      scoredCandidates.push({
        ...tech,
        active_count: activeCount,
        max_jobs: maxJobs,
        skillScore,
        proximityScore,
        kpiBonus,
        totalScore,
      });
    }

    if (scoredCandidates.length === 0) {
      return {
        assigned: false,
        tradeCategory,
        reason: 'All on-duty technicians have reached their maximum active workload capacity',
      };
    }

    // 9. Deterministic Selection
    // 1st: Total score descending
    // 2nd: Active workload ascending (lower workload wins tie)
    // 3rd: KPI score descending
    // 4th: Staff ID ascending (deterministic fallback)
    scoredCandidates.sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      if (a.active_count !== b.active_count) return a.active_count - b.active_count;
      if ((b.kpi_score || 0) !== (a.kpi_score || 0)) return (b.kpi_score || 0) - (a.kpi_score || 0);
      return a.staff_id - b.staff_id;
    });

    const bestTech = scoredCandidates[0];
    const selectionReason = `Auto-matched for '${tradeCategory}' (Skill: ${bestTech.skillScore} pts). Active workload: ${bestTech.active_count}/${bestTech.max_jobs} jobs. Proximity: ${bestTech.proximityScore} pts. KPI: ${bestTech.kpi_score || 0}.`;

    // 10. Persist Assignment in Database
    await db.query(
      `UPDATE work_orders 
       SET assigned_staff_id = ?, detected_category = ? 
       WHERE id = ?`,
      [bestTech.staff_id, tradeCategory, workOrderId]
    );

    // Sync preference to booking_requests if row exists
    try {
      await db.query(
        `UPDATE booking_requests 
         SET assignment_preference_staff_id = ? 
         WHERE work_order_id = ?`,
        [bestTech.staff_id, workOrderId]
      );
    } catch {
      // Non-critical if table/column does not exist
    }

    // 11. Write Audit Trail Entry
    await db.query(
      `INSERT INTO job_assignment_logs 
        (work_order_id, staff_id, assigned_by, assignment_type, trade_category, match_score, selection_reason)
       VALUES (?, ?, 'SYSTEM_AUTO_ASSIGN', 'AUTO_SKILL_MATCH', ?, ?, ?)`,
      [
        workOrderId,
        bestTech.staff_id,
        tradeCategory,
        bestTech.totalScore,
        selectionReason,
      ]
    );

    return {
      assigned: true,
      staffProfileId: bestTech.staff_id,
      userId: bestTech.user_id,
      staffName: bestTech.staff_name,
      staffEmail: bestTech.staff_email,
      staffPhone: bestTech.staff_phone,
      staffRole: bestTech.role_title,
      tradeCategory,
      matchScore: bestTech.totalScore,
      activeWorkload: bestTech.active_count,
      reason: selectionReason,
    };
  } catch (error) {
    console.error(`[AutoAssignmentService] Error auto-assigning Work Order #${workOrderId}:`, error);
    return {
      assigned: false,
      reason: `Internal error during assignment: ${error.message}`,
    };
  }
};

module.exports = {
  isAutoAssignmentEnabled,
  autoAssignTechnician,
};
