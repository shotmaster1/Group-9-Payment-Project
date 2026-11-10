"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { fixture } = require("./helpers/payment-fixture");
const { browser, storage, waitFor, fillCheckout, fetchApplication } = require("./helpers/browser-fixture");
const cart = () => [{ ProductID: 1, quantity: 2, Name: "Tampered browser name", Price: 0.01 }];
async function checkout(f, options = {}) {
    const network = options.network || fetchApplication(f);
    const saved = options.storage || storage({ group9Cart: JSON.stringify(cart()) });
    const ui = browser("checkout.html", { sessionStorage: saved, fetch: network.fetch, search: "?amount=0.01&orderId=OLD-ORDER", ...options.browser });
    ui.runScripts();
    await waitFor(() => !ui.get("pay-button").disabled, "quote to load");
    fillCheckout(ui);
    return { ui, network, saved };
}

test("checkout ignores browser prices/URL amounts and displays the authoritative quote safely", async t => {
    const f = fixture(t), { ui, network } = await checkout(f);
    assert.equal(ui.get("order-total").textContent, "$129.98");
    assert.equal(ui.get("checkout-cart-total").textContent, "$129.98");
    assert.match(ui.get("checkout-items").textContent, /Trail Backpack/);
    assert.doesNotMatch(ui.get("checkout-items").textContent, /Tampered browser/);
    assert.equal(ui.get("order-id").textContent, "Assigned when you pay");
    assert.deepEqual(network.calls[0].body, { items: [{ productId: 1, quantity: 2 }] });
    assert.equal(f.provider.calls.length, 0);
});

test("checkout submits only IDs/quantities and a quote, then clears cart/card fields after confirmed persisted approval", async t => {
    const f = fixture(t), { ui, network, saved } = await checkout(f);
    await ui.get("pay-button").click();
    const sent = network.calls.find(call => call.url === "/api/payments").body;
    assert.deepEqual(sent.items, [{ productId: 1, quantity: 2 }]);
    for (const key of ["amount", "Price", "orderTotal", "total"]) assert.equal(Object.hasOwn(sent, key), false);
    assert.match(sent.orderId, /^ORD-SYNTHETIC-UUID-/); assert.notEqual(sent.orderId, "OLD-ORDER");
    assert.equal(saved.getItem("group9Cart"), null);
    assert.equal(ui.get("cardNumber").value, ""); assert.equal(ui.get("cvv").value, "");
    assert.match(ui.get("result").textContent, /Payment authorized/);
    assert.equal(ui.get("pay-button").disabled, true);
    assert.equal((await f.db.getAsync("SELECT OrderStatus FROM Orders")).OrderStatus, "Authorized");
});

test("rapid clicks and Enter submissions authorize only once", async t => {
    const f = fixture(t), { ui, network } = await checkout(f);
    const first = ui.get("pay-button").click();
    await Promise.all([ui.get("pay-button").click(), ui.document.dispatch("keydown", { key: "Enter", target: ui.get("email") })]);
    await first;
    assert.equal(network.calls.filter(call => call.url === "/api/payments").length, 1);
    assert.equal(f.provider.calls.filter(call => !call.oauth).length, 1);
    assert.equal(ui.get("pay-button").disabled, true);
});

test("declines preserve the cart and the next deliberate attempt gets a fresh Order ID", async t => {
    const provider = { body: { Success: false } }, f = fixture(t, provider);
    const { ui, network, saved } = await checkout(f);
    await ui.get("pay-button").click();
    assert.match(ui.get("result").textContent, /declined/);
    assert.equal(ui.get("pay-button").disabled, false); assert.notEqual(saved.getItem("group9Cart"), null);
    assert.equal(saved.getItem("group9PaymentAttempt"), null);
    provider.body.Success = true;
    await ui.get("pay-button").click();
    const attempts = network.calls.filter(call => call.url === "/api/payments");
    assert.equal(attempts.length, 2); assert.notEqual(attempts[0].body.orderId, attempts[1].body.orderId);
    assert.equal(saved.getItem("group9Cart"), null);
});

