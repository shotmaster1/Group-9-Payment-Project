"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { fork, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { configuration, createMockGateway, restrictSQLite } = require("../scripts/browser-test-server.cjs");
const { browser, storage, waitFor, fillCheckout } = require("./helpers/browser-fixture");
const project = path.resolve(__dirname, ".."), launcher = path.join(project, "scripts/browser-test-server.cjs");
const oauth = "https://capstoneproject.proxy.beeceptor.com/oauth/token";
const authorize = "https://capstoneproject.proxy.beeceptor.com/authorize";
const headers = { "Content-Type": "application/json" };
const credentials = { merchantId: "SYNTHETIC_BROWSER_MERCHANT", secretKey: "SYNTHETIC_BROWSER_SECRET" };
const post = body => ({ method: "POST", headers, body: JSON.stringify(body) });

function removeSyntheticDirectory(directory) {
    assert.match(path.basename(directory), /^group9-browser-/);
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(directory, { recursive: true });
}

async function start(t, scenario) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "group9-launcher-test-"));
    const sentinel = path.join(directory, "do-not-open.sqlite");
    const original = Buffer.from("Synthetic sentinel: must never be opened as SQLite.");
    fs.writeFileSync(sentinel, original);
    const child = fork(launcher, [], {
        cwd: project, silent: true,
        env: { ...process.env, PORT: "0", HOST: "0.0.0.0", DB_PATH: sentinel, GROUP9_BROWSER_SCENARIO: scenario,
            MA_MERCHANT_ID: "DO_NOT_USE_INHERITED_MERCHANT", MA_SECRET_KEY: "DO_NOT_USE_INHERITED_SECRET",
            DOTENV_KEY: "DO_NOT_LOAD_A_VAULT" }
    });
    const messages = [];
    let output = "", ready;
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    child.on("message", value => { messages.push(value); });
    const exited = once(child, "exit");
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
            const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
            try { await exited; } finally { clearTimeout(timer); }
        }
        assert.deepEqual(fs.readFileSync(sentinel), original);
        if (ready) removeSyntheticDirectory(path.dirname(ready.filename));
        fs.rmSync(directory, { recursive: true });
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Launcher did not become ready: " + output)), 10000);
        child.on("message", message => {
            if (message.type === "group9-browser-ready") { ready = message; clearTimeout(timer); resolve(); }
        });
        child.once("exit", code => { clearTimeout(timer); if (!ready) reject(new Error("Launcher exited " + code + ": " + output)); });
        child.once("error", error => { clearTimeout(timer); reject(error); });
    });
    assert.equal(ready.address.address, "127.0.0.1");
    assert.equal(ready.scenario, scenario);
    assert.equal(path.basename(ready.filename), "synthetic.sqlite");
    assert.notEqual(ready.filename, sentinel);
    assert.equal(fs.statSync(ready.filename).mode & 0o777, 0o600);
    const request = async (url, options) => {
        const response = await fetch(ready.url + url, { ...options, signal: AbortSignal.timeout(5000) });
        return { status: response.status, body: await response.json() };
    };
    return { ...ready, child, exited, messages, request, fetch: (url, options) => fetch(ready.url + url, { ...options, signal: options?.signal || AbortSignal.timeout(5000) }) };
}

async function purchase(f, saved = storage()) {
    const store = browser("index.html", { sessionStorage: saved, fetch: f.fetch });
    store.runScripts();
    await waitFor(() => store.get("products").children.length === 5, "real HTTP catalog");
    await store.get("products").children[0].children.find(node => node.tagName === "BUTTON").click();
    await store.get("checkoutButton").click();
    assert.equal(store.window.location.href, "checkout.html");
    const ui = browser("checkout.html", { sessionStorage: saved, fetch: f.fetch });
    ui.runScripts();
    await waitFor(() => !ui.get("pay-button").disabled, "real HTTP quote");
    assert.equal(ui.get("order-total").textContent, "$64.99");
    fillCheckout(ui);
    const first = ui.get("pay-button").click();
    await Promise.all([first, ui.get("pay-button").click(), ui.document.dispatch("keydown", { key: "Enter", target: ui.get("email") })]);
    return { ui, saved, orderId: ui.get("order-id").textContent };
}

