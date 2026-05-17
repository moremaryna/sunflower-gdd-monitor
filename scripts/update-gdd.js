const fs = require("fs");
const path = require("path");

const API_KEY = process.env.TOMORROW_API_KEY;

if (!API_KEY) {
  throw new Error("Missing TOMORROW_API_KEY environment variable.");
}

const DATA_PATH = path.join(__dirname, "../src/_data/gdd_sunflowers.json");

const LOCATION = {
  name: "Sunflower field",
  slug: "sunflower-field",
  lat: 52.8457222,
  lon: 0.7285556,
  baseTempC: 6.7,
  upperTempC: 30,
  seasonStart: "2026-05-07",
  crop: "sunflower"
};

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function calculateDailyGdd(tminC, tmaxC, baseTempC, upperTempC) {
  let tmin = Number(tminC);
  let tmax = Number(tmaxC);

  if (!Number.isFinite(tmin) || !Number.isFinite(tmax)) {
    throw new Error(`Invalid temperatures: Tmin=${tminC}, Tmax=${tmaxC}`);
  }

  if (upperTempC !== null && upperTempC !== undefined) {
    tmin = Math.min(tmin, upperTempC);
    tmax = Math.min(tmax, upperTempC);
  }

  const meanTemp = (tmin + tmax) / 2;
  return round(Math.max(meanTemp - baseTempC, 0));
}

function getYesterdayIsoDate() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function fetchRecentDailyWeather() {
  const url = new URL("https://api.tomorrow.io/v4/weather/history/recent");

  url.searchParams.set("location", `${LOCATION.lat},${LOCATION.lon}`);
  url.searchParams.set("timesteps", "1d");
  url.searchParams.set("units", "metric");
  url.searchParams.set("apikey", API_KEY);

  const response = await fetch(url.toString(), {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tomorrow.io API error ${response.status}: ${text}`);
  }

  const json = await response.json();

  const dailyRows =
    json?.timelines?.daily ||
    json?.data?.timelines?.[0]?.intervals ||
    json?.timelines?.[0]?.intervals;

  if (!Array.isArray(dailyRows)) {
    console.log(JSON.stringify(json, null, 2));
    throw new Error("Could not find daily rows in Tomorrow.io response.");
  }

  return dailyRows;
}

function normaliseDailyRow(row) {
  const values = row.values || row;
  const date = new Date(row.time || row.startTime).toISOString().slice(0, 10);

  return {
    date,
    tminC: round(values.temperatureMin),
    tmaxC: round(values.temperatureMax),
    tavgC: round(
      values.temperatureAvg !== undefined
        ? values.temperatureAvg
        : (Number(values.temperatureMin) + Number(values.temperatureMax)) / 2
    )
  };
}

function recalculateCumulative(days) {
  let cumulative = 0;

  return days
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => {
      cumulative = round(cumulative + Number(day.dailyGdd || 0));
      return {
        ...day,
        cumulativeGdd: cumulative
      };
    });
}

async function main() {
  const existing = fs.existsSync(DATA_PATH)
    ? JSON.parse(fs.readFileSync(DATA_PATH, "utf8"))
    : { location: LOCATION, days: [] };

  const rows = await fetchRecentDailyWeather();
  const yesterday = getYesterdayIsoDate();

  const existingByDate = new Map(
    (existing.days || []).map((day) => [day.date, day])
  );

  for (const row of rows) {
    const weather = normaliseDailyRow(row);

    if (weather.date > yesterday) continue;
    if (weather.date < LOCATION.seasonStart) continue;

    const dailyGdd = calculateDailyGdd(
      weather.tminC,
      weather.tmaxC,
      LOCATION.baseTempC,
      LOCATION.upperTempC
    );

    existingByDate.set(weather.date, {
      ...weather,
      dailyGdd,
      source: "tomorrow.io"
    });
  }

  const days = recalculateCumulative([...existingByDate.values()]);

  const output = {
    location: LOCATION,
    lastUpdatedAt: new Date().toISOString(),
    days
  };

  fs.writeFileSync(DATA_PATH, JSON.stringify(output, null, 2) + "\n");

  const latest = days[days.length - 1];

  console.log("GDD updated.");
  console.log(latest || "No GDD rows yet.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
