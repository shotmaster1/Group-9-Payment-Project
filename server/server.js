const express = require("express");
const path = require("path");

const app = express();
const PORT = 3000;

app.use(express.json());

app.use(express.static(path.join(__dirname, "../client")));

app.get("/api/test", (req, res) => {
    res.json({ message: "Group 9 server is working" });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});