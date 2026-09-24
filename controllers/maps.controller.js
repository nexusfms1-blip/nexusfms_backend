// =============================================================================
// Maps Controller — Server-Side Geocoding + Routing via FREE OpenStreetMap APIs
// Nominatim (geocoding): https://nominatim.openstreetmap.org
// OSRM (routing):        https://router.project-osrm.org
// No API keys required — 100% free & open-source
// =============================================================================

const https = require('https');

// Helper: HTTP GET with timeout (returns parsed JSON)
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'NexusFMS/1.0 (Facility Management System)'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse API response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// Geocode an address string to { lat, lon } using Nominatim
async function geocodeAddress(address) {
  const encoded = encodeURIComponent(address);
  const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&countrycodes=gb`;
  const results = await fetchJson(url);
  if (!results || results.length === 0) {
    throw new Error(`Geocoding failed for address: "${address}"`);
  }
  return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
}

// Get drive time and road distance between two lat/lon pairs via OSRM
async function getDriveTime(origin, destination) {
  const url = `https://router.project-osrm.org/route/v1/driving/${origin.lon},${origin.lat};${destination.lon},${destination.lat}?overview=false`;
  const data = await fetchJson(url);
  if (!data || data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
    throw new Error('OSRM routing failed');
  }
  const route = data.routes[0];
  const durationSecs = route.duration;
  const distanceMeters = route.distance;
  const distanceMiles = (distanceMeters / 1609.34).toFixed(1);
  const durationMins = Math.round(durationSecs / 60);
  return {
    durationSecs,
    durationMins,
    durationText: durationMins < 60
      ? `${durationMins} mins`
      : `${Math.floor(durationMins / 60)}h ${durationMins % 60}m`,
    distanceMiles: parseFloat(distanceMiles),
    distanceText: `${distanceMiles} mi`,
  };
}

// @desc    Get smart staff suggestion based on drive time from home address
// @route   POST /api/v1/maps/smart-suggestion
// @access  Private (JWT Required)
const getSmartSuggestion = async (req, res, next) => {
  try {
    const { jobAddress, staffList } = req.body;

    if (!jobAddress || !staffList || !Array.isArray(staffList) || staffList.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'jobAddress and staffList are required.',
      });
    }

    // Filter staff who have a home address configured
    const staffWithAddress = staffList.filter(s => s.homeAddress && s.homeAddress.trim() !== '');

    if (staffWithAddress.length === 0) {
      return res.status(200).json({
        success: true,
        data: null,
        message: 'No staff have a home address configured. Set home addresses in Staff Management.',
      });
    }

    // Geocode the job address
    let jobCoords;
    try {
      jobCoords = await geocodeAddress(jobAddress);
    } catch (geoErr) {
      return res.status(200).json({
        success: true,
        data: null,
        message: `Could not geocode job address: ${geoErr.message}`,
      });
    }

    // Calculate drive time from each staff member's home to job location
    const results = await Promise.allSettled(
      staffWithAddress.map(async (staff) => {
        const staffCoords = await geocodeAddress(staff.homeAddress);
        const travel = await getDriveTime(staffCoords, jobCoords);
        return { staff, travel };
      })
    );

    // Filter successful results and find the closest staff
    const successful = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    if (successful.length === 0) {
      return res.status(200).json({
        success: true,
        data: null,
        message: 'Could not calculate drive times. Please check staff home addresses.',
      });
    }

    // Sort by shortest drive time
    successful.sort((a, b) => a.travel.durationSecs - b.travel.durationSecs);
    const best = successful[0];

    return res.status(200).json({
      success: true,
      data: {
        recommendedStaff: {
          id: best.staff.id,
          name: best.staff.name,
          homeAddress: best.staff.homeAddress,
        },
        driveTimeText: best.travel.durationText,
        distanceText: best.travel.distanceText,
        durationMins: best.travel.durationMins,
        distanceMiles: best.travel.distanceMiles,
        // All ranked options
        allOptions: successful.map(r => ({
          staffId: r.staff.id,
          staffName: r.staff.name,
          driveTimeText: r.travel.durationText,
          distanceText: r.travel.distanceText,
          durationMins: r.travel.durationMins,
        })),
      },
    });
  } catch (err) {
    console.error('[Maps Controller] Error:', err.message);
    next(err);
  }
};

module.exports = { getSmartSuggestion };
