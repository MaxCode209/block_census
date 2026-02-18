// Map initialization and layer management
let map;
let markers = [];
let heatmapLayer = null;
let zipCodePolygons = []; // Store zip code boundary polygons
let schoolDistrictPolygons = []; // School district overlay (NCES, for current zip)
let schoolDistrictPolylines = []; // Explicit perimeter lines for each boundary
let schoolDistrictLabels = [];   // Number labels for each attendance zone
let selectedPolygon = null; // Currently selected/highlighted zip code
let currentData = [];
let currentLayer = 'population'; // 'population', 'income', 'age'
let currentFilters = {}; // Store current active filters
let currentAddress = null; // Store current searched address
let currentLocation = null; // Store current location {lat, lng}
let currentZipCode = null; // Store current zip code
let currentCensusRecord = null; // Census record for searched zip (for Demographics legend)

const API_BASE_URL = '/api';

// Cap how many zips we geocode for the heatmap (biggest Geocoding API saver).
// Each zip = 1 Geocoding API request; without this, 5000 zips = 5000 requests per load + per layer toggle.
const MAX_ZIPS_FOR_MAP = 300;
// In-memory cache: zip -> Google Maps LatLng (or { lat, lng }). Avoids re-geocoding same zip in same session.
let zipCoordCache = new Map();

// Initialize map
function initMap() {
    map = new google.maps.Map(document.getElementById('map'), {
        center: { lat: 39.8283, lng: -98.5795 },
        zoom: 4,
        mapTypeId: 'roadmap',
        styles: [
            {
                featureType: 'poi',
                stylers: [{ visibility: 'off' }]
            }
        ]
    });
    loadCensusData();
}

// Use census block groups when we have a geographic search (city, zip, or lat/lng)
function useBlockGroups(filters) {
    return !!(filters && (filters.city || filters.zip_code || (filters.lat != null && filters.lng != null)));
}

// Load census data from API - uses block groups for city/zip/address search, zips otherwise
async function loadCensusData(filters = {}) {
    try {
        showLoading(true);
        
        // Store current filters for export
        currentFilters = filters || {};
        
        const params = new URLSearchParams();
        if (filters.zip_code) params.append('zip_code', filters.zip_code);
        if (filters.city) params.append('city', filters.city);
        if (filters.state) params.append('state', filters.state);
        if (filters.lat != null) params.append('lat', filters.lat);
        if (filters.lng != null) params.append('lng', filters.lng);
        if (filters.min_income) params.append('min_income', filters.min_income);
        if (filters.max_income) params.append('max_income', filters.max_income);
        if (filters.min_population) params.append('min_population', filters.min_population);
        if (filters.max_population) params.append('max_population', filters.max_population);
        if (filters.min_age != null && filters.min_age !== '') params.append('min_age', filters.min_age);
        if (filters.max_age != null && filters.max_age !== '') params.append('max_age', filters.max_age);
        if (filters.min_elementary_school_rating != null && filters.min_elementary_school_rating !== '' && !Number.isNaN(Number(filters.min_elementary_school_rating))) params.append('min_elementary_school_rating', filters.min_elementary_school_rating);
        if (filters.min_blended_school_rating != null && filters.min_blended_school_rating !== '' && !Number.isNaN(Number(filters.min_blended_school_rating))) params.append('min_blended_school_rating', filters.min_blended_school_rating);
        if (filters.min_zoned_elementary_school_rating != null && !Number.isNaN(Number(filters.min_zoned_elementary_school_rating))) params.append('min_zoned_elementary_school_rating', filters.min_zoned_elementary_school_rating);
        if (filters.min_zoned_blended_school_rating != null && !Number.isNaN(Number(filters.min_zoned_blended_school_rating))) params.append('min_zoned_blended_school_rating', filters.min_zoned_blended_school_rating);
        if (filters.min_local_employment_score != null && !Number.isNaN(Number(filters.min_local_employment_score))) params.append('min_local_employment_score', filters.min_local_employment_score);
        if (filters.min_employment_access_score != null && !Number.isNaN(Number(filters.min_employment_access_score))) params.append('min_employment_access_score', filters.min_employment_access_score);
        params.append('limit', '5000');
        
        let endpoint = useBlockGroups(filters) ? 'census-block-groups' : 'census-data';
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        let response, result;
        try {
            response = await fetch(`${API_BASE_URL}/${endpoint}?${params}`, { signal: controller.signal });
            result = await response.json().catch(() => ({}));
        } catch (fetchErr) {
            clearTimeout(timeoutId);
            throw fetchErr;
        }
        clearTimeout(timeoutId);

        // Block group mode: no fallback to census-data (stay with block-level filtering)
        if (!response.ok) {
            const msg = result.error || response.statusText || 'Request failed';
            throw new Error(msg);
        }

        currentData = result.data || [];
        const total = result.total ?? currentData.length;
        updateRecordCount(total, total > MAX_ZIPS_FOR_MAP ? MAX_ZIPS_FOR_MAP : null);
        if (currentData.length === 0 && useBlockGroups(filters)) {
            console.warn('No census block groups found. Run: python scripts/populate_census_block_groups.py');
        }
        updateMap();

    } catch (error) {
        console.error('Error loading census data:', error);
        alert('Error loading census data: ' + (error.message || 'Please try again.'));
    } finally {
        showLoading(false);
    }
}

// Apply data layer filters (block group level: population min, median HHI min)
function applyDataLayerFilters() {
    const filters = { ...currentFilters };
    const popMin = document.getElementById('filter-pop-min')?.value?.trim();
    const mhiMin = document.getElementById('filter-mhi-min')?.value?.trim();
    const elemMin = document.getElementById('filter-elementary-min')?.value?.trim();
    const blendedMin = document.getElementById('filter-blended-min')?.value?.trim();
    const lesMin = document.getElementById('filter-les-min')?.value?.trim();
    const easMin = document.getElementById('filter-eas-min')?.value?.trim();
    if (popMin) filters.min_population = parseInt(popMin, 10);
    if (mhiMin) filters.min_income = parseFloat(mhiMin);
    if (elemMin) filters.min_zoned_elementary_school_rating = parseFloat(elemMin);
    if (blendedMin) filters.min_zoned_blended_school_rating = parseFloat(blendedMin);
    if (lesMin) filters.min_local_employment_score = parseFloat(lesMin);
    if (easMin) filters.min_employment_access_score = parseFloat(easMin);
    if (!filters.city && !filters.zip_code && filters.lat == null && filters.lng == null) {
        alert('Search a city, zip, or address first, then click Apply Filters.');
        return;
    }
    loadCensusData(filters);
}

