"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const launcher = path.resolve(__dirname, "../scripts/live-mock-test-server.cjs");
const L = require(launcher);
const { browser, storage, waitFor, fillCheckout } = require("./helpers/browser-fixture");
const credentials = { MA_MERCHANT_ID: "SYNTHETIC_PRIVATE_MERCHANT", MA_SECRET_KEY: "SYNTHETIC_PRIVATE_SECRET" };
const token = "SYNTHETIC_PRIVATE_OAUTH", authToken = "SYNTHETIC_PRIVATE_AUTHORIZATION";
const orderId = () => "ORD-" + crypto.randomUUID();
const oauth = () => ({ method: "POST", body: JSON.stringify({ merchantId: credentials.MA_MERCHANT_ID, secretKey: credentials.MA_SECRET_KEY }), headers: { "Content-Type": "application/json" } });
const authorization = (id = orderId()) => ({
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ OrderId: id, CardDetails: { CardNumber: L.TEST_CARD.cardNumber, CardMonth: 12, CardYear: 2035, CCV: "123" }, RequestedAmount: 64.99 })
});
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const approval = (request, overrides = {}) => ({ Success: true, OrderId: JSON.parse(request.body).OrderId,
    AuthorizationToken: authToken, AuthorizedAmount: 64.99, TokenExpirationDate: "2035-01-01T00:00:00Z", ...overrides });
function setup(transport) {
    const records = [], calls = [];
    const fetch = L.createGatewayFetch({ credentials, audit: value => records.push(value), transport: async (...args) => {
        calls.push(args); return transport(...args);
    } });
    return { fetch, records, calls };
}

test("live-mock launcher import is inert and explicit configuration never includes credentials", () => {
    assert.equal(require.cache[path.resolve(__dirname, "../server/database/database.js")], undefined);
    assert.equal(require.cache[path.resolve(__dirname, "../server/server.js")], undefined);
    assert.throws(() => L.configuration({}), { code: "EXPLICIT_START_APPROVAL_REQUIRED" });
    assert.throws(() => L.configuration({ GROUP9_LIVE_MOCK_APPROVED: "YES" }), { code: "ABSOLUTE_ENV_FILE_REQUIRED" });
    assert.throws(() => L.configuration({ GROUP9_LIVE_MOCK_APPROVED: "YES", GROUP9_MA_ENV_FILE: "relative/.env" }));
    const file = path.join(os.tmpdir(), ".env");
    assert.deepEqual(L.configuration({ GROUP9_LIVE_MOCK_APPROVED: "YES", GROUP9_MA_ENV_FILE: file, PORT: "9999" }), { credentialFile: file });
    assert.throws(() => L.configuration({ GROUP9_LIVE_MOCK_APPROVED: "YES", GROUP9_MA_ENV_FILE: file, NODE_TLS_REJECT_UNAUTHORIZED: "0" }), { code: "TLS_VERIFICATION_REQUIRED" });
    const source = fs.readFileSync(path.resolve(__dirname, "../server/services/paymentService.js"), "utf8");
    assert.ok(source.includes('"' + L.OAUTH_URL + '"')); assert.ok(source.includes('"' + L.AUTHORIZE_URL + '"'));
});

test("credential loader reads only two synthetic test-file keys and leaves the file unchanged", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "group9-live-credentials-"));
    t.after(() => fs.rmSync(directory, { recursive: true }));
    const file = path.join(directory, ".env");
    const original = "MA_MERCHANT_ID=" + credentials.MA_MERCHANT_ID + "\nMA_SECRET_KEY=" + credentials.MA_SECRET_KEY + "\nDB_PATH=DO_NOT_OPEN\nUNRELATED=DO_NOT_LOAD\n";
    fs.writeFileSync(file, original, { mode: 0o600 });
    assert.deepEqual(L.loadCredentials(file), credentials);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    fs.writeFileSync(file, "MA_MERCHANT_ID=ONLY_ONE\n");
    assert.throws(() => L.loadCredentials(file), { code: "CREDENTIALS_MISSING" });
    fs.writeFileSync(file, "x".repeat(65537));
    assert.throws(() => L.loadCredentials(file), { code: "CREDENTIAL_FILE_UNUSABLE" });
    assert.throws(() => L.loadCredentials(path.join(directory, "missing")), { code: "CREDENTIAL_FILE_UNREADABLE" });
});

