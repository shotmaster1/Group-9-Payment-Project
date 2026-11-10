"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { expirationNanoseconds, manhattanAuthorizationExpiration, AuthorizationExpirationError } = require("../server/services/authorizationExpiration");
const { fixture, mockProvider, card } = require("./helpers/payment-fixture");
const { createGatewayClient } = require("../server/services/paymentService");
const { listOrders, getOrderDetails } = require("../server/services/orderQueryService");
const { settleOrder } = require("../server/services/settlementService");
const { browser, storage, waitFor, fillCheckout, fetchApplication } = require("./helpers/browser-fixture");

test("Manhattan full timestamps use the approved UTC assumption while the generic parser stays strict", () => {
    const raw = "2027-03-31T00:00:00.000";
    assert.throws(() => expirationNanoseconds(raw), AuthorizationExpirationError);
    const result = manhattanAuthorizationExpiration(raw);
    assert.deepEqual(result, { nanoseconds: expirationNanoseconds(raw + "Z"), utc: raw + "Z", assumedUtc: true });
    assert.equal(manhattanAuthorizationExpiration("2030-01-01T12:00:00").utc, "2030-01-01T12:00:00Z");
    assert.equal(manhattanAuthorizationExpiration("2030-01-01T12:00:00Z").assumedUtc, false);
});

test("UTC normalization preserves offsets, pre-epoch instants and nanosecond precision", () => {
    const value = "2030-01-01T07:00:00.123456789-05:00";
    const result = manhattanAuthorizationExpiration(value);
    assert.equal(result.utc, "2030-01-01T12:00:00.123456789Z");
    assert.equal(result.nanoseconds, expirationNanoseconds(result.utc));
    const beforeEpoch = manhattanAuthorizationExpiration("1969-12-31T23:59:59.000000001");
    assert.equal(beforeEpoch.nanoseconds, -999999999n);
    assert.equal(beforeEpoch.utc, "1969-12-31T23:59:59.000000001Z");
    assert.equal(manhattanAuthorizationExpiration("2032-02-29T00:00:00.000").utc, "2032-02-29T00:00:00.000Z");
});

test("compatibility rejects date-only, missing, malformed, incomplete and impossible dates", () => {
    for (const raw of [null, undefined, 0, {}, [], "", " ", "2028-12-31", "2027-03-31T00:00",
        "2027-03-31 00:00:00.000", "2027-03-31T00:00:00.000 ", "2027-02-29T00:00:00.000",
        "2027-02-30T00:00:00.000", "2027-13-01T00:00:00.000", "2027-03-31T24:00:00",
        "2027-03-31T00:60:00", "2027-03-31T00:00:60", "2027-03-31T00:00:00.1234567890",
        "2027-03-31T00:00:00.000z", "2027-03-31T00:00:00+24:00", "<script>synthetic()</script>"]) {
        assert.throws(() => manhattanAuthorizationExpiration(raw), AuthorizationExpirationError);
    }
    assert.throws(() => manhattanAuthorizationExpiration("2028-12-31"), error =>
        error.code === "INVALID_EXPIRATION" && error.message.includes("UTC") && error.message.includes("date-only"));
});

test("payment stores exact raw expiration and returns UTC consistently through payment/list/detail APIs", async t => {
    for (const [raw, utc] of [
        ["2027-03-31T00:00:00.000", "2027-03-31T00:00:00.000Z"],
        ["2027-03-31T00:00:00", "2027-03-31T00:00:00Z"],
        ["2027-03-31T02:00:00.123456789+02:00", "2027-03-31T00:00:00.123456789Z"]
    ]) {
        const f = fixture(t, { body: { TokenExpirationDate: raw } });
        f.setTime(Date.parse("2026-11-10T12:00:00Z"));
        const payload = await f.payload();
        const response = await f.api("POST", "/", payload);
        assert.equal(response.status, 200); assert.equal(response.body.status, "Authorized");
        assert.equal(response.body.expirationDate, utc);
        const stored = await f.db.getAsync("SELECT AuthExpirationDate, FailureReason FROM PaymentAuthorizations");
        assert.deepEqual(stored, { AuthExpirationDate: raw, FailureReason: null });
        assert.equal((await listOrders({}, { database: f.db }))[0].AuthExpirationDate, utc);
        assert.equal((await getOrderDetails(payload.orderId, { database: f.db })).LatestAuthorization.AuthExpirationDate, utc);
        assert.equal((await f.api("POST", "/", payload)).status, 409);
        assert.equal(f.provider.calls.filter(call => !call.oauth).length, 1);
        assert.equal((await f.db.getAsync("SELECT AuthExpirationDate FROM PaymentAuthorizations")).AuthExpirationDate, raw);
    }
});

