const { pool } = require('../config/db');

// @desc    Get all aggregated dashboard stats in one call
// @route   GET /api/v1/dashboard/stats
// @access  Private (JWT Required)
const getDashboardStats = async (req, res, next) => {
  try {
    const isStaff = req.user && req.user.role === 'MAINTENANCE_STAFF';
    const staffId = isStaff ? (req.user.staffProfileId || -1) : null;
    const staffFilter = isStaff ? `WHERE assigned_staff_id = ${staffId}` : '';
    const staffFilterAnd = isStaff ? `AND assigned_staff_id = ${staffId}` : '';
    const staffFilterWhereAnd = isStaff ? `WHERE assigned_staff_id = ${staffId} AND` : 'WHERE';
    const staffWorkloadQuery = isStaff 
      ? `SELECT
          u.id            AS userId,
          u.full_name     AS name,
          u.phone,
          u.email,
          u.avatar_url    AS avatarUrl,
          sp.id           AS profileId,
          sp.staff_code   AS staffCode,
          sp.role_title   AS role,
          sp.color_hex    AS color,
          sp.working_days_json    AS workingDays,
          sp.work_start_time      AS workStart,
          sp.work_end_time        AS workEnd,
          sp.unavailable_dates_json AS unavailable,
          COUNT(w.id)     AS activeJobs
        FROM users u
        LEFT JOIN staff_profiles sp ON u.id = sp.user_id
        LEFT JOIN work_orders w
          ON sp.id = w.assigned_staff_id
          AND w.pipeline_stage NOT IN ('Completed Jobs', 'Completed Quotes', 'Invoiced', 'Invoice')
        WHERE sp.id = ${staffId}
        GROUP BY u.id, sp.id`
      : `SELECT
          u.id            AS userId,
          u.full_name     AS name,
          u.phone,
          u.email,
          u.avatar_url    AS avatarUrl,
          sp.id           AS profileId,
          sp.staff_code   AS staffCode,
          sp.role_title   AS role,
          sp.color_hex    AS color,
          sp.working_days_json    AS workingDays,
          sp.work_start_time      AS workStart,
          sp.work_end_time        AS workEnd,
          sp.unavailable_dates_json AS unavailable,
          COUNT(w.id)     AS activeJobs
        FROM users u
        LEFT JOIN staff_profiles sp ON u.id = sp.user_id
        LEFT JOIN work_orders w
          ON sp.id = w.assigned_staff_id
          AND w.pipeline_stage NOT IN ('Completed Jobs', 'Completed Quotes', 'Invoiced', 'Invoice')
        WHERE u.role = 'MAINTENANCE_STAFF'
        GROUP BY u.id, sp.id
        ORDER BY u.created_at DESC`;

    // Parallel query execution for optimal performance
    const [
      [stageCounts],
      [staffRows],
      [trendRows],
      [recentRows],
      [[qrCount]],
      [[totalCount]],
      [allJobsRows]
    ] = await Promise.all([
      // 1. Pipeline stage counts
      pool.query(`
        SELECT pipeline_stage AS stage, COUNT(*) AS count
        FROM work_orders
        ${staffFilter}
        GROUP BY pipeline_stage
      `),

      // 2. Staff workload
      pool.query(staffWorkloadQuery),

      // 3. Weekly trend (last 30 days)
      pool.query(`
        SELECT
          DATE_FORMAT(created_at, '%Y-%m-%d') AS day,
          pipeline_stage                       AS stage,
          COUNT(*)                             AS count
        FROM work_orders
        ${staffFilterWhereAnd} created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
        GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d'), pipeline_stage
        ORDER BY day ASC
      `),

      // 4. Recent jobs
      pool.query(`
        SELECT
          w.id,
          w.job_number         AS jobNumber,
          w.title,
          w.description,
          w.pipeline_stage     AS section,
          w.resident_name      AS tenantName,
          r.full_name          AS liveTenantName,
          w.property_address   AS address,
          r.address            AS liveAddress,
          DATE_FORMAT(w.created_at, '%Y-%m-%d') AS createdAt,
          u.full_name          AS staffName,
          sp.color_hex         AS staffColor
        FROM work_orders w
        LEFT JOIN residents r  ON w.resident_id      = r.id
        LEFT JOIN staff_profiles sp ON w.assigned_staff_id = sp.id
        LEFT JOIN users u      ON sp.user_id          = u.id
        ${staffFilter}
        ORDER BY w.created_at DESC
        LIMIT 20
      `),

      // 5. Pending quote requests
      pool.query(`
        SELECT COUNT(*) AS count FROM quote_requests
        WHERE status IN ('PHOTO_REQUEST_PENDING', 'PENDING')
      `),

      // 6. Total jobs count
      pool.query(`
        SELECT COUNT(*) AS count FROM work_orders ${staffFilter}
      `),

      // 7. Category breakdown titles
      pool.query(`
        SELECT title, description FROM work_orders ${staffFilter}
      `)
    ]);

    const stageMap = {
      Quotes: 0,
      'Completed Quotes': 0,
      'Jobs Waiting Booking': 0,
      Jobs: 0,
      'Completed Jobs': 0,
      Invoiced: 0,
    };
    stageCounts.forEach(r => {
      const stageKey = r.stage === 'Invoice' ? 'Invoiced' : r.stage;
      if (Object.prototype.hasOwnProperty.call(stageMap, stageKey)) {
        stageMap[stageKey] = (stageMap[stageKey] || 0) + Number(r.count);
      }
    });

    const staffWorkload = staffRows.map(r => ({
      id:         r.profileId ? `stf-${r.profileId}` : `usr-${r.userId}`,
      profileId:  r.profileId,
      userId:     r.userId,
      staffCode:  r.staffCode || `STF-${100 + r.userId}`,
      name:       r.name,
      email:      r.email,
      avatarUrl:  r.avatarUrl || '',
      phone:      r.phone || '',
      role:       r.role || 'Maintenance Specialist',
      color:      r.color || '#009bf2',
      workingDays: r.workingDays || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      workStart:  r.workStart  ? String(r.workStart).substring(0, 5)  : '08:00',
      workEnd:    r.workEnd    ? String(r.workEnd).substring(0, 5)    : '17:00',
      unavailable: r.unavailable || [],
      activeJobs:  Number(r.activeJobs || 0),
    }));

    // Build last-30-days array — show last 7 in chart but include 30d of data
    const daysArr = [];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const yr  = d.getFullYear();
      const mo  = String(d.getMonth() + 1).padStart(2, '0');
      const dy  = String(d.getDate()).padStart(2, '0');
      const iso = `${yr}-${mo}-${dy}`;
      daysArr.push({
        day:        dayNames[d.getDay()],
        date:       iso,
        quotes:     0,
        bookedJobs: 0,
        completed:  0,
      });
    }

    trendRows.forEach(r => {
      const entry = daysArr.find(d => d.date === r.day);
      if (!entry) return;
      if (r.stage === 'Quotes' || r.stage === 'Completed Quotes') {
        entry.quotes += Number(r.count);
      } else if (r.stage === 'Jobs' || r.stage === 'Jobs Waiting Booking') {
        entry.bookedJobs += Number(r.count);
      } else if (r.stage === 'Completed Jobs' || r.stage === 'Invoiced' || r.stage === 'Invoice') {
        entry.completed += Number(r.count);
      }
    });

    const recentJobs = recentRows.map(r => ({
      id:          r.id,
      jobNumber:   r.jobNumber,
      title:       r.title       || '',
      description: r.description || '',
      section:     r.section,
      tenantName:  r.liveTenantName || r.tenantName || '',
      address:     r.liveAddress   || r.address     || '',
      createdAt:   r.createdAt     || null,
      staffName:   r.staffName     || null,
      staffColor:  r.staffColor    || '#009bf2',
    }));

    const catCounts = {
      'Plumbing & Leaks':      0,
      'Electrical & Lighting': 0,
      'HVAC & Air Con':        0,
      'Locks & Carpentry':     0,
      'Appliance Repair':      0,
    };

    allJobsRows.forEach(j => {
      const text = `${j.title || ''} ${j.description || ''}`.toLowerCase();
      if      (text.match(/plumb|leak|pipe|water|drain|heater|tap/))           catCounts['Plumbing & Leaks']      += 1;
      else if (text.match(/electr|light|wiring|power|bulb|fuse|socket/))       catCounts['Electrical & Lighting'] += 1;
      else if (text.match(/hvac|air.?con|heating|cooler|ventil/))              catCounts['HVAC & Air Con']        += 1;
      else if (text.match(/lock|key|door|carpentry|wood|hinge|fence|gate/))    catCounts['Locks & Carpentry']     += 1;
      else                                                                       catCounts['Appliance Repair']      += 1;
    });

    const totalCat = Object.values(catCounts).reduce((a, b) => a + b, 0) || 1;
    const categoryBreakdown = [
      { name: 'Plumbing & Leaks',      value: Math.round((catCounts['Plumbing & Leaks']      / totalCat) * 100), color: '#009bf2' },
      { name: 'Electrical & Lighting', value: Math.round((catCounts['Electrical & Lighting'] / totalCat) * 100), color: '#10b981' },
      { name: 'HVAC & Air Con',        value: Math.round((catCounts['HVAC & Air Con']        / totalCat) * 100), color: '#f59e0b' },
      { name: 'Locks & Carpentry',     value: Math.round((catCounts['Locks & Carpentry']     / totalCat) * 100), color: '#a855f7' },
      { name: 'Appliance Repair',      value: Math.round((catCounts['Appliance Repair']      / totalCat) * 100), color: '#ec4899' },
    ];

    res.status(200).json({
      success: true,
      data: {
        stageCounts:           stageMap,
        totalJobs:             Number(totalCount.count),
        staffWorkload,
        weeklyTrend:           daysArr,
        recentJobs,
        categoryBreakdown,
        pendingQuoteRequests:  Number(qrCount.count),
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getDashboardStats };
