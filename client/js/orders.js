let activeController = null;
let requestCounter = 0;
let searchTimer = null;

function showOrdersMessage(message) {
    const tableBody = document.getElementById("ordersTableBody");
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 10;
    cell.textContent = message;
    row.appendChild(cell);
    tableBody.replaceChildren(row);
}

function reloadOrders(delay = 0) {
    clearTimeout(searchTimer);
    searchTimer = null;

    // Invalidate responses immediately, including while search is debouncing.
    const requestId = ++requestCounter;
    if (activeController) {
        activeController.abort();
        activeController = null;
    }
    showOrdersMessage("Loading orders...");

    if (delay > 0) {
        searchTimer = setTimeout(() => {
            searchTimer = null;
            loadOrders(requestId);
        }, delay);
    } else {
        loadOrders(requestId);
    }
}

async function loadOrders(requestId) {
    const controller = new AbortController();
    activeController = controller;
    const params = new URLSearchParams({
        status: document.getElementById("statusFilter").value,
        search: document.getElementById("searchInput").value.trim(),
        sort: document.getElementById("sortOrder").value,
    });

    try {
        const response = await fetch(`/api/orders?${params.toString()}`, {
            signal: controller.signal,
        });
        if (requestId !== requestCounter) return;
        if (!response.ok) throw new Error("Order request failed");

        const data = await response.json();
        if (requestId !== requestCounter) return;
        if (!data || data.success !== true || !Array.isArray(data.orders)) {
            throw new Error("Invalid orders response");
        }

        if (data.orders.length === 0) {
            showOrdersMessage("No orders match your search and filters.");
        } else {
            // Filtering and order-date sorting are owned by the backend.
            renderOrders(data.orders);
        }
    } catch {
        if (requestId === requestCounter && !controller.signal.aborted) {
            showOrdersMessage("Unable to load orders. Please try again.");
        }
    } finally {
        if (requestId === requestCounter) {
            activeController = null;
        }
    }
}

function formatAuthorizationExpiration(value) {
    if (typeof value !== "string") return "N/A";

    // Accept ISO dates and timestamps with an explicit timezone only.
    const text = value.trim();
    const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2})))?$/);
    if (!match) return "N/A";

    // Reject impossible calendar dates that Date would otherwise normalize.
    const calendarDate = new Date(`${match[1]}T00:00:00Z`);
    if (Number.isNaN(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== match[1]) {
        return "N/A";
    }

    // Date-only values have no timezone; preserve their original calendar date.
    if (match[2] === undefined) return match[1];

    const [, , hour, minute, second = "0", , offsetHour = "0", offsetMinute = "0"] = match;
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
        Number(offsetHour) > 23 || Number(offsetMinute) > 59) {
        return "N/A";
    }

    const timestamp = new Date(text);
    if (Number.isNaN(timestamp.getTime())) return "N/A";

    return timestamp.toISOString().replace("T", " ").replace(/(?:\.000)?Z$/, " UTC");
}

function renderOrders(orders) {
    const tableBody = document.getElementById("ordersTableBody");

    tableBody.replaceChildren();

    orders.forEach((order) => {
        const row = document.createElement("tr");

        // Keep API values in text nodes, never HTML or inline JavaScript.
        const last4 = String(order.CardLast4 || "");
        const cardType = String(order.CardType || "");
        const cardDisplay = cardType && /^\d{4}$/.test(last4)
            ? `${cardType.charAt(0).toUpperCase() + cardType.slice(1)} •••• ${last4}`
            : "N/A";

        const values = [
            order.OrderID,
            order.CustomerName || "",
            order.CustomerEmail || "",
            `$${Number(order.OrderTotal || 0).toFixed(2)}`,
            order.OrderStatus || "",
            order.OrderDate ? new Date(order.OrderDate).toLocaleString() : "",
            cardDisplay,
            // Indicate authorization availability without exposing the token.
            order.HasAuthorizationToken === true ? "Available" : "N/A",
            formatAuthorizationExpiration(order.AuthExpirationDate),
        ];

        values.forEach((value) => {
            const cell = document.createElement("td");
            cell.textContent = value ?? "";
            row.appendChild(cell);
        });

        const actionCell = document.createElement("td");
        if (order.OrderStatus === "Authorized") {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "Settle Order";
            button.addEventListener("click", () => openSettlement(order.OrderID));
            actionCell.appendChild(button);
        } else {
            actionCell.textContent = "Not Available";
        }
        row.appendChild(actionCell);

        tableBody.appendChild(row);
    });
}

function openSettlement(orderId) {
    window.location.href =
        `warehouse.html?orderId=${encodeURIComponent(orderId)}`;
}

document
    .getElementById("searchInput")
    .addEventListener("input", () => reloadOrders(250));

document
    .getElementById("statusFilter")
    .addEventListener("change", () => reloadOrders());

document
    .getElementById("sortOrder")
    .addEventListener("change", () => reloadOrders());

reloadOrders();