// Clear data layer filter inputs and reload without them
function clearDataLayerFilters() {
    ['filter-pop-min', 'filter-mhi-min', 'filter-elementary-min', 'filter-blended-min', 'filter-les-min', 'filter-eas-min'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const filters = {};
    if (currentFilters.city) filters.city = currentFilters.city;
    if (currentFilters.state) filters.state = currentFilters.state;
    if (currentFilters.zip_code) filters.zip_code = currentFilters.zip_code;
    if (currentFilters.lat != null) filters.lat = currentFilters.lat;
    if (currentFilters.lng != null) filters.lng = currentFilters.lng;
    loadCensusData(filters);
}

// Update map with current data and selected layer
async function updateMap() {
    // Clear existing markers and polygons
    clearMarkers();
    clearPolygons();
    
    if (currentData.length === 0) {
        return;
    }
    
    // Get active layers
    const showPopulation = document.getElementById('layer-population').checked;
    const showIncome = document.getElementById('layer-income').checked;
    const showAge = document.getElementById('layer-age').checked;
    const showBoundaries = document.getElementById('layer-boundaries').checked;
    
    // Determine which layer to display (priority: income > age > population)
    let activeLayer = null;
    if (showIncome) activeLayer = 'income';
    else if (showAge) activeLayer = 'age';
    else if (showPopulation) activeLayer = 'population';
    
    if (!activeLayer) {
        return;
    }
    
    currentLayer = activeLayer;
    
    const isBlockGroupData = currentData.length > 0 && currentData[0].geoid != null && currentData[0].geometry != null;
    const heatmapData = [];
    const bounds = new google.maps.LatLngBounds();
    const recordsToShow = currentData.slice(0, MAX_ZIPS_FOR_MAP);
    
    for (const record of recordsToShow) {
        let location = null;
        if (isBlockGroupData && record.geometry) {
            location = centroidFromGeometry(record.geometry);
        } else if (record.zip_code) {
            location = await geocodeZipCode(record.zip_code);
        }
        if (location) {
            const value = getLayerValue(record, activeLayer);
            if (value !== null && value !== undefined && (activeLayer !== 'employment' || value > 0)) {
                heatmapData.push({
                    location: location,
                    weight: normalizeValue(value, activeLayer)
                });
                bounds.extend(location);
                createMarker(location, record, activeLayer, isBlockGroupData);
                if (showBoundaries) {
                    if (isBlockGroupData && record.geometry) {
                        await createBoundaryFromGeometry(record, activeLayer);
                    } else {
                        await createZipCodeBoundary(record.zip_code, record, activeLayer);
                    }
                }
            }
        }
    }
    
    // Update heatmap if we have data
    if (heatmapData.length > 0) {
        updateHeatmap(heatmapData, activeLayer);
        // Zoom to data bounds (including city search - zoom to block groups)
        if (!bounds.isEmpty()) {
            map.fitBounds(bounds, { top: 80, right: 80, bottom: 80, left: 80 });
        }
    }
    
    updateLegend();
}

// Parse geometry - may come as object or JSON string from API
function parseGeometry(geometry) {
    if (!geometry) return null;
    if (typeof geometry === 'string') {
        try { return JSON.parse(geometry); } catch (_) { return null; }
    }
    return geometry;
}

// Compute centroid from GeoJSON geometry (Polygon or MultiPolygon)
function centroidFromGeometry(geometry) {
    const geom = parseGeometry(geometry);
    if (!geom || !geom.coordinates) return null;
    let latSum = 0, lngSum = 0, n = 0;
    function addCoords(coords) {
        if (Array.isArray(coords[0])) {
            coords.forEach(addCoords);
        } else if (coords.length >= 2) {
            latSum += coords[1];
            lngSum += coords[0];
            n++;
        }
    }
    if (geom.type === 'Polygon') {
        geom.coordinates[0].forEach(addCoords);
    } else if (geom.type === 'MultiPolygon') {
        geom.coordinates.forEach(poly => poly[0].forEach(addCoords));
    }
    if (n === 0) return null;
    return new google.maps.LatLng(latSum / n, lngSum / n);
}

// Create boundary polygon from block group GeoJSON geometry
async function createBoundaryFromGeometry(record, layer) {
    const geometry = parseGeometry(record.geometry);
    if (!geometry) return null;
    const color = getColorForValue(getLayerValue(record, layer), layer);
    const processGeometry = (geom) => {
        if (geom.type === 'Polygon') {
            return [geom.coordinates[0].map(c => new google.maps.LatLng(c[1], c[0]))];
        }
        if (geom.type === 'MultiPolygon') {
            return geom.coordinates.flatMap(poly => [poly[0].map(c => new google.maps.LatLng(c[1], c[0]))]);
        }
        return [];
    };
    const paths = processGeometry(geometry);
    const showBoundaries = document.getElementById('layer-boundaries')?.checked ?? true;
    if (!showBoundaries) return null;
    paths.forEach((path, i) => {
        const polygon = new google.maps.Polygon({
            paths: path,
            map: map,
            strokeColor: '#FF0000',
            strokeOpacity: 0.9,
            strokeWeight: 2,
            fillColor: color,
            fillOpacity: 0.25,
            clickable: true,
            zIndex: 1
        });
        polygon.geoid = record.geoid;
        polygon.record = record;
        polygon.addListener('click', () => highlightZipCode(polygon, record));
        zipCodePolygons.push(polygon);
    });
    return zipCodePolygons[zipCodePolygons.length - 1];
}

// Geocode zip code to get coordinates (uses Google Geocoding API; results cached per session).
async function geocodeZipCode(zipCode) {
    const key = String(zipCode).trim();
    if (!key) return null;
    const cached = zipCoordCache.get(key);
    if (cached) return cached;
    try {
        const geocoder = new google.maps.Geocoder();
        return new Promise((resolve) => {
            // Try multiple formats for better geocoding success
            const addresses = [
                zipCode,  // Just the zip code
                `${zipCode} USA`,  // Zip code with USA
                `ZIP Code ${zipCode}`,  // Alternative format
            ];
            
            let attemptIndex = 0;
            
            function tryGeocode() {
                geocoder.geocode({ address: addresses[attemptIndex] }, (results, status) => {
                    if (status === 'OK' && results[0]) {
                        // Verify it's actually a zip code result
                        const result = results[0];
                        const hasZipCode = result.address_components.some(component => 
                            component.types.includes('postal_code')
                        );
                        
                        if (hasZipCode || attemptIndex === addresses.length - 1) {
                            const loc = result.geometry.location;
                            zipCoordCache.set(key, loc);
                            resolve(loc);
                        } else if (attemptIndex < addresses.length - 1) {
                            // Try next format
                            attemptIndex++;
                            tryGeocode();
                        } else {
                            resolve(null);
                        }
                    } else if (attemptIndex < addresses.length - 1) {
                        // Try next format
                        attemptIndex++;
                        tryGeocode();
                    } else {
                        resolve(null);
                    }
                });
            }
            
            tryGeocode();
        });
    } catch (error) {
        console.error('Geocoding error:', error);
        return null;
    }
}

// Geocode zip code and get full result with bounds
async function geocodeZipCodeFull(zipCode) {
    try {
        const geocoder = new google.maps.Geocoder();
        return new Promise((resolve) => {
            // Try multiple formats for better geocoding success
            const addresses = [
                zipCode,  // Just the zip code
                `${zipCode} USA`,  // Zip code with USA
                `ZIP Code ${zipCode}`,  // Alternative format
            ];
            
            let attemptIndex = 0;
            
            function tryGeocode() {
                geocoder.geocode({ address: addresses[attemptIndex] }, (results, status) => {
                    if (status === 'OK' && results[0]) {
                        const result = results[0];
                        // Verify it's actually a zip code result
                        const hasZipCode = result.address_components.some(component => 
                            component.types.includes('postal_code')
                        );
                        
                        if (hasZipCode || attemptIndex === addresses.length - 1) {
                            resolve({
                                location: result.geometry.location,
                                bounds: result.geometry.bounds,
                                viewport: result.geometry.viewport
                            });
                        } else if (attemptIndex < addresses.length - 1) {
                            attemptIndex++;
                            tryGeocode();
                        } else {
                            resolve(null);
                        }
                    } else if (attemptIndex < addresses.length - 1) {
                        attemptIndex++;
                        tryGeocode();
                    } else {
                        resolve(null);
                    }
                });
            }
            
            tryGeocode();
        });
    } catch (error) {
        console.error('Geocoding error:', error);
        return null;
    }
}

// Get value for specific layer
function getLayerValue(record, layer) {
    switch (layer) {
        case 'population':
            return record.population;
        case 'income':
            return record.average_household_income;
        case 'age':
            return record.median_age;
        case 'employment':
            return record.local_employment_score != null ? record.local_employment_score : null;
        default:
            return null;
    }
}

// Normalize value for heatmap visualization
function normalizeValue(value, layer) {
    if (!value || value === 0) return 0;
    
    // Get min/max from current data
    const values = currentData
        .map(r => getLayerValue(r, layer))
        .filter(v => v !== null && v !== undefined && v > 0);
    
    if (values.length === 0) return 0;
    
    const min = Math.min(...values);
    const max = Math.max(...values);
    
    if (max === min) return 0.5;
    
    return (value - min) / (max - min);
}

// Create marker with info window
function createMarker(location, record, layer, isBlockGroup = false) {
    const value = getLayerValue(record, layer);
    const color = getColorForValue(value, layer);
    const title = isBlockGroup ? `Block Group: ${record.geoid}` : `Zip Code: ${record.zip_code}`;
    
    const marker = new google.maps.Marker({
        position: location,
        map: map,
        title: title,
        icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: color,
            fillOpacity: 0.7,
            strokeColor: '#fff',
            strokeWeight: 2
        }
    });
    
    const infoWindow = new google.maps.InfoWindow({
        content: createInfoWindowContent(record)
    });
    
    marker.addListener('click', () => {
        infoWindow.open(map, marker);
    });
    
    markers.push(marker);
}

// Create info window content
function createInfoWindowContent(record) {
    if (!record) {
        return `
            <div style="padding: 10px; min-width: 200px;">
                <h3 style="margin: 0 0 10px 0;">No Data Available</h3>
                <p style="margin: 5px 0;">No census data found for this location.</p>
            </div>
        `;
    }
    const geoLabel = record.geoid ? `Block Group: ${record.geoid}` : `Zip Code: ${record.zip_code || 'N/A'}`;
    const isBlockGroup = !!record.geoid;

    // Block group: always show zoned schools section (with N/A when no data)
    let zonedSchoolsHtml = '';
    if (isBlockGroup) {
        const fmtRating = (v) => (v != null && typeof v === 'number') ? v.toFixed(1) : null;
        const re = fmtRating(record.zoned_elementary_school_rating);
        const rm = fmtRating(record.zoned_middle_school_rating);
        const rh = fmtRating(record.zoned_high_school_rating);
        const ratings = [re, rm, rh].filter(x => x != null);
        const blended = ratings.length > 0
            ? (ratings.reduce((a, b) => a + parseFloat(b), 0) / ratings.length).toFixed(1)
            : null;
        const line = (name, rating, label) => {
            const n = (name || '').trim() || 'N/A';
            const r = rating != null ? `${rating}/10` : 'N/A';
            return `<p style="margin: 3px 0 3px 8px; font-size: 0.95em;">${label}: ${n}, ${r}</p>`;
        };
        zonedSchoolsHtml = `
            <p style="margin: 8px 0 4px 0;"><strong>Zoned School Score:</strong> ${blended != null ? blended + '/10' : 'N/A'}</p>
            ${line(record.zoned_elementary_school_name, re, 'Elementary')}
            ${line(record.zoned_middle_school_name, rm, 'Middle')}
            ${line(record.zoned_high_school_name, rh, 'High')}
        `;
    }

    // Zip-level census data: schools count and avg ratings
    const tot = record.total_schools != null ? record.total_schools : 'N/A';
    const elem = record.elementary_schools != null ? record.elementary_schools : 'N/A';
    const mid = record.middle_schools != null ? record.middle_schools : 'N/A';
    const high = record.high_schools != null ? record.high_schools : 'N/A';
    const fmt = (v) => (v != null && typeof v === 'number') ? v.toFixed(1) : 'N/A';
    const avgElem = fmt(record.average_elementary_school_rating);
    const avgMid = fmt(record.average_middle_school_rating);
    const avgHigh = fmt(record.average_high_school_rating);
    const blended = fmt(record.average_school_rating);
    const schoolLine = !isBlockGroup && (tot !== 'N/A' || elem !== 'N/A' || mid !== 'N/A' || high !== 'N/A')
        ? `<p style="margin: 5px 0;"><strong>Schools:</strong> ${tot} total (Elem: ${elem}, Mid: ${mid}, High: ${high})</p>`
        : '';
    const ratingsLine = !isBlockGroup && (avgElem !== 'N/A' || avgMid !== 'N/A' || avgHigh !== 'N/A' || blended !== 'N/A')
        ? `<p style="margin: 5px 0;"><strong>Avg Ratings (1-10):</strong> Elem ${avgElem} | Mid ${avgMid} | High ${avgHigh} | Blended ${blended}</p>`
        : '';

    // Debug: log employment scores to console
    if (record.geoid && (record.local_employment_score != null || record.employment_access_score != null)) {
        console.log(`Block ${record.geoid}: LES=${record.local_employment_score} (type: ${typeof record.local_employment_score}), EAS=${record.employment_access_score} (type: ${typeof record.employment_access_score})`);
    }
    
    const lesValue = (record.local_employment_score != null && record.local_employment_score !== undefined && record.local_employment_score !== '') 
        ? Number(record.local_employment_score).toFixed(2) + ' / 10' 
        : 'N/A';
    const easValue = (record.employment_access_score != null && record.employment_access_score !== undefined && record.employment_access_score !== '') 
        ? Number(record.employment_access_score).toFixed(2) + ' / 10' 
        : 'N/A';
    
    return `
        <div style="padding: 10px; min-width: 240px;">
            <h3 style="margin: 0 0 10px 0;">${geoLabel}</h3>
            <p style="margin: 5px 0;"><strong>Population:</strong> ${formatNumber(record.population)}</p>
            <p style="margin: 5px 0;"><strong>Median Age:</strong> ${record.median_age ? record.median_age.toFixed(1) : 'N/A'}</p>
            <p style="margin: 5px 0;"><strong>Median Household Income (MHI):</strong> ${record.average_household_income ? formatCurrency(record.average_household_income) : 'N/A'}</p>
            <p style="margin: 5px 0;"><strong>Local Employment Score (LES):</strong> ${lesValue}</p>
            <p style="margin: 5px 0;"><strong>Employment Access Score (EAS):</strong> ${easValue}</p>
            ${zonedSchoolsHtml}
            ${schoolLine}
            ${ratingsLine}
        </div>
    `;
}

