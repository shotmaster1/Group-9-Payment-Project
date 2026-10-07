const OAUTH_URL =
  'https://capstoneproject.proxy.beeceptor.com/oauth/token';

const AUTHORIZE_URL =
  'https://capstoneproject.proxy.beeceptor.com/authorize';

// Token is intentionally stored only in server memory.
let cachedToken = null;


/**
 * Get an OAuth access token.
 *
 * If a token is already cached, reuse it.
 * Otherwise, authenticate with the MA mock endpoint.
 */
async function getAccessToken() {
  if (cachedToken) {
    return cachedToken;
  }

  const response = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      merchantId: process.env.MA_MERCHANT_ID,
      secretKey: process.env.MA_SECRET_KEY
    })
  });

  if (!response.ok) {
    throw new Error(`OAuth request failed: ${response.status}`);
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error('OAuth response did not contain access_token');
  }

  cachedToken = data.access_token;

  return cachedToken;
}


/**
 * Send payment authorization request to MA.
 */
async function sendAuthorizationRequest(token, payment) {
  return fetch(AUTHORIZE_URL, {
    method: 'POST',

    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },

    body: JSON.stringify({
      OrderId: payment.orderId,

      CardDetails: {
        CardNumber: payment.cardNumber,
        CardMonth: payment.cardMonth,
        CardYear: payment.cardYear,
        CCV: payment.ccv
      },

      RequestedAmount: payment.amount
    })
  });
}


/**
 * Authorize a payment.
 *
 * If MA returns 401, discard the cached token,
 * obtain a new token, and retry once.
 */
async function authorizePayment(payment) {
  let token = await getAccessToken();

  let response = await sendAuthorizationRequest(
    token,
    payment
  );

  if (response.status === 401) {
    // Token has expired or is invalid.
    cachedToken = null;

    // Get a fresh OAuth token.
    token = await getAccessToken();

    // Retry the transaction once.
    response = await sendAuthorizationRequest(
      token,
      payment
    );
  }

  return response;
}


/**
 * Process the MA authorization response.
 */
async function processPayment(payment) {
  try {
    const response = await authorizePayment(payment);

    let data = {};

    try {
      data = await response.json();
    } catch {
      // Response did not contain JSON.
    }


    // -------------------------
    // Successful authorization
    // -------------------------
    if (response.status === 200) {
      return {
        success: true,

        orderId: data.OrderId,

        authorizationToken: data.AuthorizationToken,

        tokenExpirationDate: data.TokenExpirationDate,

        authorizedAmount: data.AuthorizedAmount,

        reason: data.Reason || ''
      };
    }


    // -------------------------
    // Invalid card information
    // -------------------------
    if (response.status === 400 ||
        response.status === 422) {

      return {
        success: false,

        status: 'Payment Declined',

        message:
          data.Reason ||
          'The payment information is invalid.'
      };
    }


    // -------------------------
    // Insufficient funds
    // -------------------------
    if (response.status === 402) {
      return {
        success: false,

        status:
          'Payment Declined - Insufficient Funds',

        message:
          data.Reason ||
          'There are insufficient funds to complete the purchase.'
      };
    }


    // -------------------------
    // Payment service failure
    // -------------------------
    if (
      response.status === 500 ||
      response.status === 502 ||
      response.status === 503
    ) {
      return {
        success: false,

        status:
          'Payment Service Unavailable',

        message:
          'The payment service is temporarily unavailable.'
      };
    }


    // -------------------------
    // Unexpected response
    // -------------------------
    return {
      success: false,

      status: 'Payment Error',

      message:
        'The payment could not be processed.'
    };

  } catch (error) {

    console.error(
      'Payment processing error:',
      error
    );

    return {
      success: false,

      status: 'Payment Error',

      message:
        'Unable to contact the payment service.'
    };
  }
}


module.exports = {
  getAccessToken,
  authorizePayment,
  processPayment
};
