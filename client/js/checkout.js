/**
 * checkout.js — wires the checkout page to validation.js and the payment route.
 * IS 4880 Group 9 — Person A (customer/payment validation)
 *
 * Depends on validation.js being loaded first (window.PaymentValidation).
 */
(function () {
  "use strict";

  const V = window.PaymentValidation;

  // ---- Settings to confirm with the team ----
  const PAYMENT_ROUTE = "/api/payments";   // Quentin's route
  const USE_TWO_DIGIT_YEAR = false;        // flip to true if MA wants CardYear as "28" instead of 2028

  const FIELDS = [
    "firstName", "lastName", "email", "address", "city",
    "state", "zip", "cardNumber", "expiration", "cvv",
  ];

  const $ = (id) => document.getElementById(id);

  // ---- Order context ----
  // The cart/order flow should open this page as checkout.html?orderId=123&amount=49.99
  // The server must look up the real amount from the order; the one here is for display.
  const params = new URLSearchParams(window.location.search);
  const order = {
    orderId: params.get("orderId") || `DEMO-${Date.now()}`,
    amount: Number(params.get("amount") || 0),
  };
  $("order-id").textContent = order.orderId;
  $("order-total").textContent = order.amount.toLocaleString("en-US", { style: "currency", currency: "USD" });

  // ---- Live input formatting ----
  $("cardNumber").addEventListener("input", (e) => {
    e.target.value = V.formatCardNumber(e.target.value);
    const card = V.detectCardType(e.target.value);
    $("card-type").textContent = card ? card.label : "";
    $("cvv").maxLength = card ? card.cvvLength : 3;
  });

  $("expiration").addEventListener("input", (e) => {
    const digits = e.target.value.replace(/\D/g, "").slice(0, 4);
    e.target.value = digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
  });

  $("cvv").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "");
  });

  $("state").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/[^a-z]/gi, "").toUpperCase();
  });

  // ---- Error display ----
  function showErrors(errors) {
    for (const field of FIELDS) {
      const input = $(field);
      const message = errors[field] || "";
      $(`${field}-error`).textContent = message;
      input.setAttribute("aria-invalid", message ? "true" : "false");
    }
    const firstBad = FIELDS.find((f) => errors[f]);
    if (firstBad) $(firstBad).focus();
  }

  function showResult(kind, html) {
    const box = $("result");
    box.className = `result show ${kind}`;
    box.innerHTML = html;
  }

  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function readForm() {
    const data = {};
    for (const field of FIELDS) data[field] = $(field).value;
    return data;
  }

  // ---- Submit ----
  async function submitPayment() {
    $("result").className = "result";
    const { valid, errors, payload, display } = V.validatePaymentForm(readForm());
    showErrors(errors);
    if (!valid) return;

    // Map to the field names Quentin's processPayment() expects
    const body = {
      orderId: order.orderId,
      amount: order.amount,
      cardNumber: payload.payment.cardNumber,
      cardMonth: payload.payment.expMonth,
      cardYear: USE_TWO_DIGIT_YEAR ? payload.payment.expYear % 100 : payload.payment.expYear,
      ccv: payload.payment.cvv,
      cardType: payload.payment.cardType,
      customer: payload.customer,
    };

    const button = $("pay-button");
    button.disabled = true;
    button.textContent = "Processing…";

    try {
      const response = await fetch(PAYMENT_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      let result = {};
      try { result = await response.json(); } catch { /* non-JSON response */ }

      if (response.status === 404) {
        showResult(
          "failure",
          "<strong>Payment route not found</strong><br>The server doesn't have /api/payments yet. Your card details passed validation."
        );
      } else if (result.success) {
        showResult(
          "success",
          `<strong>Payment authorized.</strong><br>` +
          `${escapeHtml(display.cardType)} ${escapeHtml(display.maskedCard)}<br>` +
          `Order ${escapeHtml(result.orderId || order.orderId)}`
        );
        // Clear card fields so the full number doesn't stay on screen
        $("cardNumber").value = "";
        $("cvv").value = "";
        $("card-type").textContent = "";
      } else {
        showResult(
          "failure",
          `<strong>${escapeHtml(result.status || "Payment failed")}</strong><br>` +
          `${escapeHtml(result.message || "Check your card details and try again.")}`
        );
      }
    } catch {
      showResult("failure", "<strong>Payment Error</strong><br>Couldn't reach the server. Check that it's running and try again.");
    } finally {
      button.disabled = false;
      button.textContent = "Pay now";
    }
  }

  $("pay-button").addEventListener("click", submitPayment);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName === "INPUT") submitPayment();
  });
})();
