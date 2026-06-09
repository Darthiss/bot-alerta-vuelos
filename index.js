require("dotenv").config();
const axios = require("axios");
const { sendTelegram } = require("./telegram");

const ORIGIN = "EZE";
const DESTINATION = "BCN";
const MONTHS = [
  "2026-07", "2026-08", "2026-09", "2026-10",
  "2026-11", "2026-12", "2027-01", "2027-02"
];
const PRICE_THRESHOLD = 650;    // EUR per person, round trip total
const MIN_STAY_DAYS = 10;
const SCAN_STEP_DAYS = 1;       // check every departure day — no gaps for the promo to hide in
const SCAN_RETURN_OFFSET = 14;  // days; satisfies ≥10 day minimum
// On expansion (deal confirmed), check these return offsets for both adult counts
const EXPAND_RETURN_OFFSETS = [10, 14, 17, 21, 28, 35];
const PASSENGER_COUNTS = [1, 2];
const CURRENCY = "EUR";
const LOOP_INTERVAL_MS = 2 * 60 * 1000;
const CONCURRENCY = 3;          // parallel API calls per batch
const DEAL_RENOTIFY_MS = 4 * 60 * 60 * 1000;
const MAX_RUNTIME_MS = 28 * 60 * 1000; // exit after 28 min so GitHub Actions job completes cleanly

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
  "Referer": "https://www.flylevel.com/",
  "Origin": "https://www.flylevel.com"
};

const alertedDeals = new Map();

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function bestFarePrice(fare) {
  const promo = fare.totalPriceWithPromo;
  return (promo !== null && promo < fare.totalPrice) ? promo : fare.totalPrice;
}

function departureDatesForMonth(yearMonth) {
  const [year, m] = yearMonth.split("-").map(Number);
  const daysInMonth = new Date(year, m, 0).getDate();
  const dates = [];
  for (let day = 1; day <= daysInMonth - MIN_STAY_DAYS; day += SCAN_STEP_DAYS) {
    dates.push(new Date(year, m - 1, day).toISOString().split("T")[0]);
  }
  return dates;
}

async function checkPair(outDate, retDate, adults) {
  const url = `https://www.flylevel.com/nwe/api/flights/?o1=${ORIGIN}&d1=${DESTINATION}&dd1=${outDate}&dd2=${retDate}&ADT=${adults}&CHD=0&INL=0&r=true&mm=false&forcedCurrency=${CURRENCY}&forcedCulture=es-ES&newecom=true`;
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
    const outbound = res.data?.flightsInfo?.outboundJourneys || [];
    const inbound = res.data?.flightsInfo?.inboundJourneys || [];
    if (!outbound.length || !inbound.length) return null;

    let best = null;
    for (const o of outbound) {
      for (const outGroup of Object.values(o.fares)) {
        for (const outFare of outGroup) {
          for (const i of inbound) {
            for (const inGroup of Object.values(i.fares)) {
              for (const inFare of inGroup) {
                const total = bestFarePrice(outFare) + bestFarePrice(inFare);
                const pricePerPax = total / adults;
                if (pricePerPax <= PRICE_THRESHOLD) {
                  if (!best || pricePerPax < best.pricePerPax) {
                    best = {
                      outDate, retDate,
                      stayDays: Math.round((new Date(retDate) - new Date(outDate)) / 86400000),
                      groupOut: outFare.group,
                      groupIn: inFare.group,
                      total, adults, pricePerPax
                    };
                  }
                }
              }
            }
          }
        }
      }
    }
    return best;
  } catch (err) {
    console.error(`[err] ${outDate}→${retDate} (${adults}pax): ${err.message}`);
    return null;
  }
}

// Run up to `concurrency` promises at a time.
async function pooled(tasks, concurrency) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency).map(t => t());
    results.push(...await Promise.all(batch));
  }
  return results;
}

async function sendAlert(deal) {
  const key = `${deal.outDate}|${deal.retDate}|${deal.adults}`;
  const lastAlert = alertedDeals.get(key) || 0;
  if (Date.now() - lastAlert < DEAL_RENOTIFY_MS) return;
  alertedDeals.set(key, Date.now());

  const bookingUrl = `https://www.flylevel.com/Flight/Select?o1=${ORIGIN}&d1=${DESTINATION}&dd1=${deal.outDate}&dd2=${deal.retDate}&ADT=${deal.adults}&CHD=0&Inl=0&r=TRUE&mm=FALSE&forcedCurrency=${CURRENCY}&forcedCulture=es-ES`;
  const msg = `✈️ *¡VUELO BARATO EZE→BCN!*
Ida: *${deal.outDate}*   Vuelta: *${deal.retDate}*  (${deal.stayDays} días)
Tarifa: ${deal.groupOut} / ${deal.groupIn}
Pasajeros: ${deal.adults}
Total: ${CURRENCY} ${deal.total.toFixed(0)}
*Por persona: ${CURRENCY} ${deal.pricePerPax.toFixed(0)}*

[👉 Reservar ahora](${bookingUrl})`;

  console.log(`[ALERTA] ${deal.outDate}→${deal.retDate} | ${deal.adults}pax | ${CURRENCY} ${deal.pricePerPax.toFixed(0)}/pax`);
  await sendTelegram(msg);
}

// When a cheap outbound date is found, check all return offsets + both adult counts.
async function expandAndAlert(outDate) {
  const tasks = [];
  for (const offset of EXPAND_RETURN_OFFSETS) {
    if (offset < MIN_STAY_DAYS) continue;
    for (const adults of PASSENGER_COUNTS) {
      const retDate = addDays(outDate, offset);
      tasks.push(() => checkPair(outDate, retDate, adults));
    }
  }
  const deals = await pooled(tasks, CONCURRENCY);
  for (const deal of deals) {
    if (deal) await sendAlert(deal);
  }
}

let scanning = false; // prevent overlapping runs

async function main() {
  if (scanning) {
    console.log(`[${new Date().toLocaleTimeString()}] Ciclo anterior aún en curso, saltando.`);
    return;
  }
  scanning = true;
  const start = Date.now();
  console.log(`[${new Date().toLocaleTimeString()}] Escaneando ${MONTHS.length} meses...`);

  try {
    const triggeredDates = new Set();

    for (const month of MONTHS) {
      const departures = departureDatesForMonth(month);
      // Fast pass: 1 adult, fixed 14-day return, batched concurrently
      const tasks = departures.map(outDate => async () => {
        const retDate = addDays(outDate, SCAN_RETURN_OFFSET);
        const deal = await checkPair(outDate, retDate, 1);
        if (deal) triggeredDates.add(outDate);
      });
      await pooled(tasks, CONCURRENCY);
    }

    // Expand on any triggered departure dates
    for (const outDate of triggeredDates) {
      await expandAndAlert(outDate);
    }
  } finally {
    scanning = false;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[${new Date().toLocaleTimeString()}] Listo en ${elapsed}s\n`);
  }
}

main();
const loop = setInterval(main, LOOP_INTERVAL_MS);
setTimeout(() => { clearInterval(loop); console.log("[fin] Tiempo límite alcanzado, cerrando."); process.exit(0); }, MAX_RUNTIME_MS);
