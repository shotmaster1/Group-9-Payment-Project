"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { fixture } = require("./helpers/payment-fixture");
const { browser, waitFor, fetchApplication } = require("./helpers/browser-fixture");
const { settleOrder, UNDER_SETTLEMENT_REASONS } = require("../server/services/settlementService");
async function approved(t, id = "WAREHOUSE", items = [{ productId: 1, quantity: 2 }]) {
    const f = fixture(t); const result = await f.api("POST", "/", await f.payload(id, items));
    assert.equal(result.status, 200); return f;
}
async function page(f, id = "WAREHOUSE", customFetch = null) {
    const network = fetchApplication(f);
    const ui = browser("warehouse.html", { search: "?orderId=" + encodeURIComponent(id), fetch: customFetch || network.fetch });
    ui.runScripts(); await waitFor(() => !ui.get("settlementSubmitButton").disabled, "authorization loaded");
    return { ui, network };
}
async function amount(ui, value, reason = "") {
    ui.get("finalAmount").value = value; await ui.get("finalAmount").dispatch("input");
    ui.get("underSettlementReason").value = reason;
}
for (const reason of UNDER_SETTLEMENT_REASONS) test("reason is persisted atomically and returned in review: " + reason, async t => {
    const f = await approved(t);
    const result = await settleOrder({ orderId: "WAREHOUSE", finalAmount: 80, underSettlementReason: reason }, { database: f.db, now: f.now });
    assert.equal(result.authorizedAmount, 129.98); assert.equal(result.unusedAuthorizationAmount, 49.98);
    assert.equal(result.underSettlementReason, reason); assert.equal(result.orderStatus, "Settled");
    const row = await f.db.getAsync("SELECT UnderSettlementReason FROM Settlements"); assert.equal(row.UnderSettlementReason, reason);
    const detail = await (await fetchApplication(f).fetch("/api/orders/WAREHOUSE")).json();
    assert.equal(detail.order.Settlements[0].UnderSettlementReason, reason);
    await assert.rejects(settleOrder({ orderId: "WAREHOUSE", finalAmount: 1, underSettlementReason: reason }, { database: f.db, now: f.now }), { code: "ORDER_NOT_AUTHORIZED" });
    assert.equal((await f.db.getAsync("SELECT count(*) AS n FROM Settlements")).n, 1);
});

test("missing, unknown, nontext and getter reasons never create a settlement", async t => {
    const f = await approved(t);
    for (const reason of [undefined, null, "", "unavailable inventory", "<script>bad</script>", {}, 1, true]) {
        const input = { orderId: "WAREHOUSE", finalAmount: 80, ...(reason === undefined ? {} : { underSettlementReason: reason }) };
        await assert.rejects(settleOrder(input, { database: f.db, now: f.now }), error => error.statusCode === 400);
    }
    let getter = false;
    await assert.rejects(settleOrder({ orderId: "WAREHOUSE", finalAmount: 80, get underSettlementReason() { getter = true; return "Other"; } }, { database: f.db, now: f.now }), { code: "INVALID_REQUEST" });
    assert.equal(getter, false);
    assert.equal((await f.db.getAsync("SELECT count(*) AS n FROM Settlements")).n, 0);
    assert.equal((await f.db.getAsync("SELECT OrderStatus FROM Orders")).OrderStatus, "Authorized");
});

test("exact settlements need no reason and discard a valid stale reason", async t => {
    for (const supplied of [undefined, "Damaged items"]) {
        const id = supplied ? "EXACT-STALE" : "EXACT-EMPTY", f = await approved(t, id);
        const result = await settleOrder({ orderId: id, finalAmount: 129.98, ...(supplied ? { underSettlementReason: supplied } : {}) }, { database: f.db, now: f.now });
        assert.equal(result.underSettlementReason, null); assert.equal(result.unusedAuthorizationAmount, 0);
        assert.equal((await f.db.getAsync("SELECT UnderSettlementReason FROM Settlements")).UnderSettlementReason, null);
    }
});