test("live session rejects non-synthetic customers, cards and nonrandom order IDs", () => {
    const body = { customer: { ...L.SYNTHETIC_CUSTOMER }, ...L.TEST_CARD, orderId: orderId() };
    assert.equal(L.syntheticInput(body), true);
    assert.equal(L.syntheticInput({ ...body, customer: { ...body.customer, email: "different@example.test" } }), false);
    assert.equal(L.syntheticInput({ ...body, customer: { ...body.customer, extra: "not allowed" } }), false);
    assert.equal(L.syntheticInput({ ...body, cardNumber: "4242424242424242" }), false);
    assert.equal(L.syntheticInput({ ...body, ccv: "999" }), false);
    assert.equal(L.syntheticInput({ ...body, orderId: "CUSTOMER-PROVIDED-ID" }), false);
    assert.equal(L.syntheticInput({ items: [{ productId: 1, quantity: 1 }] }), true);
});

test("response diagnostics record schema and compatibility without exposing any returned values", () => {
    const request = { OrderId: orderId(), RequestedAmount: 64.99 };
    const text = JSON.stringify({ Success: true, OrderId: request.OrderId, AuthorizationToken: authToken,
        AuthorizedAmount: 64.99, TokenExpirationDate: "2035-01-01T00:00:00Z", Reason: "SYNTHETIC_PRIVATE_REASON",
        SYNTHETIC_PRIVATE_UNKNOWN_KEY: "SYNTHETIC_PRIVATE_UNKNOWN_VALUE" });
    const summary = L.responseStructure(text, "authorization", request, () => Date.parse("2030-01-01T00:00:00Z"));
    assert.equal(summary.fields.AuthorizationToken, "string"); assert.equal(summary.fields.Reason, "string");
    assert.equal(summary.unknownFieldCount, 1); assert.equal(summary.amountMatches, true); assert.equal(summary.orderIdMatches, true);
    assert.equal(summary.expirationFormat, "explicit-timezone"); assert.equal(summary.expirationValidity, "unexpired");
    assert.doesNotMatch(JSON.stringify(summary), /SYNTHETIC_PRIVATE|2035-01-01|64\.99/);
    assert.ok(!JSON.stringify(summary).includes(request.OrderId));
    for (const [text, json] of [["RAW_PRIVATE_NONJSON", "invalid"], ['"PRIVATE_STRING"', "string"], ["null", "null"], ["[]", "array"]]) {
        assert.deepEqual(L.responseStructure(text, "oauth", {}), { json });
    }
});

test("expiration diagnostics distinguish date-only, timezone-free, invalid, expired and offset values", () => {
    const base = { OrderId: orderId(), RequestedAmount: 1 }, now = () => Date.parse("2030-01-01T00:00:00Z");
    for (const [value, format, validity] of [
        ["2031-01-01", "date-only", "invalid"], ["2031-01-01T00:00:00", "timezone-free", "unexpired"],
        ["2030-01-01T00:00:00Z", "explicit-timezone", "expired"], ["2031-01-01T01:00:00+01:00", "explicit-timezone", "unexpired"],
        ["2031-02-30T00:00:00Z", "explicit-timezone", "invalid"], [null, "missing", "invalid"], [123, "non-string", "invalid"]
    ]) {
        const summary = L.responseStructure(JSON.stringify({ TokenExpirationDate: value }), "authorization", base, now);
        assert.equal(summary.expirationFormat, format); assert.equal(summary.expirationValidity, validity);
    }
});

