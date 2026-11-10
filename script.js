/**
 * White Noise — Live Snow Report
 *
 * Reading order (section headers below):
 *   1.  Config          — tunable values
 *   2.  DOM             — element lookups (one place)
 *   3.  State           — mutable runtime data
 *   4.  Utilities       — pure helper functions
 *   5.  Units           — display formatting
 *   6.  Severity        — snow intensity tiers
 *   7.  Weather API     — network layer
 *   8.  Render          — DOM updates
 *   9.  Tooltip         — shared hover popup
 *  10.  Hourly data     — cache for tooltips
 *  11.  Events          — event listener wiring
 *  12.  Actions         — user intent handlers
 *  13.  Boot            — preloader flow
 *  14.  Background      — animated triangles
 *  15.  Startup         — initialize app
 *
 * Naming conventions:
 *   - Functions:   verbNoun (renderReport, loadCity)
 *   - Booleans:    isSomething (isSearching)
 *   - Constants:   SCREAMING_SNAKE
 */

'use strict';

/* ============================================================
   1. CONFIG
   All tunable values in one place.
   ============================================================ */

const CONFIG = {
  fallbackCity:        'Bozeman',   // shown if geolocation is denied
  cacheLifetimeMs:     10 * 60 * 1000,
  minimumBootDisplayMs: 1400,
  geolocationTimeoutMs: 3500,
  navigationFadeMs:    300,
  navigationSettleMs:  80,
  homeSignalMs:        2200,
  resizeDebounceMs:    200
};

/* ============================================================
   2. DOM
   Every getElementById call in one place so we never
   re-query during renders.
   ============================================================ */

const dom = {
  // Top bar
  brandBtn:           document.getElementById('brandBtn'),
  cityInput:          document.getElementById('cityInput'),
  locationBtn:        document.getElementById('locationBtn'),
  searchBtn:          document.getElementById('searchBtn'),
  liveBadge:          document.getElementById('liveBadge'),
  liveText:           document.getElementById('liveText'),
  updatedAt:          document.getElementById('updatedAt'),
  unitToggle:         document.getElementById('unitToggle'),

  // Boot
  bootScreen:         document.getElementById('boot'),
  bootBar:            document.getElementById('bootBar'),
  bootStatus:         document.getElementById('bootStatus'),

  // Hero
  tickerText:         document.getElementById('tickerText'),
  locName:            document.getElementById('locName'),
  inlineDots:         document.getElementById('inlineDots'),
  homeBadge:          document.getElementById('homeBadge'),
  backToLocationBtn:  document.getElementById('backToLocationBtn'),
  backToLocationName: document.getElementById('backToLocationName'),
  date:               document.getElementById('date'),
  clearWeatherBanner: document.getElementById('clearWeatherBanner'),
  rateBlock:          document.getElementById('rateBlock'),
  depth:              document.getElementById('depth'),
  snowfallRate:       document.getElementById('snowfallRate'),
  temperature:        document.getElementById('temperature'),
  windChill:          document.getElementById('windChill'),
  windSpeed:          document.getElementById('windSpeed'),
  rowRate:            document.getElementById('rowRate'),
  rowTemp:            document.getElementById('rowTemp'),
  rowChill:           document.getElementById('rowChill'),
  rowWind:            document.getElementById('rowWind'),
  chanceBars:         document.getElementById('chanceBars'),
  heroBarChart:       document.getElementById('heroBarChart'),

  // Section 01: Timeline
  peakRate:           document.getElementById('peakRate'),
  peakTime:           document.getElementById('peakTime'),
  peakSeverity:       document.getElementById('peakSeverity'),
  hourlyTimeline:     document.getElementById('hourlyTimeline'),
  past24h:            document.getElementById('past24h'),
  past48h:            document.getElementById('past48h'),
  next24h:            document.getElementById('next24h'),
  next72h:            document.getElementById('next72h'),
  next24hStat:        document.getElementById('next24hStat'),
  next24hSeverity:    document.getElementById('next24hSeverity'),

  // Section 02: Nearby
  nearbyCards:        document.getElementById('nearbyCards'),

  // Section 03: Season
  seasonChart:        document.getElementById('seasonChart'),
  seasonTotal:        document.getElementById('seasonTotal'),
  seasonDelta:        document.getElementById('seasonDelta'),
  seasonNote:         document.getElementById('seasonNote'),

  // Globals
  footstamp:          document.getElementById('footstamp'),
  globalTooltip:      document.getElementById('globalTooltip'),
  errorBanner:        document.getElementById('errorBanner'),

  // Node lists (queried once)
  allDataContainers:  document.querySelectorAll('.data-container'),
  allScrollReveal:    document.querySelectorAll('.scroll-reveal')
};

/* ============================================================
   3. STATE
   The single source of truth for mutable data.
   ============================================================ */

const state = {
  currentWeatherData: null,
  homeData:           null,   // first loaded location — logo returns here
  parentLocation:     null,   // the location we drilled in from
  unitSystem:         'imperial',
  isSearching:        false,
  isNavigating:       false,
  resultCache:        new Map(),
  activeRequest:      null,
  lastFetchedAt:      null,
  tickerBaseHtml:     ''
};

// Restore saved unit preference (with migration from an older key)
try {
  const saved = localStorage.getItem('white-noise-units')
              || localStorage.getItem('snowfall-units');
  if (saved === 'metric' || saved === 'imperial') {
    state.unitSystem = saved;
  }
} catch (err) {
  /* localStorage can be blocked in private mode — ignore */
}

/* ============================================================
   4. UTILITIES
   ============================================================ */

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Sum an array slice. Clamps start/end to valid bounds. */
function sumSlice(numbers, startIndex, endIndex) {
  return numbers
    .slice(Math.max(0, startIndex), endIndex + 1)
    .reduce((total, value) => total + (value || 0), 0);
}

/**
 * Find the array index in hourly.time[] that matches "now" in the
 * location's local time (not the browser's time). Falls back to a
 * best-guess if the exact hour isn't present.
 */
function findCurrentHourIndex(weatherData) {
  if (!weatherData?.current?.time || !weatherData?.hourly?.time) {
    return 24;
  }

  const currentHour = weatherData.current.time.slice(0, 13) + ':00';
  const exactIndex = weatherData.hourly.time.indexOf(currentHour);
  if (exactIndex >= 0) return exactIndex;

  const todayDate = weatherData.current.time.slice(0, 10);
  const startOfToday = weatherData.hourly.time.findIndex((t) => t.startsWith(todayDate));
  const currentHourOfDay = parseInt(weatherData.current.time.slice(11, 13), 10) || 0;

  return startOfToday >= 0 ? startOfToday + currentHourOfDay : 24;
}

function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * The geocoder sometimes returns the same string in multiple
 * fields (e.g. "Oslo / Oslo / Norway"). This filters duplicates
 * so we don't show "OSLO, OSLO, NORWAY".
 */
function getUniquePlaceNames(name, admin1, country) {
  const seen = new Set();
  const unique = [];

  for (const part of [name, admin1, country]) {
    if (!part) continue;
    const key = part.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(part);
  }

  return unique;
}

/* ============================================================
   5. UNITS
   The API always returns metric. These functions handle display.
   ============================================================ */

