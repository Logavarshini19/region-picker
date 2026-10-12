import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { regionOptimizer } from './region-optimizer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Helper: Parse Carbon CSV
function parseCarbonCSV(text) {
  const rows = text.replace(/\r/g, '').split('\n').map(row => row.split(','));
  const carbonData = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < 4 || !row[0].trim()) continue;
    const regionCarbonData = {
      locationName: row[1]?.trim() || '',
      gCO2_kWh: parseInt(row[3], 10) || 0
    };
    const cfe = parseFloat(row[2]);
    if (!isNaN(cfe)) {
      regionCarbonData.cfe = cfe;
    }
    carbonData[row[0].trim()] = regionCarbonData;
  }
  return carbonData;
}

// In-memory data store
let regions = {};
let countries = [];
let prices = {};
let carbon = {};
let products = {};
let loaded = false;

function loadDatasets() {
  try {
    const dataDir = path.join(__dirname, 'data');
    const regionsRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'regions.json'), 'utf-8'));
    const pricesRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'prices.json'), 'utf-8'));
    const countriesRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'countries.json'), 'utf-8'));
    const productsRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'products.json'), 'utf-8'));
    const carbonCsvRaw = fs.readFileSync(path.join(dataDir, 'carbon.csv'), 'utf-8');

    carbon = parseCarbonCSV(carbonCsvRaw);
    prices = pricesRaw;
    countries = countriesRaw;
    products = productsRaw;

    // Merge pricing & carbon into regions
    regions = {};
    for (const regionId of Object.keys(regionsRaw)) {
      regions[regionId] = {
        id: regionId,
        ...regionsRaw[regionId],
        ...(prices[regionId] || {}),
        ...(carbon[regionId] || {})
      };
    }

    loaded = true;
    console.log(`[CloudRegion Advisor] Datasets loaded: ${Object.keys(regions).length} regions, ${countries.length} countries, ${Object.keys(products).length} products.`);
  } catch (err) {
    console.error('[CloudRegion Advisor] Error loading datasets:', err);
  }
}

loadDatasets();

// API Endpoints
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'Google Cloud Region Advisor Backend',
    version: '2.5.0',
    uptimeSeconds: Math.floor(process.uptime()),
    datasetLoaded: loaded,
    counts: {
      regions: Object.keys(regions).length,
      countries: countries.length,
      products: Object.keys(products).length
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/api/regions', (req, res) => {
  res.json(regions);
});

app.get('/api/countries', (req, res) => {
  res.json(countries);
});

app.get('/api/products', (req, res) => {
  res.json(products);
});

app.get('/api/stats', (req, res) => {
  const regionList = Object.values(regions);
  if (!regionList.length) {
    return res.status(500).json({ error: 'Data not loaded' });
  }

  // Find greenest region (highest CFE)
  const withCfe = regionList.filter(r => r.cfe !== undefined);
  const greenest = withCfe.sort((a, b) => b.cfe - a.cfe)[0];

  // Lowest carbon intensity
  const withIntensity = regionList.filter(r => r.gCO2_kWh !== undefined);
  const lowestCarbonIntensity = withIntensity.sort((a, b) => a.gCO2_kWh - b.gCO2_kWh)[0];

  // Lowest price
  const withPrice = regionList.filter(r => r.gce !== undefined);
  const cheapest = withPrice.sort((a, b) => a.gce - b.gce)[0];

  // Averages
  const avgCfe = Math.round((withCfe.reduce((acc, r) => acc + r.cfe, 0) / withCfe.length) * 100);
  const avgPrice = (withPrice.reduce((acc, r) => acc + r.gce, 0) / withPrice.length).toFixed(4);

  res.json({
    totalRegions: regionList.length,
    greenestRegion: {
      id: greenest?.id,
      name: greenest?.name,
      cfePercent: Math.round((greenest?.cfe || 0) * 100)
    },
    lowestIntensityRegion: {
      id: lowestCarbonIntensity?.id,
      name: lowestCarbonIntensity?.name,
      gCO2_kWh: lowestCarbonIntensity?.gCO2_kWh
    },
    cheapestRegion: {
      id: cheapest?.id,
      name: cheapest?.name,
      priceHourly: cheapest?.gce
    },
    benchmarks: {
      averageCfePercent: avgCfe,
      averagePriceHourly: avgPrice
    }
  });
});