test("gateway allowlist sends exact requests with redirects disabled and no caller-supplied transport options", async () => {
    const f = setup(async (url, request) => url === L.OAUTH_URL ? response({ access_token: token, expires_in: 3600 }) : response(approval(request)));
    const request = authorization();
    request.headers["X-Private"] = "DO_NOT_FORWARD";
    request.redirect = "follow"; request.dispatcher = "DO_NOT_USE"; request.credentials = "include";
    const result = await f.fetch(L.AUTHORIZE_URL, request);
    assert.equal(result.status, 200); assert.equal(JSON.parse(await result.text()).AuthorizationToken, authToken);
    const [, sent] = f.calls[0];
    assert.equal(sent.redirect, "manual"); assert.equal(sent.credentials, "omit"); assert.equal(sent.dispatcher, undefined);
    assert.deepEqual(Object.keys(sent.headers).sort(), ["Authorization", "Content-Type"]);
    const serialized = JSON.stringify(f.records);
    for (const value of [authToken, token, L.TEST_CARD.cardNumber, credentials.MA_SECRET_KEY, JSON.parse(request.body).OrderId]) assert.ok(!serialized.includes(value));
    assert.equal(f.records.find(record => record.phase === "headers").status, 200);
    await f.fetch(L.OAUTH_URL, oauth());
    assert.equal(f.records.at(-1).structure.fields.access_token, "string");
});

test("unexpected destinations, methods, credentials, and non-test card requests never reach transport", async () => {
    const f = setup(async () => { throw new Error("Must not reach transport"); });
    for (const url of ["https://example.invalid", L.OAUTH_URL + "?x=1", L.AUTHORIZE_URL + "#x", L.AUTHORIZE_URL + "/", L.AUTHORIZE_URL.replace("https:", "http:")]) {
        await assert.rejects(f.fetch(url, oauth()), { code: "DESTINATION_BLOCKED" });
    }
    await assert.rejects(f.fetch(L.OAUTH_URL, { ...oauth(), method: "GET" }), { code: "METHOD_BLOCKED" });
    await assert.rejects(f.fetch(L.OAUTH_URL, { ...oauth(), body: JSON.stringify({ merchantId: "WRONG", secretKey: "WRONG" }) }), { code: "REQUEST_SHAPE_BLOCKED" });
    const bad = authorization(), body = JSON.parse(bad.body);
    body.CardDetails.CardNumber = "4242424242424242";
    await assert.rejects(f.fetch(L.AUTHORIZE_URL, { ...bad, body: JSON.stringify(body) }), { code: "SYNTHETIC_REQUEST_REQUIRED" });
    assert.equal(f.calls.length, 0);
});

test("every redirect status is recorded and rejected without following Location", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
        const f = setup(async () => response({}, status, { Location: "https://example.invalid/PRIVATE" }));
        await assert.rejects(f.fetch(L.AUTHORIZE_URL, authorization()), { code: "REDIRECT_BLOCKED" });
        assert.equal(f.calls.length, 1);
        assert.equal(f.records.find(record => record.phase === "headers").status, status);
        assert.doesNotMatch(JSON.stringify(f.records), /example\.invalid|PRIVATE/);
    }
});

test("same Order ID is never sent twice after approval, decline, HTTP errors, malformed JSON or network failure", async () => {
    for (const outcome of ["approved", "declined", "401", "500", "malformed", "network"]) {
        const f = setup(async (_url, request) => {
            if (outcome === "network") throw new Error("SYNTHETIC_PRIVATE_EXCEPTION");
            if (outcome === "malformed") return new Response("SYNTHETIC_PRIVATE_NONJSON");
            if (outcome === "declined") return response({ Success: false });
            if (["401", "500"].includes(outcome)) return response({}, Number(outcome));
            return response(approval(request));
        });
        const request = authorization();
        try { await f.fetch(L.AUTHORIZE_URL, request); } catch (error) { assert.equal(error.code, "TRANSPORT_FAILED"); }
        await assert.rejects(f.fetch(L.AUTHORIZE_URL, request), { code: "AUTHORIZATION_REPLAY_BLOCKED" });
        assert.equal(f.calls.length, 1);
        assert.doesNotMatch(JSON.stringify(f.records), /SYNTHETIC_PRIVATE/);
    }
});

