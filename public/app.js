const priceDisplay = document.getElementById("priceDisplay");
const priceMeta = document.getElementById("priceMeta");
const unitSelect = document.getElementById("unitSelect");
const currencySelect = document.getElementById("currencySelect");
const puritySelect = document.getElementById("puritySelect");
const lowerThresholdInput = document.getElementById("lowerThreshold");
const upperThresholdInput = document.getElementById("upperThreshold");
const emailInput = document.getElementById("emailInput");
const startMonitoringButton = document.getElementById("startMonitoring");
const monitorStatus = document.getElementById("monitorStatus");
const agentOutput = document.getElementById("agentOutput");

let refreshTimer = null;
let agentTimer = null;

const apiBase = window.location.protocol === "file:" ? "http://localhost:3000" : "";

function formatPrice(value, currency) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 4
  }).format(value);
}

async function fetchLivePrice() {
  const unit = unitSelect.value;
  const currency = currencySelect.value;
  const purity = puritySelect.value;
  priceMeta.textContent = "Refreshing price...";
  try {
    const response = await fetch(
      `${apiBase}/api/price?unit=${unit}&currency=${currency}&purity=${purity}`
    );
    if (!response.ok) {
      throw new Error("Price unavailable");
    }
    const data = await response.json();
    priceDisplay.textContent = formatPrice(data.current_price, currency);
    priceMeta.textContent = `Updated ${new Date(data.timestamp).toLocaleTimeString()}`;
  } catch (error) {
    priceDisplay.textContent = "--";
    priceMeta.textContent = "Live price unavailable. Please try again soon.";
    monitorStatus.textContent = "Live data unavailable. Ensure the backend is running at http://localhost:3000.";
    monitorStatus.className = "status error";
  }
}

function getThresholdValues() {
  return {
    lower: Number(lowerThresholdInput.value),
    upper: Number(upperThresholdInput.value)
  };
}

async function fetchAgentPayload() {
  const { lower, upper } = getThresholdValues();
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) {
    agentOutput.textContent = "Set valid thresholds to view agent output.";
    return;
  }

  const unit = unitSelect.value;
  const currency = currencySelect.value;
  const purity = puritySelect.value;
  try {
    const response = await fetch(
      `${apiBase}/api/agent?unit=${unit}&currency=${currency}&purity=${purity}&lower_threshold=${lower}&upper_threshold=${upper}`
    );
    if (!response.ok) {
      throw new Error("Agent unavailable");
    }
    const data = await response.json();
    agentOutput.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    agentOutput.textContent = "Agent unavailable. Please try again soon.";
    monitorStatus.textContent = "Agent unavailable. Start the backend server to enable alerts.";
    monitorStatus.className = "status error";
  }
}

async function startMonitoring() {
  const { lower, upper } = getThresholdValues();
  const email = emailInput.value.trim();

  if (!email) {
    monitorStatus.textContent = "Enter a valid email address to begin monitoring.";
    monitorStatus.className = "status error";
    return;
  }

  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) {
    monitorStatus.textContent = "Please provide a valid lower and upper threshold.";
    monitorStatus.className = "status error";
    return;
  }

  const payload = {
    email,
    unit: unitSelect.value,
    currency: currencySelect.value,
    purity: Number(puritySelect.value),
    lower_threshold: lower,
    upper_threshold: upper
  };

  try {
    const response = await fetch(`${apiBase}/api/monitor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error("Unable to start monitoring");
    }

    monitorStatus.textContent = `Monitoring started for ${email}. Alerts will be sent when thresholds are breached.`;
    monitorStatus.className = "status success";
  } catch (error) {
    monitorStatus.textContent =
      "Unable to start monitoring. Ensure the backend is running at http://localhost:3000.";
    monitorStatus.className = "status error";
  }
}

function scheduleRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  refreshTimer = setInterval(fetchLivePrice, 10 * 1000);
}

function scheduleAgentRefresh() {
  if (agentTimer) {
    clearInterval(agentTimer);
  }
  agentTimer = setInterval(fetchAgentPayload, 10 * 1000);
}

startMonitoringButton.addEventListener("click", async () => {
  await startMonitoring();
  await fetchLivePrice();
  await fetchAgentPayload();
});

[unitSelect, currencySelect, puritySelect].forEach((element) => {
  element.addEventListener("change", () => {
    fetchLivePrice();
    fetchAgentPayload();
  });
});

[lowerThresholdInput, upperThresholdInput].forEach((element) => {
  element.addEventListener("input", () => {
    fetchAgentPayload();
  });
});

fetchLivePrice();
fetchAgentPayload();
scheduleRefresh();
scheduleAgentRefresh();
