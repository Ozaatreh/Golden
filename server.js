const express = require("express");
const nodemailer = require("nodemailer");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;

const GOLD_API_URL = "https://data-asg.goldprice.org/dbXRates/USD";
const FX_API_URL = "https://open.er-api.com/v6/latest/USD";
const TROY_OUNCE_IN_GRAMS = 31.1035;
const VALID_PURITY_LEVELS = new Set([24, 22, 21, 18]);

const subscriptions = new Map();
let latestUsdPricePerOunce = null;
let latestUsdToJodRate = null;
let latestFetchError = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/api", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  return next();
});

function getEmailTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
}

function getEmailFrom() {
  return process.env.SMTP_FROM || "alerts@aurum.local";
}

async function fetchGoldPriceUsdPerOunce() {
  const response = await fetch(GOLD_API_URL);
  if (!response.ok) {
    throw new Error(`Gold API error: ${response.status}`);
  }
  const data = await response.json();
  const price = data?.items?.[0]?.xauPrice;
  if (typeof price !== "number") {
    throw new Error("Unexpected gold API response format");
  }
  return price;
}

async function fetchUsdToJodRate() {
  const response = await fetch(FX_API_URL);
  if (!response.ok) {
    throw new Error(`FX API error: ${response.status}`);
  }
  const data = await response.json();
  if (!data || !data.rates || typeof data.rates.JOD !== "number") {
    throw new Error("Unexpected FX API response format");
  }
  return data.rates.JOD;
}

async function refreshReferencePrices() {
  try {
    const [usdPerOunce, usdToJod] = await Promise.all([
      fetchGoldPriceUsdPerOunce(),
      fetchUsdToJodRate()
    ]);

    latestUsdPricePerOunce = usdPerOunce;
    latestUsdToJodRate = usdToJod;
    latestFetchError = null;

    console.log("Gold:", usdPerOunce);
    console.log("USD → JOD:", usdToJod);

  } catch (error) {
    console.error("PRICE FETCH ERROR:", error);
    latestFetchError = error;
  }
}


function convertPrice({ usdPerOunce, unit, currency, usdToJod, purity }) {
  let price = usdPerOunce;
  if (unit === "gram") {
    price = price / TROY_OUNCE_IN_GRAMS;
  }
  if (currency === "JOD") {
    price = price * usdToJod;
  }
  if (purity !== undefined) {
    price = price * (purity / 24);
  }
  return price;
}

function evaluateStatus(currentPrice, lowerThreshold, upperThreshold) {
  if (currentPrice < lowerThreshold) {
    return "below_range";
  }
  if (currentPrice > upperThreshold) {
    return "above_range";
  }
  return "within_range";
}

function buildPayload({ currentPrice, unit, currency, lowerThreshold, upperThreshold, status }) {
  return {
    current_price: Number(currentPrice.toFixed(4)),
    unit,
    currency,
    lower_threshold: lowerThreshold,
    upper_threshold: upperThreshold,
    status,
    timestamp: new Date().toISOString()
  };
}

async function sendAlertEmail({ to, payload, breached }) {
  const transporter = getEmailTransporter();
  if (!transporter) {
    console.warn("Email transport not configured. Skipping alert.");
    return;
  }

  const subject = `Gold price alert: ${breached}`;
  const text = `Gold price alert\n\nCurrent price: ${payload.current_price} ${payload.currency} per ${payload.unit}\nThreshold breached: ${breached}\nLower threshold: ${payload.lower_threshold}\nUpper threshold: ${payload.upper_threshold}\nTimestamp: ${payload.timestamp}`;

  await transporter.sendMail({
    from: getEmailFrom(),
    to,
    subject,
    text
  });
}

