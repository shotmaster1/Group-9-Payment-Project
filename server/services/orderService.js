"use strict";

const defaultDatabase = require("../database/db");
const { priceCart, validateCart } = require("./pricingService");

class OrderError extends Error {
    constructor(code, message, statusCode = 400) {
        super(message);
        this.name = "OrderError";
        this.code = code;
        this.statusCode = statusCode;
    }
}

function dataFields(value, allowed, code, message) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        throw new OrderError(code, message);
    }
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.includes(key) || !Object.hasOwn(fields[key], "value"))) {
        throw new OrderError(code, message);
    }
    return fields;
}

function prepareOrder(input) {
    const fields = dataFields(input, ["orderId", "customer", "items"], "INVALID_ORDER", "Supply only orderId, customer, and items; browser amounts are not accepted.");
    const orderId = fields.orderId?.value;
    if (typeof orderId !== "string" || !orderId.trim()) {
        throw new OrderError("INVALID_ORDER_ID", "A nonblank Order ID is required.");
    }
    const names = ["firstName", "lastName", "email", "address", "city", "state", "zip"];
    const customerFields = dataFields(fields.customer?.value, names, "INVALID_CUSTOMER", "Customer information must contain supported text fields only.");
    const customer = {};
    for (const name of names) {
        const value = customerFields[name]?.value;
        const required = ["firstName", "email", "address"].includes(name);
        if ((value !== undefined && typeof value !== "string") || (required && (typeof value !== "string" || !value.trim()))) {
            throw new OrderError("INVALID_CUSTOMER", "Customer firstName, email, and address are required; supplied customer fields must be text.");
        }
        customer[name] = value === undefined ? "" : value.trim();
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customer.email)) {
        throw new OrderError("INVALID_CUSTOMER", "A valid customer email address is required.");
    }
    // Capture validated input before waiting for a connection or another transaction.
    return { orderId: orderId.trim(), customer, items: validateCart(fields.items?.value) };
}

async function insertOrder(order, tx) {
    if (await tx.get("SELECT OrderID FROM Orders WHERE OrderID = ?", [order.orderId])) {
        throw new OrderError("DUPLICATE_ORDER_ID", "An order with this Order ID already exists.", 409);
    }
    // Price within this transaction; never accept prepriced lines or caller totals.
    const priced = await priceCart(order.items, { transaction: tx });
    const orderDate = new Date().toISOString();
    const customer = order.customer;
    const inserted = await tx.run(
        "INSERT INTO Orders (OrderID,CustomerName,CustomerEmail,ShippingAddress,City,State,Zip,OrderDate,OrderTotal,OrderStatus) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending')",
        [order.orderId, (customer.firstName + " " + customer.lastName).trim(), customer.email, customer.address,
            customer.city, customer.state, customer.zip, orderDate, priced.orderTotal]
    );
    if (inserted.changes !== 1) throw new OrderError("ORDER_WRITE_FAILED", "The order could not be saved completely.", 500);
    for (const item of priced.items) {
        const saved = await tx.run(
            "INSERT INTO OrderItems (OrderID,ProductID,ProductName,UnitPriceCents,Quantity) VALUES (?, ?, ?, ?, ?)",
            [order.orderId, item.productId, item.productName, item.unitPriceCents, item.quantity]
        );
        if (saved.changes !== 1) throw new OrderError("ORDER_WRITE_FAILED", "The order items could not be saved completely.", 500);
    }
    return { orderId: order.orderId, orderDate, orderStatus: "Pending", ...priced };
}

async function createOrderWithItems(input, options = {}) {
    const order = prepareOrder(input);
    if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new TypeError("Order options must be an object.");
    }
    if (Object.hasOwn(options, "transaction")) {
        const tx = options.transaction;
        if (Object.hasOwn(options, "database") || !tx || ["get", "all", "run"].some((method) => typeof tx[method] !== "function")) {
            throw new TypeError("Supply either a central database or its transaction, not both.");
        }
        // The outer owner must propagate errors and commit before using this result.
        return insertOrder(order, tx);
    }
    const database = Object.hasOwn(options, "database") ? options.database : defaultDatabase;
    if (!database || typeof database.withTransaction !== "function") {
        throw new TypeError("Order creation requires the central database transaction API.");
    }
    return database.withTransaction((tx) => insertOrder(order, tx));
}

module.exports = { createOrderWithItems, OrderError };
