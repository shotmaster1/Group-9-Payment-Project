(function () {
  "use strict";
  const V = window.PaymentValidation;
  const FIELDS = ["firstName", "lastName", "email", "address", "city", "state", "zip", "cardNumber", "expiration", "cvv"];
  const CART_KEY = "group9Cart", ATTEMPT_KEY = "group9PaymentAttempt";
  const $ = id => document.getElementById(id);
  let quote = null, quotedItems = null, busy = false, locked = false, phase = "quote", approved = false;
  $("order-id").textContent = "Assigned when you pay";
  $("order-total").textContent = "Loading...";
  function showResult(kind, message) {
    $("result").className = "result show " + kind;
    $("result").textContent = message;
  }
  function updateButton() {
    const button = $("pay-button");
    button.disabled = busy || locked;
    button.textContent = busy ? (phase === "quote" ? "Loading total..." : "Processing…")
      : locked ? (approved ? "Payment authorized" : "Verify order status") : quote ? "Pay now" : "Load current total";
    $("checkout-form").setAttribute("aria-busy", String(busy));
  }
  function readCart() {
    const saved = JSON.parse(sessionStorage.getItem(CART_KEY) || "[]");
    if (!Array.isArray(saved) || saved.length === 0 || saved.length > 100) throw new Error("Your cart is empty or invalid. Return to the storefront.");
    const seen = new Set();
    return saved.map(item => {
      if (!item || !Number.isSafeInteger(item.ProductID) || item.ProductID <= 0 || !Number.isInteger(item.quantity) || item.quantity <= 0 || item.quantity > 999 || seen.has(item.ProductID)) throw new Error("Check your cart quantities before paying.");
      seen.add(item.ProductID);
      return { productId: item.ProductID, quantity: item.quantity };
    });
  }
  const sameCart = (left, right) => JSON.stringify([...left].sort((a, b) => a.productId - b.productId)) === JSON.stringify([...right].sort((a, b) => a.productId - b.productId));
  function saveAttempt(value) { sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(value)); }
  function uncertain(orderId, message) {
    locked = true; approved = false;
    try { saveAttempt({ orderId, state: "uncertain" }); } catch { /* Keep this page locked even if storage fails. */ }
    showResult("failure", (message || "Payment could not be confirmed.") + " Do not pay again. Verify order " + orderId + " before another attempt.");
  }
  function clearAttempt() {
    try { sessionStorage.removeItem(ATTEMPT_KEY); return true; }
    catch { locked = true; showResult("failure", "Could not clear the attempt marker. Verify the order before paying again."); return false; }
  }
  function freshOrderId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return "ORD-" + window.crypto.randomUUID();
    if (!window.crypto || typeof window.crypto.getRandomValues !== "function") throw new Error("Secure Order ID generation is unavailable. Payment was not sent.");
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    return "ORD-" + Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  }
  async function refreshQuote(message) {
    busy = true; phase = "quote"; quote = null; updateButton();
    try {
      const items = readCart();
      const response = await fetch("/api/payments/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
      const data = await response.json();
      if (!response.ok || data?.success !== true) throw new Error(typeof data?.message === "string" ? data.message : "Unable to load the current total.");
      const seen = new Set();
      let totalCents = 0;
      const validLines = Array.isArray(data.items) && data.items.length === items.length && data.items.every(item => {
        if (!item || !items.some(line => line.productId === item.productId && line.quantity === item.quantity) || seen.has(item.productId) || typeof item.productName !== "string" ||
            !Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0 || !Number.isSafeInteger(item.lineTotalCents) || item.lineTotalCents < 0 || item.lineTotalCents !== item.unitPriceCents * item.quantity) return false;
        seen.add(item.productId); totalCents += item.lineTotalCents;
        return Number.isSafeInteger(totalCents);
      });
      if (!validLines || !Number.isSafeInteger(data.totalCents) || data.totalCents <= 0 || totalCents !== data.totalCents || data.orderTotal !== data.totalCents / 100 ||
          typeof data.quoteToken !== "string" || !data.quoteToken || data.quoteToken.length > 2048) throw new Error("The server returned an invalid price quote.");
      quote = data; quotedItems = items;
      window.CheckoutSummary.renderQuote(data);
      if (message) showResult("failure", message + " Review the current total, then click Pay now to confirm.");
      else { $("result").className = "result"; $("result").textContent = ""; }
    } catch (error) {
      $("order-total").textContent = "Unavailable";
      $("cart-summary").hidden = true;
      showResult("failure", error.message || "Unable to load the current total. No payment was sent.");
    } finally { busy = false; updateButton(); }
  }
  function showErrors(errors) {
    for (const field of FIELDS) {
      const message = errors[field] || "";
      $(field + "-error").textContent = message;
      $(field).setAttribute("aria-invalid", message ? "true" : "false");
    }
    const first = FIELDS.find(field => errors[field]);
    if (first) $(first).focus();
  }
  async function submitPayment() {
    if (busy || locked) return;
    if (!quote) { await refreshQuote(); return; }
    let currentItems;
    try { currentItems = readCart(); }
    catch (error) { showResult("failure", error.message); return; }
    if (!sameCart(currentItems, quotedItems)) { await refreshQuote("Your cart changed."); return; }
    const form = Object.fromEntries(FIELDS.map(field => [field, $(field).value]));
    const checked = V.validatePaymentForm(form);
    showErrors(checked.errors);
    if (!checked.valid) return;
    busy = true; phase = "payment"; updateButton();
    let orderId = "", sent = false;
    try {
      orderId = freshOrderId();
      $("order-id").textContent = orderId;
      saveAttempt({ orderId, state: "pending" }); // Must persist before any request that could authorize.
      const body = { orderId, customer: checked.payload.customer, items: currentItems, quoteToken: quote.quoteToken,
        cardNumber: checked.payload.payment.cardNumber, cardMonth: checked.payload.payment.expMonth,
        cardYear: checked.payload.payment.expYear, ccv: checked.payload.payment.cvv, cardType: checked.payload.payment.cardType };
      sent = true;
      const response = await fetch("/api/payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      let result = null;
      try { result = await response.json(); } catch { /* Unreadable results are never safe to retry. */ }
      if (response.ok && result?.success === true && result.outcome === "approved" && result.status === "Authorized" && result.orderId === orderId &&
          result.orderTotal === quote.orderTotal && result.authorizedAmount === quote.orderTotal && typeof result.expirationDate === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(result.expirationDate)) {
        locked = true; approved = true;
        let handled = false;
        try {
          saveAttempt({ orderId, state: "confirmed", cartHandled: false });
          const saved = JSON.parse(sessionStorage.getItem(CART_KEY) || "[]");
          if (!Array.isArray(saved)) throw new Error("Invalid cart storage");
          const remaining = saved.map(item => {
            const purchased = currentItems.find(line => line.productId === item.ProductID);
            return purchased ? { ...item, quantity: Math.max(0, item.quantity - purchased.quantity) } : item;
          }).filter(item => item.quantity > 0);
          if (remaining.length) sessionStorage.setItem(CART_KEY, JSON.stringify(remaining));
          else sessionStorage.removeItem(CART_KEY);
          handled = true;
          saveAttempt({ orderId, state: "confirmed", cartHandled: true });
        } catch { /* Approval remains confirmed even if local cart cleanup fails. */ }
        showResult("success", "Payment authorized. " + checked.display.cardType + " " + checked.display.maskedCard + ". Order " + orderId +
          (handled ? "" : ". Cart cleanup needs attention; do not pay this order again."));
        $("cardNumber").value = ""; $("cvv").value = ""; $("card-type").textContent = "";
      } else if (!response.ok && result?.success === false && ["declined", "rejected"].includes(result.outcome) && typeof result.message === "string") {
        if (!clearAttempt()) return;
        showResult("failure", result.message);
        if (result.code === "QUOTE_CHANGED") await refreshQuote(result.message);
      } else {
        uncertain(orderId, typeof result?.message === "string" ? result.message : "The payment response was invalid.");
      }
    } catch (error) {
      if (sent) uncertain(orderId, "The payment response could not be received.");
      else showResult("failure", "Payment was not sent. Check browser storage and secure Order ID support.");
    } finally { busy = false; updateButton(); }
  }
  $("cardNumber").addEventListener("input", event => {
    event.target.value = V.formatCardNumber(event.target.value);
    const card = V.detectCardType(event.target.value);
    $("card-type").textContent = card ? card.label : "";
    $("cvv").maxLength = card ? card.cvvLength : 3;
  });
  $("expiration").addEventListener("input", event => {
    const digits = event.target.value.replace(/\D/g, "").slice(0, 4);
    event.target.value = digits.length > 2 ? digits.slice(0, 2) + "/" + digits.slice(2) : digits;
  });
  $("cvv").addEventListener("input", event => { event.target.value = event.target.value.replace(/\D/g, ""); });
  $("state").addEventListener("input", event => { event.target.value = event.target.value.replace(/[^a-z]/gi, "").toUpperCase(); });
  $("pay-button").addEventListener("click", submitPayment);
  document.addEventListener("keydown", event => {
    if (event.key === "Enter" && event.target.tagName === "INPUT") { event.preventDefault(); submitPayment(); }
  });
  try {
    const previous = JSON.parse(sessionStorage.getItem(ATTEMPT_KEY) || "null");
    if (previous !== null) {
      if (!previous || typeof previous !== "object" || typeof previous.orderId !== "string" || !previous.orderId.trim() || !["pending", "uncertain", "confirmed"].includes(previous.state)) throw new Error("Invalid attempt storage");
      $("order-id").textContent = previous.orderId;
      if (previous.state === "confirmed") {
        const storedCart = JSON.parse(sessionStorage.getItem(CART_KEY) || "[]");
        const newCart = previous.cartHandled === true && Array.isArray(storedCart) && storedCart.length > 0;
        if (newCart) sessionStorage.removeItem(ATTEMPT_KEY);
        else { locked = true; approved = true; showResult("success", "Order " + previous.orderId + " is already authorized. Do not pay it again."); }
      } else uncertain(previous.orderId, "An earlier payment has not been confirmed on this page.");
    }
  } catch { locked = true; showResult("failure", "Payment attempt storage cannot be read. Verify any earlier order before paying."); }
  updateButton();
  if (!locked) refreshQuote();
})();
