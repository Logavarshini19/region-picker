/* ==========================================================================
   Google Cloud Region Advisor - Enterprise Frontend Controller
   Connects to Backend API with instantaneous client-side fallback
   ========================================================================== */

import { regionOptimizer } from './region-optimizer.js';

// State Store
let state = {
  regions: {},
  countries: [],
  products: {},
  stats: null,
  weights: {
    carbon: 6,
    price: 6,
    latency: 6
  },
  userCoords: null,
  geoEnabled: true,
  selectedLocations: [], // array of { name, latitude, longitude, country }
  selectedProducts: new Set([
    "Compute Engine",
    "Cloud Storage",
    "Google Kubernetes Engine",
    "Cloud Run"
  ]),
  activeTab: 'cards',
  topResults: [],
  currentTheme: localStorage.getItem('gcp_theme') || 'dark'
};

// Hub coordinates definitions
const QUICK_HUBS = {
  US: [
    { name: "United States (East)", latitude: 37.7749, longitude: -77.4194, country: "US" },
    { name: "United States (West)", latitude: 37.7749, longitude: -122.4194, country: "US" }
  ],
  EU: [
    { name: "Germany (Frankfurt)", latitude: 50.1109, longitude: 8.6821, country: "DE" },
    { name: "United Kingdom (London)", latitude: 51.5074, longitude: -0.1278, country: "GB" },
    { name: "Netherlands (Amsterdam)", latitude: 52.3676, longitude: 4.9041, country: "NL" }
  ],
  APAC: [
    { name: "Singapore", latitude: 1.3521, longitude: 103.8198, country: "SG" },
    { name: "Japan (Tokyo)", latitude: 35.6762, longitude: 139.6503, country: "JP" },
    { name: "India (Mumbai)", latitude: 19.0760, longitude: 72.8777, country: "IN" },
    { name: "Australia (Sydney)", latitude: -33.8688, longitude: 151.2093, country: "AU" }
  ]
};

// ==========================================================================
// Initialization & Data Loading
// ==========================================================================

async function initializeApp() {
  applyTheme(state.currentTheme);
  bindEventListeners();

  // Try fetching from backend API first, otherwise fallback to local JSON
  try {
    const healthRes = await fetch('/api/health');
    if (healthRes.ok) {
      updateBackendStatus(true);
      await loadFromBackend();
    } else {
      throw new Error('API not responding');
    }
  } catch (err) {
    console.warn('[CloudRegion Advisor] Backend API unreachable, falling back to static files:', err);
    updateBackendStatus(false);
    await loadFromStatic();
  }

  // Detect Geolocation
  if (navigator.geolocation && state.geoEnabled) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.userCoords = {
          name: "My Detected Location",
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          isUserGeo: true
        };
        renderLocationChips();
        runOptimization();
      },
      (err) => {
        console.warn('Geolocation denied or unavailable:', err);
        state.userCoords = null;
        renderLocationChips();
        runOptimization();
      },
      { timeout: 5000 }
    );
  } else {
    runOptimization();
  }

  // Populate Selectors
  renderProductsList();
  renderLocationChips();
  runOptimization();
}

async function loadFromBackend() {
  const [regionsRes, countriesRes, productsRes, statsRes] = await Promise.all([
    fetch('/api/regions').then(r => r.json()),
    fetch('/api/countries').then(r => r.json()),
    fetch('/api/products').then(r => r.json()),
    fetch('/api/stats').then(r => r.json()).catch(() => null)
  ]);

  state.regions = regionsRes;
  state.countries = countriesRes.sort((a, b) => a.name.localeCompare(b.name));
  state.products = productsRes;
  state.stats = statsRes;

  if (state.stats) {
    updateKpiRibbon(state.stats);
  }
}

