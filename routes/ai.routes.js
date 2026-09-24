const express = require('express');
const router = express.Router();
const { categorizeWorkOrder, polishTechnicianReport } = require('../services/ai.service');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

// @desc    Smart parse & categorize work order description
// @route   POST /api/v1/ai/categorize
router.post('/categorize', async (req, res, next) => {
  try {
    const { description } = req.body;
    const result = await categorizeWorkOrder(description);
    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

// @desc    Polish technician field notes into professional client-ready report
// @route   POST /api/v1/ai/polish-report
router.post('/polish-report', async (req, res, next) => {
  try {
    const { notes } = req.body;
    const polished = await polishTechnicianReport(notes);
    res.status(200).json({
      success: true,
      data: {
        polishedReport: polished,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
