require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const db = require("./database/db");
const orderRoutes = require("./routes/orders");
const settlementRoutes = require("./routes/settlements");
const productsRouter = require("./routes/products");

const paymentRoutes = require("./routes/payments");

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
app.use("/api/products", productsRouter);

app.use("/api/payments", paymentRoutes);

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
