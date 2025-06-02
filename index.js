require("dotenv").config();
const axios = require("axios");
const { sendTelegram } = require("./telegram");

const ORIGIN = "EZE";
const DESTINATION = "BCN";
const MONTHS = ["2026-01", "2026-02", "2026-03"];
const PASSENGER_COUNTS = [1, 2];
const PRICE_THRESHOLD = 1000;
const MIN_STAY_DAYS = 14;
const MAX_STAY_DAYS = 60;

async function getCalendarPrices(month, year) {
  const url = `https://www.flylevel.com/nwe/flights/api/calendar/?triptype=RT&origin=${ORIGIN}&destination=${DESTINATION}&month=${month}&year=${year}&currencyCode=USD`;
  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "application/json",
        "Referer": "https://www.flylevel.com/"
      }
    });
    return data.data.dayPrices || [];
  } catch (err) {
    console.error(`Error al obtener precios del calendario ${month}/${year}:`, err.message);
    return [];
  }
}

function combinePromisingDates(dayPrices) {
  const combos = [];
  const dates = dayPrices.map(p => ({
    date: p.date,
    price: p.price
  }));

  for (let i = 0; i < dates.length; i++) {
    const ida = dates[i];
    for (
      let j = i + MIN_STAY_DAYS;
      j < dates.length && j <= i + MAX_STAY_DAYS;
      j++
    ) {
      const vuelta = dates[j];
      const total = ida.price + vuelta.price;

      if (total <= PRICE_THRESHOLD) {
        combos.push({
          ida: ida.date,
          vuelta: vuelta.date,
          estimate: total
        });
      }
    }
  }

  return combos;
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
                  if (
                    !cheapestRoundTrip ||
                    pricePerPassenger < cheapestRoundTrip.pricePerPassenger
                  ) {
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
  for (const m of MONTHS) {
    const [year, month] = m.split("-");
    const calendarPrices = await getCalendarPrices(month, year);
    const combos = combinePromisingDates(calendarPrices);

    for (const { ida, vuelta } of combos) {
      for (const adults of PASSENGER_COUNTS) {
        await checkFlight(ida, vuelta, adults);
      }
    }
  }
}

main();
