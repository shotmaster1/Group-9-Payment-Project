const express = require("express");
const router = express.Router();
const db = require("../database/db");
const { createOrderWithItems, OrderError } = require("../services/orderService");
const { PricingError } = require("../services/pricingService");
const { listOrders, getOrderDetails, OrderQueryError } = require("../services/orderQueryService");

// POST /api/orders: authoritative pricing and atomic order/item creation.
router.post("/", async (req, res) => {
  try {
    const order = await createOrderWithItems(req.body, { database: db });
    return res.status(201).json({
      success: true,
      message: "Order created successfully.",
      orderId: order.orderId,
      orderTotal: order.orderTotal,
      orderStatus: order.orderStatus
    });
  } catch (error) {
    if (error instanceof OrderError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    if (error instanceof PricingError) {
      const serverError = ["INVALID_PRODUCT_PRICE", "INVALID_PRODUCT_NAME", "INVALID_PRODUCT_DATA"].includes(error.code);
      const status = serverError ? 500 : error.code === "PRODUCT_NOT_FOUND" ? 404 : 400;
      return res.status(status).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: "Failed to create order." });
  }
});

// GET /api/orders: one row per order, with its highest-ID authorization.
router.get("/", async (req, res) => {
  try {
    const orders = await listOrders(req.query, { database: db });
    return res.status(200).json({ success: true, count: orders.length, orders });
  } catch (error) {
    if (error instanceof OrderQueryError) {
      return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: "Failed to retrieve orders." });
  }
});

// GET /api/orders/:id: safe, snapshot-based details for the warehouse UI.
router.get("/:id", async (req, res) => {
  try {
    const order = await getOrderDetails(req.params.id, { database: db });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }
    return res.status(200).json({ success: true, order });
  } catch (error) {
    if (error instanceof OrderQueryError) {
      return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: "Failed to retrieve order details." });
  }
});

module.exports = router;
