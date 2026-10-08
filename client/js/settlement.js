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
.then(response => response.json())
.then(data => {
    document.getElementById("result").textContent = data.message;
})
.catch(error => {
    console.error("Error:", error);
});

});