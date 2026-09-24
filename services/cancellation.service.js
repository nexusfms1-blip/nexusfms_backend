/**
 * Service to handle business rules related to appointment cancellation
 */

/**
 * Helper to get the starting time of a time slot.
 * Handles formats like '09:00 - 10:30' -> '09:00'
 */
function getStartTime(timeSlotStr) {
  if (!timeSlotStr) return '00:00';
  const parts = timeSlotStr.split('-');
  return parts[0].trim();
}

/**
 * Checks if a given appointment date and time is within the restricted 48-hour cancellation window.
 * 
 * @param {string} appointmentDate - YYYY-MM-DD format
 * @param {string} appointmentTimeSlot - HH:mm - HH:mm format
 * @returns {boolean} True if the appointment is WITHIN 48 hours from now (restricted)
 */
function isWithinCancellationWindow(appointmentDate, appointmentTimeSlot) {
  if (!appointmentDate) return false;
  
  const startTime = getStartTime(appointmentTimeSlot);
  
  // Create a Date object for the appointment
  // Assuming server local time or UTC. We should parse it correctly.
  const appointmentDateTimeStr = `${appointmentDate}T${startTime}:00`;
  const appointmentDateObj = new Date(appointmentDateTimeStr);
  
  // Invalid date parsing fallback
  if (isNaN(appointmentDateObj.getTime())) {
    return false; // Safest default is to allow cancellation if we can't parse it
  }

  const now = new Date();
  
  // Difference in milliseconds
  const diffMs = appointmentDateObj.getTime() - now.getTime();
  
  // If diffMs is negative, the appointment is in the past. 
  // It shouldn't be cancelled, but we count it as "within the window" for restriction purposes.
  // 48 hours in milliseconds = 48 * 60 * 60 * 1000 = 172800000
  const FORTY_EIGHT_HOURS_MS = 172800000;
  
  if (diffMs <= FORTY_EIGHT_HOURS_MS) {
    return true; // Restricted
  }
  
  return false; // Allowed
}

/**
 * Centralized validation function to check if an appointment can be cancelled.
 * Throws an error if within the 48-hour window.
 */
function validateCancellationWindow(appointmentDate, appointmentTimeSlot) {
  if (isWithinCancellationWindow(appointmentDate, appointmentTimeSlot)) {
    const err = new Error("This appointment is within the 48-hour cancellation window. Please contact our office: 0121 769 1767");
    err.status = 403;
    err.code = 'CANCELLATION_WINDOW_RESTRICTED';
    throw err;
  }
}

module.exports = {
  isWithinCancellationWindow,
  validateCancellationWindow,
  getStartTime
};
