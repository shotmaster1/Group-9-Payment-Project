"use strict";
const params = new URLSearchParams(window.location.search);
const form = document.getElementById("settlementForm");
const orderIdInput = document.getElementById("orderId");
const amountInput = document.getElementById("finalAmount");
const reasonInput = document.getElementById("underSettlementReason");
const submitButton = document.getElementById("settlementSubmitButton");
const messageBox = document.getElementById("result");
const $ = id => document.getElementById(id);
const REASONS = ["Unavailable inventory", "Damaged items", "Partial fulfillment", "Other"];
let inFlight = false, submissionLocked = false, loading = false;
let loadedOrder = null, authorizedCents = null, detailController = null, detailCounter = 0, detailTimer = null;

// Parse decimals directly to cents, then reject dollar Numbers that cannot round-trip.
function moneyCents(value) {
    if (typeof value !== "string" && typeof value !== "number") return null;
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    const match = /^(\d+|)(?:\.(\d{0,2}))?$/.exec(String(value));
    if (!match || (!match[1] && !match[2]) || match[1].replace(/^0+/, "").length > 14) return null;
    const cents = BigInt(match[1] || "0") * 100n + BigInt((match[2] || "").padEnd(2, "0"));
    if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const dollars = Number(cents) / 100;
    const roundtrip = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(dollars));
    if (!roundtrip || BigInt(roundtrip[1]) * 100n + BigInt((roundtrip[2] || "").padEnd(2, "0")) !== cents) return null;
    return Number(cents);
}
const displayMoney = cents => cents === null ? "—" : "$" + (cents / 100).toFixed(2);
function eligible() {
    return loadedOrder && loadedOrder.OrderID === orderIdInput.value.trim() && loadedOrder.OrderStatus === "Authorized" &&
        loadedOrder.LatestAuthorization?.AuthorizationResult === "Success" && authorizedCents > 0 && loadedOrder.Settlements.length === 0;
}
function updateSubmissionState() {
    submitButton.disabled = inFlight || submissionLocked || loading || !eligible();
    orderIdInput.disabled = inFlight || submissionLocked;
    amountInput.disabled = inFlight || submissionLocked;
    reasonInput.disabled = inFlight || submissionLocked || $("reasonField").hidden;
    submitButton.textContent = inFlight ? "Submitting settlement..." : "Submit Settlement";
    form.setAttribute("aria-busy", String(inFlight || loading));
}
function updateBreakdown() {
    const finalCents = moneyCents(amountInput.value.trim());
    const valid = authorizedCents !== null && finalCents !== null && finalCents > 0 && finalCents <= authorizedCents;
    const under = valid && finalCents < authorizedCents;
    $("authorizedAmount").textContent = displayMoney(authorizedCents);
    $("settlementAmount").textContent = displayMoney(finalCents);
    $("unusedAmount").textContent = displayMoney(valid ? authorizedCents - finalCents : null);
    $("reasonField").hidden = !under;
    reasonInput.required = under;
    if (!under) reasonInput.value = "";
    $("unusedExplanation").hidden = !under;
    $("amountHint").textContent = !amountInput.value ? "" : finalCents === null || finalCents <= 0 ? "Enter a positive amount with no more than two decimal places." : authorizedCents !== null && finalCents > authorizedCents ? "Settlement cannot exceed the authorization amount." : "";
    updateSubmissionState();
}
function appendDetail(container, label, value) {
    const row = document.createElement("div"), key = document.createElement("dt"), item = document.createElement("dd");
    key.textContent = label; item.textContent = value; row.append(key, item); container.appendChild(row);
}
function renderHistory(rows) {
    $("historyDetails").replaceChildren(); $("settlementHistory").hidden = rows.length === 0;
    for (const settlement of rows) {
        const list = document.createElement("dl"); list.className = "breakdown";
        appendDetail(list, "Settlement amount", displayMoney(moneyCents(settlement.FinalShipmentAmount)));
        appendDetail(list, "Settlement date", settlement.SettlementDate || "N/A");
        appendDetail(list, "Result", settlement.SettlementResult || "N/A");
        appendDetail(list, "Reason for under-settlement", settlement.UnderSettlementReason || "Not recorded");
        $("historyDetails").appendChild(list);
    }
}
function reloadOrder(delay = 0) {
    clearTimeout(detailTimer); const requestId = ++detailCounter;
    if (detailController) detailController.abort();
    loadedOrder = null; authorizedCents = null; loading = false;
    reasonInput.value = ""; $("historyDetails").replaceChildren(); $("settlementHistory").hidden = true;
    $("orderDetailsStatus").textContent = orderIdInput.value.trim() ? "Loading authorization details..." : "Enter an Order ID to load its authorization details.";
    if (orderIdInput.value.trim()) {
        loading = true;
        detailTimer = setTimeout(() => { void loadOrder(requestId, orderIdInput.value.trim()); }, delay);
    }
    updateBreakdown();
}
async function loadOrder(requestId, orderId) {
    const controller = new AbortController(); detailController = controller;
    try {
        const response = await fetch("/api/orders/" + encodeURIComponent(orderId), { signal: controller.signal });
        const data = await response.json();
        if (requestId !== detailCounter) return;
        if (!response.ok || data?.success !== true || data.order?.OrderID !== orderId || !Array.isArray(data.order.Settlements)) {
            throw new Error(response.status === 404 ? "Order not found." : "Unable to load authorization details. Check the Order ID and try again.");
        }
        loadedOrder = data.order;
        authorizedCents = typeof loadedOrder.LatestAuthorization?.AuthorizationAmount === "number" ? moneyCents(loadedOrder.LatestAuthorization.AuthorizationAmount) : null;
        renderHistory(loadedOrder.Settlements);
        $("orderDetailsStatus").textContent = "Order status: " + loadedOrder.OrderStatus + (eligible() ? ". Authorization loaded; final eligibility is checked on submission." : ". This order is not available for settlement.");
    } catch (error) {
        if (requestId !== detailCounter) return;
        loadedOrder = null; authorizedCents = null;
        $("orderDetailsStatus").textContent = "Unable to load authorization details. Check the Order ID and try again.";
        if (error.message === "Order not found.") $("orderDetailsStatus").textContent = error.message;
    } finally {
        if (requestId === detailCounter) { loading = false; detailController = null; updateBreakdown(); }
    }
}
function showUncertainOutcome(detail) {
    submissionLocked = true;
    messageBox.textContent = detail + " The settlement outcome is uncertain. Verify the order status before attempting another settlement.";
}
function showConfirmation(data, cents, authCents) {
    const list = $("confirmationDetails"); list.replaceChildren();
    appendDetail(list, "Order ID", data.orderId);
    appendDetail(list, "Original authorization amount", displayMoney(authCents));
    appendDetail(list, "Final settled amount", displayMoney(cents));
    appendDetail(list, "Unused authorization amount", displayMoney(authCents - cents));
    if (data.underSettlementReason) appendDetail(list, "Reason for under-settlement", data.underSettlementReason);
    appendDetail(list, "Final order status", data.orderStatus);
    $("confirmationExplanation").hidden = cents === authCents;
    $("confirmation").hidden = false;
    $("orderDetailsStatus").textContent = "Order status: Settled";
}
form.addEventListener("submit", async event => {
    event.preventDefault();
    if (inFlight || submissionLocked) return;
    const orderId = orderIdInput.value.trim(), finalCents = moneyCents(amountInput.value.trim());
    if (!orderId) { messageBox.textContent = "Enter an Order ID."; orderIdInput.focus(); return; }
    if (finalCents === null || finalCents <= 0) { messageBox.textContent = "Enter a positive settlement amount with no more than two decimal places."; amountInput.focus(); return; }
    if (!eligible() || loading) { messageBox.textContent = "Load an Authorized order before submitting a settlement."; return; }
    if (finalCents > authorizedCents) { messageBox.textContent = "Settlement cannot exceed the authorization amount."; return; }
    const reason = finalCents < authorizedCents ? reasonInput.value : null;
    if (finalCents < authorizedCents && !REASONS.includes(reason)) { messageBox.textContent = "Choose a reason for under-settlement."; reasonInput.focus(); return; }
    const finalAmount = finalCents / 100;
    inFlight = true; updateSubmissionState(); messageBox.textContent = "Submitting settlement...";
    try {
        const response = await fetch("/api/settlements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId, finalAmount, ...(reason ? { underSettlementReason: reason } : {}) }) });
        let data = null; try { data = await response.json(); } catch { /* Fail closed on unreadable success. */ }
        const message = typeof data?.message === "string" && data.message.trim() ? data.message : null;
        if (response.status === 400 || response.status === 404) { messageBox.textContent = message || "Settlement rejected. Check the Order ID and amount."; return; }
        if (!response.ok) { showUncertainOutcome(message || "The server could not confirm the settlement."); return; }
        const confirmedCents = typeof data?.finalAmount === "number" ? moneyCents(data.finalAmount) : null;
        const confirmedAuth = typeof data?.authorizedAmount === "number" ? moneyCents(data.authorizedAmount) : null;
        const unused = typeof data?.unusedAuthorizationAmount === "number" ? moneyCents(data.unusedAuthorizationAmount) : null;
        if (!message || data.orderId !== orderId || confirmedCents !== finalCents || confirmedAuth === null || confirmedAuth < confirmedCents || unused !== confirmedAuth - confirmedCents || data.orderStatus !== "Settled" || (confirmedCents < confirmedAuth ? data.underSettlementReason !== reason || !REASONS.includes(reason) : data.underSettlementReason !== null)) {
            showUncertainOutcome("The server returned an unexpected settlement response."); return;
        }
        submissionLocked = true; messageBox.textContent = message;
        authorizedCents = confirmedAuth; updateBreakdown();
        showConfirmation(data, confirmedCents, confirmedAuth);
    } catch { showUncertainOutcome("The settlement response could not be received."); }
    finally { inFlight = false; updateSubmissionState(); }
});
orderIdInput.addEventListener("input", () => { if (!inFlight && !submissionLocked) reloadOrder(250); });
amountInput.addEventListener("input", updateBreakdown);
const selectedOrderId = params.get("orderId");
if (selectedOrderId) orderIdInput.value = selectedOrderId;
reloadOrder();