async function loadFromStatic() {
  function parseCarbonCSV(text) {
    const rows = text.replace(/\r/g, '').split('\n').map(row => row.split(','));
    const carbonData = {};
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.length < 4 || !row[0].trim()) continue;
      const cfe = parseFloat(row[2]);
      carbonData[row[0].trim()] = {
        locationName: row[1]?.trim() || '',
        gCO2_kWh: parseInt(row[3], 10) || 0,
        ...(isNaN(cfe) ? {} : { cfe })
      };
    }
    return carbonData;
  }

  const [regionsRaw, pricesRaw, countriesRaw, productsRaw, carbonRaw] = await Promise.all([
    fetch('data/regions.json').then(r => r.json()),
    fetch('data/prices.json').then(r => r.json()),
    fetch('data/countries.json').then(r => r.json()),
    fetch('data/products.json').then(r => r.json()),
    fetch('data/carbon.csv').then(r => r.text())
  ]);

  const carbonData = parseCarbonCSV(carbonRaw);
  state.countries = countriesRaw.sort((a, b) => a.name.localeCompare(b.name));
  state.products = productsRaw;

  state.regions = {};
  for (const reg in regionsRaw) {
    state.regions[reg] = {
      id: reg,
      ...regionsRaw[reg],
      ...(pricesRaw[reg] || {}),
      ...(carbonData[reg] || {})
    };
  }
}

function updateBackendStatus(connected) {
  const badge = document.getElementById('backend-status-badge');
  const text = document.getElementById('backend-status-text');
  if (connected) {
    badge.className = 'status-badge';
    text.textContent = 'Backend API Active';
  } else {
    badge.className = 'status-badge';
    badge.style.color = '#f59e0b';
    badge.style.borderColor = 'rgba(245, 158, 11, 0.3)';
    badge.style.background = 'rgba(245, 158, 11, 0.1)';
    text.textContent = 'Client Mode';
  }
}

function updateKpiRibbon(stats) {
  if (stats.greenestRegion) {
    document.getElementById('kpi-greenest-name').textContent = stats.greenestRegion.name;
    document.getElementById('kpi-greenest-metric').textContent = `${stats.greenestRegion.cfePercent}% Carbon Free Energy`;
  }
  if (stats.cheapestRegion) {
    document.getElementById('kpi-cheapest-name').textContent = stats.cheapestRegion.name;
    document.getElementById('kpi-cheapest-metric').textContent = `$${stats.cheapestRegion.priceHourly} / vCPU-hr (E2)`;
  }
  if (stats.lowestIntensityRegion) {
    document.getElementById('kpi-intensity-name').textContent = stats.lowestIntensityRegion.name;
    document.getElementById('kpi-intensity-metric').textContent = `${stats.lowestIntensityRegion.gCO2_kWh} gCO2eq/kWh`;
  }
  if (stats.totalRegions) {
    document.getElementById('kpi-total-regions').textContent = `${stats.totalRegions} Global Regions`;
  }
}

// ==========================================================================
// Theme Management
// ==========================================================================

