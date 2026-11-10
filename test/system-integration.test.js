"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createDatabase } = require("../server/database/database");
const project = path.resolve(__dirname, "..");

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "group9-system-integration-"));
    const db = createDatabase({ filename: path.join(directory, "synthetic.sqlite") });
    t.after(async () => { await db.closeAsync(); fs.rmSync(directory, { recursive: true }); });
    return db;
}

function catalogRequest(db) {
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(project, "server/routes/products.js"), "utf8");
    vm.compileFunction(source, ["require", "module", "console"])(name => {
        if (name === "express") return require("express");
        if (name === "../database/db") return db;
        throw new Error("Unexpected catalog dependency: " + name);
    }, module, { error() {} });
    return () => new Promise((resolve, reject) => {
        let status = 200;
        const res = { status(code) { status = code; return this; }, json(body) { resolve({ status, body }); } };
        module.exports.handle({ method: "GET", url: "/" }, res, error => reject(error || new Error("Catalog route missing")));
    });
}

test("integrated catalog route uses recovery database callbacks and all five PNG assets", async t => {
    const db = fixture(t);
    const response = await catalogRequest(db)();
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.products.length, 5);
    assert.deepEqual(response.body.products.map(row => row.ProductID), [1, 2, 3, 4, 5]);
    for (const [index, product] of response.body.products.entries()) {
        assert.deepEqual(Object.keys(product).sort(), ["ProductID", "Name", "Description", "Price", "ImageURL"].sort());
        assert.equal(typeof product.Price, "number");
        assert.equal(product.ImageURL, `/img/p${index + 1}.png`);
        const filename = path.join(project, "client", product.ImageURL.slice(1));
        const descriptor = fs.openSync(filename, "r");
        const signature = Buffer.alloc(8);
        try { assert.equal(fs.readSync(descriptor, signature, 0, 8, 0), 8); }
        finally { fs.closeSync(descriptor); }
        assert.deepEqual([...signature], [137, 80, 78, 71, 13, 10, 26, 10]);
    }
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Orders")).count, 0);
});

test("integrated catalog preserves its safe database-failure response", async t => {
    const db = fixture(t); await db.ready; await db.closeAsync();
    const response = await catalogRequest(db)();
    assert.deepEqual(response, { status: 500, body: { success: false, message: "Could not load products." } });
});

test("combined server retains existing routes and mounts the storefront catalog without starting a listener", () => {
    const mounted = [], gets = new Map(), posts = new Map(), staticPaths = [], loaded = [];
    const routeMarkers = new Map(["orders", "settlements", "products", "payments"].map(name => ["./routes/" + name, { name }]));
    let startupCalls = 0;
    const app = {
        use(...args) { mounted.push(args); },
        get(route, handler) { gets.set(route, handler); },
        post(route, handler) { posts.set(route, handler); },
        listen() { startupCalls++; }
    };
    const express = () => app;
    express.json = () => () => {};
    express.static = directory => { staticPaths.push(directory); return () => {}; };
    const source = fs.readFileSync(path.join(project, "server/server.js"), "utf8");
    vm.compileFunction(source, ["require", "__dirname", "process", "console"])(name => {
        loaded.push(name);
        if (name === "dotenv") return { config() {} };
        if (name === "express") return express;
        if (name === "cors") return () => () => {};
        if (name === "path") return path;
        if (name === "./database/db") return {};
        if (routeMarkers.has(name)) return routeMarkers.get(name);

        if (name === path.join(project, "client/js/validation.js")) return {};
        throw new Error("Unexpected server dependency: " + name);
    }, path.join(project, "server"), { env: {} }, { log() {}, error() {} });
    assert.deepEqual(mounted.filter(args => typeof args[0] === "string").map(args => [args[0], args[1].name]), [
        ["/api/orders", "orders"], ["/api/settlements", "settlements"], ["/api/products", "products"], ["/api/payments", "payments"]
    ]);
    assert.equal(typeof gets.get("/api/test"), "function");
    assert.equal(posts.has("/api/payments"), false); // Payment handlers belong to the mounted reviewed router.
    assert.deepEqual(staticPaths, [path.join(project, "client")]);
    assert.equal(startupCalls, 1); // Intercepted; no real listener exists.
    assert.ok(loaded.includes("./routes/payments"));
    assert.ok(!loaded.includes("../Payment API"));
    assert.ok(!loaded.some(name => name.includes("Payment API2")));
    for (const name of ["index.html", "checkout.html", "orders.html", "warehouse.html"]) {
        const filename = path.join(project, "client", name);
        assert.ok(fs.statSync(filename).isFile());
        const html = fs.readFileSync(filename, "utf8");
        for (const [, script] of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
            assert.ok(fs.statSync(path.join(project, "client", script)).isFile(), name + ": " + script);
        }
    }
});
