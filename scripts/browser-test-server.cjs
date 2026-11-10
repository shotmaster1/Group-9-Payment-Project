"use strict";

// Test-only process launcher. Importing this module never opens a database/listener.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const SCENARIOS = Object.freeze(["approved", "declined", "payment-review"]);
const OAUTH_URL = "https://capstoneproject.proxy.beeceptor.com/oauth/token";
const AUTHORIZE_URL = "https://capstoneproject.proxy.beeceptor.com/authorize";
const MERCHANT = "SYNTHETIC_BROWSER_MERCHANT";
const SECRET = "SYNTHETIC_BROWSER_SECRET";
const ACCESS_TOKEN = "SYNTHETIC_BROWSER_OAUTH";

function configuration(env) {
    const scenario = env.GROUP9_BROWSER_SCENARIO || "approved";
    if (!SCENARIOS.includes(scenario)) throw new Error("GROUP9_BROWSER_SCENARIO must be approved, declined, or payment-review.");
    const text = env.PORT === undefined ? "3100" : env.PORT;
    if (!/^\d+$/.test(text) || !Number.isInteger(Number(text)) || Number(text) > 65535) throw new Error("PORT must be an integer from 0 to 65535.");
    return { scenario, port: Number(text) }; // 0 selects an ephemeral port for automated checks.
}

function createMockGateway({ scenario, now = Date.now, onRequest = () => {} }) {
    configuration({ GROUP9_BROWSER_SCENARIO: scenario });
    const { toCents, fromCents, addCents } = require("../server/services/moneyService");
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    return async function mockFetch(input, options = {}) {
        const url = input instanceof URL ? input.href : input;
        if (url !== OAUTH_URL && url !== AUTHORIZE_URL) throw new Error("Browser-test outbound request blocked.");
        if (options.signal?.aborted) throw new Error("Synthetic gateway request aborted.");
        if (options.method !== "POST") return json(405, { Success: false });
        let body;
        try { body = JSON.parse(options.body); } catch { return json(400, { Success: false }); }
        if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { Success: false });
        const headers = new Headers(options.headers);
        if (url === OAUTH_URL) {
            if (Object.keys(body).sort().join(",") !== "merchantId,secretKey" || body.merchantId !== MERCHANT || body.secretKey !== SECRET) return json(401, { Success: false });
            onRequest({ kind: "oauth" });
            return json(200, { access_token: ACCESS_TOKEN, expires_in: 3600 });
        }
        if (headers.get("authorization") !== "Bearer " + ACCESS_TOKEN) return json(401, { Success: false });
        if (Object.keys(body).sort().join(",") !== "CardDetails,OrderId,RequestedAmount" ||
            typeof body.OrderId !== "string" || !body.OrderId.trim() || !body.CardDetails ||
            Object.keys(body.CardDetails).sort().join(",") !== "CCV,CardMonth,CardNumber,CardYear") return json(400, { Success: false });
        let cents;
        try {
            if (typeof body.RequestedAmount !== "number") throw new Error("Expected numeric dollars.");
            cents = toCents(body.RequestedAmount);
            if (cents <= 0) throw new Error("Expected a positive total.");
            if (scenario === "payment-review") cents = addCents(cents, 1);
        } catch { return json(400, { Success: false }); }
        onRequest({ kind: "authorization", orderId: body.OrderId });
        if (scenario === "declined") return json(200, { Success: false, OrderId: body.OrderId, Reason: "Synthetic insufficient funds" });
        return json(200, {
            Success: true, OrderId: body.OrderId, AuthorizationToken: "SYNTHETIC-BROWSER-AUTH-" + body.OrderId,
            AuthorizedAmount: fromCents(cents), TokenExpirationDate: new Date(now() + 7 * 86400000).toISOString()
        });
    };
}

function installNetworkGuards(mockFetch) {
    // No saved real fetch, delegation, DNS lookup, or outbound TCP/TLS connection.
    const blocked = () => { throw new Error("Browser-test outbound socket blocked."); };
    globalThis.fetch = mockFetch;
    for (const module of ["node:http", "node:https"]) {
        const transport = require(module);
        transport.request = blocked;
        transport.get = blocked;
    }
    const net = require("node:net");
    net.connect = blocked;
    net.createConnection = blocked;
    net.Socket.prototype.connect = blocked;
    require("node:tls").connect = blocked;
    require("node:module").syncBuiltinESMExports();
}

