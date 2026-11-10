const express = require("express");
const router = express.Router();
const db = require("../database/db");
const { settleOrder, SettlementError } = require("../services/settlementService");

router.post("/", async (req, res) => {
  try {
    const result = await settleOrder(req.body, { database: db });
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof SettlementError) {
      return res.status(error.statusCode).json({ message: error.message, ...error.details });
    }
    return res.status(500).json({
      message: "Settlement could not be confirmed. Verify the order status before attempting another settlement."
    });
  }
});

module.exports = router;