test("timezone-free authorization boundary accepts before and holds equality/after as expired", async t => {
    const raw = "2030-01-01T12:00:01.000", boundary = Date.parse(raw + "Z");
    for (const delta of [-1, 0, 1]) {
        const f = fixture(t, { body: { TokenExpirationDate: raw } });
        f.setTime(boundary + delta);
        const response = await f.api("POST", "/", await f.payload());
        assert.equal(response.status, delta < 0 ? 200 : 502);
        assert.equal(response.body.status, delta < 0 ? "Authorized" : "Payment Review");
        assert.equal(response.body.code, delta < 0 ? "PAYMENT_AUTHORIZED" : "AUTHORIZATION_EXPIRED");
        assert.equal((await f.db.getAsync("SELECT AuthExpirationDate FROM PaymentAuthorizations")).AuthExpirationDate, raw);
    }
});

test("settlement uses the same UTC boundary and preserves all raw authorization history", async t => {
    const raw = "2030-01-01T12:00:01.000", boundary = Date.parse(raw + "Z");
    for (const delta of [-1, 0, 1]) {
        const f = fixture(t, { body: { TokenExpirationDate: raw } });
        f.setTime(boundary - 10);
        const payment = await f.api("POST", "/", await f.payload());
        assert.equal(payment.status, 200);
        const before = await f.db.allAsync("SELECT * FROM PaymentAuthorizations");
        f.setTime(boundary + delta);
        const settling = settleOrder({ orderId: payment.body.orderId, finalAmount: 80 }, { database: f.db, now: f.now });
        if (delta < 0) assert.equal((await settling).unusedAuthorizationAmount, 49.98);
        else {
            await assert.rejects(settling, { code: "AUTHORIZATION_EXPIRED", statusCode: 400 });
            assert.equal((await f.db.getAsync("SELECT OrderStatus FROM Orders")).OrderStatus, "Authorized");
            assert.equal((await f.db.getAsync("SELECT COUNT(*) AS count FROM Settlements")).count, 0);
        }
        assert.deepEqual(await f.db.allAsync("SELECT * FROM PaymentAuthorizations"), before);
    }
});

test("invalid or expired approval values remain review outcomes without replacement expirations", async t => {
    for (const raw of [null, "", "2028-12-31", "2031-01-01T00:00", "2031-02-30T00:00:00.000", "2029-01-01T00:00:00.000"]) {
        const f = fixture(t, { body: { TokenExpirationDate: raw } });
        const result = await f.api("POST", "/", await f.payload());
        assert.equal(result.body.success, false); assert.equal(result.body.status, "Payment Review");
        assert.equal(result.body.code, raw === "2029-01-01T00:00:00.000" ? "AUTHORIZATION_EXPIRED" : "INVALID_AUTHORIZATION_EXPIRATION");
        assert.equal((await f.db.getAsync("SELECT AuthExpirationDate FROM PaymentAuthorizations")).AuthExpirationDate, raw);
        await assert.rejects(settleOrder({ orderId: result.body.orderId, finalAmount: 1 }, { database: f.db, now: f.now }), { code: "ORDER_NOT_AUTHORIZED" });
    }
});

test("valid mock expiration cannot bypass amount matching, token validation or a gateway decline", async t => {
    const raw = "2031-01-01T00:00:00.000";
    for (const [overrides, code, status] of [
        [{ AuthorizedAmount: 129.97 }, "AUTHORIZED_AMOUNT_MISMATCH", "Payment Review"],
        [{ AuthorizationToken: " " }, "INVALID_AUTHORIZATION_TOKEN", "Payment Review"],
        [{ Success: false }, "PAYMENT_DECLINED", "Payment Failed"]
    ]) {
        const f = fixture(t, { body: { TokenExpirationDate: raw, ...overrides } });
        const result = await f.api("POST", "/", await f.payload());
        assert.equal(result.body.success, false); assert.equal(result.body.code, code); assert.equal(result.body.status, status);
        await assert.rejects(settleOrder({ orderId: result.body.orderId, finalAmount: 1 }, { database: f.db, now: f.now }), { code: "ORDER_NOT_AUTHORIZED" });
    }
});

test("queries and compatibility never promote an existing Payment Review order or modify its records", async t => {
    const f = fixture(t), id = "EXISTING-REVIEW", raw = "2031-01-01T00:00:00.000";
    await f.db.runAsync("INSERT INTO Orders VALUES (?, 'Alex', 'alex@example.test', 'Synthetic', '', '', '', '2030-01-01', 129.98, 'Payment Review')", [id]);
    await f.db.runAsync("INSERT INTO PaymentAuthorizations (OrderID,AuthorizationAmount,TransactionDateTime,AuthExpirationDate,AuthorizationResult,FailureReason) VALUES (?,129.98,'2030-01-01',?,'Success','INVALID_AUTHORIZATION_EXPIRATION')", [id, raw]);
    const before = { orders: await f.db.allAsync("SELECT * FROM Orders"), authorizations: await f.db.allAsync("SELECT * FROM PaymentAuthorizations") };
    const rows = await listOrders({}, { database: f.db });
    const detail = await getOrderDetails(id, { database: f.db });
    assert.equal(rows[0].AuthExpirationDate, raw + "Z"); assert.equal(rows[0].OrderStatus, "Payment Review");
    assert.equal(detail.LatestAuthorization.AuthExpirationDate, raw + "Z"); assert.equal(detail.OrderStatus, "Payment Review");
    await assert.rejects(settleOrder({ orderId: id, finalAmount: 80 }, { database: f.db, now: f.now }), { code: "ORDER_NOT_AUTHORIZED" });
    assert.deepEqual({ orders: await f.db.allAsync("SELECT * FROM Orders"), authorizations: await f.db.allAsync("SELECT * FROM PaymentAuthorizations") }, before);
    assert.equal(f.provider.calls.length, 0);
});