async function evaluateSubscriptions() {
  if (latestFetchError || latestUsdPricePerOunce === null || latestUsdToJodRate === null) {
    return;
  }

  for (const [email, subscription] of subscriptions.entries()) {
    const currentPrice = convertPrice({
      usdPerOunce: latestUsdPricePerOunce,
      unit: subscription.unit,
      currency: subscription.currency,
      usdToJod: latestUsdToJodRate,
      purity: subscription.purity
    });
    const status = evaluateStatus(
      currentPrice,
      subscription.lower_threshold,
      subscription.upper_threshold
    );
    const payload = buildPayload({
      currentPrice,
      unit: subscription.unit,
      currency: subscription.currency,
      lowerThreshold: subscription.lower_threshold,
      upperThreshold: subscription.upper_threshold,
      status
    });

    const previousStatus = subscription.lastStatus;
    subscription.lastStatus = status;

    if (status === "within_range") {
      continue;
    }

    if (previousStatus !== status && status !== "within_range") {
  const breached =
    status === "below_range"
      ? "below lower threshold"
      : "above upper threshold";

  try {
    await sendAlertEmail({ to: email, payload, breached });
  } catch (error) {
    console.error("Failed to send alert email", error);
  }
}

  }
}

app.get("/api/price", async (req, res) => {
  const unit = req.query.unit === "gram" ? "gram" : "ounce";
  const currency = req.query.currency === "JOD" ? "JOD" : "USD";
  const purity = Number(req.query.purity);
  const normalizedPurity = VALID_PURITY_LEVELS.has(purity) ? purity : 24;

  if (latestFetchError || latestUsdPricePerOunce === null || latestUsdToJodRate === null) {
    return res.status(503).json({
      error: "Price data currently unavailable. Please try again soon."
    });
  }

  const currentPrice = convertPrice({
    usdPerOunce: latestUsdPricePerOunce,
    unit,
    currency,
    usdToJod: latestUsdToJodRate,
    purity: normalizedPurity
  });

  return res.json({
    current_price: Number(currentPrice.toFixed(4)),
    unit,
    currency,
    timestamp: new Date().toISOString()
  });
});

app.post("/api/monitor", async (req, res) => {
  const { email, unit, currency, lower_threshold, upper_threshold, purity } = req.body || {};

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "Valid email is required." });
  }

  const lower = Number(lower_threshold);
  const upper = Number(upper_threshold);

  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) {
    return res.status(400).json({ error: "Thresholds must be numeric and lower < upper." });
  }

  const normalizedUnit = unit === "gram" ? "gram" : "ounce";
  const normalizedCurrency = currency === "JOD" ? "JOD" : "USD";
  const normalizedPurity = VALID_PURITY_LEVELS.has(Number(purity)) ? Number(purity) : 24;

  subscriptions.set(email, {
  email,
  unit: normalizedUnit,
  currency: normalizedCurrency,
  purity: normalizedPurity,
  lower_threshold: lower,
  upper_threshold: upper,
  lastStatus: undefined
});

// 🔥 Immediately evaluate after subscribing
await evaluateSubscriptions();


  return res.json({ status: "monitoring", email });
});

app.get("/api/agent", (req, res) => {
  const unit = req.query.unit === "gram" ? "gram" : "ounce";
  const currency = req.query.currency === "JOD" ? "JOD" : "USD";
  const lower = Number(req.query.lower_threshold);
  const upper = Number(req.query.upper_threshold);
  const purity = Number(req.query.purity);
  const normalizedPurity = VALID_PURITY_LEVELS.has(purity) ? purity : 24;

  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) {
    return res.status(400).json({ error: "Thresholds must be numeric and lower < upper." });
  }

  if (latestFetchError || latestUsdPricePerOunce === null || latestUsdToJodRate === null) {
    return res.status(503).json({ error: "Price data currently unavailable." });
  }

  const currentPrice = convertPrice({
    usdPerOunce: latestUsdPricePerOunce,
    unit,
    currency,
    usdToJod: latestUsdToJodRate,
    purity: normalizedPurity
  });
  const status = evaluateStatus(currentPrice, lower, upper);

  const payload = buildPayload({
    currentPrice,
    unit,
    currency,
    lowerThreshold: lower,
    upperThreshold: upper,
    status
  });

  return res.json(payload);
});

async function startMonitoring() {
  await refreshReferencePrices();
  setInterval(refreshReferencePrices, 10 * 1000);
  setInterval(evaluateSubscriptions, 10 * 1000);
}

startMonitoring();

app.listen(port, () => {
  console.log(`Aurum listening on port ${port}`);
});
