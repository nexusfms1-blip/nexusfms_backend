const { pool } = require('../config/db');

// Helper to convert "HH:mm" time string to minutes from midnight
const timeToMinutes = (timeStr) => {
  if (!timeStr) return 0;
  const parts = String(timeStr).split(':');
  const hours = parseInt(parts[0], 10) || 0;
  const mins = parseInt(parts[1], 10) || 0;
  return hours * 60 + mins;
};

// Helper to convert minutes from midnight to "HH:mm" time string
const minutesToTime = (totalMinutes) => {
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  const hStr = hours < 10 ? `0${hours}` : `${hours}`;
  const mStr = mins < 10 ? `0${mins}` : `${mins}`;
  return `${hStr}:${mStr}`;
};

// Helper to get 3-letter day abbreviation for date string (YYYY-MM-DD)
const getDayAbbreviation = (dateStr) => {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dateObj = new Date(`${dateStr}T00:00:00`);
  return days[dateObj.getDay()];
};

/**
 * Calculate available booking slots for a technician on a specific date and duration
 * @param {number} staffProfileId 
 * @param {string} targetDate - 'YYYY-MM-DD'
 * @param {number} durationHours - Float (e.g. 1.0, 1.5, 2.0, 3.0)
 * @param {object} connection - Optional MySQL transaction connection
 */
const calculateStaffAvailableSlots = async (staffProfileId, targetDate, durationHours = 1.5, connection = pool) => {
  // 1. Fetch Staff Profile Working Hours & Days
  const [staffRows] = await connection.query(
    `SELECT 
      sp.id, sp.user_id, sp.role_title, sp.working_days_json, sp.work_start_time, sp.work_end_time,
      sp.break_start_time, sp.break_end_time, sp.unavailable_dates_json, sp.duty_status,
      u.full_name as staff_name, u.email as staff_email
     FROM staff_profiles sp
     JOIN users u ON sp.user_id = u.id
     WHERE sp.id = ?`,
    [staffProfileId]
  );

  if (staffRows.length === 0) {
    return {
      success: false,
      reason: 'Staff profile not found',
      availableSlots: [],
    };
  }

  const staff = staffRows[0];
  const dayAbbrev = getDayAbbreviation(targetDate);
  
  let workingDays = staff.working_days_json;
  if (typeof workingDays === 'string') {
    try {
      workingDays = JSON.parse(workingDays);
    } catch {
      workingDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    }
  }
  if (!Array.isArray(workingDays)) {
    workingDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  }

  // Check Working Day Requirement
  if (!workingDays.includes(dayAbbrev)) {
    const isWknd = dayAbbrev === 'Sat' || dayAbbrev === 'Sun';
    return {
      success: true,
      reason: isWknd 
        ? `Staff is off on weekends (${dayAbbrev}). Working days: ${workingDays.join(', ')}`
        : `Technician is off on ${dayAbbrev}s. Working days: ${workingDays.join(', ')}`,
      availableSlots: [],
    };
  }

  // Check Unavailable / Leave Dates
  let unavail = staff.unavailable_dates_json;
  if (typeof unavail === 'string') {
    try { unavail = JSON.parse(unavail); } catch { unavail = []; }
  }
  if (Array.isArray(unavail) && unavail.includes(targetDate)) {
    return {
      success: true,
      reason: `Technician is on leave / scheduled off on ${targetDate}`,
      availableSlots: [],
    };
  }

  // Check Duty Status
  if (staff.duty_status === 'ON_LEAVE' || staff.duty_status === 'OFF_DUTY') {
    return {
      success: true,
      reason: `Technician is currently ${staff.duty_status === 'ON_LEAVE' ? 'on leave' : 'off duty'}`,
      availableSlots: [],
    };
  }

  const shiftStartMin = timeToMinutes(staff.work_start_time || '08:00:00');
  const shiftEndMin = timeToMinutes(staff.work_end_time || '17:00:00');
  const breakStartMin = timeToMinutes(staff.break_start_time || '12:00:00');
  const breakEndMin = timeToMinutes(staff.break_end_time || '13:00:00');
  const durationMins = Math.round(durationHours * 60);

  // 2. Fetch Existing Scheduled Jobs for this technician on targetDate
  const [existingJobs] = await connection.query(
    `SELECT id, scheduled_time_slot, duration_hours 
     FROM work_orders 
     WHERE assigned_staff_id = ? AND scheduled_date = ? AND scheduled_time_slot IS NOT NULL`,
    [staffProfileId, targetDate]
  );

  const occupiedIntervals = [];

  for (const job of existingJobs) {
    const slotText = job.scheduled_time_slot;
    if (slotText && slotText.includes('-')) {
      const parts = slotText.split('-').map(s => s.trim());
      const startMin = timeToMinutes(parts[0]);
      const endMin = timeToMinutes(parts[1]);
      occupiedIntervals.push({ start: startMin, end: endMin });
    }
  }

  // 3. Generate Candidate Starting Slots (Every 30 mins)
  const candidateSlots = [];
  const step = 30; // 30-minute interval grid

  for (let slotStartMin = shiftStartMin; slotStartMin + durationMins <= shiftEndMin; slotStartMin += step) {
    const slotEndMin = slotStartMin + durationMins;

    // Reject if overlaps break time
    const overlapsBreak = (slotStartMin < breakEndMin && slotEndMin > breakStartMin);
    if (overlapsBreak) continue;

    // Reject if overlaps existing job interval
    let overlapsJob = false;
    for (const jobInt of occupiedIntervals) {
      if (slotStartMin < jobInt.end && slotEndMin > jobInt.start) {
        overlapsJob = true;
        break;
      }
    }
    if (overlapsJob) continue;

    // Valid slot found!
    const startTimeStr = minutesToTime(slotStartMin);
    const endTimeStr = minutesToTime(slotEndMin);
    candidateSlots.push({
      timeSlot: `${startTimeStr} - ${endTimeStr}`,
      startTime: startTimeStr,
      endTime: endTimeStr,
      durationHours: durationHours,
      assignedStaffId: staffProfileId,
      assignedStaffName: staff.staff_name,
      assignedStaffEmail: staff.staff_email,
      assignedStaffRole: staff.role_title || 'Maintenance Specialist',
      assignedStaffCategory: staff.role_title || 'Maintenance Specialist',
    });
  }

  return {
    success: true,
    staffId: staffProfileId,
    staffName: staff.staff_name,
    staffEmail: staff.staff_email,
    staffRole: staff.role_title || 'Maintenance Specialist',
    targetDate,
    dayAbbrev,
    durationHours,
    availableSlots: candidateSlots,
  };
};