function applyTheme(theme) {
  state.currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('gcp_theme', theme);
  const themeIcon = document.getElementById('theme-icon');
  if (themeIcon) {
    themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
}

// ==========================================================================
// Event Listeners
// ==========================================================================

function bindEventListeners() {
  // Theme toggle
  document.getElementById('theme-toggle-btn').addEventListener('click', () => {
    applyTheme(state.currentTheme === 'dark' ? 'light' : 'dark');
  });

  // Sliders
  const carbonSlider = document.getElementById('weight-carbon');
  const priceSlider = document.getElementById('weight-price');
  const latencySlider = document.getElementById('weight-latency');

  function handleSliderChange(slider, key, badgeId) {
    const val = parseInt(slider.value, 10);
    state.weights[key] = val;
    const badge = document.getElementById(badgeId);
    if (val === 0) {
      badge.textContent = 'Off';
      badge.style.color = 'var(--text-muted)';
    } else {
      badge.textContent = `${(val / 10).toFixed(1)}x`;
      badge.style.color = 'var(--text-primary)';
    }
    clearActivePreset();
    runOptimization();
  }

  carbonSlider.addEventListener('input', () => handleSliderChange(carbonSlider, 'carbon', 'badge-carbon'));
  priceSlider.addEventListener('input', () => handleSliderChange(priceSlider, 'price', 'badge-price'));
  latencySlider.addEventListener('input', () => handleSliderChange(latencySlider, 'latency', 'badge-latency'));

  // Presets
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const preset = e.currentTarget.dataset.preset;
      applyPreset(preset);
    });
  });

  // Geolocation toggle
  const geoToggle = document.getElementById('toggle-geolocation');
  geoToggle.addEventListener('change', (e) => {
    state.geoEnabled = e.target.checked;
    if (!state.geoEnabled) {
      state.userCoords = null;
    } else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((pos) => {
        state.userCoords = {
          name: "My Detected Location",
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          isUserGeo: true
        };
        renderLocationChips();
        runOptimization();
      });
    }
    renderLocationChips();
    runOptimization();
  });

  // Country search input
  const countryInput = document.getElementById('location-search-input');
  const countryDropdown = document.getElementById('location-dropdown-results');

  countryInput.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) {
      countryDropdown.classList.remove('open');
      countryDropdown.innerHTML = '';
      return;
    }

    const filtered = state.countries.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
    if (!filtered.length) {
      countryDropdown.innerHTML = '<div style="padding:0.4rem; font-size:0.75rem; color:var(--text-muted);">No matching countries found</div>';
      countryDropdown.classList.add('open');
      return;
    }

    countryDropdown.innerHTML = '';
    filtered.forEach(country => {
      const opt = document.createElement('div');
      opt.className = 'location-option';
      opt.innerHTML = `<span>${country.name}</span><span style="color:var(--text-muted); font-size:0.7rem;">${country.country}</span>`;
      opt.addEventListener('click', () => {
        addLocation(country);
        countryInput.value = '';
        countryDropdown.classList.remove('open');
      });
      countryDropdown.appendChild(opt);
    });
    countryDropdown.classList.add('open');
  });

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.location-search-box') && !e.target.closest('#location-dropdown-results')) {
      countryDropdown.classList.remove('open');
    }
  });

  // Hub shortcuts
  document.querySelectorAll('.hub-btn[data-hub]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const hub = e.currentTarget.dataset.hub;
      if (hub === 'CLEAR') {
        state.selectedLocations = [];
      } else if (QUICK_HUBS[hub]) {
        QUICK_HUBS[hub].forEach(loc => addLocation(loc));
      }
      renderLocationChips();
      runOptimization();
    });
  });

  // Product search input
  const prodSearch = document.getElementById('product-search-input');
  prodSearch.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('.product-checkbox-label').forEach(label => {
      const text = label.textContent.toLowerCase();
      label.style.display = text.includes(q) ? 'flex' : 'none';
    });
  });

  // Product Quick Stacks
  document.getElementById('stack-core').addEventListener('click', () => {
    state.selectedProducts = new Set(["Compute Engine", "Cloud Storage", "Google Kubernetes Engine", "Cloud Run"]);
    renderProductsList();
    runOptimization();
  });

  document.getElementById('stack-ai').addEventListener('click', () => {
    state.selectedProducts = new Set(["Compute Engine", "Cloud Storage", "Vertex AI", "BigQuery"]);
    renderProductsList();
    runOptimization();
  });

  document.getElementById('stack-data').addEventListener('click', () => {
    state.selectedProducts = new Set(["BigQuery", "Cloud Storage", "Cloud Pub/Sub", "Cloud Dataflow", "Cloud Spanner"]);
    renderProductsList();
    runOptimization();
  });

  document.getElementById('stack-all').addEventListener('click', () => {
    state.selectedProducts = new Set(Object.keys(state.products));
    renderProductsList();
    runOptimization();
  });

  document.getElementById('stack-clear').addEventListener('click', () => {
    state.selectedProducts = new Set();
    renderProductsList();
    runOptimization();
  });

  // View Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tab = e.currentTarget.dataset.tab;
      state.activeTab = tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');

      document.getElementById('tab-cards').style.display = tab === 'cards' ? 'block' : 'none';
      document.getElementById('tab-matrix').style.display = tab === 'matrix' ? 'block' : 'none';
      document.getElementById('tab-analytics').style.display = tab === 'analytics' ? 'block' : 'none';
    });
  });

  // Share
  document.getElementById('share-btn').addEventListener('click', () => {
    if (navigator.share) {
      navigator.share({
        title: 'Google Cloud Region Advisor',
        url: window.location.href
      }).catch(() => {});
    } else {
      navigator.clipboard.writeText(window.location.href);
      alert('Strategy link copied to clipboard!');
    }
  });

  // ADR Report Modal
  document.getElementById('open-report-btn').addEventListener('click', openReportModal);
  document.getElementById('modal-close-btn').addEventListener('click', closeReportModal);
  document.getElementById('report-modal').addEventListener('click', (e) => {
    if (e.target.id === 'report-modal') closeReportModal();
  });

  document.getElementById('copy-report-btn').addEventListener('click', () => {
    const text = document.getElementById('report-preview-text').textContent;
    navigator.clipboard.writeText(text);
    const copyBtn = document.getElementById('copy-report-btn');
    const originalText = copyBtn.innerHTML;
    copyBtn.innerHTML = '✓ Copied to Clipboard!';
    setTimeout(() => { copyBtn.innerHTML = originalText; }, 2000);
  });

  document.getElementById('download-report-btn').addEventListener('click', () => {
    const text = document.getElementById('report-preview-text').textContent;
    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `GCP-Architecture-ADR-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

function clearActivePreset() {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
}

function applyPreset(preset) {
  clearActivePreset();
  const activeBtn = document.querySelector(`.preset-btn[data-preset="${preset}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  const cSlider = document.getElementById('weight-carbon');
  const pSlider = document.getElementById('weight-price');
  const lSlider = document.getElementById('weight-latency');

  if (preset === 'eco') {
    state.weights = { carbon: 10, price: 4, latency: 2 };
  } else if (preset === 'latency') {
    state.weights = { carbon: 2, price: 4, latency: 10 };
  } else if (preset === 'cost') {
    state.weights = { carbon: 2, price: 10, latency: 4 };
  } else if (preset === 'balanced') {
    state.weights = { carbon: 6, price: 6, latency: 6 };
  } else if (preset === 'reset') {
    state.weights = { carbon: 5, price: 5, latency: 5 };
  }

  cSlider.value = state.weights.carbon;
  pSlider.value = state.weights.price;
  lSlider.value = state.weights.latency;

  document.getElementById('badge-carbon').textContent = `${(state.weights.carbon / 10).toFixed(1)}x`;
  document.getElementById('badge-price').textContent = `${(state.weights.price / 10).toFixed(1)}x`;
  document.getElementById('badge-latency').textContent = `${(state.weights.latency / 10).toFixed(1)}x`;

  runOptimization();
}

// ==========================================================================
// Locations & Products Management
// ==========================================================================

function addLocation(country) {
  const exists = state.selectedLocations.some(
    l => l.name === country.name || (l.latitude === country.latitude && l.longitude === country.longitude)
  );
  if (!exists) {
    state.selectedLocations.push(country);
    renderLocationChips();
    runOptimization();
  }
}

function removeLocation(idx) {
  state.selectedLocations.splice(idx, 1);
  renderLocationChips();
  runOptimization();
}

function renderLocationChips() {
  const container = document.getElementById('selected-locations-chips');
  container.innerHTML = '';

  let totalOrigins = state.selectedLocations.length;
  if (state.userCoords && state.geoEnabled) {
    totalOrigins += 1;
    const userChip = document.createElement('span');
    userChip.className = 'chip';
    userChip.innerHTML = `<span>📍 My Location (Live GPS)</span>`;
    container.appendChild(userChip);
  }

  state.selectedLocations.forEach((loc, idx) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `<span>${loc.name}</span><span class="chip-remove" data-idx="${idx}">&times;</span>`;
    chip.querySelector('.chip-remove').addEventListener('click', () => removeLocation(idx));
    container.appendChild(chip);
  });

  const countBadge = document.getElementById('origins-count-badge');
  countBadge.textContent = totalOrigins === 1 ? '1 Origin' : `${totalOrigins} Origins`;
}

function renderProductsList() {
  const listContainer = document.getElementById('product-checkbox-list');
  listContainer.innerHTML = '';

  const productNames = Object.keys(state.products).sort();
  productNames.forEach(productName => {
    const label = document.createElement('label');
    label.className = 'product-checkbox-label';

    const isChecked = state.selectedProducts.has(productName);
    label.innerHTML = `
      <span>${productName}</span>
      <input type="checkbox" value="${productName}" ${isChecked ? 'checked' : ''}>
    `;

    label.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) {
        state.selectedProducts.add(productName);
      } else {
        state.selectedProducts.delete(productName);
      }
      updateProductComplianceBadge();
      runOptimization();
    });

    listContainer.appendChild(label);
  });

  updateProductComplianceBadge();
}

