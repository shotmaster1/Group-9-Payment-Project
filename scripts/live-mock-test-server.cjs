"use strict";

// Dedicated manual-testing process. Importing this file performs no I/O or requests.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { restrictSQLite } = require("./browser-test-server.cjs");
const HOST = "capstoneproject.proxy.beeceptor.com";
const OAUTH_URL = "https://" + HOST + "/oauth/token";
const AUTHORIZE_URL = "https://" + HOST + "/authorize";
const SYNTHETIC_CUSTOMER = Object.freeze({
    firstName: "Alex", lastName: "Example", email: "alex@example.test",
    address: "100 Synthetic Way", city: "City", state: "ST", zip: "00000"
});
const TEST_CARD = Object.freeze({ cardNumber: "4111111111111111", cardMonth: 12, cardYear: 2035, ccv: "123" });
const ORDER_ID = /^ORD-(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const MAX_BODY = 65536;
class IsolationError extends Error {
    constructor(code) { super(code); this.name = "IsolationError"; this.code = code; }
}
const fail = code => { throw new IsolationError(code); };
const kind = value => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
function exactFields(value, names) {
    return value && typeof value === "object" && !Array.isArray(value) &&
        Object.keys(value).sort().join(",") === [...names].sort().join(",");
}
function configuration(env) {
    if (env.GROUP9_LIVE_MOCK_APPROVED !== "YES") fail("EXPLICIT_START_APPROVAL_REQUIRED");
    if (typeof env.GROUP9_MA_ENV_FILE !== "string" || !path.isAbsolute(env.GROUP9_MA_ENV_FILE) ||
        path.basename(env.GROUP9_MA_ENV_FILE) !== ".env") fail("ABSOLUTE_ENV_FILE_REQUIRED");
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") fail("TLS_VERIFICATION_REQUIRED");
    return { credentialFile: env.GROUP9_MA_ENV_FILE };
}
function loadCredentials(filename) {
    // Read only these two keys. Never call dotenv.config on the original checkout.
    try {
        const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let bytes;
        try {
            const stat = fs.fstatSync(descriptor);
            if (!stat.isFile() || stat.size > MAX_BODY) fail("CREDENTIAL_FILE_UNUSABLE");
            bytes = fs.readFileSync(descriptor);
        } finally { fs.closeSync(descriptor); }
        const parsed = require("dotenv").parse(bytes);
        const result = { MA_MERCHANT_ID: parsed.MA_MERCHANT_ID, MA_SECRET_KEY: parsed.MA_SECRET_KEY };
        if (Object.values(result).some(value => typeof value !== "string" || !value.trim())) fail("CREDENTIALS_MISSING");
        return result;
    } catch (error) {
        if (error instanceof IsolationError) throw error;
        fail("CREDENTIAL_FILE_UNREADABLE");
    }
}
function syntheticInput(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return true; // Existing routes reject malformed input.
    if (Object.hasOwn(body, "customer") && (!exactFields(body.customer, Object.keys(SYNTHETIC_CUSTOMER)) ||
        Object.entries(SYNTHETIC_CUSTOMER).some(([name, value]) => body.customer[name] !== value))) return false;
    if (Object.hasOwn(body, "orderId") && (typeof body.orderId !== "string" || !ORDER_ID.test(body.orderId))) return false;
    if (Object.hasOwn(body, "cardNumber") && Object.entries(TEST_CARD).some(([name, value]) => body[name] !== value)) return false;
    return true;
}
function responseStructure(text, endpoint, requested, now = Date.now) {
    let data;
    try { data = JSON.parse(text); } catch { return { json: "invalid" }; }
    if (!data || typeof data !== "object" || Array.isArray(data)) return { json: kind(data) };
    // Unknown field names might contain sensitive values. Count them, never log them.
    const known = ["access_token", "expires_in", "expires_at", "expiresAt", "Success", "OrderId",
        "AuthorizationToken", "AuthorizedAmount", "TokenExpirationDate", "Reason"];
    const fields = Object.fromEntries(known.filter(name => Object.hasOwn(data, name)).map(name => [name, kind(data[name])]));
    const summary = { json: "object", fields, unknownFieldCount: Object.keys(data).filter(name => !known.includes(name)).length };
    if (endpoint === "authorization") {
        summary.successFlag = data.Success === true ? "true" : data.Success === false ? "false" : "missing-or-invalid";
        summary.orderIdMatches = data.OrderId === requested.OrderId;
        try {
            const { toCents } = require("../server/services/moneyService");
            summary.amountMatches = toCents(data.AuthorizedAmount) === toCents(requested.RequestedAmount);
        } catch { summary.amountMatches = false; }
        const expiration = data.TokenExpirationDate;
        summary.expirationFormat = expiration == null ? "missing"
            : typeof expiration !== "string" ? "non-string"
            : /^\d{4}-\d{2}-\d{2}$/.test(expiration) ? "date-only"
            : /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(expiration) ? "explicit-timezone"
            : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/.test(expiration) ? "timezone-free"
            : /^\d{4}-\d{2}-\d{2}T/.test(expiration) ? "timezone-free-or-malformed" : "unrecognized";
        try {
            const { manhattanAuthorizationExpiration } = require("../server/services/authorizationExpiration");
            const resolved = manhattanAuthorizationExpiration(expiration);
            summary.expirationValidity = resolved.nanoseconds > BigInt(now()) * 1000000n ? "unexpired" : "expired";
            if (resolved.assumedUtc) summary.expirationAssumption = "manhattan-mock-utc";
        } catch { summary.expirationValidity = "invalid"; }
    }
    return summary;
}
async function boundedText(response) {
    if (!response.body?.getReader) {
        const text = await response.text();
        if (Buffer.byteLength(text) > MAX_BODY) fail("RESPONSE_TOO_LARGE");
        return text;
    }
    const reader = response.body.getReader(), chunks = [];
    let length = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) break;
            length += part.value.byteLength;
            if (length > MAX_BODY) { await reader.cancel(); fail("RESPONSE_TOO_LARGE"); }
            chunks.push(Buffer.from(part.value));
        }
        return Buffer.concat(chunks).toString("utf8");
    } finally { reader.releaseLock(); }
}
function createGatewayFetch({ transport, credentials, audit, context = new AsyncLocalStorage(), now = Date.now }) {
    const attempted = new Set();
    return async function gatewayFetch(input, options = {}) {
        const url = input instanceof URL ? input.href : input;
        if (url !== OAUTH_URL && url !== AUTHORIZE_URL) fail("DESTINATION_BLOCKED");
        if (options.method !== "POST") fail("METHOD_BLOCKED");
        if (options.signal?.aborted) fail("REQUEST_ABORTED");
        let body;
        try { body = JSON.parse(options.body); } catch { fail("REQUEST_SHAPE_BLOCKED"); }
        const endpoint = url === OAUTH_URL ? "oauth" : "authorization";
        const supplied = new Headers(options.headers), headers = { "Content-Type": "application/json" };
        if (endpoint === "oauth") {
            if (!exactFields(body, ["merchantId", "secretKey"]) ||
                body.merchantId !== credentials.MA_MERCHANT_ID || body.secretKey !== credentials.MA_SECRET_KEY) fail("REQUEST_SHAPE_BLOCKED");
        } else {
            if (!exactFields(body, ["OrderId", "CardDetails", "RequestedAmount"]) ||
                typeof body.OrderId !== "string" || !ORDER_ID.test(body.OrderId) ||
                !exactFields(body.CardDetails, ["CardNumber", "CardMonth", "CardYear", "CCV"]) ||
                body.CardDetails.CardNumber !== TEST_CARD.cardNumber || body.CardDetails.CardMonth !== TEST_CARD.cardMonth ||
                body.CardDetails.CardYear !== TEST_CARD.cardYear || body.CardDetails.CCV !== TEST_CARD.ccv ||
                typeof body.RequestedAmount !== "number") fail("SYNTHETIC_REQUEST_REQUIRED");
            const { toCents } = require("../server/services/moneyService");
            if (toCents(body.RequestedAmount) <= 0) fail("REQUEST_SHAPE_BLOCKED");
            const bearer = supplied.get("authorization");
            if (typeof bearer !== "string" || !/^Bearer [^\s]+$/.test(bearer)) fail("AUTH_HEADER_REQUIRED");
            headers.Authorization = bearer;
            // Includes transport failures and the reviewed client's one 401 replay.
            // Never send a second external authorization for an already-attempted ID.
            if (attempted.has(body.OrderId)) {
                audit({ endpoint, phase: "blocked", code: "AUTHORIZATION_REPLAY_BLOCKED" });
                fail("AUTHORIZATION_REPLAY_BLOCKED");
            }
            attempted.add(body.OrderId);
        }
        const scope = { active: true };
        return context.run(scope, async () => {
            try {
                audit({ endpoint, phase: "request" });
                const response = await transport(url, {
                    method: "POST", headers, body: options.body, signal: options.signal,
                    redirect: "manual", credentials: "omit"
                });
                const status = response.status;
                if (!Number.isInteger(status) || status < 100 || status > 599) fail("RESPONSE_SHAPE_INVALID");
                audit({ endpoint, phase: "headers", status });
                if (status >= 300 && status < 400) {
                    if (response.body?.cancel) await response.body.cancel();
                    fail("REDIRECT_BLOCKED");
                }
                const text = await boundedText(response);
                audit({ endpoint, phase: "response", status, structure: responseStructure(text, endpoint, body, now) });
                return { status, ok: status >= 200 && status < 300, text: async () => text };
            } catch (error) {
                // Never log exception text, raw headers, request bodies, or provider values.
                const code = error instanceof IsolationError ? error.code : options.signal?.aborted ? "REQUEST_ABORTED" : "TRANSPORT_FAILED";
                audit({ endpoint, phase: "error", code });
                throw new IsolationError(code);
            } finally { scope.active = false; }
        });
    };
}
function allowedSocket(args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = first && typeof first === "object" ? first : { port: first, host: args[1] };
    return options.host === HOST && Number(options.port) === 443 && !options.path && !options.socketPath &&
        (!options.servername || options.servername === HOST);
}
function installOutboundGuards(context, guardedFetch) {
    const blocked = () => fail("OUTBOUND_SOCKET_BLOCKED");
    const guard = original => function (...args) {
        if (!context.getStore()?.active || !allowedSocket(args)) fail("OUTBOUND_SOCKET_BLOCKED");
        return Reflect.apply(original, this, args);
    };
    globalThis.fetch = guardedFetch;
    for (const name of ["node:http", "node:https"]) {
        const module = require(name);
        module.request = blocked; module.get = blocked;
    }
    const net = require("node:net"), tls = require("node:tls");
    net.connect = guard(net.connect); net.createConnection = guard(net.createConnection);
    net.Socket.prototype.connect = guard(net.Socket.prototype.connect); tls.connect = guard(tls.connect);
    require("node:module").syncBuiltinESMExports();
}
async function startLiveMock({ transport, listenPort = 3101 } = {}) {
    const { credentialFile } = configuration(process.env);
    if (listenPort !== 3101 && listenPort !== 0) fail("LOOPBACK_PORT_REQUIRED");
    const project = path.resolve(__dirname, "..");
    if (Object.keys(require.cache).some(name => name.startsWith(project + path.sep + "server" + path.sep))) fail("FRESH_PROCESS_REQUIRED");
    const credentials = loadCredentials(credentialFile);
    const nativeFetch = transport || globalThis.fetch.bind(globalThis);
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "group9-live-mock-")));
    const filename = path.join(directory, "synthetic.sqlite"), logFile = path.join(directory, "gateway-sanitized.jsonl");
    for (const file of [filename, logFile]) fs.closeSync(fs.openSync(file, "wx", 0o600));
    const audit = record => {
        const line = JSON.stringify({ at: new Date().toISOString(), ...record });
        fs.appendFileSync(logFile, line + "\n");
        console.log(line);
    };
    Object.assign(process.env, credentials, { DB_PATH: filename, PORT: String(listenPort), DOTENV_KEY: "" });
    const context = new AsyncLocalStorage();
    const guardedFetch = createGatewayFetch({ transport: nativeFetch, credentials, audit, context });
    installOutboundGuards(context, guardedFetch);
    restrictSQLite(require("sqlite3"), filename);
    const dotenv = require("dotenv"), originalConfig = dotenv.config;
    dotenv.config = options => originalConfig({ ...options, path: path.join(directory, ".env"), override: false, quiet: true });
    let database, server, stopping = false;
    async function shutdown(code = 0) {
        if (stopping) return;
        stopping = true;
        try {
            if (server?.listening) {
                const closing = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
                server.closeAllConnections(); await closing;
            }
            if (database) await database.closeAsync();
            console.log("Live mock testing stopped. Temporary files retained: " + directory);
        } catch { code = 1; console.error("Live mock shutdown could not be confirmed."); }
        process.exitCode = code;
        if (process.connected) process.disconnect();
    }
    try {
        database = require("../server/database/db");
        if (database.filename !== filename) fail("DATABASE_ISOLATION_FAILED");
        await database.ready;
        const counts = await database.getAsync("SELECT (SELECT COUNT(*) FROM Products) AS products, (SELECT COUNT(*) FROM Orders) AS orders, (SELECT COUNT(*) FROM PaymentAuthorizations) AS authorizations, (SELECT COUNT(*) FROM Settlements) AS settlements");
        if (counts.products !== 5 || counts.orders || counts.authorizations || counts.settlements) fail("FRESH_DATABASE_REQUIRED");
        const express = require("express"), originalJson = express.json, originalListen = express.application.listen;
        express.json = (...args) => {
            const parser = originalJson(...args);
            return (req, res, next) => parser(req, res, error => {
                if (error) return res.status(400).json({
                    success: false, outcome: "rejected", code: "INVALID_JSON",
                    message: "Invalid JSON. No gateway request was sent."
                });
                if (!syntheticInput(req.body)) return res.status(400).json({
                    success: false, outcome: "rejected", code: "SYNTHETIC_INPUT_REQUIRED",
                    message: "Use only the documented synthetic customer and test card. No gateway request was sent."
                });
                next();
            });
        };
        let resolveListening, rejectListening;
        const listening = new Promise((resolve, reject) => { resolveListening = resolve; rejectListening = reject; });
        express.application.listen = function (_port, callback) {
            if (server) fail("LISTENER_ALREADY_STARTED");
            server = originalListen.call(this, listenPort, "127.0.0.1", callback);
            server.once("error", rejectListening); server.once("listening", resolveListening);
            return server;
        };
        require("../server/server");
        await listening;
        const address = server.address();
        if (address.address !== "127.0.0.1" || database.filename !== filename) fail("ISOLATION_VERIFICATION_FAILED");
        process.once("SIGINT", () => { void shutdown(); });
        process.once("SIGTERM", () => { void shutdown(); });
        const url = "http://127.0.0.1:" + address.port;
        console.log("EXTERNAL MOCK API TEST | No gateway request is made until checkout submission.");
        console.log("Website: " + url + "/");
        console.log("Synthetic database: " + filename);
        console.log("Sanitized gateway log: " + logFile);
        console.log("Credentials loaded privately. Use only the documented synthetic inputs. Stop: Ctrl+C.");
        if (process.connected) process.send({ type: "group9-live-mock-ready", url, filename, logFile, address });
        return { server, shutdown, filename, logFile };
    } catch (error) {
        await shutdown(1); throw error;
    }
}

module.exports = { HOST, OAUTH_URL, AUTHORIZE_URL, SYNTHETIC_CUSTOMER, TEST_CARD, IsolationError,
    configuration, loadCredentials, syntheticInput, responseStructure, createGatewayFetch, allowedSocket,
    installOutboundGuards, startLiveMock };
if (require.main === module) {
    startLiveMock().catch(error => {
        console.error("Live mock startup failed: " + (error instanceof IsolationError ? error.code : "STARTUP_FAILED"));
        process.exitCode = 1;
    });
}
