"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createDatabase } = require("../../server/database/database");
const { createGatewayClient } = require("../../server/services/paymentService");
const { createQuoteService } = require("../../server/services/paymentQuoteService");
const { createPaymentRouter } = require("../../server/routes/payments");
const instant = Date.parse("2030-01-01T12:00:00Z");
const customer = () => ({ firstName: "Alex", lastName: "Example", email: "alex@example.test", address: "100 Synthetic Way", city: "City", state: "ST", zip: "00000" });
const card = () => ({ cardNumber: "4111111111111111", cardMonth: 12, cardYear: 2035, ccv: "123", cardType: "visa" });
function mockProvider(options = {}) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const oauth = url.endsWith("/oauth/token"), body = JSON.parse(init.body);
        calls.push({ oauth, body, headers: init.headers });
        if (options.network === (oauth ? "oauth" : "authorization")) throw new TypeError("SYNTHETIC-NETWORK-DETAIL");
        if (options.before) await options.before(oauth, body);
        const authCount = calls.filter(call => !call.oauth).length;
        const status = oauth ? (options.oauthStatus || 200) : options.refresh && authCount === 1 ? 401 : (options.status || 200);
        let responseBody = oauth ? { access_token: "SYNTHETIC-OAUTH-" + calls.filter(call => call.oauth).length, expires_in: 3600 }
            : { Success: status === 200, OrderId: body.OrderId, AuthorizationToken: "SYNTHETIC-AUTH-" + body.OrderId, AuthorizedAmount: body.RequestedAmount, TokenExpirationDate: "2030-01-08T12:00:00Z", ...options.body };
        if (oauth && options.oauthBody !== undefined) responseBody = options.oauthBody;
        return { status, ok: status >= 200 && status < 300, text: async () => {
            if (options.timeout === (oauth ? "oauth" : "authorization")) return new Promise((resolve, reject) => {
                if (init.signal.aborted) return reject(new Error("Synthetic abort"));
                init.signal.addEventListener("abort", () => reject(new Error("Synthetic abort")), { once: true });
            });
            return !oauth && options.invalidJson ? "{invalid-json" : JSON.stringify(responseBody);
        } };
    };
    return { calls, fetchImpl };
}
function request(router, method, url, body) {
    return new Promise((resolve, reject) => {
        let status = 200;
        const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: JSON.parse(JSON.stringify(value)) }); } };
        router.handle({ method, url, body, query: Object.fromEntries(new URL(url, "http://synthetic.local").searchParams) }, res, error => reject(error || new Error("No route matched: " + url)));
    });
}
function fixture(t, providerOptions = {}, configuration = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "group9-purchase-"));
    const filename = path.join(directory, "synthetic.sqlite"), connections = [];
    const open = () => { const db = createDatabase({ filename }); connections.push(db); return db; };
    const db = open(), provider = mockProvider(providerOptions);
    let current = instant;
    const now = () => current;
    const gateway = createGatewayClient({ fetchImpl: provider.fetchImpl, env: { MA_MERCHANT_ID: "SYNTHETIC", MA_SECRET_KEY: "SYNTHETIC" }, now, timeoutMs: 30, ...configuration });
    const quotes = createQuoteService({ key: Buffer.alloc(32, 7), now });
    const router = createPaymentRouter({ database: db, gateway, quotes, now });
    t.after(async () => { await Promise.all(connections.map(connection => connection.closeAsync())); fs.rmSync(directory, { recursive: true }); });
    const api = (method, url, body) => request(router, method, url, body);
    async function payload(orderId = "SYNTHETIC-ORDER", items = [{ productId: 1, quantity: 2 }]) {
        const quoted = await api("POST", "/quote", { items });
        if (quoted.status !== 200) throw new Error("Synthetic quote setup failed: " + quoted.body.message);
        return { orderId, customer: customer(), items, quoteToken: quoted.body.quoteToken, ...card() };
    }
    return { db, open, provider, gateway, quotes, api, payload, now, setTime(value) { current = value; } };
}
module.exports = { fixture, request, mockProvider, instant, customer, card };
