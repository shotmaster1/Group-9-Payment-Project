/**
 * POST /api/payments
 * Connects the checkout page (client/js/checkout.js) to the
 * MA Payment API service (server/services/paymentService.js).
 */
const express = require("express");
const path = require("path");
const { processPayment } = require("../services/paymentService");

// Reuse the same rules the checkout page uses, so bad data never reaches MA
const V = require(path.join(__dirname, "../../client/js/validation.js"));

const router = express.Router();

router.post("/", async (req, res) => {
  const body = req.body || {};
  const customer = body.customer || {};

  // ---- Server-side validation (never trust the browser) ----
  const check = V.validatePaymentForm({
    ...customer,
    cardNumber: body.cardNumber,
    expiration: `${body.cardMonth}/${body.cardYear}`,
    cvv: body.ccv,
  });

  if (!body.orderId) {
    check.valid = false;
    check.errors.orderId = "Order ID is required.";
  }

  // TODO (J.C.): look up the real amount from the order in SQLite
  // instead of trusting the amount sent by the browser.
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    check.valid = false;
    check.errors.amount = "Order amount is invalid.";
  }

  if (!check.valid) {
    return res.status(400).json({
      success: false,
      status: "Invalid Payment Details",
      message: Object.values(check.errors)[0],
      errors: check.errors,
    });
  }

  // ---- Send to MA through Quentin's service ----
  const result = await processPayment({
    orderId: body.orderId,
    amount,
    cardNumber: check.payload.payment.cardNumber,
    cardMonth: body.cardMonth,
    cardYear: body.cardYear,
    ccv: check.payload.payment.cvv,
  });

  // Safe card details for saving/display (never the full number or CVV)
  result.cardType = check.payload.payment.cardType;
  result.last4 = check.payload.payment.cardNumber.slice(-4);
  result.orderId = result.orderId || body.orderId;

  // TODO (J.C.): save the order + authorization result here.

  res.json(result);
});

module.exports = router;
