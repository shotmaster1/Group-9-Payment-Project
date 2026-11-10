"use strict";

const express = require("express");
const db = require("../database/db");
const gatewayClient = require("../services/paymentService");
const quoteService = require("../services/paymentQuoteService");
const { createPayment, PaymentError } = require("../services/paymentOrderService");
const { OrderError } = require("../services/orderService");
const { PricingError } = require("../services/pricingService");
const { QuoteError } = require("../services/paymentQuoteService");

function createPaymentRouter({ database = db, gateway = gatewayClient, quotes = quoteService, now = Date.now } = {}) {
    const router = express.Router();
    function failure(error, res) {
        if (error instanceof PaymentError) return res.status(error.statusCode).json({ success: false, outcome: error.outcome, code: error.code, message: error.message, orderId: error.orderId });
        if (error instanceof QuoteError) return res.status(409).json({ success: false, outcome: "rejected", code: error.code, message: error.message });
        if (error instanceof OrderError) return res.status(error.statusCode).json({ success: false, outcome: error.code === "DUPLICATE_ORDER_ID" ? "uncertain" : "rejected", code: error.code, message: error.message });
        if (error instanceof PricingError) {
            const internal = ["INVALID_PRODUCT_PRICE", "INVALID_PRODUCT_NAME", "INVALID_PRODUCT_DATA"].includes(error.code);
            return res.status(internal ? 500 : 400).json({ success: false, outcome: "rejected", code: error.code, message: error.message });
        }
        return res.status(500).json({ success: false, outcome: "uncertain", code: "PAYMENT_UNCONFIRMED", message: "The request could not be confirmed. Verify the Order ID before another payment." });
    }
    router.post("/quote", async (req, res) => {
        try {
            const input = req.body;
            if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, "items")) throw new PaymentError("INVALID_CART", "Supply cart items containing only productId and quantity.");
            return res.status(200).json({ success: true, ...await quotes.quote(input.items, database) });
        } catch (error) {
            if (error instanceof PricingError || error instanceof PaymentError || error instanceof QuoteError) return failure(error, res);
            return res.status(500).json({ success: false, outcome: "rejected", code: "QUOTE_UNAVAILABLE", message: "Unable to calculate the current total. No payment was sent." });
        }
    });
    router.post("/", async (req, res) => {
        try {
            const result = await createPayment(req.body, { database, gateway, quotes, now });
            return res.status(result.statusCode).json(result.body);
        } catch (error) { return failure(error, res); }
    });
    return router;
}
module.exports = createPaymentRouter();
module.exports.createPaymentRouter = createPaymentRouter;