const { categorizeWorkOrder } = require('./ai.service');

// Helper to compute skill match score
const computeSkillMatchScore = (roleTitle, aiCategory, description) => {
  if (!roleTitle) return 0;
  const role = roleTitle.toLowerCase();
  const cat = (aiCategory || '').toLowerCase();
  const desc = (description || '').toLowerCase();

  let score = 10; // baseline score for any active staff

  if (cat.includes('electric') && (role.includes('electr') || role.includes('wire') || role.includes('light') || role.includes('power'))) score += 60;
  if (cat.includes('plumb') && (role.includes('plumb') || role.includes('pipe') || role.includes('drain') || role.includes('leak') || role.includes('sink'))) score += 60;
  if (cat.includes('hvac') && (role.includes('hvac') || role.includes('heat') || role.includes('air') || role.includes('boiler') || role.includes('vent'))) score += 60;
  if (cat.includes('lock') && (role.includes('lock') || role.includes('carpent') || role.includes('door') || role.includes('window'))) score += 60;
  if (cat.includes('appliance') && (role.includes('appliance') || role.includes('technician') || role.includes('repair') || role.includes('specialist'))) score += 60;

  // Keyword overlap
  const descWords = desc.split(/[^a-zA-Z0-9]+/).filter(w => w.length >= 4);
  for (const word of descWords) {
    if (role.includes(word)) score += 15;
  }

  return score;
};

// Helper to compute proximity score based on address/postcode similarity
const computeProximityScore = (staffAddress, staffPostcode, jobAddress) => {
  if (!jobAddress) return 0;
  let score = 0;
  const jAddr = jobAddress.toLowerCase();
  const sAddr = (staffAddress || '').toLowerCase();
  const sPost = (staffPostcode || '').toLowerCase().trim();

  if (sPost && sPost.length >= 2 && jAddr.includes(sPost)) {
    score += 40; // Exact postcode match
  }

  if (sAddr) {
    const sTokens = sAddr.split(/[, -]+/).filter(t => t.length >= 4);
    for (const token of sTokens) {
      if (jAddr.includes(token)) {
        score += 15; // City or locality match (e.g. Indore, London, Vaishali)
      }
    }
  }

  return score;
};

/**
 * Calculate available booking slots across all active technicians,
 * ranked by AI skill categorization and location proximity.
 */