test("browser launcher import is inert and configuration validates scenarios and ports", () => {
    assert.equal(require.cache[path.join(project, "server/database/database.js")], undefined);
    assert.equal(require.cache[path.join(project, "server/server.js")], undefined);
    assert.deepEqual(configuration({}), { scenario: "approved", port: 3100 });
    assert.deepEqual(configuration({ GROUP9_BROWSER_SCENARIO: "payment-review", PORT: "0" }), { scenario: "payment-review", port: 0 });
    for (const PORT of ["", "-1", "65536", "3e3", "3100x", "1.2"]) assert.throws(() => configuration({ PORT }));
    assert.throws(() => configuration({ GROUP9_BROWSER_SCENARIO: "live" }));
});

test("browser SQLite guard rejects every database except its exact synthetic filename", () => {
    const opened = [], synthetic = "/SYNTHETIC-ONLY/synthetic.sqlite";
    const sqlite3 = { Database: function (filename) { opened.push(filename); } };
    restrictSQLite(sqlite3, synthetic);
    for (const filename of [undefined, "", ":memory:", "ecommerce.db", "/another/synthetic.sqlite"]) {
        assert.throws(() => new sqlite3.Database(filename), /database isolation/);
    }
    new sqlite3.Database(synthetic);
    assert.deepEqual(opened, [synthetic]);
});

test("gateway mock accepts only exact endpoints and valid OAuth/authorization envelopes", async () => {
    const mock = createMockGateway({ scenario: "approved" });
    for (const url of ["https://example.invalid/", oauth + "?extra=1", "http://capstoneproject.proxy.beeceptor.com/authorize", authorize + "/"]) {
        await assert.rejects(mock(url, post({})), /outbound request blocked/);
    }
    assert.equal((await mock(oauth, { method: "GET" })).status, 405);
    assert.equal((await mock(oauth, { ...post({}), body: "{" })).status, 400);
    assert.equal((await mock(oauth, post({ merchantId: "WRONG", secretKey: "WRONG" }))).status, 401);
    assert.equal((await mock(authorize, post({}))).status, 401);
    const token = await (await mock(oauth, post(credentials))).json();
    const authenticated = { ...headers, Authorization: "Bearer " + token.access_token };
    assert.equal((await mock(authorize, { ...post({}), headers: authenticated })).status, 400);
});

test("gateway scenarios preserve real protocol fields and review uses an exact one-cent mismatch", async () => {
    const body = { OrderId: "SYNTHETIC", RequestedAmount: 64.99, CardDetails: { CardNumber: "4111111111111111", CardMonth: 12, CardYear: 2035, CCV: "123" } };
    for (const scenario of ["approved", "declined", "payment-review"]) {
        const events = [], now = Date.parse("2030-01-01T00:00:00Z");
        const mock = createMockGateway({ scenario, now: () => now, onRequest: event => events.push(event) });
        const token = await (await mock(oauth, post(credentials))).json();
        const result = await (await mock(authorize, { ...post(body), headers: { ...headers, Authorization: "Bearer " + token.access_token } })).json();
        assert.equal(result.OrderId, body.OrderId);
        assert.equal(result.Success, scenario !== "declined");
        if (result.Success) {
            assert.equal(result.AuthorizedAmount, scenario === "approved" ? 64.99 : 65);
            assert.equal(result.TokenExpirationDate, "2030-01-08T00:00:00.000Z");
            assert.match(result.AuthorizationToken, /^SYNTHETIC-BROWSER-AUTH-/);
        } else assert.match(result.Reason, /insufficient/);
        assert.deepEqual(events, [{ kind: "oauth" }, { kind: "authorization", orderId: "SYNTHETIC" }]);
    }
});