test("uncertain payments preserve the cart and lock retries across clicks, Enter and reload", async t => {
    const f = fixture(t, { network: "authorization" }), { ui, network, saved } = await checkout(f);
    await ui.get("pay-button").click();
    assert.match(ui.get("result").textContent, /Do not pay again/); assert.equal(ui.get("pay-button").disabled, true);
    assert.notEqual(saved.getItem("group9Cart"), null);
    await ui.get("pay-button").click(); await ui.document.dispatch("keydown", { key: "Enter", target: ui.get("email") });
    const reloaded = browser("checkout.html", { sessionStorage: saved, fetch: network.fetch }); reloaded.runScripts();
    assert.equal(reloaded.get("pay-button").disabled, true); assert.match(reloaded.get("result").textContent, /Do not pay again/);
    assert.equal(network.calls.filter(call => call.url === "/api/payments").length, 1);
});

test("expired or date-only approval is held for review without cart clearing or a second request", async t => {
    const f = fixture(t, { body: { TokenExpirationDate: "2030-01-08" } }), { ui, network, saved } = await checkout(f);
    await ui.get("pay-button").click(); await ui.get("pay-button").click();
    assert.equal(ui.get("pay-button").disabled, true); assert.notEqual(saved.getItem("group9Cart"), null);
    assert.equal(network.calls.filter(call => call.url === "/api/payments").length, 1);
    assert.equal((await f.db.getAsync("SELECT OrderStatus FROM Orders")).OrderStatus, "Payment Review");
});

test("a changed server price refreshes displayed totals and requires another explicit confirmation", async t => {
    const f = fixture(t), { ui, network, saved } = await checkout(f);
    await f.db.runAsync("UPDATE Products SET Price=65.99 WHERE ProductID=1");
    await ui.get("pay-button").click();
    assert.match(ui.get("result").textContent, /Review the current total/);
    assert.equal(ui.get("order-total").textContent, "$131.98"); assert.notEqual(saved.getItem("group9Cart"), null);
    assert.equal(f.provider.calls.length, 0);
    await ui.get("pay-button").click();
    assert.equal(f.provider.calls.find(call => !call.oauth).body.RequestedAmount, 131.98);
    const ids = network.calls.filter(call => call.url === "/api/payments").map(call => call.body.orderId);
    assert.notEqual(ids[0], ids[1]);
});

test("network failures and unreadable payment responses are never retried or treated as approvals", async t => {
    for (const mode of ["network", "invalid-json", "invalid-success"]) {
        const f = fixture(t);
        const network = fetchApplication(f, async url => {
            if (url !== "/api/payments") return null;
            if (mode === "network") throw new TypeError("Synthetic network error");
            return { ok: true, status: 200, json: async () => { if (mode === "invalid-json") throw new SyntaxError("Synthetic JSON"); return { success: true, message: "Incomplete" }; } };
        });
        const { ui, saved } = await checkout(f, { network });
        await ui.get("pay-button").click();
        assert.equal(ui.get("pay-button").disabled, true); assert.notEqual(saved.getItem("group9Cart"), null);
        await ui.get("pay-button").click();
        assert.equal(network.calls.filter(call => call.url === "/api/payments").length, 1);
    }
});

test("browser storage failure prevents authorization, and malformed previous-attempt markers block payment", async t => {
    const f = fixture(t), { ui, saved } = await checkout(f);
    saved.failWrites = true;
    await ui.get("pay-button").click();
    assert.match(ui.get("result").textContent, /Payment was not sent/); assert.equal(f.provider.calls.length, 0);
    const bad = storage({ group9Cart: JSON.stringify(cart()), group9PaymentAttempt: '{"state":"pending","orderId":123}' });
    const second = browser("checkout.html", { sessionStorage: bad, fetch: async () => { throw new Error("Must not fetch"); } }); second.runScripts();
    assert.equal(second.get("pay-button").disabled, true);
});