// Get color for value
function getColorForValue(value, layer) {
    if (!value || value === 0) return '#999';
    
    const normalized = normalizeValue(value, layer);
    
    // Color gradient: blue (low) to red (high)
    const hue = (1 - normalized) * 240; // 240 is blue, 0 is red
    return `hsl(${hue}, 70%, 50%)`;
}

// Update heatmap
function updateHeatmap(heatmapData, layer) {
    if (heatmapLayer) {
        heatmapLayer.setMap(null);
    }
    
    const gradient = getGradientForLayer(layer);
    
    heatmapLayer = new google.maps.visualization.HeatmapLayer({
        data: heatmapData,
        map: map,
        radius: 20,
        gradient: gradient,
        opacity: 0.6
    });
}

// Get gradient for layer
function getGradientForLayer(layer) {
    return [
        'rgba(0, 255, 255, 0)',
        'rgba(0, 255, 255, 1)',
        'rgba(0, 191, 255, 1)',
        'rgba(0, 127, 255, 1)',
        'rgba(0, 63, 255, 1)',
        'rgba(0, 0, 255, 1)',
        'rgba(0, 0, 223, 1)',
        'rgba(0, 0, 191, 1)',
        'rgba(0, 0, 159, 1)',
        'rgba(0, 0, 127, 1)',
        'rgba(63, 0, 91, 1)',
        'rgba(127, 0, 63, 1)',
        'rgba(191, 0, 31, 1)',
        'rgba(255, 0, 0, 1)'
    ];
}

// Update legend: Demographics card for searched zip (from census table)
function updateLegend() {
    const legend = document.getElementById('map-legend');
    legend.classList.add('active');

    if (!currentZipCode) {
        legend.innerHTML = '<h4>Demographics</h4><p class="legend-placeholder">Search a zip code to see demographics.</p>';
        return;
    }

    if (!currentCensusRecord) {
        legend.innerHTML = `
            <h4>Demographics</h4>
            <p class="legend-row"><strong>Zip Code:</strong> ${currentZipCode}</p>
            <p class="legend-placeholder">No census data in database for this zip.</p>
        `;
        return;
    }

    const r = currentCensusRecord;
    const pop = r.population != null ? formatNumber(r.population) : 'N/A';
    const age = r.median_age != null ? r.median_age.toFixed(1) + ' years' : 'N/A';
    const hhi = r.average_household_income != null ? formatCurrency(r.average_household_income) : 'N/A';
    const empScore = r.local_employment_score != null ? (r.local_employment_score.toFixed(2) + ' / 10') : 'N/A';

    legend.innerHTML = `
        <h4>Demographics</h4>
        <p class="legend-row"><strong>Zip Code:</strong> ${currentZipCode}</p>
        <p class="legend-row"><strong>Population:</strong> ${pop}</p>
        <p class="legend-row"><strong>Median Age:</strong> ${age}</p>
        <p class="legend-row"><strong>Median HHI:</strong> ${hhi}</p>
        <p class="legend-row"><strong>Local Employment Score (LES):</strong> ${empScore}</p>
    `;
}

// Format value for display
function formatValue(value, layer) {
    switch (layer) {
        case 'population':
            return formatNumber(value);
        case 'income':
            return formatCurrency(value);
        case 'age':
            return value.toFixed(1) + ' years';
        case 'employment':
            return value != null ? (value.toFixed(1) + ' / 10') : 'N/A';
        default:
            return value;
    }
}

// Format number with commas
function formatNumber(num) {
    if (!num) return 'N/A';
    return num.toLocaleString();
}

// Format currency
function formatCurrency(num) {
    if (!num) return 'N/A';
    return '$' + num.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

// Create zip code boundary polygon with actual shape using Google Data-Driven Styling
async function createZipCodeBoundary(zipCode, record, layer) {
    try {
        const color = getColorForValue(getLayerValue(record, layer), layer);
        let polygons = []; // Store all polygons (for MultiPolygon cases)
        
        // Helper function to create a polygon from coordinates
        const createPolygonFromPath = (path, isMain = true) => {
            return new google.maps.Polygon({
                paths: path,
                map: map,
                strokeColor: '#FF0000', // Red border for visibility
                strokeOpacity: 0.9,
                strokeWeight: 3, // Thicker border
                fillColor: color,
                fillOpacity: 0.25, // More visible fill
                clickable: true,
                zIndex: isMain ? 2 : 1
            });
        };
        
        // Helper function to process GeoJSON geometry
        const processGeometry = (geometry) => {
            if (geometry.type === 'Polygon') {
                // Single polygon - convert coordinates to LatLng array
                const coordinates = geometry.coordinates[0];
                const path = coordinates.map(coord => 
                    new google.maps.LatLng(coord[1], coord[0])
                );
                return [path];
            } else if (geometry.type === 'MultiPolygon') {
                // Multiple polygons - process ALL of them
                const allPaths = [];
                geometry.coordinates.forEach(polygonGroup => {
                    polygonGroup.forEach(ring => {
                        const path = ring.map(coord => 
                            new google.maps.LatLng(coord[1], coord[0])
                        );
                        allPaths.push(path);
                    });
                });
                return allPaths;
            }
            return [];
        };
        
        // Method 1: Try backend API first (uses FREE Census TIGERweb and other free sources)
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
            
            const response = await fetch(`${API_BASE_URL}/zip-boundary/${zipCode}`, {
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            
            if (response.ok) {
                const geojson = await response.json();
                
                // Handle FeatureCollection
                let features = [];
                if (geojson.type === 'FeatureCollection' && geojson.features) {
                    features = geojson.features;
                } else if (geojson.type === 'Feature') {
                    features = [geojson];
                } else if (geojson.geometry) {
                    // Direct geometry object
                    features = [{ geometry: geojson.geometry }];
                }
                
                // Process all features
                for (const feature of features) {
                    const geometry = feature.geometry || geojson;
                    const paths = processGeometry(geometry);
                    
                    // Create polygon for each path
                    paths.forEach((path, index) => {
                        const polygon = createPolygonFromPath(path, index === 0);
                        polygon.zipCode = zipCode;
                        polygon.record = record;
                        polygon.addListener('click', () => {
                            highlightZipCode(polygon, record);
                        });
                        polygons.push(polygon);
                    });
                }
                
                if (polygons.length > 0) {
                    console.log(`✓ Found accurate boundary for ${zipCode} (${polygons.length} part${polygons.length > 1 ? 's' : ''})`);
                    // Store all polygons
                    polygons.forEach(p => zipCodePolygons.push(p));
                    return polygons[0]; // Return first as main polygon
                }
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.log(`Backend boundary fetch failed for ${zipCode}:`, error);
            }
        }
        
        // Method 2: Try direct CDN sources if backend fails (FREE sources)
        if (polygons.length === 0) {
            const cdnSources = [
                `https://raw.githubusercontent.com/OpenDataDE/State-zip-code-GeoJSON/master/zcta5/${zipCode}_polygon.geojson`,
                `https://raw.githubusercontent.com/OpenDataDE/State-zip-code-GeoJSON/master/${zipCode[0]}/${zipCode}_polygon.geojson`,
            ];
            
            for (const cdnUrl of cdnSources) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 8000);
                    
                    const response = await fetch(cdnUrl, { 
                        method: 'GET',
                        mode: 'cors',
                        cache: 'default',
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);
                    
                    if (response.ok) {
                        const geojson = await response.json();
                        
                        // Handle different GeoJSON structures
                        let features = [];
                        if (geojson.type === 'FeatureCollection' && geojson.features) {
                            features = geojson.features;
                        } else if (geojson.type === 'Feature') {
                            features = [geojson];
                        } else if (geojson.geometry) {
                            features = [{ geometry: geojson.geometry }];
                        }
                        
                        for (const feature of features) {
                            const geometry = feature.geometry || geojson;
                            const paths = processGeometry(geometry);
                            
                            paths.forEach((path, index) => {
                                const polygon = createPolygonFromPath(path, index === 0);
                                polygon.zipCode = zipCode;
                                polygon.record = record;
                                polygon.addListener('click', () => {
                                    highlightZipCode(polygon, record);
                                });
                                polygons.push(polygon);
                            });
                        }
                        
                        if (polygons.length > 0) {
                            console.log(`✓ Found boundary for ${zipCode} from CDN (${polygons.length} part${polygons.length > 1 ? 's' : ''})`);
                            break; // Success!
                        }
                    }
                } catch (error) {
                    if (error.name !== 'AbortError') {
                        // Try next source
                        continue;
                    }
                }
            }
        }
        
        // Method 3: Fallback to approximate boundary ONLY if no accurate boundary found
        if (polygons.length === 0) {
            console.log(`⚠ Could not find exact boundary for ${zipCode}, using approximate rectangle`);
            const geocodeResult = await geocodeZipCodeFull(zipCode);
            
            if (!geocodeResult) {
                return null;
            }
            
            const { location, bounds, viewport } = geocodeResult;
            
            // Use bounds if available (creates a rectangle as fallback)
            let polygon;
            if (bounds) {
                polygon = new google.maps.Rectangle({
                    bounds: bounds,
                    map: map,
                    strokeColor: '#FFA500', // Orange to indicate approximate
                    strokeOpacity: 0.7,
                    strokeWeight: 2,
                    strokeDashArray: [5, 5], // Dashed line to show it's approximate
                    fillColor: color,
                    fillOpacity: 0.15,
                    clickable: true,
                    zIndex: 1
                });
            } else if (viewport) {
                polygon = new google.maps.Rectangle({
                    bounds: viewport,
                    map: map,
                    strokeColor: '#FFA500',
                    strokeOpacity: 0.7,
                    strokeWeight: 2,
                    strokeDashArray: [5, 5],
                    fillColor: color,
                    fillOpacity: 0.15,
                    clickable: true,
                    zIndex: 1
                });
            } else {
                // Last resort: circle
                polygon = new google.maps.Circle({
                    center: location,
                    radius: 2000,
                    map: map,
                    strokeColor: '#FFA500',
                    strokeOpacity: 0.7,
                    strokeWeight: 2,
                    fillColor: color,
                    fillOpacity: 0.15,
                    clickable: true,
                    zIndex: 1
                });
            }
            
            polygon.zipCode = zipCode;
            polygon.record = record;
            polygon.addListener('click', () => {
                highlightZipCode(polygon, record);
            });
            polygons.push(polygon);
        }
        
        // Store all polygons and set up center/bounds for info windows
        const mainPolygon = polygons[0];
        
        // Get center for info windows
        if (mainPolygon.getBounds) {
            mainPolygon.center = mainPolygon.getBounds().getCenter();
            mainPolygon.bounds = mainPolygon.getBounds();
        } else if (mainPolygon.center) {
            // Already has center (Circle)
        } else if (mainPolygon.getPath) {
            // Calculate center from path (Polygon)
            const path = mainPolygon.getPath();
            let latSum = 0, lngSum = 0, count = 0;
            path.forEach(point => {
                latSum += point.lat();
                lngSum += point.lng();
                count++;
            });
            if (count > 0) {
                mainPolygon.center = new google.maps.LatLng(latSum / count, lngSum / count);
            }
        }
        
        // Store all polygons
        polygons.forEach(p => zipCodePolygons.push(p));
        return mainPolygon;
        
    } catch (error) {
        console.error('Error creating boundary:', error);
        return null;
    }
}

