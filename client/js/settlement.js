const params = new URLSearchParams(window.location.search);
const selectedOrderId = params.get("orderId");

if (selectedOrderId) {
    document.getElementById("orderId").value = selectedOrderId;
}

const form = document.getElementById("settlementForm");

form.addEventListener("submit", function(event) {
    event.preventDefault();

    const orderId = document.getElementById("orderId").value;
    const finalAmount = document.getElementById("finalAmount").value;

    console.log("Order ID:", orderId);
    console.log("Final Amount:", finalAmount);


    fetch("/api/settlements", {
    method: "POST",
    headers: {
        "Content-Type": "application/json"
    },
    body: JSON.stringify({
        orderId: orderId,
        finalAmount: finalAmount
    })
})

.then(async response => {
    const data = await response.json();

    return {
        ok: response.ok,
        status: response.status,
        data: data
    };
})
.then(result => {
    const messageBox = document.getElementById("result");

    messageBox.textContent = result.data.message;

    if (!result.ok) {
        alert(result.data.message);
        return;
    }

    alert("Settlement completed successfully.");
})

.catch(error => {
    console.error("Error:", error);
});

});