test("oversized bodies fail closed and sanitizer never records raw response data", async () => {
    const f = setup(async () => new Response("SYNTHETIC_PRIVATE_" + "x".repeat(65536)));
    await assert.rejects(f.fetch(L.AUTHORIZE_URL, authorization()), { code: "RESPONSE_TOO_LARGE" });
    assert.doesNotMatch(JSON.stringify(f.records), /SYNTHETIC_PRIVATE|xxxx/);
});

test("reviewed client cannot replay an external 401 authorization or retry a timed-out authorization", async () => {
    const { createGatewayClient } = require("../server/services/paymentService");
    for (const outcome of ["401", "timeout"]) {
        const f = setup(async (url, request) => {
            if (url === L.OAUTH_URL) return response({ access_token: token, expires_in: 3600 });
            if (outcome === "401") return response({}, 401);
            return new Promise((resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("SYNTHETIC_PRIVATE_TIMEOUT")), { once: true }));
        });
        const client = createGatewayClient({ fetchImpl: f.fetch, env: credentials, timeoutMs: 20 });
        const result = await client.processPayment({ orderId: orderId(), amount: 64.99, ...L.TEST_CARD });
        assert.equal(result.success, false); assert.equal(result.outcome, "uncertain");
        assert.equal(f.calls.filter(([url]) => url === L.AUTHORIZE_URL).length, 1);
        if (outcome === "timeout") { assert.equal(result.statusCode, 504); assert.equal(result.code, "PAYMENT_TIMEOUT"); }
        assert.doesNotMatch(JSON.stringify(f.records), /SYNTHETIC_PRIVATE/);
    }
});

