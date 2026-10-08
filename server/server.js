const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const express = require("express");

const app = express();
const PORT = 3000;

app.use(express.json());

app.use(express.static(path.join(__dirname, "../client")));

app.get("/api/test", (req, res) => {
    res.json({ message: "Group 9 server is working" });
});

app.use("/api/payments", require("./routes/payments"));

if (!process.env.MA_MERCHANT_ID || !process.env.MA_SECRET_KEY) {
    console.warn("Warning: MA_MERCHANT_ID / MA_SECRET_KEY not set. Create a .env file (see .env.example).");
}

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