test("outbound guards reject fetch, HTTP, HTTPS, TCP and TLS before any connection", () => {
    const code = [
        'const assert = require("node:assert/strict");',
        'const { installNetworkGuards, createMockGateway } = require(' + JSON.stringify(launcher) + ');',
        'installNetworkGuards(createMockGateway({ scenario: "approved" }));',
        '(async () => {',
        'await assert.rejects(fetch("https://example.invalid"), /outbound request blocked/);',
        'for (const name of ["node:http", "node:https"]) for (const method of ["request", "get"]) assert.throws(() => require(name)[method]("https://example.invalid"), /outbound socket blocked/);',
        'assert.throws(() => require("node:net").connect(443, "example.invalid"), /outbound socket blocked/);',
        'assert.throws(() => require("node:net").createConnection({port: 443, host: "example.invalid"}), /outbound socket blocked/);',
        'assert.throws(() => new (require("node:net").Socket)().connect(443, "example.invalid"), /outbound socket blocked/);',
        'assert.throws(() => require("node:tls").connect(443, "example.invalid"), /outbound socket blocked/);',
        '})().catch(error => { console.error(error); process.exitCode = 1; });'
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
});

test("real server serves all pages, scripts, stylesheet and PNGs from a fresh isolated database", { timeout: 20000 }, async t => {
    const f = await start(t, "approved");
    assert.deepEqual(await f.request("/api/test"), { status: 200, body: { message: "Group 9 server is online." } });
    assert.equal((await f.request("/api/orders")).body.count, 0);
    const catalog = (await f.request("/api/products")).body.products;
    assert.equal(catalog.length, 5);
    const assets = new Set(["/", "/index.html", "/checkout.html", "/orders.html", "/warehouse.html"]);
    for (const page of ["index.html", "checkout.html", "orders.html", "warehouse.html"]) {
        const html = fs.readFileSync(path.join(project, "client", page), "utf8");
        for (const [, asset] of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
            if (/\.(?:js|css)$/.test(asset)) assets.add("/" + asset.replace(/^\//, ""));
        }
    }
    for (const product of catalog) {
        assert.match(product.ImageURL, /^\/img\/p[1-5]\.png$/);
        assets.add(product.ImageURL);
    }
    for (const asset of assets) {
        const response = await fetch(f.url + asset, { signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200, asset);
        const file = path.join(project, "client", asset === "/" ? "index.html" : asset.slice(1));
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(file), asset);
    }
    assert.equal((await f.request("/api/orders/MISSING-SYNTHETIC")).status, 404);
    assert.equal((await f.request("/api/settlements", post({ orderId: "MISSING-SYNTHETIC", finalAmount: 1 }))).status, 404);
    assert.equal(f.messages.filter(message => message.kind === "authorization").length, 0);
    f.child.kill("SIGINT");
    assert.deepEqual(await f.exited, [0, null]);
    assert.ok(fs.existsSync(f.filename)); // Ctrl+C closes, but does not erase test history.
});

test("actual frontend and HTTP routes complete approved checkout, dashboard, under/exact settlement and duplicate rejection", { timeout: 20000 }, async t => {
    const f = await start(t, "approved");
    const { ui, saved, orderId } = await purchase(f);
    assert.match(ui.get("result").textContent, /Payment authorized/);
    assert.equal(saved.getItem("group9Cart"), null);
    assert.equal((await f.request("/api/orders/" + orderId)).body.order.OrderStatus, "Authorized");
    const filtered = await f.request("/api/orders?status=Authorized&search=alex%40example.test&sort=oldest");
    assert.equal(filtered.status, 200); assert.deepEqual(filtered.body.orders.map(order => order.OrderID), [orderId]);
    const quoted = await f.request("/api/payments/quote", post({ items: [{ productId: 1, quantity: 1 }] }));
    const duplicate = await f.request("/api/payments", post({
        orderId, items: [{ productId: 1, quantity: 1 }], quoteToken: quoted.body.quoteToken,
        customer: { firstName: "Alex", lastName: "Example", email: "alex@example.test", address: "100 Synthetic Way", city: "City", state: "ST", zip: "00000" },
        cardNumber: "4111111111111111", cardMonth: 12, cardYear: 2035, ccv: "123", cardType: "visa"
    }));
    assert.equal(duplicate.status, 409);
    const dashboard = browser("orders.html", { fetch: f.fetch });
    dashboard.get("statusFilter").value = "Authorized"; dashboard.get("sortOrder").value = "newest";
    dashboard.runScripts();
    await waitFor(() => dashboard.get("ordersTableBody").children[0]?.textContent.includes(orderId), "HTTP dashboard");
    const row = dashboard.get("ordersTableBody").children[0];
    assert.equal(row.children.length, 10);
    assert.doesNotMatch(row.textContent, /4111111111111111|SYNTHETIC-BROWSER-AUTH/);
    await row.children[9].children[0].click();
    assert.equal(dashboard.window.location.href, "warehouse.html?orderId=" + encodeURIComponent(orderId));
    const warehouse = browser("warehouse.html", { fetch: f.fetch, search: "?orderId=" + encodeURIComponent(orderId) });
    warehouse.runScripts();
    assert.equal(warehouse.get("orderId").value, orderId);
    warehouse.get("finalAmount").value = "65.00";
    await warehouse.get("settlementForm").dispatch("submit");
    assert.match(warehouse.get("result").textContent, /exceeds authorized amount/);
    assert.equal(warehouse.get("settlementSubmitButton").disabled, false);
    warehouse.get("finalAmount").value = "40.00";
    await Promise.all([warehouse.get("settlementForm").dispatch("submit"), warehouse.get("settlementForm").dispatch("submit")]);
    assert.match(warehouse.get("result").textContent, /Successful settlement/);
    assert.equal(warehouse.get("settlementSubmitButton").disabled, true);
    const detail = (await f.request("/api/orders/" + orderId)).body.order;
    assert.equal(detail.OrderStatus, "Settled"); assert.equal(detail.Settlements.length, 1);
    assert.equal(detail.Settlements[0].FinalShipmentAmount, 40);
    assert.equal((await f.request("/api/settlements", post({ orderId, finalAmount: 40 }))).status, 400);
    const second = await purchase(f);
    const concurrent = await Promise.all([1, 2].map(() => f.request("/api/settlements", post({ orderId: second.orderId, finalAmount: 64.99 }))));
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 400]);
    assert.equal(concurrent.find(response => response.status === 200).body.unusedAuthorizationAmount, 0);
    assert.equal((await f.request("/api/orders/" + second.orderId)).body.order.Settlements.length, 1);
    const third = await purchase(f);
    const under = await f.request("/api/settlements", post({ orderId: third.orderId, finalAmount: 40 }));
    assert.equal(under.status, 200); assert.equal(under.body.unusedAuthorizationAmount, 24.99);
    assert.equal(f.messages.filter(message => message.kind === "authorization").length, 3);
});

for (const scenario of ["declined", "payment-review"]) {
    test("actual checkout/HTTP " + scenario + " retains the cart and blocks settlement", { timeout: 20000 }, async t => {
        const f = await start(t, scenario);
        const { ui, saved, orderId } = await purchase(f);
        assert.notEqual(saved.getItem("group9Cart"), null);
        const detail = (await f.request("/api/orders/" + orderId)).body.order;
        assert.equal(detail.OrderStatus, scenario === "declined" ? "Payment Failed" : "Payment Review");
        assert.equal((await f.request("/api/settlements", post({ orderId, finalAmount: 1 }))).status, 400);
        if (scenario === "payment-review") {
            assert.match(ui.get("result").textContent, /amount does not match/);
            assert.equal(detail.LatestAuthorization.AuthorizationAmount, 65);
            assert.equal(ui.get("pay-button").disabled, true);
            await ui.get("pay-button").click();
            const reloaded = browser("checkout.html", { fetch: f.fetch, sessionStorage: saved });
            reloaded.runScripts();
            assert.equal(reloaded.get("pay-button").disabled, true);
            assert.match(reloaded.get("result").textContent, /Do not pay again/);
        } else {
            assert.match(ui.get("result").textContent, /declined/);
            assert.equal(ui.get("pay-button").disabled, false);
            await ui.get("pay-button").click();
            assert.notEqual(ui.get("order-id").textContent, orderId);
        }
        assert.equal(f.messages.filter(message => message.kind === "authorization").length, scenario === "declined" ? 2 : 1);
    });
}
