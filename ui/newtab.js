'use strict';

const ENGINES = [
  { id: 'duckduckgo', name: 'DDG', label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  { id: 'google', name: 'G', label: 'Google', url: 'https://www.google.com/search?q=' },
  { id: 'bing', name: 'Bing', label: 'Bing', url: 'https://www.bing.com/search?q=' },
  { id: 'brave', name: 'Brave', label: 'Brave Search', url: 'https://search.brave.com/search?q=' }
];

const WMO_CODES = {
  0: ['Clear sky', 'Sunny'],
  1: ['Mainly clear', 'Mostly clear'],
  2: ['Partly cloudy', 'Partly cloudy'],
  3: ['Overcast', 'Overcast'],
  45: ['Fog', 'Foggy'],
  48: ['Rime fog', 'Foggy'],
  51: ['Light drizzle', 'Drizzle'],
  53: ['Drizzle', 'Drizzle'],
  55: ['Heavy drizzle', 'Drizzle'],
  61: ['Light rain', 'Rain'],
  63: ['Rain', 'Rain'],
  65: ['Heavy rain', 'Rain'],
  71: ['Light snow', 'Snow'],
  73: ['Snow', 'Snow'],
  75: ['Heavy snow', 'Snow'],
  80: ['Rain showers', 'Showers'],
  81: ['Rain showers', 'Showers'],
  82: ['Heavy showers', 'Showers'],
  95: ['Thunderstorm', 'Storm']
};

const STORAGE_KEY = 'voidbrowser_quicklinks';
const DEFAULT_LINKS = [
  { name: 'YouTube', url: 'https://youtube.com', icon: 'Y' },
  { name: 'GitHub', url: 'https://github.com', icon: 'G' },
  { name: 'Reddit', url: 'https://reddit.com', icon: 'R' },
  { name: 'X', url: 'https://x.com', icon: 'X' }
];

let currentEngineIdx = 0;
let quickLinks = [];
let appConfig = null;

async function init() {
  appConfig = await loadAppConfig();
  setupClock();
  setupSearch();
  setupQuickLinks();
  applyBackgroundConfig();
  setupCanvas();
  loadWeather();
}

async function loadAppConfig() {
  try {
    if (window.voidAPI && window.voidAPI.config) {
      return await window.voidAPI.config.get();
    }
  } catch (_) {}
  return { search_engine: 'duckduckgo', newtab_background_preset: 'aurora', newtab_background_image: '' };
}

function setupClock() {
  const clockEl = document.getElementById('clock');
  const dateEl = document.getElementById('date');

  const tick = () => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    clockEl.textContent = `${hh}:${mm}`;
    dateEl.textContent = now.toLocaleDateString('de-DE', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  tick();
  setInterval(tick, 1000);
}

function setupSearch() {
  const form = document.getElementById('search-form');
  const input = document.getElementById('search-input');
  const configuredEngine = (appConfig && appConfig.search_engine) || 'duckduckgo';
  currentEngineIdx = Math.max(0, ENGINES.findIndex(engine => engine.id === configuredEngine));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) return;

    const looksLikeUrl = /^https?:\/\//i.test(value)
      || /^[\w-]+\.[\w]{2,}(\/.*)?$/i.test(value)
      || /^localhost(:\d+)?(\/.*)?$/i.test(value);

    if (looksLikeUrl) {
      window.location.href = /^https?:\/\//i.test(value) ? value : `https://${value}`;
      return;
    }

    const target = ENGINES[currentEngineIdx].url + encodeURIComponent(value);
    window.location.href = target;
  });

  input.focus();
}

function applyBackgroundConfig() {
  const preset = (appConfig && appConfig.newtab_background_preset) || 'aurora';
  const imageUrl = (appConfig && appConfig.newtab_background_image) || '';
  document.body.dataset.backgroundPreset = preset;

  if (preset === 'image' && imageUrl) {
    document.body.style.backgroundImage = `linear-gradient(rgba(13,13,13,0.72), rgba(13,13,13,0.82)), url("${imageUrl.replace(/"/g, '%22')}")`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundRepeat = 'no-repeat';
  } else {
    document.body.style.backgroundImage = '';
    document.body.style.backgroundSize = '';
    document.body.style.backgroundPosition = '';
    document.body.style.backgroundRepeat = '';
  }
}