// Highlight a specific zip code
function highlightZipCode(shape, record) {
    // Reset previous selection
    if (selectedPolygon && selectedPolygon.setOptions) {
        selectedPolygon.setOptions({
            strokeWeight: 2,
            strokeOpacity: 0.8,
            fillOpacity: 0.15,
            strokeColor: '#4285F4',
            zIndex: 1
        });
    }
    
    // Highlight new selection
    selectedPolygon = shape;
    if (shape.setOptions) {
        shape.setOptions({
            strokeWeight: 4,
            strokeOpacity: 1,
            fillOpacity: 0.3,
            strokeColor: '#FF0000',
            zIndex: 10
        });
    }
    
    // Zoom to the zip code
    let center = null;
    if (shape.bounds) {
        map.fitBounds(shape.bounds);
        center = shape.bounds.getCenter();
    } else if (shape.getBounds) {
        const bounds = shape.getBounds();
        map.fitBounds(bounds);
        center = bounds.getCenter();
    } else if (shape.center) {
        map.setCenter(shape.center);
        map.setZoom(13);
        center = shape.center;
    }
    
    // Show info window
    if (center) {
        // Handle null record case
        const infoContent = record 
            ? createInfoWindowContent(record)
            : `<div style="padding: 10px; min-width: 200px;"><h3>Location</h3><p>No census data available for this location.</p></div>`;
        
        const infoWindow = new google.maps.InfoWindow({
            content: infoContent,
            position: center
        });
        infoWindow.open(map);
    }

    // Update Zoned Schools panel when clicking a block group
    if (record && record.geoid) {
        updateZonedSchoolsPanelFromBlockGroup(record);
    }
}

// Clear all polygons
function clearPolygons() {
    zipCodePolygons.forEach(polygon => {
        if (polygon.setMap) {
            polygon.setMap(null);
        }
    });
    zipCodePolygons = [];
    clearSchoolDistrictPolygons();
    selectedPolygon = null;
}

// Clear school district overlay (NCES districts for current zip), perimeter lines, and zone labels
function clearSchoolDistrictPolygons() {
    schoolDistrictPolygons.forEach(polygon => {
        if (polygon && polygon.setMap) {
            polygon.setMap(null);
        }
    });
    schoolDistrictPolygons = [];
    schoolDistrictPolylines.forEach(line => {
        if (line && line.setMap) line.setMap(null);
    });
    schoolDistrictPolylines = [];
    schoolDistrictLabels.forEach(m => {
        if (m && m.setMap) m.setMap(null);
    });
    schoolDistrictLabels = [];
}

// Compute label position: centroid (mean of vertices) of polygon path.
// Placed on largest part per zone. Prefer centroid over bbox center for irregular shapes.
function pathCentroid(path) {
    if (!path || path.length === 0) return null;
    let latSum = 0, lngSum = 0;
    path.forEach(p => {
        latSum += p.lat();
        lngSum += p.lng();
    });
    const n = path.length;
    return new google.maps.LatLng(latSum / n, lngSum / n);
}

// Turn GeoJSON geometry (Polygon/MultiPolygon, WGS84 [lng,lat]) into Google Maps paths
// Accepts type 'Polygon' or 'polygon', 'MultiPolygon' or 'multipolygon', 'GeometryCollection'
function geometryToPaths(geometry) {
    if (!geometry) return [];
    const type = (geometry.type || '').toLowerCase();
    const paths = [];
    function addRing(ring) {
        if (!Array.isArray(ring) || ring.length < 3) return;
        const path = ring.map(coord => new google.maps.LatLng(coord[1], coord[0]));
        paths.push(path);
    }
    if (type === 'polygon' && geometry.coordinates) {
        const rings = geometry.coordinates;
        if (rings.length > 0) addRing(rings[0]);
    } else if (type === 'multipolygon' && geometry.coordinates) {
        geometry.coordinates.forEach(poly => {
            if (Array.isArray(poly) && poly.length > 0) addRing(poly[0]);
        });
    } else if (type === 'geometrycollection' && geometry.geometries) {
        geometry.geometries.forEach(g => paths.push(...geometryToPaths(g)));
    }
    return paths;
}

// Resolve which zip to use for school districts: current search zip, or single-record data zip
function getZipForSchoolDistricts() {
    const searchZip = document.getElementById('search-zip') && document.getElementById('search-zip').value.trim();
    if (currentZipCode) return currentZipCode;
    if (searchZip && /^\d{5}$/.test(searchZip)) return searchZip;
    if (currentData.length === 1 && currentData[0].zip_code) return currentData[0].zip_code;
    return null;
}

// Cached by-level data for current zip (so sub-toggle changes don't re-fetch)
let cachedSchoolZonesByLevel = null;
let cachedSchoolZonesZip = null;

// Toggle school districts layer: when checked, draw districts for current zip
function onSchoolDistrictsToggle() {
    const cb = document.getElementById('layer-school-districts');
    if (!cb) return;
    const sublayerDiv = document.getElementById('school-level-sublayers');
    if (sublayerDiv) sublayerDiv.style.display = cb.checked ? 'block' : 'none';
    if (cb.checked) {
        const zip = getZipForSchoolDistricts();
        if (!zip) {
            cb.checked = false;
            if (sublayerDiv) sublayerDiv.style.display = 'none';
            alert('Search for a zip code first (Search Zip or Search Address), then enable School Districts.');
            return;
        }
        loadAndDrawSchoolDistricts(zip);
    } else {
        clearSchoolDistrictPolygons();
        setSchoolDistrictsStatus('');
        cachedSchoolZonesByLevel = null;
        cachedSchoolZonesZip = null;
    }
}

function onSchoolLevelSublayerChange() {
    if (!cachedSchoolZonesByLevel || !cachedSchoolZonesZip) return;
    drawSchoolZonesByLevel(cachedSchoolZonesByLevel, cachedSchoolZonesZip);
}

