require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const db = require("./database/db");
const orderRoutes = require("./routes/orders");
const settlementRoutes = require("./routes/settlements");

let paymentService = null;
try {
  paymentService = require("../Payment API");
} catch (e) {
  try {
    paymentService = require("./services/payment");
  } catch (err) {
    console.log("Payment service loading in simulation fallback mode.");
  }
}

const PaymentValidation = require(path.join(__dirname, "../client/js/validation.js"));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../client")));

app.get("/api/test", (req, res) => {
  res.json({ message: "Group 9 server is online." });
});

app.use("/api/orders", orderRoutes);
app.use("/api/settlements", settlementRoutes);

app.post("/api/payments", async (req, res) => {
  const { orderId, amount, customer, cardNumber, cardMonth, cardYear, ccv, cardType } = req.body;

  if (!cardNumber || !customer) {
    return res.status(400).json({
      success: false,
      status: "Validation Error",
      message: "Missing customer or payment details."
    });
  }

  const cardValidation = PaymentValidation.validateCardNumber(cardNumber);
  if (!cardValidation.valid) {
    return res.status(400).json({
      success: false,
      status: "Card Error",
      message: cardValidation.error
    });
  }

  const idToUse = orderId || `ORD-${Date.now()}`;
  const fullName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim();
  const orderDate = new Date().toISOString();
  const orderTotal = Number(amount || 0);
  const cardLast4 = String(cardNumber).replace(/\D/g, "").slice(-4);
  const safeCardType = cardType || "Unknown";

  const insertOrderSql = `
    INSERT INTO Orders (OrderID, CustomerName, CustomerEmail, ShippingAddress, City, State, Zip, OrderDate, OrderTotal, OrderStatus)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending')
    ON CONFLICT(OrderID) DO UPDATE SET OrderStatus='Pending'
  `;

  const orderParams = [
    idToUse,
    fullName,
    customer.email || "",
    customer.address || "",
    customer.city || "",
    customer.state || "",
    customer.zip || "",
    orderDate,
    orderTotal
  ];

  db.run(insertOrderSql, orderParams, async function (err) {
    if (err) {
      console.error("Database Order Insert Error:", err.message);
      return res.status(500).json({
        success: false,
        status: "Server Error",
        message: "Failed to create order record."
      });
    }

    let authSuccess = true;
    let authResultData = {
      authorizationToken: "MA-AUTH-" + Math.random().toString(36).substring(2, 10).toUpperCase(),
      authorizedAmount: orderTotal,
      tokenExpirationDate: "2028-12-31T23:59:59Z"
    };

    if (paymentService && typeof paymentService.processPayment === "function") {
      try {
        const apiResult = await paymentService.processPayment({
          orderId: idToUse,
          amount: orderTotal,
          cardNumber,
          cardMonth,
          cardYear,
          ccv,
          cardType
        });

        if (apiResult) {
          authSuccess = apiResult.success;
          authResultData = apiResult;
        }
      } catch (apiErr) {
        console.error("External Payment API Exception:", apiErr.message);
        authSuccess = false;
        authResultData.status = "API Connection Error";
        authResultData.message = apiErr.message;
      }
    }

    if (authSuccess) {
      const fullAuthToken = authResultData.authorizationToken || `${idToUse}-TOK-OK`;
      const expDate = authResultData.tokenExpirationDate || "2028-12-31";

      const insertAuthSql = `
        INSERT INTO PaymentAuthorizations
        (OrderID, AuthorizationToken, AuthorizationAmount, TransactionDateTime, AuthExpirationDate, AuthorizationResult, CardType, CardLast4)
        VALUES (?, ?, ?, ?, ?, 'Success', ?, ?)
      `;

      db.run(
        insertAuthSql,
        [idToUse, fullAuthToken, orderTotal, orderDate, expDate, safeCardType, cardLast4],
        function (authErr) {
          if (authErr) console.error("Database Auth Insert Error:", authErr.message);

          db.run(`UPDATE Orders SET OrderStatus = 'Authorized' WHERE OrderID = ?`, [idToUse]);

          return res.status(200).json({
            success: true,
            orderId: idToUse,
            status: "Authorized",
            message: "Payment authorized successfully.",
            authToken: fullAuthToken,
            expirationDate: expDate
          });
        }
      );
    } else {
      const failureReason = authResultData.message || authResultData.status || "Payment Declined";

      const insertFailedAuthSql = `
        INSERT INTO PaymentAuthorizations
        (OrderID, AuthorizationToken, AuthorizationAmount, TransactionDateTime, AuthExpirationDate, AuthorizationResult, CardType, CardLast4, FailureReason)
        VALUES (?, NULL, ?, ?, NULL, 'Failed', ?, ?, ?)
      `;

      db.run(insertFailedAuthSql, [idToUse, orderTotal, orderDate, safeCardType, cardLast4, failureReason], function (failedErr) {
        if (failedErr) console.error("Database Failed Auth Insert Error:", failedErr.message);

        db.run(`UPDATE Orders SET OrderStatus = 'Payment Failed' WHERE OrderID = ?`, [idToUse]);

        return res.status(400).json({
          success: false,
          orderId: idToUse,
          status: "Payment Failed",
          message: failureReason
        });
      });
    }
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