test("reason is snapshotted before queuing; failures roll it back with the order status", async t => {
    const f = await approved(t);
    let enter, release; const entered = new Promise(r => enter = r), gate = new Promise(r => release = r);
    const blocker = f.db.withTransaction(async () => { enter(); await gate; }); await entered;
    const input = { orderId: "WAREHOUSE", finalAmount: 80, underSettlementReason: "Damaged items" };
    const pending = settleOrder(input, { database: f.db, now: f.now }); input.underSettlementReason = "Other";
    release(); await blocker; assert.equal((await pending).underSettlementReason, "Damaged items");
    const g = await approved(t, "ROLLBACK");
    await g.db.runAsync("CREATE TRIGGER AbortStatus BEFORE UPDATE OF OrderStatus ON Orders BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
    await assert.rejects(settleOrder({ orderId: "ROLLBACK", finalAmount: 80, underSettlementReason: "Other" }, { database: g.db, now: g.now }));
    assert.equal((await g.db.getAsync("SELECT count(*) AS n FROM Settlements")).n, 0);
    assert.equal((await g.db.getAsync("SELECT OrderStatus FROM Orders")).OrderStatus, "Authorized");
});

test("warehouse preview uses actual authorization, toggles reason and computes exact cents", async t => {
    const f = await approved(t); await f.db.runAsync("UPDATE Orders SET OrderTotal=999");
    const { ui } = await page(f);
    assert.equal(ui.get("authorizedAmount").textContent, "$129.98");
    await amount(ui, "80.01", "Partial fulfillment");
    assert.equal(ui.get("unusedAmount").textContent, "$49.97"); assert.equal(ui.get("settlementAmount").textContent, "$80.01");
    assert.equal(ui.get("reasonField").hidden, false); assert.equal(ui.get("underSettlementReason").required, true);
    assert.equal(ui.get("unusedExplanation").hidden, false);
    await amount(ui, "129.98");
    assert.equal(ui.get("reasonField").hidden, true); assert.equal(ui.get("underSettlementReason").required, false);
    assert.equal(ui.get("underSettlementReason").value, ""); assert.equal(ui.get("unusedAmount").textContent, "$0.00");
    assert.equal(ui.get("unusedExplanation").hidden, true);
    for (const invalid of ["", "0", "-1", "80.001", "Infinity", "abc", "999999999999999999999", "130"]) {
        await amount(ui, invalid); assert.equal(ui.get("unusedAmount").textContent, "—");
    }
});

test("warehouse requires a reason, confirms authoritative values and displays saved history after reopening", async t => {
    const f = await approved(t), { ui, network } = await page(f);
    await amount(ui, "80"); await ui.get("settlementForm").dispatch("submit");
    assert.match(ui.get("result").textContent, /Choose a reason/);
    assert.equal(network.calls.filter(c => c.url === "/api/settlements").length, 0);
    ui.get("underSettlementReason").value = "Partial fulfillment";
    await Promise.all([ui.get("settlementForm").dispatch("submit"), ui.get("settlementForm").dispatch("submit")]);
    assert.equal(network.calls.filter(c => c.url === "/api/settlements").length, 1);
    assert.equal(ui.get("confirmation").hidden, false);
    assert.match(ui.get("confirmationDetails").textContent, /WAREHOUSE.*\$129.98.*\$80.00.*\$49.98.*Partial fulfillment.*Settled/);
    assert.equal(ui.get("confirmationExplanation").hidden, false); assert.equal(ui.get("settlementSubmitButton").disabled, true);
    const history = browser("warehouse.html", { search: "?orderId=WAREHOUSE", fetch: network.fetch }); history.runScripts();
    await waitFor(() => !history.get("settlementHistory").hidden);
    assert.match(history.get("historyDetails").textContent, /Partial fulfillment/);
    assert.equal(history.get("settlementSubmitButton").disabled, true);
});

test("warehouse exact confirmation omits reason and provider explanation", async t => {
    const f = await approved(t), { ui } = await page(f); await amount(ui, "129.98");
    await ui.get("settlementForm").dispatch("submit");
    assert.equal(ui.get("confirmation").hidden, false); assert.equal(ui.get("confirmationExplanation").hidden, true);
    assert.doesNotMatch(ui.get("confirmationDetails").textContent, /Reason for under-settlement/);
    assert.match(ui.get("confirmationDetails").textContent, /Unused authorization amount\$0.00/);
});

test("warehouse lookup ignores stale responses and prevents submit while the ID changes", async () => {
    const pending = [], calls = [];
    const fetch = (url) => { calls.push(url); return new Promise(resolve => pending.push(resolve)); };
    const ui = browser("warehouse.html", { search: "?orderId=FIRST", fetch }); ui.runScripts();
    await waitFor(() => pending.length === 1); assert.equal(ui.get("settlementSubmitButton").disabled, true);
    ui.get("orderId").value = "SECOND"; await ui.get("orderId").dispatch("input");
    await waitFor(() => pending.length === 2);
    const response = (id, amount) => ({ ok: true, status: 200, json: async () => ({ success: true, order: { OrderID: id, OrderStatus: "Authorized", LatestAuthorization: { AuthorizationAmount: amount, AuthorizationResult: "Success" }, Settlements: [] } }) });
    pending[1](response("SECOND", 200)); await waitFor(() => ui.get("authorizedAmount").textContent === "$200.00");
    pending[0](response("FIRST", 100)); await new Promise(r => setTimeout(r, 5));
    assert.equal(ui.get("authorizedAmount").textContent, "$200.00"); assert.equal(ui.get("settlementSubmitButton").disabled, false);
    ui.get("orderId").value = "THIRD"; await ui.get("orderId").dispatch("input");
    await amount(ui, "50", "Other"); await ui.get("settlementForm").dispatch("submit");
    assert.equal(calls.some(url => url === "/api/settlements"), false);
});

for (const mode of ["404", "network", "invalid-json", "invalid-response"]) test("warehouse fails closed on detail lookup " + mode, async () => {
    const ui = browser("warehouse.html", { search: "?orderId=LOOKUP", fetch: async () => {
        if (mode === "network") throw new Error("Synthetic");
        return { ok: mode !== "404", status: mode === "404" ? 404 : 200, json: async () => { if (mode === "invalid-json") throw new Error("JSON"); return {}; } };
    } }); ui.runScripts();
    await waitFor(() => /not found|Unable to load/.test(ui.get("orderDetailsStatus").textContent));
    assert.equal(ui.get("settlementSubmitButton").disabled, true); assert.equal(ui.get("authorizedAmount").textContent, "—");
});


test("committed authorization replaces a stale preview without trusting the browser amount", async t => {
    const f = await approved(t), { ui } = await page(f);
    await amount(ui, "80", "Other");
    assert.equal(ui.get("authorizedAmount").textContent, "$129.98");
    await f.db.runAsync("UPDATE PaymentAuthorizations SET AuthorizationAmount=100");
    await ui.get("settlementForm").dispatch("submit");
    assert.equal(ui.get("confirmation").hidden, false);
    assert.equal(ui.get("authorizedAmount").textContent, "$100.00");
    assert.equal(ui.get("unusedAmount").textContent, "$20.00");
    assert.match(ui.get("confirmationDetails").textContent, /Original authorization amount\$100.00/);
});