function updateProductComplianceBadge() {
  const count = state.selectedProducts.size;
  document.getElementById('product-compliance-badge').textContent = `${count} Selected`;
}

// ==========================================================================
// Regional Optimization Engine
// ==========================================================================

async function runOptimization() {
  if (!Object.keys(state.regions).length) return;

  // Build active locations list
  const activeLocations = [];
  if (state.userCoords && state.geoEnabled) {
    activeLocations.push(state.userCoords);
  }
  state.selectedLocations.forEach(loc => activeLocations.push(loc));

  // Calculate allowed regions based on product availability
  const allowedRegions = new Set();
  const selectedProds = Array.from(state.selectedProducts);

  if (selectedProds.length === 0) {
    Object.keys(state.regions).forEach(r => allowedRegions.add(r));
  } else {
    // Start with all regions supporting the first product
    const firstProd = selectedProds[0];
    const firstProdRegions = state.products[firstProd] || {};
    for (const r in firstProdRegions) {
      if (firstProdRegions[r]) allowedRegions.add(r);
    }
    // Intersect with remaining selected products
    for (let i = 1; i < selectedProds.length; i++) {
      const prodRegions = state.products[selectedProds[i]] || {};
      for (const r of Array.from(allowedRegions)) {
        if (!prodRegions[r]) {
          allowedRegions.delete(r);
        }
      }
    }
  }

  // Update count indicator
  const totalCount = Object.keys(state.regions).length;
  document.getElementById('eligible-regions-count').textContent = 
    `Showing top recommendations (${allowedRegions.size} of ${totalCount} regions eligible)`;

  const optimizerParams = {
    weights: {
      carbon: state.weights.carbon / 10,
      price: state.weights.price / 10,
      latency: state.weights.latency / 10
    },
    locations: activeLocations,
    allowedRegions: allowedRegions
  };

  // Perform local calculation for 60fps instant response
  const regionsCopy = JSON.parse(JSON.stringify(state.regions));
  const results = await regionOptimizer(regionsCopy, optimizerParams);

  state.topResults = results.sorted;
  renderResults(results.sorted, activeLocations);
}