function setupQuickLinks() {
  quickLinks = loadQuickLinks();
  renderQuickLinks();

  const addBtn = document.getElementById('btn-add-quicklink');
  const form = document.getElementById('quicklink-form');
  const nameInput = document.getElementById('quicklink-name');
  const urlInput = document.getElementById('quicklink-url');
  const cancelBtn = document.getElementById('quicklink-cancel');

  addBtn.addEventListener('click', () => {
    form.classList.remove('hidden');
    form.classList.remove('revealing');
    // Reflow to restart animation class reliably
    void form.offsetWidth;
    form.classList.add('revealing');
    nameInput.focus();
  });

  cancelBtn.addEventListener('click', () => {
    hideQuickLinkForm();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    let url = urlInput.value.trim();
    if (!name || !url) return;

    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }

    quickLinks.push({ name, url, icon: name.charAt(0).toUpperCase() || '?' });
    saveQuickLinks(quickLinks);
    renderQuickLinks();

    nameInput.value = '';
    urlInput.value = '';
    hideQuickLinkForm();
  });
}

function hideQuickLinkForm() {
  const form = document.getElementById('quicklink-form');
  form.classList.add('hidden');
  form.classList.remove('revealing');
}

function loadQuickLinks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : DEFAULT_LINKS.slice();
  } catch (_) {
    return DEFAULT_LINKS.slice();
  }
}

function saveQuickLinks(items) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

function renderQuickLinks() {
  const grid = document.getElementById('quicklinks-grid');
  grid.innerHTML = '';

  quickLinks.forEach((link, index) => {
    const item = document.createElement('a');
    item.className = 'quicklink';
    item.href = link.url;
    item.title = link.url;
    item.setAttribute('role', 'listitem');

    const iconWrap = document.createElement('div');
    iconWrap.className = 'quicklink-icon';

    const favicon = document.createElement('img');
    favicon.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(link.url)}&sz=64`;
    favicon.alt = '';
    favicon.addEventListener('error', () => {
      iconWrap.textContent = link.icon || '?';
    });

    const label = document.createElement('div');
    label.className = 'quicklink-label';
    label.textContent = link.name;

    const remove = document.createElement('button');
    remove.className = 'quicklink-remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Remove shortcut';
    remove.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      quickLinks.splice(index, 1);
      saveQuickLinks(quickLinks);
      renderQuickLinks();
    });

    iconWrap.appendChild(favicon);
    item.appendChild(iconWrap);
    item.appendChild(label);
    item.appendChild(remove);
    grid.appendChild(item);
  });
}

async function loadWeather() {
  const iconEl = document.getElementById('weather-icon');
  const tempEl = document.getElementById('weather-temp');
  const descEl = document.getElementById('weather-desc');
  const locEl = document.getElementById('weather-location');

  try {
    // Primary method: browser geolocation (allowed in Electron via permission handler)
    let lat;
    let lon;
    let locationLabel = '';

    const geo = await getBrowserGeolocation().catch(() => null);
    if (geo) {
      lat = geo.coords.latitude;
      lon = geo.coords.longitude;
      locationLabel = 'Current location';
    } else {
      // Fallback A: IP-based location via ipapi
      const ipData = await getIpLocation().catch(() => null);
      if (ipData && typeof ipData.latitude === 'number' && typeof ipData.longitude === 'number') {
        lat = ipData.latitude;
        lon = ipData.longitude;
        locationLabel = `${ipData.city || ''}${ipData.city && ipData.country_name ? ', ' : ''}${ipData.country_name || ''}`.trim();
      }

      // Fallback B: alternate IP provider
      if (typeof lat !== 'number' || typeof lon !== 'number') {
        const alt = await getIpLocationAlt().catch(() => null);
        if (alt && typeof alt.latitude === 'number' && typeof alt.longitude === 'number') {
          lat = alt.latitude;
          lon = alt.longitude;
          locationLabel = `${alt.city || ''}${alt.city && alt.country ? ', ' : ''}${alt.country || ''}`.trim();
        }
      }

      // Fallback C: deterministic default coordinates (Berlin)
      if (typeof lat !== 'number' || typeof lon !== 'number') {
        lat = 52.52;
        lon = 13.405;
        locationLabel = 'Berlin, DE';
      }
    }

    if (typeof lat !== 'number' || typeof lon !== 'number') {
      throw new Error('Missing coordinates');
    }

    const weather = await fetchWeather(lat, lon);
    const code = weather.weathercode;
    const [desc, short] = WMO_CODES[code] || ['Unknown', 'Unknown'];

    iconEl.textContent = weatherEmoji(code);
    tempEl.textContent = `${Math.round(weather.temperature)}°C`;
    descEl.textContent = desc;
    locEl.textContent = locationLabel || short;
  } catch (err) {
    iconEl.textContent = '•';
    tempEl.textContent = '--';
    descEl.textContent = 'Weather unavailable';
    locEl.textContent = 'Check network/geolocation permissions';
  }
}

function getBrowserGeolocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 4500,
      maximumAge: 120000
    });
  });
}

async function getIpLocation() {
  const res = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new Error(`IP geolocation failed: HTTP ${res.status}`);
  }
  return res.json();
}

async function getIpLocationAlt() {
  const res = await fetch('https://ipwho.is/', { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new Error(`Alt IP geolocation failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data.success) {
    throw new Error('Alt IP geolocation provider returned failure');
  }
  return data;
}