function setSchoolDistrictsStatus(msg) {
    const el = document.getElementById('school-districts-status');
    if (el) el.textContent = msg || '';
}

// Load and draw school districts for a zip (by level: Elementary, Middle, High). NCES attendance zones, NC/SC.
async function loadAndDrawSchoolDistricts(zipCode) {
    clearSchoolDistrictPolygons();
    setSchoolDistrictsStatus('');
    if (!zipCode || !/^\d{5}$/.test(zipCode)) return;
    setSchoolDistrictsStatus('Loading attendance zones… (may take 1–2 min)');
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000);
        let response = await fetch(`${API_BASE_URL}/zips/${zipCode}/school-zones?by_level=1`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (response.status === 404) {
            setSchoolDistrictsStatus('Loading zip boundary…');
            await fetch(`${API_BASE_URL}/zip-boundary/${zipCode}`);
            const c2 = new AbortController();
            const t2 = setTimeout(() => c2.abort(), 300000);
            response = await fetch(`${API_BASE_URL}/zips/${zipCode}/school-zones?by_level=1`, { signal: c2.signal });
            clearTimeout(t2);
        }
        if (!response.ok) {
            let err = {};
            try {
                const text = await response.text();
                err = JSON.parse(text);
            } catch (_) { /* response may be HTML */ }
            const msg = err.message || err.error || response.statusText || `HTTP ${response.status}`;
            setSchoolDistrictsStatus(msg.includes('boundary') ? 'Zip boundary needed (search by zip first)' : msg);
            console.warn('School zones not available for zip', zipCode, msg);
            return;
        }
        let data;
        try {
            data = await response.json();
        } catch (parseErr) {
            setSchoolDistrictsStatus('Invalid response from server');
            console.warn('School zones: JSON parse failed', parseErr);
            return;
        }
        const byLevel = data.by_level && (data.elementary || data.middle || data.high);
        if (!byLevel) {
            const msg = data.message || 'No attendance zones for this zip (NC/SC only)';
            setSchoolDistrictsStatus(msg);
            return;
        }
        cachedSchoolZonesByLevel = {
            elementary: data.elementary || [],
            middle: data.middle || [],
            high: data.high || []
        };
        cachedSchoolZonesZip = zipCode;
        const total = (cachedSchoolZonesByLevel.elementary.length + cachedSchoolZonesByLevel.middle.length + cachedSchoolZonesByLevel.high.length);
        setSchoolDistrictsStatus(`Loaded ${total} school boundary(ies) — 1 polygon = 1 school (NCES 2015)`);
        try {
            drawSchoolZonesByLevel(cachedSchoolZonesByLevel, zipCode);
        } catch (drawErr) {
            setSchoolDistrictsStatus('Failed to draw: ' + (drawErr && drawErr.message || String(drawErr)));
            console.warn('drawSchoolZonesByLevel error:', drawErr);
        }
    } catch (e) {
        let msg = e && (e.message || String(e)) || 'Unknown error';
        if (e && e.name === 'AbortError') {
            msg = 'Request timed out (5 min) — try again or use a different zip';
        } else if (msg.includes('Failed to fetch') || msg.includes('Load failed') || msg.includes('NetworkError')) {
            msg = 'Server not reachable — is the app running? (python app.py)';
        }
        setSchoolDistrictsStatus('Failed to load zones: ' + msg);
        console.warn('Failed to load school zones:', e);
    }
}