// ==========================================================================
// Rendering Results
// ==========================================================================

function renderResults(sortedResults, activeLocations) {
  if (!sortedResults || !sortedResults.length) {
    renderEmptyState();
    return;
  }

  // 1. Hero Spotlight for #1 Region
  const top1 = sortedResults[0];
  renderSpotlight(top1);

  // 2. Tab 1: Cards View
  renderCards(sortedResults.slice(0, 10));

  // 3. Tab 2: Comparison Matrix Table
  renderMatrix(sortedResults.slice(0, 12));

  // 4. Tab 3: Analytics View
  renderAnalytics(sortedResults.slice(0, 8));
}

function renderEmptyState() {
  document.getElementById('spotlight-region-id').textContent = 'No Region Match';
  document.getElementById('spotlight-location-name').textContent = 'Try reducing required product constraints';
  document.getElementById('spotlight-score-num').textContent = '0.0';
  document.getElementById('results-cards-container').innerHTML = 
    '<div class="panel-card" style="text-align:center; padding:2rem; color:var(--text-muted);">No regions satisfy all selected GCP products simultaneously. Please remove some product filters.</div>';
}

function renderSpotlight(top) {
  const p = top.properties;
  document.getElementById('spotlight-region-id').textContent = top.region;
  document.getElementById('spotlight-location-name').textContent = p.name || top.region;
  document.getElementById('spotlight-score-num').textContent = (top.score * 100).toFixed(1);

  const flagImg = document.getElementById('spotlight-flag');
  if (p.flag) {
    flagImg.src = p.flag;
  }

  // Carbon pill
  const cfeText = p.cfe !== undefined ? `${Math.round(p.cfe * 100)}% Carbon Free` : `${p.gCO2_kWh} gCO2eq/kWh`;
  document.getElementById('spotlight-eco-pill').textContent = `🌱 ${cfeText}`;

  // Cost pill
  const costText = p.gce ? `$${p.gce.toFixed(4)} / hr` : 'Standard Rate';
  document.getElementById('spotlight-cost-pill').textContent = `💰 ${costText}`;

  // Latency pill
  document.getElementById('spotlight-latency-pill').textContent = `⚡ Optimized Routing`;
}

