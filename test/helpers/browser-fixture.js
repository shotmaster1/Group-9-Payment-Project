"use strict";
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const project = path.resolve(__dirname, "../..");
let unique = 0;
class Element {
    constructor(tagName = "div") { this.tagName = tagName.toUpperCase(); this.children = []; this.listeners = new Map(); this.value = ""; this.disabled = false; this.hidden = false; this._text = ""; this.attributes = {}; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    set innerHTML(value) { if (value !== "") throw new Error("Dynamic HTML must not be rendered"); this.replaceChildren(); }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { this._text = ""; this.children = [...children]; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(event, handler) { if (!this.listeners.has(event)) this.listeners.set(event, []); this.listeners.get(event).push(handler); }
    focus() { this.focused = true; }
    dispatch(event, properties = {}) { return Promise.all((this.listeners.get(event) || []).map(handler => handler({ target: this, preventDefault() {}, ...properties }))); }
    click() { return this.dispatch("click"); }
}
function storage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return { values, failWrites: false, failRemoves: false,
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { if (this.failWrites) throw new Error("Synthetic storage failure"); values.set(key, String(value)); },
        removeItem(key) { if (this.failRemoves) throw new Error("Synthetic storage failure"); values.delete(key); }
    };
}
function browser(page, { sessionStorage = storage(), fetch, crypto = { randomUUID: () => "SYNTHETIC-UUID-" + (++unique) }, search = "" } = {}) {
    const html = fs.readFileSync(path.join(project, "client", page), "utf8");
    const nodes = new Map();
    for (const [, tag, id] of html.matchAll(/<([a-zA-Z]+)[^>]*\bid=["']([^"']+)["']/g)) nodes.set(id, new Element(tag));
    const document = new Element("document");
    document.getElementById = id => nodes.get(id) || null;
    document.createElement = tag => new Element(tag);
    const window = { crypto, location: { search, href: page + search } };
    const context = vm.createContext({ window, document, sessionStorage, fetch, URLSearchParams, AbortController, Uint8Array, setTimeout, clearTimeout, console });
    const run = name => vm.runInContext(fs.readFileSync(path.join(project, "client", name), "utf8"), context, { filename: name });
    const runScripts = () => { for (const [, source] of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) run(source); };
    return { nodes, document, window, context, run, runScripts, sessionStorage, get: id => nodes.get(id) };
}
async function waitFor(condition, message = "browser condition") {
    const deadline = Date.now() + 5000;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for " + message);
        await new Promise(resolve => setTimeout(resolve, 1));
    }
}
function fillCheckout(ui) {
    const values = { firstName: "Alex", lastName: "Example", email: "alex@example.test", address: "100 Synthetic Way", city: "City", state: "ST", zip: "00000", cardNumber: "4111111111111111", expiration: "12/35", cvv: "123" };
    for (const [id, value] of Object.entries(values)) ui.get(id).value = value;
}
function loadRouter(name, db, overrides = {}) {
    const filename = path.join(project, "server/routes", name + ".js");
    const module = { exports: {} };
    vm.compileFunction(fs.readFileSync(filename, "utf8"), ["require", "module", "console"])(name => {
        if (Object.hasOwn(overrides, name)) return overrides[name];
        if (name === "../database/db") return db;
        return name.startsWith(".") ? require(path.resolve(path.dirname(filename), name)) : require(name);
    }, module, { error() {} });
    return module.exports;
}
function fetchApplication(f, custom = null) {
    const { request } = require("./payment-fixture");
    const settlement = require("../../server/services/settlementService");
    const products = loadRouter("products", f.db), orders = loadRouter("orders", f.db);
    const settlements = loadRouter("settlements", f.db, { "../services/settlementService": { ...settlement, settleOrder: (input, options) => settlement.settleOrder(input, { ...options, now: f.now }) } });
    const calls = [];
    const fetch = async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : undefined;
        calls.push({ url, body });
        if (custom) { const response = await custom(url, options, body); if (response) return response; }
        const parsed = new URL(url, "http://synthetic.local");
        let response;
        if (parsed.pathname === "/api/payments/quote") response = await f.api("POST", "/quote", body);
        else if (parsed.pathname === "/api/payments") response = await f.api("POST", "/", body);
        else if (parsed.pathname === "/api/products") response = await request(products, "GET", "/", body);
        else if (parsed.pathname.startsWith("/api/orders")) response = await request(orders, "GET", (parsed.pathname.slice(11) || "/") + parsed.search, body);
        else if (parsed.pathname === "/api/settlements") response = await request(settlements, "POST", "/", body);
        else throw new Error("Unexpected mocked application URL: " + url);
        return { status: response.status, ok: response.status >= 200 && response.status < 300, json: async () => response.body };
    };
    return { fetch, calls };
}
module.exports = { Element, storage, browser, waitFor, fillCheckout, fetchApplication };