function drawSchoolZonesByLevel(byLevel, zipCode) {
    clearSchoolDistrictPolygons();
    const showElem = document.getElementById('layer-school-elementary')?.checked ?? true;
    const showMid = document.getElementById('layer-school-middle')?.checked ?? true;
    const showHigh = document.getElementById('layer-school-high')?.checked ?? true;
    const levels = [];
    if (showElem) levels.push({ key: 'elementary', arr: byLevel.elementary || [], label: 'Elementary' });
    if (showMid) levels.push({ key: 'middle', arr: byLevel.middle || [], label: 'Middle' });
    if (showHigh) levels.push({ key: 'high', arr: byLevel.high || [], label: 'High' });
    const bounds = new google.maps.LatLngBounds();
    let drawnCount = 0;
    let activeSchoolZoneInfo = null;
    function showZonePopup(zoneData, anchorPosition) {
        if (activeSchoolZoneInfo) activeSchoolZoneInfo.close();
        const { z, zoneNum, label, hasMultipleParts } = zoneData;
        const district = z.district_name ? `District: ${z.district_name}` : '';
        const blendedLine = z.avg_rating != null
            ? `<br/><strong>Blended average: ${z.avg_rating}/10</strong> <span style="color:#666;font-size:0.9em;">(Great Schools)</span>`
            : '';
        const multiPartNote = hasMultipleParts ? '<br/><em style="color:#666;font-size:0.9em;">This school\'s boundary has multiple non-contiguous areas in this zip</em>' : '';
        const schools = z.schools || [];
        const schoolsList = schools.length > 0
            ? schools.map(s => `• ${(s.name || 'Unknown')}${s.rating != null ? ` — <strong>${s.rating}/10</strong> Great Schools` : ' — rating N/A'}`).join('<br/>')
            : '<em>No school data for this zone</em>';
        const content = `<div style="padding:12px;min-width:280px;max-width:340px;font-family:sans-serif;">
            <strong style="font-size:1.05em;">Attendance Zone #${zoneNum}</strong> <span style="color:#666;">(${label})</span><br/>
            ${district}${blendedLine}${multiPartNote}
            <br/><br/>
            <strong>Schools in this zone:</strong><br/>
            <div style="margin-top:6px;line-height:1.5;">${schoolsList}</div>
        </div>`;
        activeSchoolZoneInfo = new google.maps.InfoWindow({ content });
        activeSchoolZoneInfo.setPosition(anchorPosition);
        activeSchoolZoneInfo.open(map);
        activeSchoolZoneInfo.addListener('closeclick', () => { activeSchoolZoneInfo = null; });
        setTimeout(() => {
            if (activeSchoolZoneInfo) { activeSchoolZoneInfo.close(); activeSchoolZoneInfo = null; }
        }, 12000);
    }

    const ZONE_PALETTE = [
        '#2E7D32', '#1565C0', '#C62828', '#6A1B9A', '#E65100', '#00695C',
        '#283593', '#558B2F', '#AD1457', '#0277BD', '#EF6C00', '#37474F'
    ];
    levels.forEach(({ arr, label }) => {
        arr.forEach((z, zoneIdx) => {
            const zoneNum = zoneIdx + 1;
            const geometry = z.geometry;
            if (!geometry) return;
            const paths = geometryToPaths(geometry);
            const fillColor = ZONE_PALETTE[zoneIdx % ZONE_PALETTE.length];
            const hasMultipleParts = paths.length > 1;
            const zoneData = { z, zoneNum, label, hasMultipleParts };
            let labelPath = null;
            let maxPathLen = 0;
            paths.forEach((path, pathIdx) => {
                if (path.length < 3) return;
                path.forEach(ll => bounds.extend(ll));
                const polygon = new google.maps.Polygon({
                    paths: path,
                    map: map,
                    strokeColor: '#333333',
                    strokeOpacity: 1,
                    strokeWeight: 3,
                    fillColor: fillColor,
                    fillOpacity: 0.25,
                    clickable: true,
                    zIndex: 2
                });
                polygon.addListener('click', () => showZonePopup(zoneData, path[0]));
                schoolDistrictPolygons.push(polygon);
                const closedPath = path.concat([path[0]]);
                const perimeterLine = new google.maps.Polyline({
                    path: closedPath,
                    map: map,
                    strokeColor: fillColor,
                    strokeOpacity: 0.9,
                    strokeWeight: 2,
                    clickable: true,
                    cursor: 'pointer',
                    zIndex: 5
                });
                perimeterLine.addListener('click', () => showZonePopup(zoneData, path[0]));
                schoolDistrictPolylines.push(perimeterLine);
                if (path.length > maxPathLen) {
                    maxPathLen = path.length;
                    labelPath = path;
                }
                drawnCount++;
            });
            if (labelPath) {
                const center = pathCentroid(labelPath);
                if (center) {
                    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><circle cx="14" cy="14" r="12" fill="${fillColor}" fill-opacity="0.9" stroke="#1a1a1a" stroke-width="2.5"/><text x="14" y="18" text-anchor="middle" font-size="11" font-weight="bold" fill="#fff">${zoneNum}</text></svg>`;
                    const labelMarker = new google.maps.Marker({
                        position: center,
                        map: map,
                        icon: {
                            url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
                            scaledSize: new google.maps.Size(28, 28),
                            anchor: new google.maps.Point(14, 14)
                        },
                        zIndex: 7,
                        clickable: true,
                        cursor: 'pointer'
                    });
                    labelMarker.addListener('click', () => showZonePopup(zoneData, center));
                    schoolDistrictLabels.push(labelMarker);
                }
            }
        });
    });
    if (drawnCount > 0 && !bounds.isEmpty()) {
        map.fitBounds(bounds, { top: 60, right: 60, bottom: 60, left: 60 });
    }
    if (drawnCount === 0) {
        setSchoolDistrictsStatus('No levels selected — check Elementary, Middle, or High');
    } else {
        setSchoolDistrictsStatus(`Showing ${drawnCount} zone(s) — each boundary = one school. Red outer line = zip boundary.`);
    }
    console.log(`Drew ${drawnCount} school zone polygon(s) for zip ${zipCode}`);
}

// Clear all markers
function clearMarkers() {
    markers.forEach(marker => marker.setMap(null));
    markers = [];
    
    if (heatmapLayer) {
        heatmapLayer.setMap(null);
        heatmapLayer = null;
    }
}

// Update record count - Total Census Blocks matching search & filters (capMsg: if map capped, show "count (map: first N)")
function updateRecordCount(count, capMsg) {
    const el = document.getElementById('record-count');
    if (!el) return;
    el.textContent = capMsg != null ? `${count} (map shows first ${capMsg})` : String(count);
}

// Show/hide loading indicator
function showLoading(show) {
    // You can implement a loading spinner here
    const buttons = document.querySelectorAll('.btn');
    buttons.forEach(btn => {
        btn.disabled = show;
    });
}

// Run when DOM is ready (handles case where DOMContentLoaded already fired)
function runWhenReady() {
    if (!window.google || !window.google.maps) {
        const check = setInterval(() => {
            if (window.google && window.google.maps) {
                clearInterval(check);
                doInit();
            }
        }, 50);
        // Timeout after 15s so we don't hang forever
        setTimeout(() => {
            clearInterval(check);
            if (!window.google || !window.google.maps) {
                console.error('Google Maps API did not load. Check API key and network.');
                alert('Map failed to load: Google Maps API did not load. Check API key and network.');
            }
        }, 15000);
        return;
    }
    doInit();
}

function doInit() {
    initMap();
    // Layer toggles
    document.getElementById('layer-population').addEventListener('change', updateMap);
    document.getElementById('layer-income').addEventListener('change', updateMap);
    document.getElementById('layer-age').addEventListener('change', updateMap);
    document.getElementById('layer-employment').addEventListener('change', updateMap);
    document.getElementById('layer-boundaries').addEventListener('change', updateMap);
    const schoolDistrictsEl = document.getElementById('layer-school-districts');
    if (schoolDistrictsEl) schoolDistrictsEl.addEventListener('change', onSchoolDistrictsToggle);
    ['layer-school-elementary', 'layer-school-middle', 'layer-school-high'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', onSchoolLevelSublayerChange);
    });
    
    // Search by city
    document.getElementById('apply-filters-btn').addEventListener('click', applyDataLayerFilters);
    document.getElementById('clear-filters-btn').addEventListener('click', clearDataLayerFilters);
    document.getElementById('search-city-btn').addEventListener('click', searchByCity);
    document.getElementById('search-city').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            searchByCity();
        }
    });
    
    // Search and zoom to zip code
    document.getElementById('search-zoom-btn').addEventListener('click', searchAndZoom);
    document.getElementById('search-zip').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            searchAndZoom();
        }
    });
    
    // Search and zoom by address
    document.getElementById('search-address-btn').addEventListener('click', searchByAddress);
    document.getElementById('search-address').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            searchByAddress();
        }
    });
    
    // Fetch data from Census API
    document.getElementById('fetch-data').addEventListener('click', async () => {
        try {
            showLoading(true);
            const response = await fetch(`${API_BASE_URL}/census-data/fetch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            const result = await response.json();
            alert(`Fetched ${result.total_fetched} records. Added: ${result.added}, Updated: ${result.updated}`);
            loadCensusData();
        } catch (error) {
            console.error('Error fetching data:', error);
            alert('Error fetching census data. Please check console for details.');
        } finally {
            showLoading(false);
        }
    });
    
    // Export to Word/PDF Report
    document.getElementById('export-sheets').addEventListener('click', async () => {
        // Check if we have address information from a search
        if (!currentAddress || !currentLocation) {
            // Try to get from search address field
            const addressField = document.getElementById('search-address').value.trim();
            const zipField = document.getElementById('search-zip').value.trim();
            
            if (!addressField && !zipField) {
                alert('Please search for an address first using the "Search Address" field, then click "Go" to load the data.');
                return;
            }
            
            // If we have zip but no address, use zip as address
            if (!addressField && zipField) {
                currentAddress = zipField;
                currentZipCode = zipField;
                // Try to geocode to get location
                try {
                    const geocodeResult = await geocodeZipCodeFull(zipField);
                    if (geocodeResult) {
                        currentLocation = {
                            lat: geocodeResult.location.lat(),
                            lng: geocodeResult.location.lng()
                        };
                    } else {
                        alert('Could not geocode address. Please search for a full address first.');
                        return;
                    }
                } catch (e) {
                    alert('Could not geocode address. Please search for a full address first.');
                    return;
                }
            } else if (addressField) {
                currentAddress = addressField;
            }
        }
        
        // Ask user for format preference
        const format = confirm('Click OK for Word document (.docx)\nClick Cancel for PDF') ? 'docx' : 'pdf';
        
        // Build query parameters
        const params = new URLSearchParams();
        params.append('address', currentAddress);
        params.append('lat', currentLocation.lat);
        params.append('lng', currentLocation.lng);
        if (currentZipCode) {
            params.append('zip_code', currentZipCode);
        }
        params.append('format', format);
        
        // Show loading
        showLoading(true);
        
        try {
            // Directly navigate to the download URL - browser will handle the download
            const downloadUrl = `${API_BASE_URL}/export/report?${params}`;
            window.location.href = downloadUrl;
            
            // Wait a moment then hide loading
            setTimeout(() => {
                showLoading(false);
            }, 2000);
        } catch (error) {
            console.error('Export error:', error);
            alert('Error generating report. Please try again.');
            showLoading(false);
        }
    });

    // Export for LandVision: download current block groups as shapefile ZIP (census block number, location, borders)
    document.getElementById('export-landvision').addEventListener('click', async () => {
        const f = currentFilters || {};
        const hasGeo = !!(f.city || f.zip_code || (f.lat != null && f.lng != null));
        if (!hasGeo) {
            alert('Search by city, zip, or address first. Then apply any filters and click "Export for LandVision".');
            return;
        }
        const params = new URLSearchParams();
        params.append('format', 'shapefile');
        if (f.zip_code) params.append('zip_code', f.zip_code);
        if (f.city) params.append('city', f.city);
        if (f.state) params.append('state', f.state);
        if (f.lat != null) params.append('lat', f.lat);
        if (f.lng != null) params.append('lng', f.lng);
        if (f.min_income) params.append('min_income', f.min_income);
        if (f.max_income) params.append('max_income', f.max_income);
        if (f.min_population) params.append('min_population', f.min_population);
        if (f.max_population) params.append('max_population', f.max_population);
        if (f.min_age != null && f.min_age !== '') params.append('min_age', f.min_age);
        if (f.max_age != null && f.max_age !== '') params.append('max_age', f.max_age);
        if (f.min_zoned_elementary_school_rating != null && !Number.isNaN(Number(f.min_zoned_elementary_school_rating))) params.append('min_zoned_elementary_school_rating', f.min_zoned_elementary_school_rating);
        if (f.min_zoned_blended_school_rating != null && !Number.isNaN(Number(f.min_zoned_blended_school_rating))) params.append('min_zoned_blended_school_rating', f.min_zoned_blended_school_rating);
        if (f.min_local_employment_score != null && !Number.isNaN(Number(f.min_local_employment_score))) params.append('min_local_employment_score', f.min_local_employment_score);
        if (f.min_employment_access_score != null && !Number.isNaN(Number(f.min_employment_access_score))) params.append('min_employment_access_score', f.min_employment_access_score);
        params.append('limit', '10000');
        const base = window.location.origin;
        const exportPath = '/api/census-block-groups';
        const url = `${base}${exportPath}?${params.toString()}`;
        console.log('[Export] Requesting:', url);
        try {
            const response = await fetch(url, { method: 'GET' });
            if (!response.ok) {
                const text = await response.text();
                let msg = `Server returned ${response.status} (${response.statusText}).`;
                try {
                    const j = JSON.parse(text);
                    if (j.error) msg += ' ' + j.error;
                } catch (_) { if (text) msg += ' ' + text.slice(0, 200); }
                msg += '\n\nTrying direct download - check address bar for requested URL.';
                alert('Export failed: ' + msg);
                window.open(url, '_blank');
                return;
            }
            const blob = await response.blob();
            const disp = response.headers.get('Content-Disposition');
            const m = disp && disp.match(/filename="?([^";\n]+)"?/);
            const filename = m ? m[1] : `block_groups_landvision_${new Date().toISOString().slice(0,10)}.zip`;
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
            URL.revokeObjectURL(a.href);
        } catch (err) {
            alert('Export failed: ' + (err.message || err) + '\n\nOpening URL in new tab so you can see the exact address.');
            window.open(url, '_blank');
        }
    });
    
    // Refresh map
    document.getElementById('refresh-map').addEventListener('click', () => {
        loadCensusData();
    });
}

// Start: run when DOM is ready (DOMContentLoaded may have already fired if script is at end of body)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runWhenReady);
} else {
    runWhenReady();
}

// Parse "Wilmington NC" or "Wilmington, NC" into { city, state }
function parseCityState(input) {
    const s = (input || '').trim();
    if (!s) return { city: '', state: null };
    // Match trailing ", XX" or " XX" where XX is 2-letter state code
    const match = s.match(/^(.+?)(?:,?\s+([A-Za-z]{2}))\s*$/);
    if (match) {
        return { city: match[1].trim(), state: match[2].toUpperCase() };
    }
    return { city: s, state: null };
}

// Search by city (and optional state, e.g. "Wilmington NC")
async function searchByCity() {
    const cityInput = document.getElementById('search-city');
    const raw = cityInput && cityInput.value.trim();
    
    if (!raw) {
        alert('Please enter a city name (e.g. Charlotte or Wilmington NC)');
        return;
    }

    const { city, state } = parseCityState(raw);
    
    try {
        showLoading(true);
        currentZipCode = null;
        currentCensusRecord = null;
        currentAddress = null;
        currentLocation = null;
        updateLegend();
        // Clear zip and address fields
        const zipEl = document.getElementById('search-zip');
        const addrEl = document.getElementById('search-address');
        if (zipEl) zipEl.value = '';
        if (addrEl) addrEl.value = '';
        // Auto-enable zip boundaries
        const boundariesCb = document.getElementById('layer-boundaries');
        if (boundariesCb) boundariesCb.checked = true;

        const filters = { city };
        if (state) filters.state = state;
        await loadCensusData(filters);

        // Zoom to city using geocode
        const geocodeAddr = state ? `${city}, ${state}, USA` : `${city}, USA`;
        const geocoder = new google.maps.Geocoder();
        const geocodeResult = await new Promise((resolve) => {
            geocoder.geocode(
                { address: geocodeAddr, componentRestrictions: { country: 'US' } },
                (results, status) => {
                    if (status === 'OK' && results && results.length > 0) resolve(results[0]);
                    else resolve(null);
                }
            );
        });
        if (geocodeResult) {
            const loc = geocodeResult.geometry.location;
            const vp = geocodeResult.geometry.viewport;
            const b = geocodeResult.geometry.bounds;
            if (b) map.fitBounds(b, { top: 80, right: 80, bottom: 80, left: 80 });
            else if (vp) map.fitBounds(vp, { top: 80, right: 80, bottom: 80, left: 80 });
            else { map.setCenter(loc); map.setZoom(11); }
        }
    } catch (error) {
        console.error('Error searching by city:', error);
        alert('Error searching by city. Please try again.');
    } finally {
        showLoading(false);
    }
}

// Search and zoom to specific zip code
async function searchAndZoom() {
    const zipCode = document.getElementById('search-zip').value.trim();
    
    if (!zipCode) {
        alert('Please enter a zip code');
        return;
    }
    
    // Validate zip code format (5 digits)
    if (!/^\d{5}$/.test(zipCode)) {
        alert('Please enter a valid 5-digit zip code');
        return;
    }
    
    try {
        showLoading(true);
        // Clear city field - zip/address search is separate from Search by City
        const cityEl = document.getElementById('search-city');
        if (cityEl) cityEl.value = '';
        
        // First, try to geocode the zip code (this works even if not in database)
        let geocodeResult = await geocodeZipCodeFull(zipCode);
        
        if (!geocodeResult) {
            // Try one more time with a different approach - use component restrictions
            const geocoder = new google.maps.Geocoder();
            const finalAttempt = await new Promise((resolve) => {
                geocoder.geocode(
                    { 
                        address: zipCode,
                        componentRestrictions: { country: 'US' }
                    }, 
                    (results, status) => {
                        console.log('Geocoding attempt with component restrictions:', status, results);
                        if (status === 'OK' && results && results.length > 0) {
                            resolve({
                                location: results[0].geometry.location,
                                bounds: results[0].geometry.bounds,
                                viewport: results[0].geometry.viewport
                            });
                        } else {
                            // Try with "ZCTA5" prefix (Census format)
                            geocoder.geocode(
                                { address: `ZCTA5 ${zipCode}` },
                                (results2, status2) => {
                                    console.log('Geocoding attempt with ZCTA5:', status2, results2);
                                    if (status2 === 'OK' && results2 && results2.length > 0) {
                                        resolve({
                                            location: results2[0].geometry.location,
                                            bounds: results2[0].geometry.bounds,
                                            viewport: results2[0].geometry.viewport
                                        });
                                    } else {
                                        console.error('Geocoding failed. Status:', status2 || status);
                                        resolve(null);
                                    }
                                }
                            );
                        }
                    }
                );
            });
            
            if (!finalAttempt) {
                // Try backend geocoding endpoint as fallback
                try {
                    const backendResponse = await fetch(`${API_BASE_URL}/geocode-zip/${zipCode}`);
                    const backendResult = await backendResponse.json();
                    
                    if (backendResult.success) {
                        geocodeResult = {
                            location: new google.maps.LatLng(
                                backendResult.location.lat,
                                backendResult.location.lng
                            ),
                            bounds: backendResult.bounds ? new google.maps.LatLngBounds(
                                new google.maps.LatLng(backendResult.bounds.southwest.lat, backendResult.bounds.southwest.lng),
                                new google.maps.LatLng(backendResult.bounds.northeast.lat, backendResult.bounds.northeast.lng)
                            ) : null,
                            viewport: backendResult.viewport ? new google.maps.LatLngBounds(
                                new google.maps.LatLng(backendResult.viewport.southwest.lat, backendResult.viewport.southwest.lng),
                                new google.maps.LatLng(backendResult.viewport.northeast.lat, backendResult.viewport.northeast.lng)
                            ) : null
                        };
                    } else {
                        throw new Error(backendResult.error || 'Backend geocoding failed');
                    }
                } catch (backendError) {
                    console.error('Backend geocoding error:', backendError);
                    // Last resort: show helpful error message
                    const errorMsg = `Could not geocode zip code ${zipCode}.\n\n` +
                        `Possible reasons:\n` +
                        `1. Geocoding API may not be enabled in Google Cloud Console\n` +
                        `2. Zip code format issue\n` +
                        `3. API quota exceeded\n\n` +
                        `Please check:\n` +
                        `- Google Cloud Console → APIs & Services → Enable "Geocoding API"\n` +
                        `- Verify zip code ${zipCode} is correct`;
                    
                    alert(errorMsg);
                    showLoading(false);
                    return;
                }
            } else {
                geocodeResult = finalAttempt;
            }
            
            // Use the final attempt result
            geocodeResult = finalAttempt;
        }
        
        const { location, bounds, viewport } = geocodeResult;
        
        // Store current address and location for export
        currentAddress = zipCode;  // Use zip code as address if no full address
        currentLocation = { lat: location.lat(), lng: location.lng() };
        currentZipCode = zipCode;
        
        // Load block groups at this zip (geocoded point-in-polygon)
        await loadCensusData({ zip_code: zipCode });
        
        // Zoom to the location
        if (bounds) {
            map.fitBounds(bounds);
        } else if (viewport) {
            map.fitBounds(viewport);
        } else {
            map.setCenter(location);
            map.setZoom(13);
        }
        
        const hasBlockGroups = currentData.length > 0 && currentData[0].geoid;
        let record = null;
        if (hasBlockGroups) {
            currentCensusRecord = currentData[0];
        } else {
            try {
                const response = await fetch(`${API_BASE_URL}/census-data/zip/${zipCode}`);
                if (response.ok) record = await response.json();
            } catch (e) { /* zip not in DB */ }
            currentCensusRecord = record;
        }
        updateLegend();

        // Create or highlight the polygon (block groups already drawn by updateMap)
        let polygon = hasBlockGroups
            ? (zipCodePolygons.find(p => p.geoid === currentData[0].geoid) || zipCodePolygons[0])
            : zipCodePolygons.find(p => p.zipCode === zipCode);
        
        if (!polygon && !hasBlockGroups) {
            if (record) {
                polygon = await createZipCodeBoundary(zipCode, record, currentLayer);
            } else {
                const tempRecord = { zip_code: zipCode, population: 0, average_household_income: 0, median_age: 0 };
                polygon = await createZipCodeBoundary(zipCode, tempRecord, 'population');
            }
        }
        
        if (polygon) {
            highlightZipCode(polygon, hasBlockGroups ? currentData[0] : record);
        }
        if (document.getElementById('layer-school-districts') && document.getElementById('layer-school-districts').checked) {
            loadAndDrawSchoolDistricts(zipCode);
        }
        if (!polygon) {
            // Create a temporary highlight circle
            const circle = new google.maps.Circle({
                center: location,
                radius: 2000,
                map: map,
                strokeColor: '#FF0000',
                strokeOpacity: 1,
                strokeWeight: 4,
                fillColor: '#FF0000',
                fillOpacity: 0.2,
                zIndex: 10
            });
            
            // Show info window
            const infoContent = record 
                ? createInfoWindowContent(record)
                : `<div style="padding: 10px;"><h3>Zip Code: ${zipCode}</h3><p>No census data available in database.</p></div>`;
            
            const infoWindow = new google.maps.InfoWindow({
                content: infoContent,
                position: location
            });
            infoWindow.open(map);
            
            // Store reference to remove later
            circle.infoWindow = infoWindow;
            
            // Remove after 10 seconds
            setTimeout(() => {
                circle.setMap(null);
                if (circle.infoWindow) {
                    circle.infoWindow.close();
                }
            }, 10000);
        }
        
    } catch (error) {
        console.error('Error searching zip code:', error);
        alert('Error searching for zip code. Please try again.');
    } finally {
        showLoading(false);
    }
}

// Search by address - geocodes address, finds zip code, then zooms
async function searchByAddress() {
    const address = document.getElementById('search-address').value.trim();
    
    if (!address) {
        alert('Please enter an address');
        return;
    }
    
    try {
        showLoading(true);
        // Clear city field - zip/address search is separate from Search by City
        const cityEl = document.getElementById('search-city');
        if (cityEl) cityEl.value = '';
        
        // Geocode the address
        const geocoder = new google.maps.Geocoder();
        const geocodeResult = await new Promise((resolve, reject) => {
            geocoder.geocode(
                { 
                    address: address,
                    componentRestrictions: { country: 'US' }
                },
                (results, status) => {
                    if (status === 'OK' && results && results.length > 0) {
                        resolve(results[0]);
                    } else {
                        reject(new Error(`Geocoding failed: ${status}`));
                    }
                }
            );
        });
        
        const location = geocodeResult.geometry.location;
        const bounds = geocodeResult.geometry.bounds;
        const viewport = geocodeResult.geometry.viewport;
        
        // Extract zip code from address components
        let zipCode = null;
        for (const component of geocodeResult.address_components) {
            if (component.types.includes('postal_code')) {
                zipCode = component.long_name;
                break;
            }
        }
        
        if (!zipCode) {
            // Try to extract from formatted address
            const formattedAddress = geocodeResult.formatted_address;
            const zipMatch = formattedAddress.match(/\b(\d{5})(?:-\d{4})?\b/);
            if (zipMatch) {
                zipCode = zipMatch[1];
            }
        }
        
        if (!zipCode) {
            alert('Could not find zip code for this address. Showing location on map.');
            // Still zoom to location even without zip code
            if (bounds) {
                map.fitBounds(bounds);
            } else if (viewport) {
                map.fitBounds(viewport);
            } else {
                map.setCenter(location);
                map.setZoom(15);
            }
            
            // Add a marker at the location
            const marker = new google.maps.Marker({
                position: location,
                map: map,
                title: address
            });
            
            const infoWindow = new google.maps.InfoWindow({
                content: `<div style="padding: 10px;"><h3>${address}</h3><p>No zip code found for this address.</p></div>`
            });
            infoWindow.open(map, marker);
            
            showLoading(false);
            return;
        }
        
        // Update the zip code search field so export works
        document.getElementById('search-zip').value = zipCode;
        
        // Store current address and location for export
        currentAddress = address;
        currentLocation = { lat: location.lat(), lng: location.lng() };
        currentZipCode = zipCode;
        
        // Load block groups containing this address (point-in-polygon)
        await loadCensusData({ lat: location.lat(), lng: location.lng() });
        
        // Zoom to the location
        if (bounds) {
            map.fitBounds(bounds);
        } else if (viewport) {
            map.fitBounds(viewport);
        } else {
            map.setCenter(location);
            map.setZoom(15);
        }
        
        const hasBlockGroupsAddr = currentData.length > 0 && currentData[0].geoid;
        let record = null;
        if (hasBlockGroupsAddr) {
            currentCensusRecord = currentData[0];
        } else {
            try {
                const response = await fetch(`${API_BASE_URL}/census-data/zip/${zipCode}`);
                if (response.ok) record = await response.json();
            } catch (e) { /* zip not in DB */ }
            currentCensusRecord = record;
        }
        updateLegend();

        // Ensure boundaries checkbox is checked so boundary is visible
        const boundariesCheckbox = document.getElementById('layer-boundaries');
        if (!boundariesCheckbox.checked) {
            boundariesCheckbox.checked = true;
        }
        
        let polygon = hasBlockGroupsAddr
            ? (zipCodePolygons.find(p => p.geoid === currentData[0].geoid) || zipCodePolygons[0])
            : zipCodePolygons.find(p => p.zipCode === zipCode);
        
        if (!polygon && !hasBlockGroupsAddr) {
            const layerToUse = currentLayer || (record ? 'population' : 'population');
            if (record) {
                polygon = await createZipCodeBoundary(zipCode, record, layerToUse);
            } else {
                const tempRecord = { zip_code: zipCode, population: 0, average_household_income: 0, median_age: 0 };
                polygon = await createZipCodeBoundary(zipCode, tempRecord, 'population');
            }
        }
        
        if (polygon) {
            if (polygon.setMap && !polygon.getMap()) {
                polygon.setMap(map);
            }
            highlightZipCode(polygon, hasBlockGroupsAddr ? currentData[0] : record);
        } else {
            // Add a marker at the location
            const marker = new google.maps.Marker({
                position: location,
                map: map,
                title: `${address} (Zip: ${zipCode})`
            });
            
            // Show info window
            const infoContent = record 
                ? createInfoWindowContent(record)
                : `<div style="padding: 10px;"><h3>Address: ${address}</h3><p>Zip Code: ${zipCode}</p><p>No census data available in database.</p></div>`;
            
            const infoWindow = new google.maps.InfoWindow({
                content: infoContent,
                position: location
            });
            infoWindow.open(map, marker);
        }
        if (document.getElementById('layer-school-districts') && document.getElementById('layer-school-districts').checked) {
            loadAndDrawSchoolDistricts(zipCode);
        }
        
        // Zoned Schools panel: use block group data when available (same as city/state search)
        if (hasBlockGroupsAddr && currentData[0]) {
            updateZonedSchoolsPanelFromBlockGroup(currentData[0]);
        } else {
            await fetchAndDisplaySchoolScores(address, location.lat(), location.lng());
        }
        
    } catch (error) {
        console.error('Error searching address:', error);
        alert(`Error searching for address: ${error.message}\n\nPlease check:\n- Address format is correct\n- Geocoding API is enabled in Google Cloud Console`);
    } finally {
        showLoading(false);
    }
}

// Update Zoned Schools panel from block group record (zoned school names/ratings from API)
function updateZonedSchoolsPanelFromBlockGroup(record) {
    const section = document.getElementById('school-scores-section');
    const subtitle = document.getElementById('school-scores-subtitle');
    if (!section || !subtitle) return;
    section.style.display = 'block';
    subtitle.textContent = `Block Group ${record.geoid} — Zoned schools (NC/SC)`;
    const fmt = (v) => (v != null && typeof v === 'number') ? v.toFixed(1) : 'N/A';
    const re = record.zoned_elementary_school_rating;
    const rm = record.zoned_middle_school_rating;
    const rh = record.zoned_high_school_rating;
    const ratings = [re, rm, rh].filter(x => x != null && typeof x === 'number');
    const blended = ratings.length > 0 ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : 'N/A';
    document.getElementById('elementary-score').textContent = fmt(re);
    document.getElementById('elementary-name').textContent = (record.zoned_elementary_school_name || '').trim() || 'N/A';
    document.getElementById('middle-score').textContent = fmt(rm);
    document.getElementById('middle-name').textContent = (record.zoned_middle_school_name || '').trim() || 'N/A';
    document.getElementById('high-score').textContent = fmt(rh);
    document.getElementById('high-name').textContent = (record.zoned_high_school_name || '').trim() || 'N/A';
    document.getElementById('blended-score').textContent = blended;
}

// Fetch and display school scores for an address
async function fetchAndDisplaySchoolScores(address, lat, lng) {
    try {
        // Show loading state
        const schoolSection = document.getElementById('school-scores-section');
        schoolSection.style.display = 'block';
        document.getElementById('elementary-score').textContent = 'Loading...';
        document.getElementById('middle-score').textContent = 'Loading...';
        document.getElementById('high-score').textContent = 'Loading...';
        document.getElementById('blended-score').textContent = 'Loading...';
        
        console.log(`Fetching school data for: ${address} (${lat}, ${lng})`);
        
        // Fetch school data from backend (fast database lookup - instant!)
        const response = await fetch(`${API_BASE_URL}/schools/address?address=${encodeURIComponent(address)}&lat=${lat}&lng=${lng}`, {
            timeout: 10000 // 10 second timeout (should be instant, but just in case)
        });
        
        console.log(`Response status: ${response.status}`);
        
        const schoolData = await response.json();
        console.log('School data received:', schoolData);
        
        if (!response.ok) {
            // Check if it's an error response
            if (schoolData.error) {
                console.error('API Error:', schoolData.error, schoolData.message);
                // Still show the data even if there's an error (might have partial data)
                if (schoolData.elementary_school_rating === undefined && schoolData.middle_school_rating === undefined) {
                    throw new Error(schoolData.message || schoolData.error);
                }
            } else {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
        }
        
        // Display school scores – show zoned school names even when rating is N/A
        const isZoned = schoolData.school_source === 'zoned';
        const reason = schoolData.fallback_reason || '';
        const subtitleEl = document.getElementById('school-scores-subtitle');
        if (subtitleEl) {
            if (isZoned) {
                subtitleEl.textContent = 'Address-based attendance zones (NC/SC)';
            } else if (reason === 'no_zones_loaded') {
                subtitleEl.textContent = 'Nearest schools — no zone data loaded in database.';
            } else if (reason === 'point_not_in_any_zone') {
                subtitleEl.textContent = 'Nearest schools — address outside known zones (try NC/SC, or area may be uncovered).';
            } else {
                subtitleEl.textContent = 'Nearest schools (zoned data not available for this area).';
            }
        }
        const elemName = schoolData.elementary_school_name || (isZoned ? '' : 'No data available');
        const midName = schoolData.middle_school_name || (isZoned ? '' : 'No data available');
        const highName = schoolData.high_school_name || (isZoned ? '' : 'No data available');

        document.getElementById('elementary-score').textContent = (schoolData.elementary_school_rating != null) ? schoolData.elementary_school_rating.toFixed(1) : 'N/A';
        document.getElementById('elementary-name').textContent = elemName || 'No zoned school';
        document.getElementById('middle-score').textContent = (schoolData.middle_school_rating != null) ? schoolData.middle_school_rating.toFixed(1) : 'N/A';
        document.getElementById('middle-name').textContent = midName || 'No zoned school';
        document.getElementById('high-score').textContent = (schoolData.high_school_rating != null) ? schoolData.high_school_rating.toFixed(1) : 'N/A';
        document.getElementById('high-name').textContent = highName || 'No zoned school';
        
        if (schoolData.blended_school_score !== null && schoolData.blended_school_score !== undefined) {
            document.getElementById('blended-score').textContent = schoolData.blended_school_score.toFixed(1);
        } else {
            document.getElementById('blended-score').textContent = 'N/A';
        }
        
    } catch (error) {
        console.error('Error fetching school scores:', error);
        // Show error state
        document.getElementById('elementary-score').textContent = 'Error';
        document.getElementById('middle-score').textContent = 'Error';
        document.getElementById('high-score').textContent = 'Error';
        document.getElementById('blended-score').textContent = 'Error';
        
        // Still show the section so user knows we tried
        document.getElementById('school-scores-section').style.display = 'block';
    }
}