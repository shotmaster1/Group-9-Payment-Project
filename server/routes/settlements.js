const express = require("express");
const router = express.Router();

const testAuthorizations = {
    "1001": 100.00,
    "1002": 250.00,
    "1003": 75.50
};

router.post("/", (req, res) => {
    const { orderId, finalAmount } = req.body;

    const authorizedAmount = testAuthorizations[orderId];

    console.log("Order ID:", orderId);
    console.log("Final Amount:", finalAmount);
    console.log("Authorized Amount:", authorizedAmount);

    const finalAmountNumber = Number(finalAmount);

    if (finalAmountNumber <= authorizedAmount) {
        return res.status(200).json({
            message: "Successful settlement request received",
            orderId: orderId,
            finalAmount: finalAmount,
            authorizedAmount: authorizedAmount
        });
    }

    else{
        return res.status(400).json({
            message: "Failed settlement request",
            finalAmount: finalAmount,
            authorizedAmount: authorizedAmount
        });
    }

    res.json({
        message: "Settlement request received",
        orderId: orderId,
        finalAmount: finalAmount
    });
});

module.exports = router;