async function fetchWeather(latitude, longitude) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&temperature_unit=celsius`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new Error(`Weather API failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data.current_weather) {
    throw new Error('Weather data missing');
  }
  return data.current_weather;
}

function weatherEmoji(code) {
  if (code === 0) return '☀';
  if (code <= 3) return '☁';
  if (code >= 45 && code <= 48) return '🌫';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return '🌧';
  if (code >= 71 && code <= 77) return '❄';
  if (code >= 95) return '⛈';
  return '🌤';
}

function setupCanvas() {
  const canvas = document.getElementById('bg-canvas');
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let t = 0;

  const resize = () => {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  };

  const draw = () => {
    t += 0.0028;
    ctx.clearRect(0, 0, width, height);

    const preset = document.body.dataset.backgroundPreset || 'aurora';
    const palette = getBackgroundPalette(preset);

    const x1 = width * (0.3 + 0.09 * Math.sin(t));
    const y1 = height * (0.35 + 0.07 * Math.cos(t * 0.8));
    const g1 = ctx.createRadialGradient(x1, y1, 0, x1, y1, width * 0.5);
    g1.addColorStop(0, palette.primary);
    g1.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, width, height);

    const x2 = width * (0.75 + 0.06 * Math.cos(t * 0.7));
    const y2 = height * (0.62 + 0.05 * Math.sin(t));
    const g2 = ctx.createRadialGradient(x2, y2, 0, x2, y2, width * 0.45);
    g2.addColorStop(0, palette.secondary);
    g2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, width, height);

    requestAnimationFrame(draw);
  };

  resize();
  window.addEventListener('resize', resize);
  requestAnimationFrame(draw);
}

function getBackgroundPalette(preset) {
  switch (preset) {
    case 'graphite':
      return { primary: 'rgba(148,163,184,0.07)', secondary: 'rgba(71,85,105,0.08)' };
    case 'midnight':
      return { primary: 'rgba(37,99,235,0.08)', secondary: 'rgba(15,23,42,0.22)' };
    case 'minimal':
      return { primary: 'rgba(255,255,255,0.018)', secondary: 'rgba(255,255,255,0.01)' };
    case 'image':
      return { primary: 'rgba(14,165,233,0.03)', secondary: 'rgba(6,182,212,0.02)' };
    case 'aurora':
    default:
      return { primary: 'rgba(14,165,233,0.07)', secondary: 'rgba(6,182,212,0.06)' };
  }
}

document.addEventListener('DOMContentLoaded', init);