app.post('/api/optimize', async (req, res) => {
  try {
    const { weights, locations, allowedRegions } = req.body;
    
    // Prepare optimizer params
    const params = {
      weights: {
        carbon: parseFloat(weights?.carbon ?? 0.5),
        price: parseFloat(weights?.price ?? 0.5),
        latency: parseFloat(weights?.latency ?? 0.5)
      },
      locations: Array.isArray(locations) ? locations : [],
      allowedRegions: new Set(Array.isArray(allowedRegions) ? allowedRegions : Object.keys(regions))
    };

    // Make deep copy of regions so optimizer mutations do not corrupt cached store
    const regionsCopy = JSON.parse(JSON.stringify(regions));
    const result = await regionOptimizer(regionsCopy, params);

    res.json({
      success: true,
      evaluatedAt: new Date().toISOString(),
      topCount: result.sorted.length,
      sorted: result.sorted,
      missingData: result.missingData
    });
  } catch (error) {
    console.error('[CloudRegion Advisor] Optimize error:', error);
    res.status(500).json({ error: 'Failed to run regional optimization', details: error.message });
  }
});

// Architectural Report Generator endpoint
app.post('/api/report', (req, res) => {
  const { topRegions, weights, locations, selectedProducts } = req.body;

  const top3 = (topRegions || []).slice(0, 3);
  const reportLines = [
    `# Google Cloud Architecture Decision Record (ADR)`,
    `**Project**: Google Cloud Multi-Region Optimization Study`,
    `**Generated**: ${new Date().toUTCString()}`,
    `**Optimization Profile**: Carbon (${weights?.carbon ?? 'N/A'}), Cost (${weights?.price ?? 'N/A'}), Latency (${weights?.latency ?? 'N/A'})`,
    ``,
    `## Executive Recommendation`,
    top3[0] 
      ? `The primary optimal target region is **${top3[0].region}** (${top3[0].properties?.name}) with an architecture composite score of **${(top3[0].score * 100).toFixed(1)}/100**.`
      : `No matching region found for current criteria.`,
    ``,
    `### Top Candidate Regions:`,
    ...top3.map((r, i) => {
      const name = r.properties?.name || r.name || 'GCP Region';
      const cfe = r.properties?.cfe ?? r.cfe;
      const gCO2_kWh = r.properties?.gCO2_kWh ?? r.gCO2_kWh;
      const gce = r.properties?.gce ?? r.gce;
      return `${i + 1}. **${r.region}** (${name})\n   - Carbon-Free Energy: ${cfe ? Math.round(cfe * 100) + '%' : 'N/A'}\n   - Grid Intensity: ${gCO2_kWh ?? 'N/A'} gCO2eq/kWh\n   - Hourly Compute (E2 vCPU): $${gce ?? 'N/A'}`;
    }),
    ``,
    `## Selected GCP Stack:`,
    (selectedProducts && selectedProducts.length) ? selectedProducts.map(p => `- ${p}`).join('\n') : '- Core Compute & Storage',
    ``,
    `## Target Traffic Origins:`,
    (locations && locations.length) ? locations.map(l => `- Location [Lat: ${l.latitude}, Long: ${l.longitude}]`).join('\n') : '- Global / Undefined'
  ];

  res.json({
    markdown: reportLines.join('\n'),
    generatedAt: new Date().toISOString()
  });
});

// Serve frontend static files
app.use(express.static(__dirname));

// Fallback to index.html for SPA client-side routes
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(` 🚀 Google Cloud Region Advisor Backend & Frontend Live`);
  console.log(` 🌐 Web Application:  http://localhost:${PORT}`);
  console.log(` 📡 Health Check:     http://localhost:${PORT}/api/health`);
  console.log(` 📊 Regional Stats:   http://localhost:${PORT}/api/stats`);
  console.log(`=======================================================`);
});