test("socket guards deny all direct requests and allow socket shapes only for the approved TLS host", () => {
    assert.equal(L.allowedSocket([{ host: L.HOST, port: 443, servername: L.HOST }]), true);
    assert.equal(L.allowedSocket([[{ host: L.HOST, port: "443" }]]), true);
    for (const args of [[{ host: "example.invalid", port: 443 }], [{ host: L.HOST, port: 80 }], [{ host: L.HOST, port: 443, path: "/socket" }], [{ host: L.HOST, port: 443, servername: "example.invalid" }]]) assert.equal(L.allowedSocket(args), false);
    const code = [
        'const assert=require("node:assert/strict"),{AsyncLocalStorage}=require("node:async_hooks");',
        'const L=require(process.argv[1]),context=new AsyncLocalStorage();',
        'L.installOutboundGuards(context,async()=>{throw new Error("NO_FETCH");});',
        'for(const name of ["node:http","node:https"])for(const method of ["get","request"])assert.throws(()=>require(name)[method](L.OAUTH_URL),{code:"OUTBOUND_SOCKET_BLOCKED"});',
        'for(const module of ["node:net","node:tls"])assert.throws(()=>require(module).connect({host:L.HOST,port:443}),{code:"OUTBOUND_SOCKET_BLOCKED"});',
        'assert.throws(()=>new(require("node:net").Socket)().connect({host:L.HOST,port:443}),{code:"OUTBOUND_SOCKET_BLOCKED"});',
        'context.run({active:true},()=>assert.throws(()=>require("node:tls").connect({host:"example.invalid",port:443}),{code:"OUTBOUND_SOCKET_BLOCKED"}));'
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", code, launcher], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
});

test("running the CLI without the explicit approval gate does not load credentials or start a server", () => {
    const env = { ...process.env }; delete env.GROUP9_LIVE_MOCK_APPROVED; delete env.GROUP9_MA_ENV_FILE;
    const result = spawnSync(process.execPath, [launcher], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert.match(result.stderr, /EXPLICIT_START_APPROVAL_REQUIRED/);
    assert.doesNotMatch(result.stderr, /MA_SECRET|PRIVATE|Synthetic database/);
});

async function offlineServer(t, scenario) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "group9-live-offline-test-"));
    const file = path.join(directory, ".env"), sentinel = path.join(directory, "never-open.sqlite");
    fs.writeFileSync(file, "MA_MERCHANT_ID=" + credentials.MA_MERCHANT_ID + "\nMA_SECRET_KEY=" + credentials.MA_SECRET_KEY + "\n", { mode: 0o600 });
    fs.writeFileSync(sentinel, "SYNTHETIC_DATABASE_SENTINEL");
    const code = [
        'const L=require(process.argv[1]);',
        'L.startLiveMock({listenPort:0,transport:async(url,request)=>{',
        'const body=JSON.parse(request.body);process.send({type:"offline-request",oauth:url===L.OAUTH_URL});',
        'if(url===L.OAUTH_URL)return new Response(JSON.stringify({access_token:"SYNTHETIC_PRIVATE_OAUTH",expires_in:3600}));',
        'const scenario=process.env.OFFLINE_SCENARIO;',
        'const result={Success:scenario!=="declined",OrderId:body.OrderId,AuthorizationToken:"SYNTHETIC_PRIVATE_AUTHORIZATION",AuthorizedAmount:body.RequestedAmount,TokenExpirationDate:new Date(Date.now()+7*86400000).toISOString()};',
        'if(scenario==="declined")result.Reason="SYNTHETIC_PRIVATE_REASON";',
        'if(scenario==="date-only")result.TokenExpirationDate="2035-01-01";',
        'if(scenario==="timezone-free")result.TokenExpirationDate=result.TokenExpirationDate.slice(0,-1);',
        'if(scenario==="amount-mismatch")result.AuthorizedAmount=65;',
        'return new Response(JSON.stringify(result));',
        '}}).catch(()=>{console.error("OFFLINE_START_FAILED");process.exitCode=1;});'
    ].join("\n");
    const child = spawn(process.execPath, ["-e", code, launcher], {
        cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, GROUP9_LIVE_MOCK_APPROVED: "YES", GROUP9_MA_ENV_FILE: file, DB_PATH: sentinel,
            HOST: "0.0.0.0", PORT: "9999", OFFLINE_SCENARIO: scenario, NODE_TLS_REJECT_UNAUTHORIZED: "1" }
    });
    const events = []; let output = "", ready;
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    child.on("message", value => events.push(value));
    const exited = once(child, "exit");
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
            try { assert.deepEqual(await exited, [0, null]); } finally { clearTimeout(timer); }
        }
        assert.equal(fs.readFileSync(sentinel, "utf8"), "SYNTHETIC_DATABASE_SENTINEL");
        for (const value of [credentials.MA_MERCHANT_ID, credentials.MA_SECRET_KEY, token, authToken, L.TEST_CARD.cardNumber]) assert.ok(!output.includes(value), "Unexpected private value in launcher output");
        if (ready) {
            const generated = path.dirname(ready.filename);
            assert.match(path.basename(generated), /^group9-live-mock-/);
            assert.equal(path.dirname(fs.realpathSync(generated)), fs.realpathSync(os.tmpdir()));
            fs.rmSync(generated, { recursive: true });
        }
        fs.rmSync(directory, { recursive: true });
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Offline launcher timeout: " + output)), 10000);
        child.on("message", message => { if (message.type === "group9-live-mock-ready") { ready = message; clearTimeout(timer); resolve(); } });
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", () => { clearTimeout(timer); if (!ready) reject(new Error("Offline launcher exited: " + output)); });
    });
    assert.equal(ready.address.address, "127.0.0.1");
    assert.equal(fs.statSync(ready.filename).mode & 0o777, 0o600);
    assert.equal(fs.statSync(ready.logFile).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(ready.logFile, "utf8"), ""); assert.equal(events.filter(event => event.type === "offline-request").length, 0);
    return { ...ready, events, fetch: (url, options) => fetch(ready.url + url, { ...options, signal: options?.signal || AbortSignal.timeout(5000) }) };
}
for (const scenario of ["approved", "timezone-free", "declined", "date-only", "amount-mismatch"]) {
    test("offline-only live launcher exercises real checkout/HTTP " + scenario + " without contacting Beeceptor", { timeout: 20000 }, async t => {
        const f = await offlineServer(t, scenario);
        const catalog = await (await f.fetch("/api/products")).json(); assert.equal(catalog.products.length, 5);
        assert.equal((await (await f.fetch("/api/orders")).json()).count, 0);
        for (const url of ["/", "/checkout.html", "/orders.html", "/warehouse.html", "/img/p1.png"]) assert.equal((await f.fetch(url)).status, 200);
        const invalid = await f.fetch("/api/payments", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ customer: { ...L.SYNTHETIC_CUSTOMER, email: "other@example.test" }, ...L.TEST_CARD, orderId: orderId() }) });
        assert.equal(invalid.status, 400); assert.equal(f.events.filter(event => event.type === "offline-request").length, 0);
        const saved = storage({ group9Cart: JSON.stringify([{ ProductID: 1, quantity: 1 }]) });
        const ui = browser("checkout.html", { fetch: f.fetch, sessionStorage: saved, crypto: { randomUUID: crypto.randomUUID } });
        ui.runScripts(); await waitFor(() => !ui.get("pay-button").disabled, "offline live-launcher quote"); fillCheckout(ui);
        await Promise.all([ui.get("pay-button").click(), ui.get("pay-button").click(), ui.document.dispatch("keydown", { key: "Enter", target: ui.get("email") })]);
        const id = ui.get("order-id").textContent;
        const detail = await (await f.fetch("/api/orders/" + id)).json();
        const approved = scenario === "approved" || scenario === "timezone-free";
        const expectedStatus = approved ? "Authorized" : scenario === "declined" ? "Payment Failed" : "Payment Review";
        assert.equal(detail.order.OrderStatus, expectedStatus);
        assert.equal(saved.getItem("group9Cart") === null, approved);
        assert.equal(f.events.filter(event => event.type === "offline-request" && !event.oauth).length, 1);
        const log = fs.readFileSync(f.logFile, "utf8").trim().split("\n").map(JSON.parse);
        assert.equal(log.find(record => record.endpoint === "oauth" && record.phase === "headers").status, 200);
        const auth = log.find(record => record.endpoint === "authorization" && record.phase === "response");
        assert.equal(auth.structure.fields.AuthorizationToken, "string");
        assert.equal(auth.structure.expirationFormat, scenario === "date-only" ? "date-only" : scenario === "timezone-free" ? "timezone-free" : "explicit-timezone");
        if (scenario === "timezone-free") assert.equal(auth.structure.expirationAssumption, "manhattan-mock-utc");
        assert.equal(auth.structure.amountMatches, scenario !== "amount-mismatch");
        assert.doesNotMatch(JSON.stringify(log), /SYNTHETIC_PRIVATE|4111111111111111/);
        const settle = () => f.fetch("/api/settlements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: id, finalAmount: 40 }) });
        if (approved) {
            const settled = await settle(); assert.equal(settled.status, 200);
            assert.equal((await settled.json()).unusedAuthorizationAmount, 24.99);
            assert.equal((await settle()).status, 400);
        } else assert.equal((await settle()).status, 400);
        if (expectedStatus === "Payment Review") {
            const reload = browser("checkout.html", { fetch: f.fetch, sessionStorage: saved }); reload.runScripts();
            assert.equal(reload.get("pay-button").disabled, true);
            await reload.get("pay-button").click();
            assert.equal(f.events.filter(event => event.type === "offline-request" && !event.oauth).length, 1);
        }
    });
}