const units = {
  isMetric() {
    return state.unitSystem === 'metric';
  },

  formatDepth(meters) {
    return this.isMetric()
      ? { value: (meters * 100).toFixed(1), unit: 'CM' }
      : { value: (meters * 39.3701).toFixed(1), unit: 'IN' };
  },

  formatSnowfall(centimeters) {
    return this.isMetric()
      ? { value: centimeters.toFixed(1), unit: 'CM' }
      : { value: (centimeters / 2.54).toFixed(1), unit: 'IN' };
  },

  formatRate(centimetersPerHour) {
    return this.isMetric()
      ? { value: centimetersPerHour.toFixed(2), unit: 'CM/HR' }
      : { value: (centimetersPerHour / 2.54).toFixed(2), unit: 'IN/HR' };
  },

  formatTemperature(celsius) {
    return this.isMetric()
      ? { value: Math.round(celsius), unit: '°C' }
      : { value: Math.round(celsius * 9 / 5 + 32), unit: '°F' };
  },

  formatWind(kilometersPerHour) {
    return this.isMetric()
      ? { value: Math.round(kilometersPerHour), unit: 'KM/H' }
      : { value: Math.round(kilometersPerHour / 1.60934), unit: 'MPH' };
  },

  /** Internal helper — used for threshold comparisons that are always in inches. */
  centimetersToInches(centimeters) {
    return (centimeters || 0) / 2.54;
  },

  refreshLabels() {
    const lengthLabel = this.isMetric() ? 'CM' : 'IN';
    const rateLabel   = this.isMetric() ? 'CM/HR' : 'IN/HR';

    document.querySelectorAll('[data-unit="length"]').forEach((el) => {
      el.textContent = lengthLabel;
    });

    document.querySelectorAll('[data-unit="rate"]').forEach((el) => {
      el.textContent = rateLabel;
    });
  }
};

/* ============================================================
   6. SEVERITY
   Thresholds aligned to NWS advisory and warning criteria.
   ============================================================ */

const severity = {
  /** Inches per hour → tier. */
  fromRate(inchesPerHour) {
    if (inchesPerHour > 0.3) return 'severe';
    if (inchesPerHour > 0.1) return 'moderate';
    if (inchesPerHour > 0)   return 'low';
    return 'none';
  },

  /** Total inches → tier. */
  fromTotal(inches) {
    if (inches >= 6) return 'severe';
    if (inches >= 3) return 'moderate';
    if (inches > 0)  return 'low';
    return 'none';
  },

  label(level) {
    return {
      severe:   'SEVERE',
      moderate: 'MODERATE',
      low:      'LOW',
      none:     '—'
    }[level] || '—';
  },

  cssClass(level) {
    return 'severity-' + level;
  },

  advice(level) {
    return {
      severe:   'AVOID UNNECESSARY TRAVEL',
      moderate: 'TRAVEL WITH CAUTION',
      low:      'LIGHT SNOW POSSIBLE',
      none:     'CLEAR SKIES'
    }[level] || 'CLEAR SKIES';
  },

  /** Sort rank — 0 = most severe. Used to order nearby cards. */
  rank(level) {
    return { severe: 0, moderate: 1, low: 2, none: 3 }[level] ?? 3;
  }
};

/* ============================================================
   7. WEATHER API
   All network requests. No DOM touches.
   ============================================================ */

const weatherApi = {

  async fetchByCity(cityName) {
    const cacheKey = 'city:' + cityName.toLowerCase();
    const cached = state.resultCache.get(cacheKey);

    if (cached && Date.now() - cached.savedAt < CONFIG.cacheLifetimeMs) {
      return { ...cached.data, _fetchedAt: cached.savedAt };
    }

    this._cancelInFlight();
    state.activeRequest = new AbortController();
    const { signal } = state.activeRequest;

    const location = await this._geocode(cityName, signal);
    const weatherBundle = await this._fetchBundle(location.latitude, location.longitude, signal);

    const data = { location, ...weatherBundle, _fetchedAt: Date.now() };
    state.resultCache.set(cacheKey, { savedAt: data._fetchedAt, data });
    return data;
  },

  async fetchByCoordinates(latitude, longitude, displayName) {
    const cacheKey = 'coords:' + latitude.toFixed(2) + ',' + longitude.toFixed(2);
    const cached = state.resultCache.get(cacheKey);

    if (cached && Date.now() - cached.savedAt < CONFIG.cacheLifetimeMs) {
      return { ...cached.data, _fetchedAt: cached.savedAt };
    }

    this._cancelInFlight();
    state.activeRequest = new AbortController();
    const { signal } = state.activeRequest;

    const location = { name: displayName, region: '', latitude, longitude };
    const weatherBundle = await this._fetchBundle(latitude, longitude, signal);

    const data = { location, ...weatherBundle, _fetchedAt: Date.now() };
    state.resultCache.set(cacheKey, { savedAt: data._fetchedAt, data });
    return data;
  },

  async _geocode(cityName, signal) {
    const url = 'https://geocoding-api.open-meteo.com/v1/search'
      + `?name=${encodeURIComponent(cityName)}`
      + '&count=1&language=en&format=json';

    const result = await this._fetchJson(url, signal);
    if (!result.results?.length) throw new Error('City not found');

    const first = result.results[0];
    const parts = getUniquePlaceNames(first.name, first.admin1, first.country);

    return {
      name: parts[0] || 'Unknown',
      region: parts.slice(1).join(', '),
      latitude: first.latitude,
      longitude: first.longitude
    };
  },

  async _fetchBundle(latitude, longitude, signal) {
    const nearbyOffsets = this._buildNearbyOffsets(latitude, longitude);
    const urls = this._buildUrls(latitude, longitude, nearbyOffsets);

    const [forecast, history, nearby] = await Promise.allSettled([
      this._fetchJson(urls.forecast, signal),
      this._fetchJson(urls.history, signal),
      this._fetchJson(urls.nearby, signal)
    ]);

    // The forecast is the only required source — if it fails, the app can't work.
    if (forecast.status === 'rejected') throw new Error('Forecast API failed');

    return {
      forecast:    forecast.value,
      history:     this._parseSeasonHistory(history),
      nearbyAreas: this._parseNearbyAreas(nearby, nearbyOffsets)
    };
  },

  _buildNearbyOffsets(latitude, longitude) {
    // ~25 miles north/south, adjusted for longitude convergence at the poles.
    const latOffset = 0.36;
    const lonOffset = 0.36 / Math.cos(latitude * Math.PI / 180);

    return [
      { direction: 'NORTH', latitude: latitude + latOffset, longitude },
      { direction: 'EAST',  latitude, longitude: longitude + lonOffset },
      { direction: 'SOUTH', latitude: latitude - latOffset, longitude },
      { direction: 'WEST',  latitude, longitude: longitude - lonOffset }
    ];
  },

  _buildUrls(latitude, longitude, nearbyOffsets) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);

    const seasonStartYear = cutoff.getMonth() >= 6
      ? cutoff.getFullYear()
      : cutoff.getFullYear() - 1;

    const earliestHistoryDate = `${seasonStartYear - 5}-10-01`;
    const cutoffDateString = cutoff.toISOString().slice(0, 10);

    const forecast = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${latitude}&longitude=${longitude}`
      + '&current=temperature_2m,apparent_temperature,wind_speed_10m'
      + '&hourly=snowfall,snow_depth,temperature_2m,apparent_temperature,wind_speed_10m'
      + '&daily=precipitation_probability_max'
      + '&past_days=2&forecast_days=7&timezone=auto';

    const history = 'https://archive-api.open-meteo.com/v1/archive'
      + `?latitude=${latitude}&longitude=${longitude}`
      + `&start_date=${earliestHistoryDate}&end_date=${cutoffDateString}`
      + '&daily=snowfall_sum&timezone=auto';

    const nearby = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${nearbyOffsets.map((p) => p.latitude.toFixed(3)).join(',')}`
      + `&longitude=${nearbyOffsets.map((p) => p.longitude.toFixed(3)).join(',')}`
      + '&current=temperature_2m&hourly=snowfall'
      + '&past_days=1&forecast_days=1&timezone=auto';

    return { forecast, history, nearby };
  },

  _parseSeasonHistory(historyResult) {
    if (historyResult.status !== 'fulfilled') return [];

    const historyData = historyResult.value;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);

    const seasonStartYear = cutoff.getMonth() >= 6
      ? cutoff.getFullYear()
      : cutoff.getFullYear() - 1;

    const seasons = [];

    for (let yearsAgo = 5; yearsAgo >= 0; yearsAgo--) {
      const seasonStart = seasonStartYear - yearsAgo;
      const rangeStart = `${seasonStart}-10-01`;
      // Past seasons run their full length. Current season runs to "now"
// so the "this season so far" comparison stays honest.
const rangeEnd = yearsAgo === 0
  ? cutoff.toISOString().slice(0, 10)
  : `${seasonStart + 1}-05-31`;

      let centimeters = 0;
      historyData.daily.time.forEach((dateString, i) => {
        if (dateString >= rangeStart && dateString <= rangeEnd) {
          centimeters += historyData.daily.snowfall_sum[i] || 0;
        }
      });

      seasons.push({
        label: `${seasonStart}–${String(seasonStart + 1).slice(2)}`,
        centimeters,
        current: yearsAgo === 0
      });
    }

    return seasons;
  },

  _parseNearbyAreas(nearbyResult, nearbyOffsets) {
    if (nearbyResult.status !== 'fulfilled') return [];

    const raw = Array.isArray(nearbyResult.value)
      ? nearbyResult.value
      : [nearbyResult.value];

    return raw.map((area, i) => ({
      ...area,
      direction: nearbyOffsets[i]?.direction || 'SECTOR',
      latitude:  nearbyOffsets[i]?.latitude,
      longitude: nearbyOffsets[i]?.longitude
    }));
  },

  async _fetchJson(url, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const json = await response.json();
    if (json.error) throw new Error(json.reason || 'API error');

    return json;
  },

  _cancelInFlight() {
    if (state.activeRequest) state.activeRequest.abort();
  }
};