const calculateMultiStaffAvailableSlots = async (
  targetDate,
  durationHours = 1.5,
  preferredStaffId = null,
  jobDetails = {},
  connection = pool
) => {
  const dayAbbrev = getDayAbbreviation(targetDate);
  const durationMins = Math.round(durationHours * 60);

  // 1. Fetch All Active Staff Profiles
  const [allStaffRows] = await connection.query(
    `SELECT 
      sp.id, sp.user_id, sp.role_title, sp.working_days_json, sp.work_start_time, sp.work_end_time,
      sp.break_start_time, sp.break_end_time, sp.home_address, sp.home_postcode, sp.color_hex,
      sp.duty_status, sp.unavailable_dates_json, u.full_name as staff_name, u.email as staff_email, u.phone as staff_phone
     FROM staff_profiles sp
     JOIN users u ON sp.user_id = u.id
     WHERE u.role = 'MAINTENANCE_STAFF' AND (u.is_active = 1 OR u.is_active IS NULL)
     ORDER BY sp.id ASC`
  );

  if (allStaffRows.length === 0) {
    return {
      success: true,
      targetDate,
      dayAbbrev,
      durationHours,
      availableSlots: [],
      message: 'No active maintenance technicians found in system.',
      workingDaysInfo: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    };
  }

  // 2. Perform AI Categorization on job description
  const jobDesc = (jobDetails.description || jobDetails.title || '').trim();
  const jobAddress = jobDetails.property_address || jobDetails.address || '';
  const aiInfo = await categorizeWorkOrder(jobDesc);

  // 3. Rank Staff by Preference, Skill Match & Proximity
  const cleanPrefId = preferredStaffId ? parseInt(String(preferredStaffId).replace(/^(stf-|usr-)/, ''), 10) : null;

  const rankedStaff = allStaffRows.map(staff => {
    let days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    if (staff.working_days_json) {
      try {
        days = typeof staff.working_days_json === 'string' ? JSON.parse(staff.working_days_json) : staff.working_days_json;
      } catch {
        days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
      }
    }
    if (!Array.isArray(days)) days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

    let unavail = staff.unavailable_dates_json;
    if (typeof unavail === 'string') {
      try { unavail = JSON.parse(unavail); } catch { unavail = []; }
    }
    const isDateUnavailable = Array.isArray(unavail) && unavail.includes(targetDate);
    const isOffDutyOrLeave = staff.duty_status === 'ON_LEAVE' || staff.duty_status === 'OFF_DUTY';

    const isPreferred = cleanPrefId && (staff.id === cleanPrefId || staff.user_id === cleanPrefId);
    const skillScore = computeSkillMatchScore(staff.role_title, aiInfo.category, jobDesc);
    const proximityScore = computeProximityScore(staff.home_address, staff.home_postcode, jobAddress);
    const worksOnDay = days.includes(dayAbbrev) && !isDateUnavailable && !isOffDutyOrLeave;

    let totalScore = skillScore + proximityScore;
    if (isPreferred) totalScore += 1000;
    if (staff.duty_status === 'AVAILABLE' || !staff.duty_status) totalScore += 10;

    return {
      ...staff,
      workingDays: days,
      worksOnDay,
      isDateUnavailable,
      isOffDutyOrLeave,
      isPreferred,
      skillScore,
      proximityScore,
      totalScore,
      aiCategory: aiInfo.category,
    };
  });

  // Sort descending by match score
  rankedStaff.sort((a, b) => b.totalScore - a.totalScore);

  // Collect all working days across the team
  const allTeamWorkingDays = Array.from(new Set(rankedStaff.flatMap(s => s.workingDays)));

  // Filter staff who actually work and are available on targetDate
  const availableStaffOnDay = rankedStaff.filter(s => s.worksOnDay);

  if (availableStaffOnDay.length === 0) {
    const isWeekend = dayAbbrev === 'Sat' || dayAbbrev === 'Sun';
    const reasonMsg = isWeekend
      ? `Staff is off on weekends (${dayAbbrev}). Please select a working day (${allTeamWorkingDays.join(', ')}).`
      : `No maintenance technicians are available on ${dayAbbrev}, ${targetDate} (All staff are off, on leave, or outside scheduled days). Please choose another date.`;

    return {
      success: true,
      targetDate,
      dayAbbrev,
      durationHours,
      availableSlots: [],
      message: reasonMsg,
      workingDaysInfo: allTeamWorkingDays,
      aiCategory: aiInfo.category,
      rankedStaff: rankedStaff.map(s => ({
        id: s.id,
        name: s.staff_name,
        role: s.role_title,
        color: s.color_hex || '#009bf2',
        score: s.totalScore,
      })),
    };
  }

  // 4. Fetch all scheduled jobs on targetDate across these technicians
  const staffIds = availableStaffOnDay.map(s => s.id);
  const [existingJobs] = await connection.query(
    `SELECT id, assigned_staff_id, scheduled_time_slot, duration_hours 
     FROM work_orders 
     WHERE assigned_staff_id IN (?) AND scheduled_date = ? AND scheduled_time_slot IS NOT NULL`,
    [staffIds, targetDate]
  );

  // Map occupied intervals by staffId
  const occupiedByStaff = {};
  for (const sId of staffIds) {
    occupiedByStaff[sId] = [];
  }

  for (const job of existingJobs) {
    const sId = job.assigned_staff_id;
    const slotText = job.scheduled_time_slot;
    if (sId && slotText && slotText.includes('-')) {
      const parts = slotText.split('-').map(s => s.trim());
      const startMin = timeToMinutes(parts[0]);
      const endMin = timeToMinutes(parts[1]);
      if (occupiedByStaff[sId]) {
        occupiedByStaff[sId].push({ start: startMin, end: endMin });
      }
    }
  }

  // 5. Build candidate slots for each working technician
  const bestTechnician = availableStaffOnDay[0];
  const candidateSlots = [];

  for (const tech of availableStaffOnDay) {
    const shiftStartMin = timeToMinutes(tech.work_start_time || '08:00:00');
    const shiftEndMin = timeToMinutes(tech.work_end_time || '17:00:00');
    const breakStartMin = timeToMinutes(tech.break_start_time || '12:00:00');
    const breakEndMin = timeToMinutes(tech.break_end_time || '13:00:00');
    const occupied = occupiedByStaff[tech.id] || [];

    const step = 30; // 30-min grid intervals

    for (let slotStartMin = shiftStartMin; slotStartMin + durationMins <= shiftEndMin; slotStartMin += step) {
      const slotEndMin = slotStartMin + durationMins;

      // Check break overlap
      if (slotStartMin < breakEndMin && slotEndMin > breakStartMin) continue;

      // Check existing job overlap
      let overlaps = false;
      for (const occ of occupied) {
        if (slotStartMin < occ.end && slotEndMin > occ.start) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;

      const startTimeStr = minutesToTime(slotStartMin);
      const endTimeStr = minutesToTime(slotEndMin);
      const slotKey = `${startTimeStr} - ${endTimeStr}`;

      candidateSlots.push({
        slotId: `${startTimeStr}-${endTimeStr}-${tech.id}`,
        timeSlot: slotKey,
        startTime: startTimeStr,
        endTime: endTimeStr,
        durationHours: durationHours,
        assignedStaffId: tech.id,
        assignedStaffName: tech.staff_name,
        assignedStaffEmail: tech.staff_email,
        assignedStaffRole: tech.role_title || 'Maintenance Specialist',
        assignedStaffCategory: aiInfo.category || tech.role_title || 'General Maintenance',
        assignedStaffColor: tech.color_hex || '#009bf2',
        isRecommended: bestTechnician ? (tech.id === bestTechnician.id) : false,
      });
    }
  }

  // Sort slots by start time, then recommended first
  candidateSlots.sort((a, b) => {
    const diff = timeToMinutes(a.startTime) - timeToMinutes(b.startTime);
    if (diff !== 0) return diff;
    return (b.isRecommended ? 1 : 0) - (a.isRecommended ? 1 : 0);
  });

  return {
    success: true,
    targetDate,
    dayAbbrev,
    durationHours,
    availableSlots: candidateSlots,
    totalSlotsFound: candidateSlots.length,
    aiCategory: aiInfo.category,
    recommendedStaff: bestTechnician ? {
      id: bestTechnician.id,
      name: bestTechnician.staff_name,
      email: bestTechnician.staff_email,
      role: bestTechnician.role_title,
      color: bestTechnician.color_hex || '#009bf2',
      matchScore: bestTechnician.totalScore,
    } : null,
    rankedStaff: rankedStaff.map(s => ({
      id: s.id,
      name: s.staff_name,
      email: s.staff_email,
      role: s.role_title,
      color: s.color_hex || '#009bf2',
      worksOnDay: s.worksOnDay,
      score: s.totalScore,
    })),
    workingDaysInfo: allTeamWorkingDays,
  };
};

module.exports = {
  calculateStaffAvailableSlots,
  calculateMultiStaffAvailableSlots,
  computeSkillMatchScore,
  computeProximityScore,
  timeToMinutes,
  minutesToTime,
  getDayAbbreviation,
};
