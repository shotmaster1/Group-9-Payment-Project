const params = new URLSearchParams(window.location.search);
const selectedOrderId = params.get("orderId");
const form = document.getElementById("settlementForm");
const orderIdInput = document.getElementById("orderId");
const amountInput = document.getElementById("finalAmount");
const submitButton = document.getElementById("settlementSubmitButton");
const messageBox = document.getElementById("result");
let inFlight = false;
let submissionLocked = false;

if (selectedOrderId) {
    orderIdInput.value = selectedOrderId;
}

function updateSubmissionState() {
    const disabled = inFlight || submissionLocked;
    submitButton.disabled = disabled;
    orderIdInput.disabled = disabled;
    amountInput.disabled = disabled;
    submitButton.textContent = inFlight ? "Submitting settlement..." : "Submit Settlement";
    form.setAttribute("aria-busy", String(inFlight));
}

function showUncertainOutcome(detail) {
    submissionLocked = true;
    messageBox.textContent = `${detail} The settlement outcome is uncertain. ` +
        "Verify the order status before attempting another settlement.";
}

form.addEventListener("submit", async function(event) {
    event.preventDefault();
    if (inFlight || submissionLocked) return;

    // Snapshot values before locking the controls or awaiting the request.
    const orderId = orderIdInput.value.trim();
    const amountText = amountInput.value.trim();
    const finalAmount = Number(amountText);

    if (!orderId) {
        messageBox.textContent = "Enter an Order ID.";
        orderIdInput.focus();
        return;
    }
    if (!amountText || !Number.isFinite(finalAmount) || finalAmount <= 0) {
        messageBox.textContent = "Enter a settlement amount greater than $0.";
        amountInput.focus();
        return;
    }
    if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(amountText)) {
        messageBox.textContent = "Use a decimal amount with no more than two decimal places.";
        amountInput.focus();
        return;
    }

    inFlight = true;
    updateSubmissionState();
    messageBox.textContent = "Submitting settlement...";

    try {
        const response = await fetch("/api/settlements", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderId, finalAmount }),
        });

        let data = null;
        try {
            data = await response.json();
        } catch {
            // HTTP 400/404 are definite rejections even if their body is unreadable.
        }
        const message = data && typeof data.message === "string" && data.message.trim()
            ? data.message
            : null;

        if (response.status === 400 || response.status === 404) {
            messageBox.textContent = message || (response.status === 404
                ? "No successful payment authorization was found for this Order ID."
                : "Settlement rejected. Check the Order ID and amount.");
            return;
        }
        if (!response.ok) {
            showUncertainOutcome(message || "The server could not confirm the settlement.");
            return;
        }

        // The current API has no success boolean. Confirm its documented fields.
        if (!message || data.orderId !== orderId || !Number.isFinite(data.finalAmount) ||
            data.finalAmount !== finalAmount || !Number.isFinite(data.authorizedAmount) ||
            data.authorizedAmount < finalAmount) {
            showUncertainOutcome("The server returned an unexpected settlement response.");
            return;
        }

        submissionLocked = true;
        messageBox.textContent = message;
    } catch {
        showUncertainOutcome("The settlement response could not be received.");
    } finally {
        inFlight = false;
        updateSubmissionState();
    }

});
