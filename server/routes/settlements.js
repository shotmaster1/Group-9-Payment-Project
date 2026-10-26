const express = require("express");
const router = express.Router();
const db = require("../database/db");

router.post("/", (req, res) => {
    const { orderId, finalAmount } = req.body;

    const finalAmountNumber = Number(finalAmount);

    if (!orderId || Number.isNaN(finalAmountNumber) || finalAmountNumber < 0) {
        return res.status(400).json({
            message: "Invalid Order ID or final shipment amount."
        });
    }

    const sql = `
        SELECT AuthorizationAmount
        FROM PaymentAuthorizations
        WHERE OrderID = ?
        AND AuthorizationResult = 'Success'
        ORDER BY AuthorizationID DESC
        LIMIT 1
    `;

    db.get(sql, [orderId], (err, row) => {

        if (err) {
            console.error("Database error:", err.message);

            return res.status(500).json({
                message: "Database error"
            });
        }

        if (!row) {
            return res.status(404).json({
                message: "No authorization found for this Order ID."
            });
        }

        const authorizedAmount = Number(row.AuthorizationAmount);

        console.log("Order ID:", orderId);
        console.log("Final Amount:", finalAmountNumber);
        console.log("Authorized Amount:", authorizedAmount);

        if (finalAmountNumber <= authorizedAmount) {

            const settlementDate = new Date().toISOString();

            const insertSettlementSql = `
                INSERT INTO Settlements
                (OrderID, FinalShipmentAmount, SettlementDate, SettlementResult)
                VALUES (?, ?, ?, ?)
            `;

            db.run(
                insertSettlementSql,
                [orderId, finalAmountNumber, settlementDate, "Success"],
                function(err) {

                    if (err) {
                        console.error("Settlement insert error:", err.message);

                        return res.status(500).json({
                            message: "Failed to save settlement."
                        });
                    }

                    console.log("Settlement saved with ID:", this.lastID);

                    db.run(
                        `UPDATE Orders SET OrderStatus = 'Settled' WHERE OrderID = ?`,
                        [orderId],
                        function(updateErr) {

                            if (updateErr) {
                                console.error("Order status update error:", updateErr.message);

                                return res.status(500).json({
                                    message: "Settlement saved, but order status could not be updated."
                                });
                            }

                            return res.status(200).json({
                                message: "Successful settlement request received",
                                orderId: orderId,
                                finalAmount: finalAmountNumber,
                                authorizedAmount: authorizedAmount
                            });
                        }
                    );
                }
            );

        } else {

            return res.status(400).json({
                message: "Failed settlement request",
                finalAmount: finalAmountNumber,
                authorizedAmount: authorizedAmount
            });
        }
    });
});

module.exports = router;