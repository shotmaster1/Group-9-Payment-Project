"use strict";

// Reviewed transport adapted from Quentin's Payment API2 (33ee567).
// Keep response-body deadlines, shared OAuth refresh, and one 401 retry.
// Application approval validation/persistence belongs to paymentOrderService.
const { expirationNanoseconds } = require("./authorizationExpiration");
const OAUTH_URL = "https://capstoneproject.proxy.beeceptor.com/oauth/token";
const AUTHORIZE_URL = "https://capstoneproject.proxy.beeceptor.com/authorize";

function createGatewayClient({ fetchImpl = (...args) => globalThis.fetch(...args), env = process.env, now = Date.now, timeoutMs = 10000 } = {}) {
    if (typeof fetchImpl !== "function" || typeof now !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) throw new TypeError("Invalid gateway configuration.");
    let cachedToken = null, pendingToken = null;
    const isConfigured = () => [env.MA_MERCHANT_ID, env.MA_SECRET_KEY].every(value => typeof value === "string" && value.trim());
    const cacheValid = () => cachedToken && now() + 30000 < cachedToken.expiresAt;
    async function request(url, options) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(url, { ...options, signal: controller.signal });
            const text = await response.text();
            let data;
            try { data = JSON.parse(text); } catch { data = null; }
            if (!data || typeof data !== "object" || Array.isArray(data)) data = null;
            return { status: response.status, ok: response.ok, data };
        } catch (error) {
            if (controller.signal.aborted) {
                const timeout = new Error("Gateway request timed out."); timeout.name = "TimeoutError"; throw timeout;
            }
            throw error;
        } finally { clearTimeout(timer); }
    }
    function oauthExpiry(data) {
        if (typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0) {
            const expires = now() + data.expires_in * 1000;
            if (Number.isSafeInteger(expires) && Number.isFinite(new Date(expires).getTime())) return expires;
        }
        try {
            const expires = Number(expirationNanoseconds(data.expires_at ?? data.expiresAt) / 1000000n);
            if (Number.isSafeInteger(expires)) return expires;
        } catch { /* Unknown/ambiguous OAuth expiry is never cached. */ }
        return null;
    }
    async function getAccessToken() {
        if (cacheValid()) return cachedToken.value;
        if (pendingToken) return pendingToken;
        const work = (async () => {
            const response = await request(OAUTH_URL, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ merchantId: env.MA_MERCHANT_ID, secretKey: env.MA_SECRET_KEY })
            });
            if (!response.ok || typeof response.data?.access_token !== "string" || !response.data.access_token.trim()) {
                const error = new Error("OAuth authentication failed."); error.upstreamStatusCode = response.status; throw error;
            }
            const expiresAt = oauthExpiry(response.data);
            cachedToken = expiresAt !== null && expiresAt > now() ? { value: response.data.access_token, expiresAt } : null;
            return response.data.access_token;
        })();
        pendingToken = work;
        try { return await work; }
        finally { if (pendingToken === work) pendingToken = null; }
    }
    const failure = (code, statusCode, outcome, orderId, upstreamStatusCode = null) => ({
        success: false, code, statusCode, outcome, orderId, upstreamStatusCode
    });
    async function processPayment(payment) {
        if (!isConfigured()) return failure("PAYMENT_CONFIGURATION_ERROR", 503, "rejected", payment.orderId);
        let mayHaveAuthorized = false;
        try {
            let token = await getAccessToken();
            const authorize = async currentToken => {
                mayHaveAuthorized = true;
                return request(AUTHORIZE_URL, {
                    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + currentToken },
                    body: JSON.stringify({
                        OrderId: payment.orderId,
                        CardDetails: { CardNumber: payment.cardNumber, CardMonth: payment.cardMonth, CardYear: payment.cardYear, CCV: payment.ccv },
                        RequestedAmount: payment.amount
                    })
                });
            };
            let response = await authorize(token);
            if (response.status === 401 && response.data?.Success !== true) {
                mayHaveAuthorized = false; // This request was explicitly denied.
                if (cachedToken?.value === token) cachedToken = null;
                token = cacheValid() ? cachedToken.value : await getAccessToken();
                response = await authorize(token); // Exactly one 401 refresh/retry.
            }
            const data = response.data;
            if (data?.OrderId != null && data.OrderId !== payment.orderId) return failure("GATEWAY_ORDER_MISMATCH", 502, "uncertain", payment.orderId, response.status);
            if (data?.Success === true) {
                const complete = [data.OrderId, data.AuthorizationToken, data.AuthorizedAmount, data.TokenExpirationDate].every(value => value != null);
                return {
                    success: complete && response.status === 200, approvalReported: true, outcome: complete && response.status === 200 ? "approved" : "uncertain",
                    statusCode: complete && response.status === 200 ? 200 : 502, upstreamStatusCode: response.status,
                    code: response.status !== 200 ? "UNEXPECTED_APPROVAL_STATUS" : complete ? "PAYMENT_AUTHORIZED" : "INCOMPLETE_AUTHORIZATION_RESPONSE",
                    orderId: data.OrderId, authorizationToken: data.AuthorizationToken,
                    authorizedAmount: data.AuthorizedAmount, tokenExpirationDate: data.TokenExpirationDate
                };
            }
            if (response.status === 200 && data?.Success === false) {
                const insufficient = typeof data.Reason === "string" && data.Reason.toLowerCase().includes("insufficient");
                return failure(insufficient ? "INSUFFICIENT_FUNDS" : "PAYMENT_NOT_AUTHORIZED", 402, "declined", payment.orderId, 200);
            }
            if ([400, 401, 402, 422].includes(response.status)) {
                return failure(response.status === 402 ? "INSUFFICIENT_FUNDS" : "PAYMENT_REJECTED", response.status === 401 ? 502 : response.status, "rejected", payment.orderId, response.status);
            }
            return failure("UNCONFIRMED_GATEWAY_RESPONSE", 502, "uncertain", payment.orderId, response.status);
        } catch (error) {
            const timeout = error?.name === "TimeoutError";
            return failure(timeout ? "PAYMENT_TIMEOUT" : "PAYMENT_UNAVAILABLE", timeout ? 504 : error?.upstreamStatusCode ? 502 : 503,
                mayHaveAuthorized ? "uncertain" : "rejected", payment.orderId, error?.upstreamStatusCode || null);
        }
    }
    return { isConfigured, processPayment };
}

const defaultClient = createGatewayClient();
module.exports = { ...defaultClient, createGatewayClient };