test("invalid form data, empty/malformed carts and missing secure IDs never contact the payment gateway", async t => {
    const f = fixture(t), { ui } = await checkout(f);
    ui.get("cvv").value = "12"; await ui.get("pay-button").click();
    assert.match(ui.get("cvv-error").textContent, /Security code/); assert.equal(f.provider.calls.length, 0);
    for (const savedCart of ["[]", "invalid JSON", '[{"ProductID":1,"quantity":0}]']) {
        const network = fetchApplication(f), saved = storage({ group9Cart: savedCart });
        const page = browser("checkout.html", { sessionStorage: saved, fetch: network.fetch }); page.runScripts();
        await waitFor(() => !page.get("pay-button").disabled);
        assert.equal(network.calls.filter(call => call.url === "/api/payments").length, 0);
    }
    const unsafe = await checkout(f, { browser: { crypto: {} } });
    await unsafe.ui.get("pay-button").click(); assert.match(unsafe.ui.get("result").textContent, /Payment was not sent/);
    assert.equal(f.provider.calls.length, 0);
});

test("cart mutations during payment remove only purchased quantities after approval", async t => {
    let saved;
    const f = fixture(t, { before: async oauth => {
        if (!oauth) saved.setItem("group9Cart", JSON.stringify([{ ProductID: 1, quantity: 3, Price: 64.99 }, { ProductID: 2, quantity: 1, Price: 24.99 }]));
    } });
    const page = await checkout(f); saved = page.saved;
    await page.ui.get("pay-button").click();
    assert.deepEqual(JSON.parse(saved.getItem("group9Cart")).map(item => [item.ProductID, item.quantity]), [[1, 1], [2, 1]]);
    assert.equal(page.ui.get("pay-button").disabled, true);
});

test("server catalog and quote names remain text nodes rather than executable HTML", async t => {
    const f = fixture(t); await f.db.runAsync("UPDATE Products SET Name='<img src=x onerror=synthetic()>' WHERE ProductID=1");
    const { ui } = await checkout(f);
    assert.match(ui.get("checkout-items").textContent, /<img src=x/);
    assert.ok(ui.get("checkout-items").children.every(row => row.children.every(child => child.tagName === "SPAN")));
});

test("full mocked storefront, checkout, dashboard, warehouse and settlement journey succeeds", async t => {
    const f = fixture(t), network = fetchApplication(f), saved = storage();
    const store = browser("index.html", { sessionStorage: saved, fetch: network.fetch }); store.runScripts();
    await waitFor(() => store.get("products").children.length === 5, "catalog products");
    await store.get("products").children[0].children.find(child => child.tagName === "BUTTON").click();
    await store.get("products").children[0].children.find(child => child.tagName === "BUTTON").click();
    await store.get("checkoutButton").click(); assert.equal(store.window.location.href, "checkout.html");
    const { ui } = await checkout(f, { network, storage: saved });
    await ui.get("pay-button").click(); const orderId = ui.get("order-id").textContent;
    assert.equal(saved.getItem("group9Cart"), null);
    const dashboard = browser("orders.html", { sessionStorage: saved, fetch: network.fetch });
    dashboard.get("statusFilter").value = "Authorized"; dashboard.get("sortOrder").value = "newest";
    dashboard.runScripts();
    await waitFor(() => dashboard.get("ordersTableBody").children[0]?.textContent.includes(orderId), "dashboard authorized order");
    const row = dashboard.get("ordersTableBody").children[0]; assert.equal(row.children.length, 10);
    assert.match(row.textContent, /1111/); assert.doesNotMatch(row.textContent, /4111111111111111|SYNTHETIC-AUTH/);
    const settleButton = row.children[9].children[0]; await settleButton.click();
    assert.equal(dashboard.window.location.href, "warehouse.html?orderId=" + encodeURIComponent(orderId));
    const warehouse = browser("warehouse.html", { sessionStorage: saved, fetch: network.fetch, search: "?orderId=" + encodeURIComponent(orderId) }); warehouse.runScripts();
    assert.equal(warehouse.get("orderId").value, orderId); warehouse.get("finalAmount").value = "80.00";
    await warehouse.get("settlementForm").dispatch("submit");
    assert.match(warehouse.get("result").textContent, /Successful settlement/); assert.equal(warehouse.get("settlementSubmitButton").disabled, true);
    const detail = await (await network.fetch("/api/orders/" + encodeURIComponent(orderId))).json();
    assert.equal(detail.order.OrderStatus, "Settled"); assert.equal(detail.order.Items.length, 1);
    assert.equal(detail.order.Settlements[0].FinalShipmentAmount, 80);
    assert.equal(f.provider.calls.filter(call => !call.oauth).length, 1);
});


