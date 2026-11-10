"use strict";

const { createOrderWithItems, OrderError } = require("./orderService");
const { validateCart, PricingError } = require("./pricingService");
const { MoneyError, toCents, fromCents } = require("./moneyService");
const { manhattanAuthorizationExpiration } = require("./authorizationExpiration");
const { QuoteError } = require("./paymentQuoteService");
const validation = require("../../client/js/validation");

class PaymentError extends Error {
    constructor(code, message, statusCode = 400, outcome = "rejected", orderId) {
        super(message); this.name = "PaymentError"; this.code = code;
        this.statusCode = statusCode; this.outcome = outcome; this.orderId = orderId;
    }
}
function fields(value, allowed) {
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new PaymentError("INVALID_PAYMENT", "Payment details must be an object.");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowed.includes(key) || !Object.hasOwn(descriptors[key], "value"))) throw new PaymentError("INVALID_PAYMENT", "Payment details contain unsupported fields; browser amounts are not accepted.");
    return Object.fromEntries(Object.keys(descriptors).map(key => [key, descriptors[key].value]));
}
function time(now) {
    const value = now();
    if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) throw new Error("Invalid backend payment clock.");
    return value;
}
function prepare(input, now) {
    const data = fields(input, ["orderId", "customer", "items", "quoteToken", "cardNumber", "cardMonth", "cardYear", "ccv", "cardType"]);
    if (typeof data.orderId !== "string" || !data.orderId.trim() || data.orderId.length > 200) throw new PaymentError("INVALID_ORDER_ID", "A nonblank Order ID of at most 200 characters is required.");
    const orderId = data.orderId.trim();
    const customer = fields(data.customer, ["firstName", "lastName", "email", "address", "city", "state", "zip"]);
    if (Object.values(customer).some(value => typeof value !== "string")) throw new PaymentError("INVALID_CUSTOMER", "Customer fields must be text.");
    if (typeof data.cardNumber !== "string" || !/^\d{12,19}$/.test(data.cardNumber) || typeof data.ccv !== "string" || !/^\d{3,4}$/.test(data.ccv) ||
        !Number.isInteger(data.cardMonth) || data.cardMonth < 1 || data.cardMonth > 12 || !Number.isInteger(data.cardYear) || data.cardYear < 1000 || data.cardYear > 9999) throw new PaymentError("INVALID_CARD", "Check the card number, expiration, and security code.");
    const checked = validation.validatePaymentForm({ ...customer, cardNumber: data.cardNumber, expiration: data.cardMonth + "/" + data.cardYear, cvv: data.ccv }, new Date(time(now)));
    if (!checked.valid) throw new PaymentError("INVALID_PAYMENT", Object.values(checked.errors)[0]);
    if (data.cardType !== undefined && data.cardType !== checked.payload.payment.cardType) throw new PaymentError("INVALID_CARD", "The card type does not match the card number.");
    if (typeof data.quoteToken !== "string" || !data.quoteToken || data.quoteToken.length > 2048) throw new QuoteError();
    return { orderId, customer: checked.payload.customer, items: validateCart(data.items), quoteToken: data.quoteToken,
        cardNumber: checked.payload.payment.cardNumber, cardMonth: checked.payload.payment.expMonth, cardYear: checked.payload.payment.expYear,
        ccv: checked.payload.payment.cvv, cardType: checked.payload.payment.cardType, cardLast4: checked.payload.payment.cardNumber.slice(-4) };
}
function decision(result, order, request, currentTime) {
    const base = { success: false, outcome: "uncertain", code: "PAYMENT_UNCONFIRMED", status: "Payment Review",
        message: "Payment requires review. Do not pay again; verify this Order ID before another attempt.", orderId: order.orderId, orderTotal: order.orderTotal };
    if (!result || typeof result !== "object" || Array.isArray(result)) return { statusCode: 502, body: base, record: null };
    if (result.success === true || result.approvalReported === true) {
        if (result.orderId !== order.orderId) return { statusCode: 502, body: { ...base, code: "GATEWAY_ORDER_MISMATCH" }, record: null };
        let amount, amountCents;
        try {
            amountCents = toCents(result.authorizedAmount);
            if (amountCents <= 0) throw new MoneyError("INVALID_MONEY", "Invalid approved amount.");
            amount = fromCents(amountCents);
        } catch { return { statusCode: 502, body: { ...base, code: "INVALID_AUTHORIZED_AMOUNT" }, record: null }; }
        const record = { token: typeof result.authorizationToken === "string" ? result.authorizationToken : null,
            amount, expiry: typeof result.tokenExpirationDate === "string" ? result.tokenExpirationDate : null, result: "Success" };
        let code = null;
        if (typeof record.token !== "string" || !record.token || /[\s\x00-\x1f\x7f]/u.test(record.token) || record.token.length > 4096) {
            record.token = null;
            code = "INVALID_AUTHORIZATION_TOKEN";
        }
        let normalizedExpiration;
        try {
            const expiration = manhattanAuthorizationExpiration(record.expiry);
            normalizedExpiration = expiration.utc;
            if (BigInt(currentTime) * 1000000n >= expiration.nanoseconds) code = "AUTHORIZATION_EXPIRED";
        }
        catch { code = "INVALID_AUTHORIZATION_EXPIRATION"; }
        if (amountCents !== order.totalCents) code = "AUTHORIZED_AMOUNT_MISMATCH";
        if (result.success !== true && !code) code = "INCOMPLETE_AUTHORIZATION_RESPONSE";
        if (code) {
            const message = code === "AUTHORIZED_AMOUNT_MISMATCH"
                ? "The gateway authorization amount does not match the order total. Payment requires review. Do not submit this payment again until its status is confirmed."
                : base.message;
            return { statusCode: 502, body: { ...base, code, message, authorizedAmount: amount }, record };
        }
        return { statusCode: 200, body: { success: true, outcome: "approved", code: "PAYMENT_AUTHORIZED", status: "Authorized",
            message: "Payment authorized successfully.", orderId: order.orderId, orderTotal: order.orderTotal,
            authorizedAmount: amount, expirationDate: normalizedExpiration }, record };
    }
    if (result.success === false && ["declined", "rejected"].includes(result.outcome)) {
        const insufficient = result.code === "INSUFFICIENT_FUNDS";
        const code = insufficient ? "INSUFFICIENT_FUNDS" : result.outcome === "declined" ? "PAYMENT_DECLINED" : "PAYMENT_REJECTED";
        const statusCode = [400, 402, 422, 502, 503, 504].includes(result.statusCode) ? result.statusCode : 400;
        return { statusCode, body: { ...base, outcome: result.outcome, code, status: "Payment Failed",
            message: insufficient ? "Payment declined: insufficient funds." : result.outcome === "declined" ? "Payment was declined. No authorization was confirmed." : "Payment was rejected before a confirmed authorization. Check the payment details or service configuration." },
            record: { token: null, amount: 0, expiry: null, result: "Failed" } };
    }
    const statusCode = [502, 503, 504].includes(result.statusCode) ? result.statusCode : 502;
    return { statusCode, body: { ...base, code: ["PAYMENT_TIMEOUT", "GATEWAY_ORDER_MISMATCH"].includes(result.code) ? result.code : "PAYMENT_UNCONFIRMED" }, record: null };
}
async function createPayment(input, { database, gateway, quotes, now = Date.now }) {
    const request = prepare(input, now);
    if (!gateway || typeof gateway.processPayment !== "function" || (typeof gateway.isConfigured === "function" && !gateway.isConfigured())) throw new PaymentError("PAYMENT_CONFIGURATION_ERROR", "Payment processing is unavailable. No authorization request was sent.", 503, "rejected", request.orderId);
    let order;
    try {
        order = await database.withTransaction(async tx => {
            const created = await createOrderWithItems({ orderId: request.orderId, customer: request.customer, items: request.items }, { transaction: tx });
            quotes.verify(request.quoteToken, created);
            return created;
        });
    } catch (error) {
        if (error instanceof OrderError || error instanceof PricingError || error instanceof QuoteError) throw error;
        throw new PaymentError("ORDER_CREATION_FAILED", "The order could not be created. No authorization request was sent.", 500, "rejected", request.orderId);
    }
    let result;
    try { result = await gateway.processPayment({ orderId: order.orderId, amount: order.orderTotal, cardNumber: request.cardNumber,
        cardMonth: request.cardMonth, cardYear: request.cardYear, ccv: request.ccv, cardType: request.cardType }); }
    catch { result = null; } // Never infer a decline from an unknown transport failure.
    try {
        return await database.withTransaction(async tx => {
            const current = await tx.get("SELECT OrderStatus FROM Orders WHERE OrderID = ?", [order.orderId]);
            if (current?.OrderStatus !== "Pending" || await tx.get("SELECT AuthorizationID FROM PaymentAuthorizations WHERE OrderID = ?", [order.orderId])) throw new Error("Order changed during authorization.");
            const currentTime = time(now), selected = decision(result, order, request, currentTime);
            if (selected.record) {
                const record = selected.record;
                const saved = await tx.run(`INSERT INTO PaymentAuthorizations
                    (OrderID, AuthorizationToken, AuthorizationAmount, TransactionDateTime, AuthExpirationDate, AuthorizationResult, CardType, CardLast4, FailureReason)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [order.orderId, record.token, record.amount, new Date(currentTime).toISOString(), record.expiry,
                    record.result, request.cardType, request.cardLast4, selected.body.success ? null : selected.body.code]);
                if (saved.changes !== 1) throw new Error("Authorization record was not saved.");
            }
            const saved = await tx.run("UPDATE Orders SET OrderStatus = ? WHERE OrderID = ? AND OrderStatus = 'Pending'", [selected.body.status, order.orderId]);
            if (saved.changes !== 1) throw new Error("Payment status was not saved.");
            return selected;
        });
    } catch {
        throw new PaymentError("PAYMENT_PERSISTENCE_UNCONFIRMED", "Payment could not be confirmed in the database. Do not pay again; verify this Order ID.", 500, "uncertain", order.orderId);
    }
}
module.exports = { createPayment, PaymentError };
