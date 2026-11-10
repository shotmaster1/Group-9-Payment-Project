"use strict";

const { createHash, createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { priceCart } = require("./pricingService");

class QuoteError extends Error {
    constructor(message = "The price quote expired or changed. Review the current total before paying again.") {
        super(message);
        this.name = "QuoteError";
        this.code = "QUOTE_CHANGED";
        this.statusCode = 409;
    }
}
function priceDigest(priced) {
    const lines = priced.items.map(item => [item.productId, item.productName, item.quantity, item.unitPriceCents])
        .sort((left, right) => left[0] - right[0]);
    return createHash("sha256").update(JSON.stringify([priced.totalCents, lines])).digest("hex");
}
function createQuoteService({ key = randomBytes(32), now = Date.now, lifetimeMs = 300000 } = {}) {
    if (!Buffer.isBuffer(key) || key.length < 32 || typeof now !== "function" || !Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) throw new TypeError("Invalid backend quote configuration.");
    const secret = Buffer.from(key);
    const signature = body => createHmac("sha256", secret).update(body).digest();
    function clock() {
        const time = now();
        if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(time + lifetimeMs)) throw new Error("Invalid quote clock.");
        return time;
    }
    return {
        async quote(items, database) {
            const priced = await priceCart(items, { database });
            if (priced.totalCents <= 0) throw new QuoteError("A payment requires a positive cart total.");
            const expiresAt = clock() + lifetimeMs;
            const body = Buffer.from(JSON.stringify({ v: 1, digest: priceDigest(priced), expiresAt })).toString("base64url");
            return { ...priced, quoteToken: body + "." + signature(body).toString("base64url"), expiresAt };
        },
        verify(token, priced) {
            try {
                if (typeof token !== "string" || token.length > 2048) throw new QuoteError();
                const parts = token.split(".");
                if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new QuoteError();
                const received = Buffer.from(parts[1], "base64url"), expected = signature(parts[0]);
                if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new QuoteError();
                const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
                if (payload.v !== 1 || !Number.isSafeInteger(payload.expiresAt) || clock() >= payload.expiresAt || payload.digest !== priceDigest(priced)) throw new QuoteError();
            } catch (error) {
                if (error instanceof QuoteError) throw error;
                throw new QuoteError();
            }
        }
    };
}
const defaultQuoteService = createQuoteService();
module.exports = { ...defaultQuoteService, createQuoteService, QuoteError };