/* ============================================================
   8. RENDER
   Every function that writes to the DOM lives here.
   ============================================================ */

const render = {

  // Instance data used by hover handlers
  _barChartValuesCm: [],
  _barChartBaseHourIndex: 0,
  _seasonChartBars: [],
  _timestampTimer: null,

  /** Master entry point — turns a weather data object into the on-screen UI. */
  report(data) {
     dom.cityInput.value = '';
    const currentHourIndex = findCurrentHourIndex(data.forecast);
    const { hourly, current } = data.forecast;

    this.header(data);
    this.conditions(current, hourly, currentHourIndex);
    this.risk(data, currentHourIndex);
    this.ticker(data, currentHourIndex);
    this.timestamp(data);
    this.chanceBars(data, currentHourIndex);
    this.heroChart(hourly.snowfall, currentHourIndex);
    this.timeline(hourly, currentHourIndex);
    this.peakBadge(hourly.snowfall, currentHourIndex);
    this.next24Severity(data, currentHourIndex);
    this.nearbyCards(data.nearbyAreas);
    this.seasonChart(data.history.seasons);
    this.clearState(data, currentHourIndex);

    this._clearEmptyStates();
    this._flashDepth();
  },

  header(data) {
    const { location } = data;
    const fullName = [location.name, location.region]
      .filter(Boolean)
      .join(', ')
      .toUpperCase();

    dom.locName.textContent = fullName;

    dom.date.textContent =
      new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      }).toUpperCase() + ' // ' +
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (state.parentLocation) {
      dom.backToLocationBtn.classList.add('visible');
      dom.backToLocationName.textContent =
        `BACK TO ${state.parentLocation.name.toUpperCase()}`;
    } else {
      dom.backToLocationBtn.classList.remove('visible');
    }
  },

  conditions(current, hourly, currentHourIndex) {
    const depthMeters = hourly.snow_depth[currentHourIndex] || 0;
    const rateCm = hourly.snowfall[currentHourIndex] || 0;

    const depth = units.formatDepth(depthMeters);
    const rate = units.formatRate(rateCm);
    const temp = units.formatTemperature(current.temperature_2m);
    const chill = units.formatTemperature(current.apparent_temperature);
    const wind = units.formatWind(current.wind_speed_10m);

    this._animateNumber(dom.depth, parseFloat(depth.value));

    dom.snowfallRate.textContent = `${rate.value} ${rate.unit}`;
    dom.temperature.textContent  = `${temp.value}${temp.unit}`;
    dom.windChill.textContent    = `${chill.value}${chill.unit}`;
    dom.windSpeed.textContent    = `${wind.value} ${wind.unit}`;

    this._animateNumber(dom.past24h, parseFloat(units.formatSnowfall(
      sumSlice(hourly.snowfall, currentHourIndex - 23, currentHourIndex)
    ).value));

    this._animateNumber(dom.past48h, parseFloat(units.formatSnowfall(
      sumSlice(hourly.snowfall, currentHourIndex - 47, currentHourIndex)
    ).value));

    this._animateNumber(dom.next24h, parseFloat(units.formatSnowfall(
      sumSlice(hourly.snowfall, currentHourIndex + 1, currentHourIndex + 24)
    ).value));

    this._animateNumber(dom.next72h, parseFloat(units.formatSnowfall(
      sumSlice(hourly.snowfall, currentHourIndex + 1, currentHourIndex + 72)
    ).value));
  },

  /**
   * Severity highlighting.
   *
   * Three visual states for LOW risk:
   *   - "truly clear"  → no highlight, muted ticker
   *   - "light snow"   → cyan highlight on the snowfall rate row
   *   - (moderate / severe work as expected)
   *
   * `risk.reasons.length` is the trick that distinguishes
   * "no snow" from "light snow" — both technically return LOW.
   */
  risk(data, currentHourIndex) {
    const current = data.forecast.current;
    const hourly = data.forecast.hourly;
    const rateCm = hourly.snowfall[currentHourIndex] || 0;

    const rateInches = units.centimetersToInches(rateCm);
    const windChillF = current.apparent_temperature * 9 / 5 + 32;
    const windMph = current.wind_speed_10m / 1.60934;

    const next12hInches = units.centimetersToInches(
      sumSlice(hourly.snowfall, currentHourIndex + 1, currentHourIndex + 12)
    );

    const next24hInches = units.centimetersToInches(
      sumSlice(hourly.snowfall, currentHourIndex + 1, currentHourIndex + 24)
    );

    const risk = this._calculateRisk({
      windChillF, windMph, rateInches, next12hInches, next24hInches
    });

    // LOW with no reasons means nothing is happening right now.
    const hasActivity = risk.reasons.length > 0;

    dom.liveBadge.classList.remove('low', 'moderate', 'severe');
    dom.liveBadge.classList.add(risk.level.toLowerCase());
    dom.liveText.textContent = (risk.level === 'LOW' && !hasActivity)
      ? 'LIVE'
      : 'LIVE · ' + risk.level;

    // Reset row classes each render
    [dom.rowRate, dom.rowTemp, dom.rowChill, dom.rowWind].forEach((row) => {
      row.className = 'row';
    });

    if (!hasActivity) return;

    const highlightClass =
      risk.level === 'SEVERE' ? 'highlight-severe' :
      risk.level === 'MODERATE' ? 'highlight-moderate' :
      'highlight-low';

    // Only highlight the rows that actually contributed to the tier.
    if (risk.level === 'SEVERE') {
      if (next24hInches >= 8 || next12hInches >= 6) dom.rowRate.classList.add(highlightClass);
      if (windChillF <= -20) dom.rowChill.classList.add(highlightClass);
      if (windMph >= 35 && rateInches >= 0.3) dom.rowWind.classList.add(highlightClass);
    } else if (risk.level === 'MODERATE') {
      if (next24hInches >= 6 || next12hInches >= 4) dom.rowRate.classList.add(highlightClass);
      if (windChillF <= -10) dom.rowChill.classList.add(highlightClass);
      if (windMph >= 25 && rateInches >= 0.1) dom.rowWind.classList.add(highlightClass);
    } else {
      dom.rowRate.classList.add(highlightClass);
    }
  },

  /** Returns { level, reasons } using NWS-aligned thresholds. */
  _calculateRisk(conditions) {
    const { windChillF, windMph, rateInches, next12hInches, next24hInches } = conditions;
    const reasons = [];

    // SEVERE — Warning-level
    if (next24hInches >= 8 || next12hInches >= 6) reasons.push('Winter Storm Warning (heavy snow)');
    if (windMph >= 35 && rateInches >= 0.3) reasons.push('Blizzard conditions');
    if (windChillF <= -20) reasons.push('Extreme Cold Warning');
    if (reasons.length) return { level: 'SEVERE', reasons };

    // MODERATE — Advisory-level
    if (next24hInches >= 6 || next12hInches >= 4) reasons.push('Winter Storm Warning (moderate)');
    if (windChillF <= -10) reasons.push('Cold Weather Advisory');
    if (windMph >= 25 && rateInches >= 0.1) reasons.push('Blowing Snow Advisory');
    if (reasons.length) return { level: 'MODERATE', reasons };

    // LOW — light snow or clear
    if (next24hInches >= 1) reasons.push('Light snow expected');
    if (rateInches >= 0.1) reasons.push('Light snow falling');

    return { level: 'LOW', reasons };
  },

  ticker(data, currentHourIndex) {
    const current = data.forecast.current;
    const hourly = data.forecast.hourly;
    const rateCm = hourly.snowfall[currentHourIndex] || 0;

    const rateInches = units.centimetersToInches(rateCm);
    const next12hInches = units.centimetersToInches(
      sumSlice(hourly.snowfall, currentHourIndex + 1, currentHourIndex + 12)
    );
    const next24hInches = units.centimetersToInches(
      sumSlice(hourly.snowfall, currentHourIndex + 1, currentHourIndex + 24)
    );

    const risk = this._calculateRisk({
      windChillF: current.apparent_temperature * 9 / 5 + 32,
      windMph: current.wind_speed_10m / 1.60934,
      rateInches, next12hInches, next24hInches
    });

    const hasActivity = risk.reasons.length > 0;

    const items = [];

    // Status
    const statusClass = risk.level === 'SEVERE' ? 'alert'
      : risk.level === 'MODERATE' ? 'warn'
      : (hasActivity ? 'ok' : 'clear');

    const alertName = hasActivity
      ? risk.reasons[0].replace(/\s*\(.*\)$/, '')
      : 'ALL CLEAR';

    items.push(`<span class="ticker-item ${statusClass}">[ ${risk.level}: ${alertName} ]</span>`);

    // Peak window
    const peakWindow = this._findPeakWindow(hourly, currentHourIndex);
    if (peakWindow) {
      items.push(`<span class="ticker-item">PEAK ${peakWindow.rateLabel} · ${peakWindow.timeRange}</span>`);
    }

    // Wind chill
    const chill = units.formatTemperature(current.apparent_temperature);
    items.push(`<span class="ticker-item">WIND CHILL ${chill.value}${chill.unit}</span>`);

    // Advice
    items.push(`<span class="ticker-item friendly">${severity.advice(risk.level.toLowerCase())}</span>`);

    // Separator
    items.push(`<span class="ticker-item">///</span>`);

    state.tickerBaseHtml = items.join('');
    this._fillTicker();
  },

  /**
   * Duplicate the ticker content until it fills 2× viewport width.
   * The @keyframes ticker animates to -50%, so we need an even
   * number of copies for the loop to be seamless.
   */
  _fillTicker() {
    const baseHtml = state.tickerBaseHtml;
    if (!baseHtml) return;

    const el = dom.tickerText;
    if (!el) return;

    // Measure one copy
    el.innerHTML = baseHtml;
    const singleCycleWidth = el.scrollWidth;
    if (!singleCycleWidth) return;

    const viewportWidth = window.innerWidth;
    let copiesNeeded = Math.ceil((viewportWidth * 2) / singleCycleWidth) + 1;
    if (copiesNeeded % 2 !== 0) copiesNeeded += 1;

    el.innerHTML = baseHtml.repeat(copiesNeeded);
  },

  _findPeakWindow(hourly, currentHourIndex) {
    const window = [];
    for (let i = currentHourIndex; i <= currentHourIndex + 11; i++) {
      window.push(hourly.snowfall[i] || 0);
    }

    const peakCm = Math.max(...window, 0);
    if (peakCm < 0.1) return null;

    let firstSnowOffset = -1;
    let lastSnowOffset = -1;

    window.forEach((cm, i) => {
      if (cm >= 0.05) {
        if (firstSnowOffset === -1) firstSnowOffset = i;
        lastSnowOffset = i;
      }
    });

    const formatClockTime = (offset) => {
      const time = hourly.time[currentHourIndex + offset];
      return time ? time.slice(11, 16) : '';
    };

    const timeRange = firstSnowOffset === -1
      ? '—'
      : (firstSnowOffset === lastSnowOffset
          ? formatClockTime(firstSnowOffset)
          : `${formatClockTime(firstSnowOffset)}–${formatClockTime(lastSnowOffset)}`);

    const rate = units.formatRate(peakCm);

    return { rateLabel: `${rate.value} ${rate.unit}`, timeRange };
  },

  timestamp(data) {
    state.lastFetchedAt = data?._fetchedAt || Date.now();
    this._refreshTimestampLabel();

    if (!this._timestampTimer) {
      this._timestampTimer = setInterval(() => this._refreshTimestampLabel(), 30000);
    }
  },

  _refreshTimestampLabel() {
    if (!state.lastFetchedAt) {
      dom.updatedAt.textContent = '—';
      return;
    }

    const minutes = Math.floor((Date.now() - state.lastFetchedAt) / 60000);

    if (minutes < 1)      dom.updatedAt.textContent = 'UPDATED JUST NOW';
    else if (minutes === 1) dom.updatedAt.textContent = 'UPDATED 1 MIN AGO';
    else if (minutes < 60)  dom.updatedAt.textContent = `UPDATED ${minutes} MIN AGO`;
    else                    dom.updatedAt.textContent = `UPDATED ${Math.floor(minutes / 60)}H AGO`;
  },

  chanceBars(data, currentHourIndex) {
    const hourly = data.forecast.hourly;
    const daily = data.forecast.daily;
    const next72hCm = sumSlice(hourly.snowfall, currentHourIndex + 1, currentHourIndex + 72);

    const precipChance = Math.max(
      ...daily.precipitation_probability_max.slice(2, 5).map((v) => v || 0)
    );

    // Convert inch thresholds to cm since we're working in metric internally
    const thresholdsCm = [1, 3, 6].map((inches) => inches * 2.54);

    const chances = thresholdsCm.map((thresholdCm) => {
      if (next72hCm >= thresholdCm) {
        return Math.round(100 * Math.max(precipChance / 100, 0.6));
      }
      const ratio = Math.min(next72hCm / thresholdCm, 1);
      return Math.round(100 * (precipChance / 100) * Math.pow(ratio, 2));
    });

    const labels = ['1+ IN', '3+ IN', '6+ IN'];

    dom.chanceBars.innerHTML = chances.map((chance, i) =>
      `<div class="prob">
        <div class="top"><span>${labels[i]}</span><span>${chance}%</span></div>
        <div class="bar"><i data-width="${chance}"></i></div>
      </div>`
    ).join('');

    // Animate the bars after the DOM has been updated
    requestAnimationFrame(() => {
      dom.chanceBars.querySelectorAll('.bar i').forEach((bar) => {
        bar.style.width = bar.dataset.width + '%';
      });
    });
  },

  heroChart(allSnowfallCm, currentHourIndex) {
    const valuesCm = [];
    for (let i = currentHourIndex - 12; i <= currentHourIndex + 12; i++) {
      valuesCm.push(allSnowfallCm[i] || 0);
    }

    this._barChartValuesCm = valuesCm;
    this._barChartBaseHourIndex = currentHourIndex;

    const maxCm = Math.max(...valuesCm, 0.1);

    dom.heroBarChart.innerHTML = valuesCm.map((cm, i) => {
      const inches = units.centimetersToInches(cm);
      const heightPercent = (cm / maxCm) * 100;

      let severityClass = 'none';
      if (inches > 0.3)      severityClass = 'heavy';
      else if (inches > 0.1) severityClass = 'moderate';
      else if (inches > 0)   severityClass = 'light';

      const height = cm > 0 ? Math.max(heightPercent, 6) : 2;
      const offset = i - 12;
      const isPast = offset < 0;

      return `<div class="bar ${severityClass}${isPast ? ' past' : ''}"
        style="height: ${height}%"
        data-offset="${offset}"
        data-cm="${cm}"></div>`;
    }).join('');
  },

  timeline(hourly, currentHourIndex) {
    const cells = [];

    for (let i = currentHourIndex; i <= currentHourIndex + 11; i++) {
      const cm = hourly.snowfall[i] || 0;
      const inches = units.centimetersToInches(cm);
      const offset = i - currentHourIndex;
      const hourLabel = offset === 0 ? 'NOW' : '+' + offset + 'H';
      const clockTime = (hourly.time[i] || '').slice(11, 16);

      const rate = units.formatRate(cm);
      const temp = units.formatTemperature(hourly.temperature_2m?.[i] ?? 0);
      const wind = units.formatWind(hourly.wind_speed_10m?.[i] ?? 0);
      const snowfallLabel = units.formatSnowfall(cm);

      let intensityClass = 'none';
      let intensityLabel = 'NONE';
      if (inches > 0.3)      { intensityClass = 'heavy';    intensityLabel = 'HEAVY'; }
      else if (inches > 0.1) { intensityClass = 'moderate'; intensityLabel = 'MOD'; }
      else if (inches > 0)   { intensityClass = 'light';    intensityLabel = 'LIGHT'; }

      const iconSvg = this._pickHourIcon(inches);

      cells.push(`<div class="hour${offset === 0 ? ' now' : ''}"
        data-when="${hourLabel} · ${clockTime}"
        data-rate="${rate.value} ${rate.unit}"
        data-temp="${temp.value}${temp.unit}"
        data-wind="${wind.value} ${wind.unit}">
        <div class="t">${hourLabel}</div>
        <div class="node"></div>
        <div class="i">${iconSvg}</div>
        <div class="amt">${snowfallLabel.value}<small>${units.isMetric() ? 'cm' : '″'}</small></div>
        <div class="intensity ${intensityClass}">${intensityLabel}</div>
      </div>`);
    }

    dom.hourlyTimeline.innerHTML = cells.join('');
  },

  _pickHourIcon(inches) {
    if (inches > 0.3) {
      return '<svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.4" fill="none"><line x1="12" y1="2" x2="12" y2="22"/><line x1="3.5" y1="7" x2="20.5" y2="17"/><line x1="3.5" y1="17" x2="20.5" y2="7"/></svg>';
    }
    if (inches > 0) {
      return '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M18 9h-1.26A8 8 0 1 0 9 19h9a5 5 0 0 0 0-10z" opacity="0.7"/><circle cx="8" cy="21" r="0.9"/><circle cx="12" cy="22" r="0.9"/><circle cx="16" cy="21" r="0.9"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
  },

  peakBadge(allSnowfallCm, currentHourIndex) {
    const windowCm = [];
    for (let i = currentHourIndex; i <= currentHourIndex + 11; i++) {
      windowCm.push(allSnowfallCm[i] || 0);
    }

    const peakCm = Math.max(...windowCm, 0);
    const peakOffset = windowCm.indexOf(peakCm);

    const peakRate = units.formatRate(peakCm);
    dom.peakRate.textContent = peakRate.value;
    dom.peakTime.textContent = peakCm > 0.05
      ? (peakOffset === 0 ? '@ NOW' : `@ +${peakOffset}H`)
      : '—';

    const level = severity.fromRate(units.centimetersToInches(peakCm));
    dom.peakSeverity.className = 'peak-sev ' + severity.cssClass(level);
    dom.peakSeverity.textContent = severity.label(level);
  },

  next24Severity(data, currentHourIndex) {
    const next24hCm = sumSlice(data.forecast.hourly.snowfall, currentHourIndex + 1, currentHourIndex + 24);
    const inches = units.centimetersToInches(next24hCm);
    const level = severity.fromTotal(inches);

    dom.next24hStat.classList.remove('severity-low', 'severity-moderate', 'severity-severe');
    if (level !== 'none') {
      dom.next24hStat.classList.add(severity.cssClass(level));
    }

    dom.next24hSeverity.className = 'stat-sev ' + severity.cssClass(level);
    dom.next24hSeverity.textContent = severity.label(level);
  },

  nearbyCards(nearbyAreas) {
    if (!nearbyAreas || nearbyAreas.length === 0) {
      dom.nearbyCards.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; padding: 40px; font-family: var(--mono); font-size: 11px; letter-spacing: 0.2em; color: var(--mute); text-transform: uppercase;">DATA UNAVAILABLE</div>';
      return;
    }

    // Build card data, then sort so most-severe appears first.
    // (The app "chooses for you" — user sees the worst direction first.)
    const cards = nearbyAreas.map((area) => {
      const hourIndex = findCurrentHourIndex(area);
      const rateCm = area.hourly.snowfall[hourIndex] || 0;
      const level = severity.fromRate(units.centimetersToInches(rateCm));

      return {
        direction: area.direction,
        latitude: area.latitude,
        longitude: area.longitude,
        rateCm,
        dayTotalCm: sumSlice(area.hourly.snowfall, hourIndex - 23, hourIndex),
        hourlySnowfall: area.hourly.snowfall,
        hourIndex,
        level,
        severityRank: severity.rank(level)
      };
    }).sort((a, b) => {
      if (a.severityRank !== b.severityRank) return a.severityRank - b.severityRank;
      return b.dayTotalCm - a.dayTotalCm;
    });

    dom.nearbyCards.innerHTML = cards.map((card) => {
      const rate = units.formatRate(card.rateCm);
      const total = units.formatSnowfall(card.dayTotalCm);
      const sparklinePath = this._buildSparklinePath(card.hourlySnowfall, card.hourIndex);

      return `<button
        type="button"
        class="nearby-card"
        data-lat="${card.latitude}"
        data-lon="${card.longitude}"
        data-direction="${card.direction}"
        aria-label="View full report for area ${card.direction}">
        <div class="nearby-top">
          <span class="nearby-direction">${card.direction}</span>
          <span class="nearby-dot ${severity.cssClass(card.level)}" aria-hidden="true"></span>
        </div>
        <div class="nearby-rate ${severity.cssClass(card.level)}">
          ${rate.value}<small>${rate.unit}</small>
        </div>
        <svg class="nearby-sparkline ${severity.cssClass(card.level)}" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
          <path d="${sparklinePath}" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
        </svg>
        <div class="nearby-footer">
          <span>24H · <span class="nf-val">${total.value} ${total.unit}</span></span>
          <span class="nearby-arrow">→</span>
        </div>
      </button>`;
    }).join('');
  },

  /** Builds a smooth 12-hour sparkline path for a nearby card. */
  _buildSparklinePath(hourlySnowfallCm, startIndex) {
    const values = [];
    for (let i = startIndex; i <= startIndex + 11; i++) {
      values.push(hourlySnowfallCm[i] || 0);
    }

    const maxValue = Math.max(...values, 0.1);
    const chartWidth = 100;
    const chartHeight = 24;

    const points = values.map((value, i) => ({
      x: (i / 11) * chartWidth,
      y: chartHeight - 2 - (value / maxValue) * (chartHeight - 6)
    }));

    // Smooth cubic interpolation
    let path = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const midX = (p1.x + p2.x) / 2;

      path += ` Q ${midX.toFixed(1)} ${p1.y.toFixed(1)}, ${midX.toFixed(1)} ${((p1.y + p2.y) / 2).toFixed(1)}`;
      path += ` Q ${midX.toFixed(1)} ${p2.y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }

    return path;
  },

  seasonChart(seasons) {
    const canvas = dom.seasonChart;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    // Canvas can't render if it's hidden (clientWidth = 0). Retry once.
    if (canvas.clientWidth === 0) {
      setTimeout(() => this.seasonChart(seasons), 100);
      return;
    }

    canvas.width  = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);

    this._seasonChartBars = [];

    if (!seasons || seasons.length === 0) {
      ctx.font = '10px ui-monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#6a7580';
      ctx.fillText('HISTORICAL DATA UNAVAILABLE', canvas.clientWidth / 2, canvas.clientHeight / 2);
      dom.seasonDelta.textContent = '—';
      dom.seasonDelta.className = 'season-delta';
      dom.seasonNote.textContent = '';
      return;
    }

    const displayed = seasons.map((s) => ({
      label: s.label,
      current: s.current,
      displayValue: units.isMetric() ? s.centimeters : s.centimeters / 2.54,
      unitLabel: units.isMetric() ? 'cm' : 'in'
    }));

    const maxValue = Math.max(...displayed.map((s) => s.displayValue), 1) * 1.25;
    const barWidth = (canvas.clientWidth - 64) / displayed.length;
    const topPadding = 20;
    const bottomPadding = 30;
    const chartHeight = canvas.clientHeight - topPadding - bottomPadding;

    ctx.font = '10px ui-monospace';
    ctx.textAlign = 'center';

    displayed.forEach((season, i) => {
      const barHeight = (season.displayValue / maxValue) * chartHeight;
      const x = 32 + i * barWidth + barWidth * 0.15;
      const y = canvas.clientHeight - bottomPadding - barHeight;

      ctx.fillStyle = season.current ? '#1a5276' : '#b0bcc6';
      ctx.fillRect(x, y, barWidth * 0.7, barHeight);

      ctx.fillStyle = season.current ? '#1a5276' : '#6a7580';
      ctx.fillText(season.displayValue.toFixed(1), x + barWidth * 0.35, y - 8);
      ctx.fillText(season.label, x + barWidth * 0.35, canvas.clientHeight - 10);

      this._seasonChartBars.push({
        x, y,
        width: barWidth * 0.7,
        height: Math.max(barHeight, 4),
        season,
        unitLabel: season.unitLabel
      });
    });

    // 5-season average line
    const pastSeasons = displayed.filter((s) => !s.current);
    const average = pastSeasons.length
      ? pastSeasons.reduce((sum, s) => sum + s.displayValue, 0) / pastSeasons.length
      : 0;

    const averageY = canvas.clientHeight - bottomPadding - (average / maxValue) * chartHeight;

    ctx.strokeStyle = '#0b2d4a';
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(32, averageY);
    ctx.lineTo(canvas.clientWidth - 32, averageY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;

    // Average label at the top — prevents collisions with bar value labels
    const averageUnit = units.isMetric() ? 'cm' : 'in';
    ctx.fillStyle = '#0b2d4a';
    ctx.textAlign = 'left';
    ctx.font = '9px ui-monospace';
    ctx.fillText(`5-SEASON AVG: ${average.toFixed(1)} ${averageUnit}`, 32, 12);

    // "X% vs avg" chip
    const currentSeasonValue = displayed[displayed.length - 1].displayValue;
    const percentChange = average
      ? Math.round(((currentSeasonValue - average) / average) * 100)
      : 0;

    dom.seasonDelta.textContent = `${percentChange >= 0 ? '+' : ''}${percentChange}% VS AVG`;
    dom.seasonDelta.className = 'season-delta ' + (percentChange >= 0 ? 'pos' : 'neg');
    dom.seasonNote.textContent =
      `CURRENT SEASON ${percentChange >= 0 ? '+' : ''}${percentChange}% VS 5-SEASON AVERAGE`;
  },

  clearState(data, currentHourIndex) {
    const next72hCm = sumSlice(data.forecast.hourly.snowfall, currentHourIndex + 1, currentHourIndex + 72);
    dom.clearWeatherBanner.classList.toggle('visible', next72hCm < 0.1);
  },

  _animateNumber(element, targetValue) {
    if (element._animationFrame) {
      cancelAnimationFrame(element._animationFrame);
    }

    const decimals = (element.textContent || '0.0').split('.')[1]?.length || 1;
    const startValue = parseFloat(element.textContent) || 0;
    const startTime = performance.now();
    const durationMs = 400;

    const step = (now) => {
      const progress = Math.min((now - startTime) / durationMs, 1);
      const eased = 1 - Math.pow(1 - progress, 3);   // ease-out cubic
      const current = startValue + (targetValue - startValue) * eased;

      element.textContent = current.toFixed(decimals);

      if (progress < 1) {
        element._animationFrame = requestAnimationFrame(step);
      } else {
        element._animationFrame = null;
      }
    };

    element._animationFrame = requestAnimationFrame(step);
  },

  _clearEmptyStates() {
    dom.allDataContainers.forEach((container) => {
      container.classList.remove('empty');
    });
  },

  _flashDepth() {
    dom.rateBlock.classList.remove('is-focused');
    void dom.rateBlock.offsetWidth;   // force reflow so the animation restarts
    dom.rateBlock.classList.add('is-focused');
    setTimeout(() => dom.rateBlock.classList.remove('is-focused'), 2500);
  }
};

/* ============================================================
   9. TOOLTIP
   One shared element, repositioned for whatever is hovered.
   ============================================================ */

const tooltip = {
  show(clientX, clientY, htmlContent) {
    dom.globalTooltip.innerHTML = htmlContent;
    dom.globalTooltip.classList.add('visible');

    const rect = dom.globalTooltip.getBoundingClientRect();
    const margin = 12;

    let left = clientX + 16;
    let top = clientY + 16;

    // Keep the tooltip on screen
    if (left + rect.width > window.innerWidth - margin) {
      left = clientX - rect.width - 16;
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = clientY - rect.height - 16;
    }

    dom.globalTooltip.style.left = Math.max(margin, left) + 'px';
    dom.globalTooltip.style.top  = Math.max(margin, top)  + 'px';
  },

  hide() {
    dom.globalTooltip.classList.remove('visible');
  }
};

/* ============================================================
   10. HOURLY DATA
   Small cache so hover tooltips have access to hourly temp/wind
   without threading it through every function.
   ============================================================ */

const hourlyData = {
  time: [],
  temperature_2m: [],
  wind_speed_10m: [],

  update(hourly) {
    this.time            = hourly.time;
    this.temperature_2m  = hourly.temperature_2m;
    this.wind_speed_10m  = hourly.wind_speed_10m;
  }
};

/* ============================================================
   11. EVENTS
   Wire up every user interaction. Called once at startup.
   ============================================================ */

const events = {

  attach() {
    this._search();
    this._location();
    this._brand();
    this._backButton();
    this._presets();
    this._unitToggle();
    this._nearbyCards();
    this._chartHover();
    this._hourlyHover();
    this._seasonHover();
    this._shortcuts();
    this._resize();
    this._visibility();
  },

  _search() {
    dom.searchBtn.addEventListener('click', () => {
      const cityName = dom.cityInput.value.trim();
      if (cityName) actions.loadCity(cityName);
    });

    dom.cityInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        dom.searchBtn.click();
      }
    });
  },

  _location() {
  dom.locationBtn.addEventListener('click', () => actions.useLocation());
},

_brand() {
  dom.brandBtn.addEventListener('click', () => actions.goHome());
},

_backButton() {
  dom.backToLocationBtn.addEventListener('click', () => actions.returnToParent());
},
  _presets() {
    document.querySelectorAll('.preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cityName = btn.dataset.city;
        dom.cityInput.value = cityName;
        actions.loadCity(cityName);
      });
    });
  },

  _unitToggle() {
    dom.unitToggle.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => actions.setUnits(btn.dataset.unit));
    });
  },

  _nearbyCards() {
    dom.nearbyCards.addEventListener('click', (event) => {
      const card = event.target.closest('.nearby-card');
      if (!card) return;

      const latitude = parseFloat(card.dataset.lat);
      const longitude = parseFloat(card.dataset.lon);
      const direction = card.dataset.direction;
      const parentName = state.currentWeatherData?.location?.name || 'Current';

      actions.loadCoordinates(latitude, longitude, `${direction} OF ${parentName}`);
    });
  },

  _chartHover() {
    dom.heroBarChart.addEventListener('mousemove', (event) => {
      const bar = event.target.closest('.bar');
      if (!bar) { tooltip.hide(); return; }

      const offset = parseInt(bar.dataset.offset, 10);
      const cm = parseFloat(bar.dataset.cm);
      const baseIndex = render._barChartBaseHourIndex;
      const hourIndexInData = baseIndex + offset;

      const rate = units.formatRate(cm);
      const temp = units.formatTemperature(hourlyData.temperature_2m?.[hourIndexInData] ?? 0);
      const wind = units.formatWind(hourlyData.wind_speed_10m?.[hourIndexInData] ?? 0);
      const label = offset === 0 ? 'NOW' : (offset > 0 ? `+${offset}H` : `${offset}H`);

      tooltip.show(event.clientX, event.clientY, `
        <span class="tt-label">${label}</span>
        <div class="tt-row"><span>Snowfall</span><span>${rate.value} ${rate.unit}</span></div>
        <div class="tt-row"><span>Temp</span><span>${temp.value}${temp.unit}</span></div>
        <div class="tt-row"><span>Wind</span><span>${wind.value} ${wind.unit}</span></div>
      `);
    });

    dom.heroBarChart.addEventListener('mouseleave', () => tooltip.hide());
  },

  _hourlyHover() {
    dom.hourlyTimeline.addEventListener('mouseover', (event) => {
      const hour = event.target.closest('.hour');
      if (!hour) return;

      tooltip.show(event.clientX, event.clientY, `
        <span class="tt-label">${hour.dataset.when}</span>
        <div class="tt-row"><span>Snowfall</span><span>${hour.dataset.rate}</span></div>
        <div class="tt-row"><span>Temp</span><span>${hour.dataset.temp}</span></div>
        <div class="tt-row"><span>Wind</span><span>${hour.dataset.wind}</span></div>
      `);
    });

    dom.hourlyTimeline.addEventListener('mouseout', (event) => {
      if (!event.relatedTarget?.closest?.('.hour')) tooltip.hide();
    });
  },

  _seasonHover() {
    dom.seasonChart.addEventListener('mousemove', (event) => {
      const rect = dom.seasonChart.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      const hoveredBar = render._seasonChartBars.find((bar) =>
        x >= bar.x && x <= bar.x + bar.width && y >= bar.y && y <= bar.y + bar.height
      );

      if (!hoveredBar) { tooltip.hide(); return; }

      tooltip.show(event.clientX, event.clientY, `
        <span class="tt-label">${hoveredBar.season.label}${hoveredBar.season.current ? ' · CURRENT' : ''}</span>
        <div class="tt-row"><span>Season total</span><span>${hoveredBar.season.displayValue.toFixed(1)} ${hoveredBar.season.unitLabel}</span></div>
      `);
    });

    dom.seasonChart.addEventListener('mouseleave', () => tooltip.hide());
  },

  _shortcuts() {
    // Press "/" anywhere (outside an input) to focus the search box.
    document.addEventListener('keydown', (event) => {
      const tagName = document.activeElement?.tagName;
      const isTyping = tagName === 'INPUT' || tagName === 'TEXTAREA';

      if (event.key === '/' && !isTyping) {
        event.preventDefault();
        dom.cityInput.focus();
      }
    });
  },

  _resize() {
    const debouncedResize = debounce(() => {
      if (state.currentWeatherData) {
        render.seasonChart(state.currentWeatherData.history.seasons);
      }
      render._fillTicker();
    }, CONFIG.resizeDebounceMs);

    window.addEventListener('resize', debouncedResize);
  },

  _visibility() {
    // Pause CPU-heavy animations when the tab isn't visible.
    document.addEventListener('visibilitychange', () => {
      document.body.classList.toggle('tab-hidden', document.hidden);
    });
  }
};

/* ============================================================
   12. ACTIONS
   Higher-level user intents. Called by event handlers.
   ============================================================ */

const actions = {
  _errorTimer: null,
  _homeSignalTimer: null,

  setSearching(isSearching, buttonLabel) {
    state.isSearching = isSearching;
    document.body.classList.toggle('is-loading', isSearching);
    dom.searchBtn.disabled = isSearching;
    dom.searchBtn.textContent = buttonLabel || (isSearching ? 'LOADING' : 'SEARCH');
    dom.inlineDots.classList.toggle('visible', isSearching);
  },

  showError(message) {
    dom.errorBanner.textContent = message;
    dom.errorBanner.classList.add('visible');

    clearTimeout(this._errorTimer);
    this._errorTimer = setTimeout(() => {
      dom.errorBanner.classList.remove('visible');
    }, 4500);
  },

  scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  async loadCity(cityName) {
    if (state.isSearching) return;

    state.parentLocation = null;
    this.setSearching(true, 'SEARCHING');
    dom.locName.textContent = 'LOADING';

    try {
      const data = await weatherApi.fetchByCity(cityName);

      if (!state.homeData) state.homeData = data;
      state.currentWeatherData = data;
      hourlyData.update(data.forecast.hourly);

      render.report(data);
      this.scrollToTop();
    } catch (err) {
      if (err.name === 'AbortError') return;

      console.error('[loadCity]', err);
      dom.locName.textContent = 'UNABLE TO LOAD';

      const friendlyMessage = err.message === 'City not found'
        ? 'CITY NOT FOUND — CHECK SPELLING OR TRY ANOTHER NAME'
        : 'COULD NOT LOAD WEATHER DATA — TRY AGAIN';

      this.showError(friendlyMessage);
    } finally {
      this.setSearching(false);
    }
  },

  async loadCoordinates(latitude, longitude, displayName) {
    if (state.isSearching) return;

    // Capture the current location as "parent" the first time we drill in
    if (state.currentWeatherData && !state.parentLocation) {
      state.parentLocation = {
        data: state.currentWeatherData,
        name: state.currentWeatherData.location.name
      };
    }

    this.setSearching(true, 'SEARCHING');
    dom.locName.textContent = 'LOADING';

    try {
      const data = await weatherApi.fetchByCoordinates(latitude, longitude, displayName);

      if (!state.homeData) state.homeData = data;
      state.currentWeatherData = data;
      hourlyData.update(data.forecast.hourly);

      render.report(data);
      this.scrollToTop();
    } catch (err) {
      if (err.name === 'AbortError') return;

      console.error('[loadCoordinates]', err);
      dom.locName.textContent = 'UNABLE TO LOAD';
      this.showError('COULD NOT LOAD THIS AREA');
    } finally {
      this.setSearching(false);
    }
  },

  async useLocation() {
    const location = await getBrowserLocation();

    if (!location) {
      this.showError('LOCATION ACCESS DENIED — TRY SEARCHING A CITY INSTEAD');
      return;
    }

    await this.loadCoordinates(location.lat, location.lon, 'Your location');
  },

  async goHome() {
    // Fire the logo animation regardless of whether home exists
    dom.brandBtn.classList.remove('is-firing');
    void dom.brandBtn.offsetWidth;
    dom.brandBtn.classList.add('is-firing');
    setTimeout(() => dom.brandBtn.classList.remove('is-firing'), 520);

    if (!state.homeData) {
      this.scrollToTop();
      return;
    }

    state.parentLocation = null;
    await this._navigateTo(state.homeData, { showHomeSignal: true });
  },

  async returnToParent() {
    if (!state.parentLocation) return;

    const parent = state.parentLocation;
    state.parentLocation = null;

    await this._navigateTo(parent.data, { showHomeSignal: false });
  },

  /**
   * Fade out → scroll to top → swap data → fade in → optional HOME signal.
   * Only used for cached data swaps (home + back). Network loads use
   * loadCity/loadCoordinates instead.
   */
  async _navigateTo(targetData, options = {}) {
    if (!targetData || state.isNavigating) return;

    state.isNavigating = true;
    document.body.classList.add('is-navigating');
    this.scrollToTop();

    await wait(CONFIG.navigationFadeMs);

    state.currentWeatherData = targetData;
    hourlyData.update(targetData.forecast.hourly);
    render.report(targetData);

    await wait(CONFIG.navigationSettleMs);
    document.body.classList.remove('is-navigating');

    if (options.showHomeSignal) {
      await wait(120);
      this._showHomeSignal();
    }

    state.isNavigating = false;
  },

  _showHomeSignal() {
    const cityEl = dom.locName;
    const badge = dom.homeBadge;
    if (!cityEl || !badge) return;

    cityEl.classList.remove('is-returning');
    badge.classList.remove('visible');
    void cityEl.offsetWidth;

    cityEl.classList.add('is-returning');
    badge.classList.add('visible');

    clearTimeout(this._homeSignalTimer);
    this._homeSignalTimer = setTimeout(() => {
      badge.classList.remove('visible');
      cityEl.classList.remove('is-returning');
    }, CONFIG.homeSignalMs);
  },

  setUnits(nextUnits) {
    if (state.unitSystem === nextUnits) return;

    state.unitSystem = nextUnits;
    try { localStorage.setItem('white-noise-units', nextUnits); } catch (err) { /* ignore */ }

    dom.unitToggle.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.unit === nextUnits);
    });

    units.refreshLabels();

    if (state.currentWeatherData) {
      render.report(state.currentWeatherData);
    }
  }
};

/* ============================================================
   13. GEOLOCATION
   ============================================================ */

async function getBrowserLocation() {
  if (!navigator.geolocation) return null;

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { timeout: CONFIG.geolocationTimeoutMs, maximumAge: 5 * 60 * 1000 }
    );
  });
}

/* ============================================================
   14. SCROLL REVEAL
   Sections fade in as they enter the viewport.
   ============================================================ */

function setupScrollReveals() {
  if (!('IntersectionObserver' in window)) {
    // Fallback: reveal everything immediately
    dom.allScrollReveal.forEach((el) => el.classList.add('revealed'));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        observer.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.12,
    rootMargin: '0px 0px -60px 0px'
  });

  dom.allScrollReveal.forEach((el) => observer.observe(el));
}

/* ============================================================
   15. BOOT SEQUENCE
   ============================================================ */

async function runBootSequence() {
  const bootStart = performance.now();

  const setProgress = (percent, message) => {
    dom.bootBar.style.width = percent + '%';
    if (message) dom.bootStatus.textContent = message;
  };

  setProgress(15, 'LOCATING POSITION');
  const userLocation = await getBrowserLocation();

  setProgress(45, 'RETRIEVING TELEMETRY');

  const dataPromise = (userLocation
    ? weatherApi.fetchByCoordinates(userLocation.lat, userLocation.lon, 'Your location')
    : weatherApi.fetchByCity(CONFIG.fallbackCity)
  )
    .then((data) => ({ success: true, data }))
    .catch((error) => ({ success: false, error }));

  // Wait for both the data AND the minimum boot display time
  const [result] = await Promise.all([
    dataPromise,
    wait(Math.max(0, CONFIG.minimumBootDisplayMs - (performance.now() - bootStart)))
  ]);

  setProgress(85, 'COMPUTING SEVERITY');
  await wait(140);

  setProgress(100, 'READY');
  await wait(200);

  dom.bootScreen.classList.add('hidden');
  document.body.classList.add('loaded');
  window.scrollTo(0, 0);
  setTimeout(() => dom.bootScreen.remove(), 400);

  if (result.success) {
    if (!state.homeData) state.homeData = result.data;
    state.currentWeatherData = result.data;
    hourlyData.update(result.data.forecast.hourly);
    render.report(result.data);
  } else if (result.error.name !== 'AbortError') {
    console.error('[boot]', result.error);
    dom.locName.textContent = 'UNABLE TO LOAD';
    actions.showError('COULD NOT LOAD INITIAL DATA');
  }
}

/* ============================================================
   16. ANIMATED TRIANGLE BACKGROUND
   Builds a field of pulsing triangles behind everything.
   ============================================================ */

function buildTriangleBackground() {
  const svg = document.getElementById('tris-svg');

  const COLOR_TONES = [
    ['#bcc5cd', '#a0abb5'],
    ['#a3aeb8', '#8996a1'],
    ['#9ba6b1', '#8794a1']
  ];

  const rebuild = () => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const isMobile = viewportWidth < 768;

    const triangleWidth = viewportWidth / (isMobile ? 3.5 : 6.5);
    const triangleHeight = triangleWidth * 0.866;
    const edgePadding = 3;

    const columns = Math.ceil(viewportWidth / (triangleWidth / 2)) + 4;
    const rows = Math.ceil(viewportHeight / triangleHeight) + 3;

    const polygons = [];
    let defs = '<defs>';

    // Build a gradient for each (tone, direction) combination
    COLOR_TONES.forEach((tone, toneIndex) => {
      [0, 1].forEach((direction) => {
        const corners = direction === 0
          ? ['0%', '0%', '100%', '100%']
          : ['100%', '0%', '0%', '100%'];

        defs += `<linearGradient id="g${toneIndex}${direction}" x1="${corners[0]}" y1="${corners[1]}" x2="${corners[2]}" y2="${corners[3]}">
          <stop offset="0%" stop-color="${tone[0]}"/>
          <stop offset="100%" stop-color="${tone[1]}"/>
        </linearGradient>`;
      });
    });
    defs += '</defs>';

    for (let row = -1; row <= rows; row++) {
      for (let col = -2; col <= columns; col++) {
        const left = col * (triangleWidth / 2);
        const top = row * triangleHeight;
        const isPointingUp = (col + row) % 2 === 0;
        const direction = isPointingUp ? 0 : 1;

        const points = isPointingUp
          ? `${left + triangleWidth / 2},${top - edgePadding} ` +
            `${left - edgePadding},${top + triangleHeight + edgePadding} ` +
            `${left + triangleWidth + edgePadding},${top + triangleHeight + edgePadding}`
          : `${left - edgePadding},${top - edgePadding} ` +
            `${left + triangleWidth + edgePadding},${top - edgePadding} ` +
            `${left + triangleWidth / 2},${top + triangleHeight + edgePadding}`;

        // Deterministic delay so the pattern churns consistently
        const baseDelay = -(Math.abs(row * 0.83 + col * 0.61) % 15);

        // 3 layered polygons per cell, offset 5s apart
        let cellHtml = '';
        for (let layer = 0; layer < 3; layer++) {
          const delay = (baseDelay - layer * 5).toFixed(2);
          cellHtml += `<polygon class="tri" points="${points}" fill="url(#g${layer}${direction})" style="animation-delay:${delay}s"/>`;
        }

        polygons.push(cellHtml);
      }
    }

    svg.innerHTML = defs +
      `<rect width="100%" height="100%" fill="var(--bg)"/>` +
      `<g>${polygons.join('')}</g>`;

    svg.setAttribute('viewBox', `0 0 ${viewportWidth} ${viewportHeight}`);
    svg.setAttribute('preserveAspectRatio', 'none');
  };

  rebuild();

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rebuild, 200);
  });
}

/* ============================================================
   17. STARTUP
   ============================================================ */

function start() {
  // Reflect saved unit preference in the toggle buttons
  dom.unitToggle.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.unit === state.unitSystem);
  });
  units.refreshLabels();

  events.attach();
  setupScrollReveals();
  buildTriangleBackground();

  dom.footstamp.textContent = new Date()
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    .toUpperCase();

  runBootSequence();
}

start();