test("malformed quote totals or lines cannot become payment attempts and can be safely reloaded", async t => {
    const f = fixture(t);
    let corrupt = true;
    const actual = fetchApplication(f);
    const network = { calls: actual.calls, fetch: async (url, options) => {
        const response = await actual.fetch(url, options);
        if (url !== "/api/payments/quote" || !corrupt) return response;
        const body = await response.json(); body.orderTotal = 0.01;
        return { ok: true, status: 200, json: async () => body };
    } };
    const { ui } = await checkout(f, { network });
    assert.match(ui.get("result").textContent, /invalid price quote/);
    assert.equal(f.provider.calls.length, 0);
    corrupt = false; await ui.get("pay-button").click();
    assert.equal(ui.get("order-total").textContent, "$129.98"); assert.equal(ui.get("result").textContent, "");
    assert.equal(network.calls.filter(call => call.url === "/api/payments").length, 0);
});


test("exact-match policy holds mismatched approvals for review and blocks repayment across reloads", async t => {
    const { settleOrder } = require("../server/services/settlementService");
    for (const amount of [80, 129.97, 129.99, 200]) {
        const f = fixture(t, { body: { AuthorizedAmount: amount } });
        const { ui, network, saved } = await checkout(f);
        const originalCart = saved.getItem("group9Cart");
        await ui.get("pay-button").click();
        const orderId = ui.get("order-id").textContent;
        assert.match(ui.get("result").textContent, /amount does not match the order total/);
        assert.match(ui.get("result").textContent, /Payment requires review/);
        assert.match(ui.get("result").textContent, /Do not submit this payment again until its status is confirmed/);
        assert.doesNotMatch(ui.get("result").textContent, /Payment authorized\./);
        assert.equal(ui.get("pay-button").disabled, true);
        assert.equal(saved.getItem("group9Cart"), originalCart);
        const order = await f.db.getAsync("SELECT OrderStatus, OrderTotal FROM Orders WHERE OrderID = ?", [orderId]);
        assert.deepEqual(order, { OrderStatus: "Payment Review", OrderTotal: 129.98 });
        const authorization = await f.db.getAsync("SELECT AuthorizationResult, AuthorizationAmount, AuthorizationToken, FailureReason FROM PaymentAuthorizations WHERE OrderID = ?", [orderId]);
        assert.deepEqual(authorization, { AuthorizationResult: "Success", AuthorizationAmount: amount, AuthorizationToken: "SYNTHETIC-AUTH-" + orderId, FailureReason: "AUTHORIZED_AMOUNT_MISMATCH" });
        await assert.rejects(settleOrder({ orderId, finalAmount: 1 }, { database: f.db, now: f.now }), { code: "ORDER_NOT_AUTHORIZED" });
        assert.equal((await f.db.getAsync("SELECT COUNT(*) AS count FROM Settlements")).count, 0);
        await ui.get("pay-button").click();
        await ui.document.dispatch("keydown", { key: "Enter", target: ui.get("email") });
        const reloaded = browser("checkout.html", { sessionStorage: saved, fetch: network.fetch });
        reloaded.runScripts();
        assert.equal(reloaded.get("pay-button").disabled, true);
        assert.match(reloaded.get("result").textContent, /Do not pay again/);
        assert.equal(reloaded.get("order-id").textContent, orderId);
        assert.equal(network.calls.filter(call => call.url === "/api/payments").length, 1);
        assert.equal(f.provider.calls.filter(call => !call.oauth).length, 1);
    }
});
