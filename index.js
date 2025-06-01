// Archivo: index.js
require("dotenv").config();
const axios = require("axios");
const { sendTelegram } = require("./telegram");

const ORIGIN = "EZE";
const DESTINATION = "BCN";
const MONTHS = ["2025-12", "2026-01", "2026-02", "2026-03"];
const PASSENGER_COUNTS = [2];//, 4, 7];
const PRICE_THRESHOLD = 600;

// Genera combinaciones ida-vuelta a 7, 14 y 21 días
function generateDatePairs(month) {
  const pairs = [];
  const [year, m] = month.split("-").map(Number);
  const daysInMonth = new Date(year, m, 0).getDate();

  for (let day = 1; day <= daysInMonth - 21; day++) {
    const ida = new Date(year, m - 1, day);
    [14, 21].forEach(offset => {
      const vuelta = new Date(ida);
      vuelta.setDate(ida.getDate() + offset);

      const idaStr = ida.toISOString().split("T")[0];
      const vueltaStr = vuelta.toISOString().split("T")[0];
      pairs.push([idaStr, vueltaStr]);
    });
  }
  return pairs;
}

async function checkFlight(ida, vuelta, adults) {
  const url = `https://www.flylevel.com/nwe/api/flights/?o1=${ORIGIN}&d1=${DESTINATION}&dd1=${ida}&dd2=${vuelta}&ADT=${adults}&CHD=0&INL=0&r=true&mm=true&forcedCurrency=USD&forcedCulture=es-ES&newecom=true`;
  try {
    const res = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Referer": "https://www.flylevel.com/"
      }
    });

    const outbound = res.data.flightsInfo.outboundJourneys || [];
    const inbound = res.data.flightsInfo.inboundJourneys || [];
    let cheapestRoundTrip = null;

    outbound.forEach(o => {
      Object.values(o.fares).forEach(outboundGroup => {
        outboundGroup.forEach(outboundFare => {
          inbound.forEach(i => {
            Object.values(i.fares).forEach(inboundGroup => {
              inboundGroup.forEach(inboundFare => {
                const total = outboundFare.totalPrice + inboundFare.totalPrice;
                const pricePerPassenger = total / adults;

                if (pricePerPassenger <= PRICE_THRESHOLD) {
                  if (!cheapestRoundTrip || pricePerPassenger < cheapestRoundTrip.pricePerPassenger) {
                    cheapestRoundTrip = {
                      ida,
                      vuelta,
                      groupOut: outboundFare.group,
                      groupIn: inboundFare.group,
                      total,
                      count: adults,
                      pricePerPassenger
                    };
                  }
                }
              });
            });
          });
        });
      });
    });

    if (cheapestRoundTrip) {
      const msg = `\u2708\ufe0f *Vuelo barato encontrado!*
Origen: *${ORIGIN}*  \u2192  Destino: *${DESTINATION}*
Fecha ida: ${cheapestRoundTrip.ida}
Fecha vuelta: ${cheapestRoundTrip.vuelta}
Clases: Ida *${cheapestRoundTrip.groupOut}* / Vuelta *${cheapestRoundTrip.groupIn}*
Pasajeros: ${cheapestRoundTrip.count}
Total aprox: USD ${cheapestRoundTrip.total.toFixed(2)}
Precio final por adulto: *USD ${cheapestRoundTrip.pricePerPassenger.toFixed(2)}*`;
      await sendTelegram(msg);
    }

  } catch (err) {
    console.error(`Error ${ida} -> ${vuelta} (${adults}):`, err.message);
  }
}

async function main() {
  for (const month of MONTHS) {
    const pairs = generateDatePairs(month);
    for (const [ida, vuelta] of pairs) {
      for (const adults of PASSENGER_COUNTS) {
        await checkFlight(ida, vuelta, adults);
      }
    }
  }
}

main();