test("actual checkout/dashboard/warehouse scripts complete the normalized mock timestamp workflow", async t => {
    const raw = "2027-03-31T00:00:00.000", f = fixture(t, { body: { TokenExpirationDate: raw } });
    f.setTime(Date.parse("2026-11-10T12:00:00Z"));
    const network = fetchApplication(f), saved = storage({ group9Cart: JSON.stringify([{ ProductID: 1, quantity: 2 }]) });
    const checkout = browser("checkout.html", { fetch: network.fetch, sessionStorage: saved });
    checkout.runScripts(); await waitFor(() => !checkout.get("pay-button").disabled); fillCheckout(checkout);
    await checkout.get("pay-button").click();
    assert.match(checkout.get("result").textContent, /Payment authorized/);
    assert.equal(saved.getItem("group9Cart"), null); assert.equal(checkout.get("pay-button").disabled, true);
    const id = checkout.get("order-id").textContent;
    const dashboard = browser("orders.html", { fetch: network.fetch });
    dashboard.get("statusFilter").value = "Authorized"; dashboard.get("sortOrder").value = "newest"; dashboard.runScripts();
    await waitFor(() => dashboard.get("ordersTableBody").children[0]?.textContent.includes(id));
    const row = dashboard.get("ordersTableBody").children[0];
    assert.equal(row.children.length, 10);
    assert.equal(row.children[8].textContent, "2027-03-31 00:00:00 UTC");
    await row.children[9].children[0].click();
    assert.equal(dashboard.window.location.href, "warehouse.html?orderId=" + encodeURIComponent(id));
    const warehouse = browser("warehouse.html", { fetch: network.fetch, search: "?orderId=" + encodeURIComponent(id) });
    warehouse.runScripts(); warehouse.get("finalAmount").value = "80.00";
    await Promise.all([warehouse.get("settlementForm").dispatch("submit"), warehouse.get("settlementForm").dispatch("submit")]);
    assert.match(warehouse.get("result").textContent, /Successful settlement/);
    assert.equal(warehouse.get("settlementSubmitButton").disabled, true);
    assert.equal((await f.db.getAsync("SELECT COUNT(*) AS count FROM Settlements")).count, 1);
    assert.equal((await f.db.getAsync("SELECT AuthExpirationDate FROM PaymentAuthorizations")).AuthExpirationDate, raw);
    const duplicate = await network.fetch("/api/settlements", { method: "POST", body: JSON.stringify({ orderId: id, finalAmount: 80 }) });
    assert.equal(duplicate.status, 400);
    assert.equal(f.provider.calls.filter(call => !call.oauth).length, 1);
});

test("UTC assumption and normalized response are identical across host timezones without Git history", () => {
    const modulePath = path.resolve(__dirname, "../server/services/authorizationExpiration.js");
    const code = 'const p=require(process.argv[1]);const r=p.manhattanAuthorizationExpiration("2027-03-31T00:00:00.000");console.log(JSON.stringify({utc:r.utc,ns:r.nanoseconds.toString()}));';
    const outputs = [];
    for (const TZ of ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Kiritimati"]) {
        const result = spawnSync(process.execPath, ["-e", code, modulePath], { env: { ...process.env, TZ }, encoding: "utf8", timeout: 5000 });
        assert.equal(result.status, 0, result.stderr); outputs.push(result.stdout);
    }
    assert.equal(new Set(outputs).size, 1);
    assert.equal(JSON.parse(outputs[0]).utc, "2027-03-31T00:00:00.000Z");
});

test("OAuth expiry caching remains strict for timezone-free full timestamps", async () => {
    const provider = mockProvider({ oauthBody: { access_token: "SYNTHETIC-OAUTH", expires_at: "2031-01-01T00:00:00.000" } });
    const client = createGatewayClient({ fetchImpl: provider.fetchImpl, env: { MA_MERCHANT_ID: "SYNTHETIC", MA_SECRET_KEY: "SYNTHETIC" }, now: () => Date.parse("2030-01-01T00:00:00Z") });
    for (const orderId of ["OAUTH-ONE", "OAUTH-TWO"]) assert.equal((await client.processPayment({ orderId, amount: 1, ...card() })).success, true);
    assert.equal(provider.calls.filter(call => call.oauth).length, 2);
});