function restrictSQLite(sqlite3, filename) {
    const NativeDatabase = sqlite3.Database;
    function SyntheticDatabase(candidate, ...args) {
        if (candidate !== filename) throw new Error("Browser-test database isolation: only the newly created synthetic database may be opened.");
        return new NativeDatabase(candidate, ...args);
    }
    SyntheticDatabase.prototype = NativeDatabase.prototype;
    Object.setPrototypeOf(SyntheticDatabase, NativeDatabase);
    sqlite3.Database = SyntheticDatabase;
}

async function startBrowserTest() {
    const { scenario, port } = configuration(process.env);
    const project = path.resolve(__dirname, "..");
    // Require a fresh process; the guards must precede every application import.
    if (Object.keys(require.cache).some(name => name.startsWith(project + path.sep + "server" + path.sep))) throw new Error("Start browser testing in a fresh Node process.");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "group9-browser-"));
    const filename = path.join(fs.realpathSync(directory), "synthetic.sqlite");
    fs.closeSync(fs.openSync(filename, "wx", 0o600));
    process.env.DB_PATH = filename; // Ignore any inherited database/merchant configuration.
    process.env.PORT = String(port);
    process.env.MA_MERCHANT_ID = MERCHANT;
    process.env.MA_SECRET_KEY = SECRET;
    process.env.DOTENV_KEY = "";
    const notify = event => { if (process.connected) process.send(event); };
    installNetworkGuards(createMockGateway({
        scenario, onRequest: event => notify({ type: "group9-browser-gateway", ...event })
    }));
    restrictSQLite(require("sqlite3"), filename);
    const dotenv = require("dotenv"), originalConfig = dotenv.config;
    // The real server calls config(); redirect that read to the fresh temp directory.
    dotenv.config = options => originalConfig({ ...options, path: path.join(directory, ".env"), override: false, quiet: true });

    let database, server, stopping = false;
    async function shutdown(code = 0) {
        if (stopping) return;
        stopping = true;
        try {
            if (server?.listening) {
                const closing = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
                server.closeAllConnections();
                await closing;
            }
            if (database) await database.closeAsync();
            console.log("Browser testing stopped. Synthetic database retained: " + filename);
        } catch { code = 1; console.error("Browser-test shutdown could not be confirmed."); }
        process.exitCode = code;
        if (process.connected) process.disconnect();
    }
    try {
        database = require("../server/database/db");
        if (database.filename !== filename) throw new Error("Synthetic database path verification failed.");
        await database.ready;
        // Ensure this run starts with only the five synthetic catalog products.
        const counts = await database.getAsync("SELECT (SELECT COUNT(*) FROM Products) AS products, (SELECT COUNT(*) FROM Orders) AS orders, (SELECT COUNT(*) FROM PaymentAuthorizations) AS authorizations, (SELECT COUNT(*) FROM Settlements) AS settlements");
        if (counts.products !== 5 || counts.orders || counts.authorizations || counts.settlements) throw new Error("Fresh synthetic database verification failed.");
        const express = require("express"), originalListen = express.application.listen;
        let resolveListening, rejectListening;
        const listening = new Promise((resolve, reject) => { resolveListening = resolve; rejectListening = reject; });
        express.application.listen = function (_requestedPort, callback) {
            if (server) throw new Error("Browser-test listener already exists.");
            server = originalListen.call(this, port, "127.0.0.1", callback);
            server.once("error", rejectListening);
            server.once("listening", resolveListening);
            return server;
        };
        require("../server/server");
        await listening;
        const address = server.address();
        if (address.address !== "127.0.0.1" || database.filename !== filename) throw new Error("Browser-test isolation verification failed.");
        process.once("SIGINT", () => { void shutdown(); });
        process.once("SIGTERM", () => { void shutdown(); });
        const url = "http://127.0.0.1:" + address.port;
        console.log("BROWSER TEST ONLY | Gateway: mocked | Scenario: " + scenario);
        console.log("Website: " + url + "/");
        console.log("Synthetic database: " + filename);
        console.log("Stop: Ctrl+C. Every launch creates a new database.");
        notify({ type: "group9-browser-ready", url, filename, scenario, address });
        return { shutdown, filename, server };
    } catch (error) {
        await shutdown(1);
        throw error;
    }
}

module.exports = { SCENARIOS, configuration, createMockGateway, installNetworkGuards, restrictSQLite, startBrowserTest };
if (require.main === module) {
    startBrowserTest().catch(error => { console.error("Browser-test startup failed: " + error.message); process.exitCode = 1; });
}