function renderCards(list) {
  const container = document.getElementById('results-cards-container');
  container.innerHTML = '';

  list.forEach((item, index) => {
    const p = item.properties;
    const card = document.createElement('div');
    card.className = 'region-card';

    const rank = index + 1;
    const cfeVal = p.cfe !== undefined ? `${Math.round(p.cfe * 100)}% CFE` : `${p.gCO2_kWh} gCO2`;
    const priceVal = p.gce ? `$${p.gce.toFixed(4)}/hr` : 'N/A';
    const scorePct = Math.min(100, Math.round(item.score * 100));

    // Distance proxy calculation
    let distText = 'Proximity Proxy';
    if (p.distance !== undefined) {
      const km = Math.round(p.distance / 1000);
      distText = `~${km.toLocaleString()} km`;
    }

    card.innerHTML = `
      <div class="card-main-row">
        <div class="card-identity">
          <div class="card-rank-badge">#${rank}</div>
          <img src="${p.flag || 'images/icons/location_on-24px.svg'}" class="card-flag" alt="${p.name}">
          <div class="card-titles">
            <div class="card-region-id">${item.region}</div>
            <div class="card-location-name">${p.name || ''}</div>
          </div>
        </div>

        <div class="card-metrics">
          <div class="metric-item">
            <div class="metric-label">Sustainability</div>
            <div class="metric-value eco">🌱 ${cfeVal}</div>
          </div>

          <div class="metric-item">
            <div class="metric-label">Compute Cost</div>
            <div class="metric-value cost">💰 ${priceVal}</div>
          </div>

          <div class="metric-item">
            <div class="metric-label">Network Distance</div>
            <div class="metric-value latency">⚡ ${distText}</div>
          </div>

          <div class="card-score-box">
            <div class="metric-label">Match Score</div>
            <div class="metric-value" style="color:var(--gcp-blue);">${(item.score * 100).toFixed(1)}</div>
            <div class="card-score-bar-bg">
              <div class="card-score-bar-fill" style="width:${scorePct}%;"></div>
            </div>
          </div>
        </div>
      </div>

      <button class="card-details-toggle">
        <span>Technical Specs</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </button>

      <div class="card-details-drawer">
        <div class="drawer-stat-item">
          <div class="d-label">Carbon Intensity:</div>
          <div class="d-val">${p.gCO2_kWh ? p.gCO2_kWh + ' gCO2eq/kWh' : 'Not recorded'}</div>
        </div>
        <div class="drawer-stat-item">
          <div class="d-label">Google CFE %:</div>
          <div class="d-val">${p.cfe !== undefined ? Math.round(p.cfe * 100) + '%' : 'Grid fallback'}</div>
        </div>
        <div class="drawer-stat-item">
          <div class="d-label">Coordinates:</div>
          <div class="d-val">${p.latitude?.toFixed(2)}, ${p.longitude?.toFixed(2)}</div>
        </div>
        <div class="drawer-stat-item">
          <div class="d-label">GCP Console:</div>
          <div class="d-val"><a href="https://console.cloud.google.com" target="_blank" style="color:var(--gcp-blue); text-decoration:none;">Open Console &nearr;</a></div>
        </div>
      </div>
    `;

    const toggleBtn = card.querySelector('.card-details-toggle');
    const drawer = card.querySelector('.card-details-drawer');
    toggleBtn.addEventListener('click', () => {
      drawer.classList.toggle('open');
    });

    container.appendChild(card);
  });
}

