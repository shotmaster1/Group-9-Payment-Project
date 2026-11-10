"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createGatewayClient } = require("../server/services/paymentService");
const { mockProvider, instant, card } = require("./helpers/payment-fixture");
const payment = () => ({ orderId: "SYNTHETIC", amount: 100, ...card() });
function client(options = {}, settings = {}) {
    const provider = mockProvider(options);
    const gateway = createGatewayClient({ fetchImpl: provider.fetchImpl, env: { MA_MERCHANT_ID: "SYNTHETIC", MA_SECRET_KEY: "SYNTHETIC" }, now: () => instant, timeoutMs: 20, ...settings });
    return { provider, gateway };
}

test("reviewed gateway sends correct OAuth and authorization fields without fabricated values", async () => {
    const { provider, gateway } = client();
    const result = await gateway.processPayment(payment());
    assert.equal(result.success, true); assert.equal(result.authorizationToken, "SYNTHETIC-AUTH-SYNTHETIC");
    assert.equal(result.authorizedAmount, 100); assert.equal(result.tokenExpirationDate, "2030-01-08T12:00:00Z");
    assert.deepEqual(provider.calls[0].body, { merchantId: "SYNTHETIC", secretKey: "SYNTHETIC" });
    assert.deepEqual(provider.calls[1].body, { OrderId: "SYNTHETIC", CardDetails: { CardNumber: "4111111111111111", CardMonth: 12, CardYear: 2035, CCV: "123" }, RequestedAmount: 100 });
    assert.equal(provider.calls[1].headers.Authorization, "Bearer SYNTHETIC-OAUTH-1");
});

test("missing gateway credentials fail closed before any network request", async () => {
    const { provider, gateway } = client({}, { env: {} });
    const result = await gateway.processPayment(payment());
    assert.equal(result.success, false); assert.equal(result.outcome, "rejected"); assert.equal(result.code, "PAYMENT_CONFIGURATION_ERROR");
    assert.equal(provider.calls.length, 0);
});

test("concurrent authorizations share one OAuth request and cache a known valid token", async () => {
    const { provider, gateway } = client();
    const results = await Promise.all(Array.from({ length: 5 }, () => gateway.processPayment(payment())));
    assert.ok(results.every(result => result.success));
    assert.equal(provider.calls.filter(call => call.oauth).length, 1);
    assert.equal(provider.calls.filter(call => !call.oauth).length, 5);
});

test("unknown, ambiguous or overflowing OAuth expiration is never cached", async () => {
    for (const oauthBody of [{ access_token: "SYNTHETIC" }, { access_token: "SYNTHETIC", expires_at: "2030-01-02" }, { access_token: "SYNTHETIC", expires_in: Number.MAX_VALUE }]) {
        const { provider, gateway } = client({ oauthBody });
        await gateway.processPayment(payment()); await gateway.processPayment(payment());
        assert.equal(provider.calls.filter(call => call.oauth).length, 2);
    }
});

test("OAuth expiry and 30-second refresh skew trigger a fresh token", async () => {
    let now = instant;
    const { provider, gateway } = client({}, { now: () => now });
    await gateway.processPayment(payment()); now += 3590 * 1000; await gateway.processPayment(payment());
    assert.equal(provider.calls.filter(call => call.oauth).length, 2);
});

test("one authorization 401 refreshes OAuth and retries only once", async () => {
    for (const options of [{ refresh: true }, { status: 401 }]) {
        const { provider, gateway } = client(options);
        const result = await gateway.processPayment(payment());
        assert.equal(provider.calls.filter(call => call.oauth).length, 2);
        assert.equal(provider.calls.filter(call => !call.oauth).length, 2);
        assert.equal(result.success, Boolean(options.refresh));
        if (!options.refresh) assert.equal(result.outcome, "rejected");
    }
});

test("HTTP 200 declines and explicit rejection statuses cannot become approvals", async () => {
    for (const options of [{ body: { Success: false } }, { status: 400 }, { status: 402 }, { status: 422 }]) {
        const { provider, gateway } = client(options);
        const result = await gateway.processPayment(payment());
        assert.equal(result.success, false); assert.ok(["rejected", "declined"].includes(result.outcome));
        assert.equal(provider.calls.filter(call => !call.oauth).length, 1);
    }
});

test("incomplete approval preserves actual supplied values and is marked uncertain", async () => {
    const { gateway } = client({ body: { TokenExpirationDate: null, AuthorizedAmount: 80 } });
    const result = await gateway.processPayment(payment());
    assert.equal(result.success, false); assert.equal(result.approvalReported, true);
    assert.equal(result.authorizedAmount, 80); assert.equal(result.tokenExpirationDate, null);
});

test("malformed responses, network failures and gateway 5xx are uncertain without automatic retries", async () => {
    for (const options of [{ invalidJson: true }, { status: 500 }, { network: "authorization" }, { body: { Success: "true" } }]) {
        const { provider, gateway } = client(options);
        const result = await gateway.processPayment(payment());
        assert.equal(result.success, false); assert.equal(result.outcome, "uncertain");
        assert.equal(provider.calls.filter(call => !call.oauth).length, 1);
        assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC-NETWORK-DETAIL/);
    }
});

test("OAuth failures are safe rejections with no authorization attempt", async () => {
    for (const options of [{ oauthStatus: 400 }, { network: "oauth" }, { oauthBody: null }]) {
        const { provider, gateway } = client(options);
        const result = await gateway.processPayment(payment());
        assert.equal(result.success, false); assert.equal(result.outcome, "rejected");
        assert.equal(provider.calls.filter(call => !call.oauth).length, 0);
    }
});

test("response-body timeout applies to OAuth and authorization, preserving uncertainty correctly", async () => {
    for (const target of ["oauth", "authorization"]) {
        const { provider, gateway } = client({ timeout: target });
        const result = await gateway.processPayment(payment());
        assert.equal(result.statusCode, 504); assert.equal(result.code, "PAYMENT_TIMEOUT");
        assert.equal(result.outcome, target === "oauth" ? "rejected" : "uncertain");
        assert.equal(provider.calls.filter(call => !call.oauth).length, target === "oauth" ? 0 : 1);
    }
});


test("approval claims on failure HTTP statuses are held uncertain and never trigger a 401 replay", async () => {
    for (const status of [400, 401, 500]) {
        const { provider, gateway } = client({ status, body: { Success: true } });
        const result = await gateway.processPayment(payment());
        assert.equal(result.success, false); assert.equal(result.approvalReported, true); assert.equal(result.outcome, "uncertain");
        assert.equal(result.code, "UNEXPECTED_APPROVAL_STATUS");
        assert.equal(provider.calls.filter(call => !call.oauth).length, 1);
    }
});