function renderMatrix(list) {
  const tbody = document.getElementById('matrix-table-body');
  tbody.innerHTML = '';

  list.forEach((item, index) => {
    const p = item.properties;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono" style="font-weight:700;">#${index + 1}</td>
      <td class="mono" style="color:var(--gcp-blue); font-weight:700;">${item.region}</td>
      <td>
        <span style="display:inline-flex; align-items:center; gap:0.35rem;">
          <img src="${p.flag || ''}" width="18" height="18" style="border-radius:50%; object-fit:cover;">
          ${p.name || ''}
        </span>
      </td>
      <td class="mono" style="font-weight:700;">${(item.score * 100).toFixed(1)}</td>
      <td style="color:var(--eco-green); font-weight:600;">${p.cfe !== undefined ? Math.round(p.cfe * 100) + '%' : 'N/A'}</td>
      <td>${p.gCO2_kWh ? p.gCO2_kWh + ' gCO2' : 'N/A'}</td>
      <td style="color:var(--cost-purple); font-weight:600;">$${p.gce ? p.gce.toFixed(4) : 'N/A'}</td>
      <td style="color:var(--text-muted);">${p.distance ? Math.round(p.distance / 1000).toLocaleString() + ' km' : 'Proxy'}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderAnalytics(list) {
  const carbonContainer = document.getElementById('chart-carbon-bars');
  const costContainer = document.getElementById('chart-cost-bars');

  carbonContainer.innerHTML = '';
  costContainer.innerHTML = '';

  list.forEach(item => {
    const p = item.properties;

    // Carbon Bar
    const cfePct = p.cfe !== undefined ? Math.round(p.cfe * 100) : 30;
    const carbonRow = document.createElement('div');
    carbonRow.className = 'bar-row';
    carbonRow.innerHTML = `
      <span class="bar-label">${item.region}</span>
      <div class="bar-track">
        <div class="bar-fill eco" style="width: ${cfePct}%;"></div>
      </div>
      <span class="bar-num" style="color:var(--eco-green);">${cfePct}%</span>
    `;
    carbonContainer.appendChild(carbonRow);

    // Cost Bar (Inverse scale so lower price looks cleaner)
    const price = p.gce || 0.025;
    const priceRelative = Math.min(100, Math.round((price / 0.035) * 100));
    const costRow = document.createElement('div');
    costRow.className = 'bar-row';
    costRow.innerHTML = `
      <span class="bar-label">${item.region}</span>
      <div class="bar-track">
        <div class="bar-fill cost" style="width: ${priceRelative}%;"></div>
      </div>
      <span class="bar-num" style="color:var(--cost-purple);">$${price.toFixed(3)}</span>
    `;
    costContainer.appendChild(costRow);
  });
}

// ==========================================================================
// ADR Report Generator
// ==========================================================================

function openReportModal() {
  const modal = document.getElementById('report-modal');
  modal.classList.add('open');

  const top3 = state.topResults.slice(0, 3);
  const primary = top3[0];

  const reportText = [
    `# Google Cloud Architecture Decision Record (ADR)`,
    `**Title**: Multi-Region Placement Strategy for Cloud Workloads`,
    `**Date**: ${new Date().toUTCString()}`,
    `**Evaluation Engine**: Google Cloud Region Advisor v2.5`,
    ``,
    `## 1. Context & Constraints`,
    `- **Optimization Weights**: Carbon (${state.weights.carbon}/10), FinOps Compute Cost (${state.weights.price}/10), Latency (${state.weights.latency}/10)`,
    `- **Target Audience Origins**: ${state.selectedLocations.length ? state.selectedLocations.map(l => l.name).join(', ') : 'Global Clients'}`,
    `- **Required GCP Services**: ${Array.from(state.selectedProducts).join(', ') || 'Default Stack'}`,
    ``,
    `## 2. Decision & Executive Recommendation`,
    primary ? `We recommend deploying the core cloud workload to **${primary.region}** (${primary.properties?.name}).` : `No matching region meets all requirements.`,
    primary ? `This recommendation achieves a Composite Architecture Score of **${(primary.score * 100).toFixed(1)}/100**.` : '',
    ``,
    `## 3. Top Candidate Regions Comparison`,
    ...top3.map((r, i) => `${i + 1}. **${r.region}** (${r.properties?.name})
   - Overall Match Score: ${(r.score * 100).toFixed(1)}/100
   - Carbon Free Energy (CFE): ${r.properties?.cfe ? Math.round(r.properties.cfe * 100) + '%' : 'N/A'}
   - Grid Carbon Intensity: ${r.properties?.gCO2_kWh || 'N/A'} gCO2eq/kWh
   - Hourly Compute Rate (E2): $${r.properties?.gce || 'N/A'} / vCPU-hr`),
    ``,
    `## 4. Architectural Trade-offs`,
    `- **Sustainability**: Maximizes utilization of zero-carbon clean energy where possible.`,
    `- **FinOps Efficiency**: Maintains cloud budget within lowest pricing tiers for Google Compute Engine.`,
    `- **Network Latency**: Minimizes transit hops and geodesic distance to designated user populations.`,
    ``,
    `## 5. Status`,
    `ACCEPTED for architectural review and mentor presentation.`
  ].join('\n');

  document.getElementById('report-preview-text').textContent = reportText;
}

function closeReportModal() {
  document.getElementById('report-modal').classList.remove('open');
}

// ==========================================================================
// Bootstrap
// ==========================================================================

initializeApp();