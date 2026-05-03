// =============================================================================
// Transportunity Costs — Visualization Script
// CMSC 471 Final Project, Group 14
// =============================================================================
//
// ── FILES USED ───────────────────────────────────────────────────────────────
//
//  DC (both required — already in data/):
//    ACS_5-Year_Demographic_Characteristics_of_DC_Census_Tracts.geojson
//      206 census-tract Polygons with embedded DP05 demographic columns.
//      Key columns decoded by dp05ToDemog():
//        DP05_0001E  = Total population
//        DP05_0082E  = White alone, not Hispanic or Latino
//        DP05_0024E  = 65 years and over
//        INTPTLAT / INTPTLON = Census-computed centroid
//
//    Metro_Stations_Regional.geojson
//      98 Point features.  Properties used: NAME, LINE (e.g. "green, yellow").
//
//  NYC (stations already in data/; tracts optional):
//    MTA_Subway_Stations_20260427.geojson
//      496 Point features.  Properties used: stop_name, borough (M/Bk/Bx/Q/SI).
//
//    nyc_census_tracts.geojson  ← OPTIONAL, generate with data/prepare_nyc.py
//      Same schema as the DC ACS file above (DP05_0001E, DP05_0082E, etc.).
//      When present: enables a neighborhood-level choropleth for NYC and a
//      proper minority/non-minority distance comparison chart.
//      When absent: falls back to borough-centroid data hardcoded from the xlsx.
//
// ── HOW DISTANCE IS COMPUTED ─────────────────────────────────────────────────
//   nearestKm(lat, lng, stationArray) uses the Haversine formula to find the
//   distance in km from a census-tract (or borough) centroid to the closest
//   transit station.  Results are stored in each demog row as _nearestKm and
//   drive the bar charts.
//
// =============================================================================

(function () {
    "use strict";

    // =========================================================================
    // 1. CONFIGURATION
    // =========================================================================

    const CFG = {
        nyc: {
            mapId:      "nyc-map",
            chartId:    "nyc-chart",
            legendId:   "nyc-map-legend",
            loadingMap: "nyc-map-loading",
            loadingCh:  "nyc-chart-loading",
            stationFile:"data/MTA_Subway_Stations_20260427.geojson",
            tractsFile: "data/nyc_census_tracts.geojson",   // optional
            center:     [-73.98, 40.67],
            scale:      46000,
            label:      "New York City",
            accentColor:"#4f9cf9",
        },
        dc: {
            mapId:      "dc-map",
            chartId:    "dc-chart",
            legendId:   "dc-map-legend",
            loadingMap: "dc-map-loading",
            loadingCh:  "dc-chart-loading",
            acsFile:    "data/ACS_5-Year_Demographic_Characteristics_of_DC_Census_Tracts.geojson",
            stationFile:"data/Metro_Stations_Regional.geojson",
            center:     [-77.01, 38.90],
            scale:      90000,
            label:      "Washington, D.C.",
            accentColor:"#f97316",
        },
    };

    // Borough-level demographics derived from data/demo_2016acs5yr_nyc.xlsx
    // Used as a fallback when nyc_census_tracts.geojson is not available.
    // white_pct = "White alone, not Hispanic or Latino" (row 90 in xlsx)
    // Centroids are the official NYC borough centroids.
    const NYC_BOROUGHS = {
        M:  { name:"Manhattan",    minority_pct:0.529, senior_pct:0.144, total_pop:1634989, lat:40.7831, lng:-73.9712 },
        Bk: { name:"Brooklyn",     minority_pct:0.642, senior_pct:0.122, total_pop:2606852, lat:40.6501, lng:-73.9496 },
        Bx: { name:"Bronx",        minority_pct:0.904, senior_pct:0.113, total_pop:1436785, lat:40.8448, lng:-73.8648 },
        Q:  { name:"Queens",       minority_pct:0.744, senior_pct:0.137, total_pop:2310011, lat:40.7282, lng:-73.7949 },
        SI: { name:"Staten Island",minority_pct:0.374, senior_pct:0.145, total_pop: 473324, lat:40.5795, lng:-74.1502 },
    };

    // Official WMATA line hex colors
    const WMATA = {
        red:"#BF0000", orange:"#ED8B00", silver:"#919D9D",
        blue:"#0076A5", yellow:"#FFD100", green:"#00B140",
    };

    // Fallback transit stroke colors by mode
    const TSTROKE = {
        subway:"#ffe066", bus:"#66d9e8", metro:"#b399f5", rail:"#88e0b0", default:"#99a0b8",
    };

    // =========================================================================
    // 2. SCALES
    // =========================================================================

    // Vulnerability index weights (minority, poverty, senior)
    const VW = { minority:0.40, poverty:0.35, senior:0.25 };
    function vulnIdx(d) {
        return VW.minority * (+d.minority_pct || 0)
             + VW.poverty  * (+d.poverty_pct  || 0)
             + VW.senior   * (+d.senior_pct   || 0);
    }

    // Sequential yellow→orange→red choropleth scale.
    // Domain is computed dynamically from actual data values in buildMap()
    // so DC's majority-minority tracts spread across the full colour range.

    // =========================================================================
    // 3. UTILITIES
    // =========================================================================

    function toRad(d) { return d * Math.PI / 180; }

    function haversineKm(lat1, lng1, lat2, lng2) {
        const R = 6371;
        const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat/2)**2
                + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // Finds the closest station in stationPts [{lat,lng}] to the given point.
    function nearestKm(lat, lng, stationPts) {
        if (!stationPts.length || isNaN(lat) || isNaN(lng)) return null;
        let min = Infinity;
        for (const s of stationPts) {
            const d = haversineKm(lat, lng, s.lat, s.lng);
            if (d < min) min = d;
        }
        return min;
    }

    // Converts WMATA LINE string (may be "green, yellow") to a single hex color.
    function wmataColor(line) {
        if (!line) return WMATA.blue;
        const first = line.split(",")[0].trim().toLowerCase();
        return WMATA[first] || WMATA.blue;
    }

    // Tooltip
    const tooltip = d3.select("#tooltip");
    function showTip(ev, html) {
        tooltip.style("display","block").html(html)
               .style("left", (ev.clientX + 15) + "px")
               .style("top",  (ev.clientY - 12) + "px");
    }
    function hideTip() { tooltip.style("display","none"); }

    const fmtPct    = d3.format(".1%");
    const fmtKm     = d3.format(".2f");
    const fmtIncome = d3.format("$,.0f");
    const fmtPop    = n => (+n).toLocaleString();

    // =========================================================================
    // 4. DP05 → DEMOG OBJECT
    // =========================================================================
    //
    // Maps the raw ACS DP05 GeoJSON properties (from both the DC ACS file and
    // the optional nyc_census_tracts.geojson) into our standard demog shape.
    // Column meanings verified against 2019 ACS DP05 variable definitions:
    //   DP05_0001E = SEX AND AGE — Total population
    //   DP05_0024E = SEX AND AGE — 65 years and over
    //   DP05_0082E = HISPANIC OR LATINO AND RACE — Not Hispanic or Latino — White alone
    //                (i.e. White alone, not Hispanic or Latino — the standard
    //                 "non-Hispanic white" metric used in equity research)

    function dp05ToDemog(p) {
        const total    = +(p.DP05_0001E) || 0;
        const whitePop = +(p.DP05_0082E) || 0;  // White alone, not Hispanic
        const senior   = +(p.DP05_0024E) || 0;  // 65 years and over
        return {
            geoid:         String(p.GEOID || ""),
            name:          p.NAMELSAD || p.NAME || "",
            total_pop:     total,
            white_pct:     total > 0 ? whitePop / total : 0,
            minority_pct:  total > 0 ? (total - whitePop) / total : 0,
            poverty_pct:   0,   // not in DP05; DP03 Economic Characteristics would have it
            senior_pct:    total > 0 ? senior / total : 0,
            median_income: 0,   // not in DP05
            lat:           +(p.INTPTLAT) || 0,
            lng:           +(p.INTPTLON) || 0,
            _nearestKm:    null,
        };
    }

    // =========================================================================
    // 5. DATA LOADING — DC
    // =========================================================================

    async function loadDC() {
        const [acsGeo, stationGeo] = await Promise.all([
            d3.json(CFG.dc.acsFile),
            d3.json(CFG.dc.stationFile),
        ]);

        // Tag census-tract Polygon features as "neighborhood" and embed demog.
        // The join between geography and demographics is trivial here because
        // the ACS GeoJSON already contains DP05 columns on each feature.
        const neighborhoods = acsGeo.features.map(f => ({
            ...f,
            properties: {
                ...f.properties,
                type:  "neighborhood",
                id:    f.properties.GEOID,
                name:  f.properties.NAMELSAD,
                demog: dp05ToDemog(f.properties),
            },
        }));

        // Tag metro station Point features.
        const stations = stationGeo.features.map(f => ({
            ...f,
            properties: {
                ...f.properties,
                type:         "station",
                transit_type: "metro",
                name:         f.properties.NAME,
                line_color:   wmataColor(f.properties.LINE),
            },
        }));

        return {
            geoFeatures: [...neighborhoods, ...stations],
            demogRows:   neighborhoods.map(f => f.properties.demog),
        };
    }

    // =========================================================================
    // 6. DATA LOADING — NYC
    // =========================================================================

    async function loadNYC() {
        // Subway stations are always required.
        const stationGeo = await d3.json(CFG.nyc.stationFile);

        const stations = stationGeo.features.map(f => ({
            ...f,
            properties: {
                ...f.properties,
                type:         "station",
                transit_type: "subway",
                name:         f.properties.stop_name,
                line_color:   null,
            },
        }));

        // Attempt to load the optional census-tract GeoJSON (same DP05 schema
        // as the DC ACS file).  Generate it with data/prepare_nyc.py.
        let neighborhoods = [];
        let hasTractData  = false;
        try {
            const nycACS = await d3.json(CFG.nyc.tractsFile);
            neighborhoods = nycACS.features.map(f => ({
                ...f,
                properties: {
                    ...f.properties,
                    type:  "neighborhood",
                    id:    f.properties.GEOID,
                    name:  f.properties.NAMELSAD || f.properties.NAME,
                    demog: dp05ToDemog(f.properties),
                },
            }));
            hasTractData = neighborhoods.length > 0;
            console.info(`[NYC] Loaded ${neighborhoods.length} census tract features.`);
        } catch {
            console.info("[NYC] nyc_census_tracts.geojson not found — " +
                         "run data/prepare_nyc.py to enable the full choropleth. " +
                         "Using borough-centroid fallback.");
        }

        // If no tract file: build 5 borough rows from the hardcoded xlsx values.
        const demogRows = hasTractData
            ? neighborhoods.map(f => f.properties.demog)
            : Object.entries(NYC_BOROUGHS).map(([code, b]) => ({
                geoid:        code,
                name:         b.name,
                total_pop:    b.total_pop,
                white_pct:    1 - b.minority_pct,
                minority_pct: b.minority_pct,
                poverty_pct:  0,
                senior_pct:   b.senior_pct,
                median_income:0,
                lat:          b.lat,
                lng:          b.lng,
                _nearestKm:   null,
            }));

        return {
            geoFeatures:  [...neighborhoods, ...stations],
            demogRows,
            hasTractData,
        };
    }

    // =========================================================================
    // 7. MAP BUILDER
    // =========================================================================

    // Returns a flat [{lat, lng}] array of station points extracted from features,
    // so the caller can pass them to nearestKm() for each demog row.
    function buildMap(cfg, geoFeatures) {
        const loadEl = document.getElementById(cfg.loadingMap);
        if (loadEl) loadEl.style.display = "none";

        const svgEl = document.getElementById(cfg.mapId);
        const W = svgEl.parentElement.clientWidth - 2;
        const H = svgEl.clientHeight || 440;

        const svg = d3.select(`#${cfg.mapId}`)
            .attr("viewBox", `0 0 ${W} ${H}`)
            .attr("preserveAspectRatio", "xMidYMid meet");
        svg.selectAll("*").remove();

        // Dark ocean/background so neighbourhood polygons contrast clearly
        svg.append("rect").attr("width", W).attr("height", H).attr("fill", "#090d12");

        // Mercator — center[] is [lng, lat]; scale is pixels-per-radian (higher = more zoom).
        const proj = d3.geoMercator()
            .center(cfg.center)
            .scale(cfg.scale)
            .translate([W / 2, H / 2]);
        const path = d3.geoPath().projection(proj);

        const hoods    = geoFeatures.filter(f => f.properties.type === "neighborhood");
        const routes   = geoFeatures.filter(f => f.properties.type === "route");
        const stations = geoFeatures.filter(f =>
            f.properties.type === "station" && f.geometry?.type === "Point");

        // Inferno colormap offset so the minimum is a visible dark-maroon (not black),
        // and the maximum is a bright yellow. Works well on dark panel backgrounds.
        const vulnInterp = t => d3.interpolateInferno(0.15 + t * 0.85);

        // Build a per-map colour scale whose domain spans the actual data range.
        let vulnColor;
        if (hoods.length > 0) {
            const vals = hoods
                .filter(h => h.properties.demog)
                .map(h => vulnIdx(h.properties.demog));
            const [lo, hi] = d3.extent(vals);
            vulnColor = d3.scaleSequential(vulnInterp)
                .domain([lo ?? 0, (hi ?? 1) * 1.05]);
        } else {
            vulnColor = d3.scaleSequential(vulnInterp).domain([0, 1]);
        }

        // Layer 1: choropleth (only if neighborhood polygons exist)
        if (hoods.length > 0) {
            svg.append("g").attr("class", "neighborhoods")
                .selectAll("path")
                .data(hoods)
                .join("path")
                    .attr("class", "neighborhood")
                    .attr("d", path)
                    .attr("fill", d =>
                        d.properties.demog
                            ? vulnColor(vulnIdx(d.properties.demog))
                            : "#1d2236")
                    .on("mousemove", (ev, d) => showTip(ev, hoodTip(d)))
                    .on("mouseleave", hideTip);
        }

        // Layer 2: route lines (optional)
        if (routes.length > 0) {
            svg.append("g").attr("class", "routes")
                .selectAll("path")
                .data(routes)
                .join("path")
                    .attr("class", "transit-route")
                    .attr("d", path)
                    .attr("stroke", d =>
                        d.properties.line_color ||
                        TSTROKE[d.properties.transit_type] || TSTROKE.default);
        }

        // Layer 3: station dots — DC dots larger to show WMATA line colors clearly
        const stationR = cfg.mapId === "dc-map" ? 5 : (hoods.length > 0 ? 3.5 : 2.5);
        svg.append("g").attr("class", "stations")
            .selectAll("circle")
            .data(stations)
            .join("circle")
                .attr("class", "transit-station")
                .attr("cx", d => proj(d.geometry.coordinates)[0])
                .attr("cy", d => proj(d.geometry.coordinates)[1])
                .attr("r",  stationR)
                .attr("fill", d =>
                    d.properties.line_color ||
                    TSTROKE[d.properties.transit_type] || TSTROKE.default)
                .attr("stroke", "#0c0f1a")
                .attr("stroke-width", 0.8)
                .on("mousemove", (ev, d) => showTip(ev,
                    `<strong>${d.properties.name || "Station"}</strong>
                     <div class="tt-row"><span class="tt-label">Type</span>
                          <span class="tt-val">${d.properties.transit_type}</span></div>`))
                .on("mouseleave", hideTip);

        // Layer 4: geographic labels — borough names (NYC) or ward names (DC)
        const LABEL_STYLE = {
            "font-family": "'Space Grotesk', 'Inter', system-ui, sans-serif",
            "font-weight": "700",
            "font-size":   cfg.mapId === "dc-map" ? "10px" : "11px",
            "letter-spacing": "0.04em",
            "text-anchor": "middle",
            "fill": "rgba(255,255,255,0.92)",
            "paint-order": "stroke",
            "stroke": "rgba(0,0,0,0.75)",
            "stroke-width": "3px",
            "stroke-linejoin": "round",
            "pointer-events": "none",
        };
        const labelsG = svg.append("g").attr("class", "geo-labels");

        const GEO_LABELS = cfg.mapId === "nyc-map"
            ? [
                { name: "Manhattan",    lat: 40.7831, lng: -73.9712 },
                { name: "Brooklyn",     lat: 40.6501, lng: -73.9496 },
                { name: "Bronx",        lat: 40.8448, lng: -73.8648 },
                { name: "Queens",       lat: 40.7282, lng: -73.7949 },
                { name: "Staten Is.",   lat: 40.5795, lng: -74.1502 },
              ]
            : [
                { name: "Ward 1",  lat: 38.9219, lng: -77.0274 },
                { name: "Ward 2",  lat: 38.9001, lng: -77.0468 },
                { name: "Ward 3",  lat: 38.9360, lng: -77.0720 },
                { name: "Ward 4",  lat: 38.9510, lng: -77.0225 },
                { name: "Ward 5",  lat: 38.9180, lng: -76.9930 },
                { name: "Ward 6",  lat: 38.8886, lng: -77.0000 },
                { name: "Ward 7",  lat: 38.8893, lng: -76.9540 },
                { name: "Ward 8",  lat: 38.8530, lng: -76.9835 },
              ];

        GEO_LABELS.forEach(lbl => {
            const [px, py] = proj([lbl.lng, lbl.lat]);
            if (px < 4 || px > W - 4 || py < 4 || py > H - 4) return;
            const t = labelsG.append("text").attr("x", px).attr("y", py);
            Object.entries(LABEL_STYLE).forEach(([k, v]) => t.style(k, v));
            t.text(lbl.name);
        });

        buildMapLegend(cfg, hoods.length > 0);

        // Return station lat/lng so init() can call nearestKm() for each demog row.
        return stations.map(f => ({
            lat: f.geometry.coordinates[1],
            lng: f.geometry.coordinates[0],
        }));
    }

    function hoodTip(d) {
        const dem = d.properties.demog;
        if (!dem) return `<strong>${d.properties.name || "Unknown"}</strong><br><span class="tt-label">No demographic data</span>`;
        return `<strong>${dem.name || d.properties.name}</strong>
                <div class="tt-row"><span class="tt-label">Population</span><span class="tt-val">${fmtPop(dem.total_pop)}</span></div>
                <div class="tt-row"><span class="tt-label">Minority</span><span class="tt-val">${fmtPct(dem.minority_pct)}</span></div>
                <div class="tt-row"><span class="tt-label">Senior 65+</span><span class="tt-val">${fmtPct(dem.senior_pct)}</span></div>
                <div class="tt-row"><span class="tt-label">Vuln. Index</span><span class="tt-val">${d3.format(".3f")(vulnIdx(dem))}</span></div>`;
    }

    function buildMapLegend(cfg, hasHoods) {
        const div = document.getElementById(cfg.legendId);
        if (!div) return;
        div.innerHTML = "";

        if (hasHoods) {
            const ns = "http://www.w3.org/2000/svg";
            const sv = document.createElementNS(ns, "svg");
            sv.setAttribute("width", "110"); sv.setAttribute("height", "11");
            sv.style.cssText = "border-radius:3px;overflow:hidden;flex-shrink:0";
            const defs = document.createElementNS(ns, "defs");
            const grad = document.createElementNS(ns, "linearGradient");
            grad.setAttribute("id", `grad-${cfg.mapId}`);
            [0, .25, .5, .75, 1].forEach(t => {
                const stop = document.createElementNS(ns, "stop");
                stop.setAttribute("offset", `${t * 100}%`);
                stop.setAttribute("stop-color", d3.interpolateInferno(0.15 + t * 0.85));
                grad.appendChild(stop);
            });
            defs.appendChild(grad);
            sv.appendChild(defs);
            const rect = document.createElementNS(ns, "rect");
            rect.setAttribute("width", "110"); rect.setAttribute("height", "11");
            rect.setAttribute("fill", `url(#grad-${cfg.mapId})`);
            sv.appendChild(rect);
            div.appendChild(Object.assign(document.createElement("span"), { textContent: "Low vuln. " }));
            div.appendChild(sv);
            div.appendChild(Object.assign(document.createElement("span"), { textContent: " High  " }));
        }

        const types = cfg.mapId.startsWith("dc")
            ? [["metro", "Metro (color = line)"]]
            : [["subway", "Subway station"]];
        types.forEach(([type, label]) => {
            const dot = document.createElement("span");
            dot.className = "legend-dot";
            dot.style.background = TSTROKE[type];
            div.appendChild(dot);
            div.appendChild(Object.assign(document.createElement("span"), { textContent: " " + label }));
        });
    }

    // =========================================================================
    // 8. CHART BUILDERS
    // =========================================================================

    // Renders a 2-bar chart: minority-majority vs. non-minority, with error bars.
    // Used for DC (tract-level) and for NYC when tract data is available.
    function buildBinaryChart(cfg, demogRows, yLabel) {
        const loadEl = document.getElementById(cfg.loadingCh);
        if (loadEl) loadEl.style.display = "none";

        const valid = demogRows.filter(d => d._nearestKm != null && isFinite(d._nearestKm));

        const groups = [
            { label: "Minority-Majority", color: "#e74c3c",
              rows: valid.filter(d => +d.minority_pct >= 0.5) },
            { label: "Non-Minority",      color: "#2ecc71",
              rows: valid.filter(d => +d.minority_pct <  0.5) },
        ];
        groups.forEach(g => {
            const v = g.rows.map(r => r._nearestKm);
            g.mean = d3.mean(v) || 0;
            g.std  = d3.deviation(v) || 0;
            g.n    = v.length;
        });

        drawBarChart({
            svgId:      cfg.chartId,
            groups,
            annotation: `${cfg.label} — n = ${valid.length} areas`,
            yLabel,
        });
    }

    // Renders a 5-bar borough chart for NYC when tract data is absent.
    // Bars ordered by descending minority_pct; color encodes minority gradient.
    function buildBoroughChart(cfg, demogRows) {
        const loadEl = document.getElementById(cfg.loadingCh);
        if (loadEl) loadEl.style.display = "none";

        const rows = demogRows
            .filter(d => d._nearestKm != null && isFinite(d._nearestKm))
            .sort((a, b) => b.minority_pct - a.minority_pct);

        if (!rows.length) return;

        const svgEl = document.getElementById(cfg.chartId);
        const totalW = svgEl.parentElement.clientWidth - 2;
        const totalH = svgEl.clientHeight || 440;
        const M = { top:32, right:20, bottom:88, left:62 };
        const cW = totalW - M.left - M.right;
        const cH = totalH - M.top  - M.bottom;

        const svg = d3.select(`#${cfg.chartId}`)
            .attr("viewBox", `0 0 ${totalW} ${totalH}`)
            .attr("preserveAspectRatio", "xMidYMid meet");
        svg.selectAll("*").remove();
        const g = svg.append("g").attr("transform", `translate(${M.left},${M.top})`);

        const x = d3.scaleBand().domain(rows.map(d => d.name)).range([0, cW]).padding(0.32);
        const yMax = d3.max(rows, d => d._nearestKm) || 1;
        const y = d3.scaleLinear().domain([0, yMax * 1.25]).range([cH, 0]).nice();

        // Red (high minority) → green (low minority)
        const barFill = d3.scaleSequential(d3.interpolateRdYlGn).domain([1, 0]);

        g.append("g").attr("class", "grid")
            .call(d3.axisLeft(y).tickSize(-cW).tickFormat(""));
        g.append("g").attr("class", "axis")
            .attr("transform", `translate(0,${cH})`)
            .call(d3.axisBottom(x).tickSize(0));
        g.append("g").attr("class", "axis")
            .call(d3.axisLeft(y).ticks(5).tickFormat(v => `${v.toFixed(1)} km`));
        g.append("text").attr("class", "axis-label")
            .attr("transform", "rotate(-90)").attr("x", -(cH/2)).attr("y", -50)
            .attr("text-anchor", "middle")
            .text("Distance from Borough Centroid to Nearest Subway Station (km)");

        g.selectAll(".bar").data(rows).join("rect")
            .attr("class", "bar")
            .attr("x",      d => x(d.name))
            .attr("y",      d => y(d._nearestKm))
            .attr("width",  x.bandwidth())
            .attr("height", d => Math.max(0, cH - y(d._nearestKm)))
            .attr("fill",   d => barFill(d.minority_pct))
            .attr("rx", 4)
            .on("mousemove", (ev, d) => showTip(ev,
                `<strong>${d.name}</strong>
                 <div class="tt-row"><span class="tt-label">Minority</span><span class="tt-val">${fmtPct(d.minority_pct)}</span></div>
                 <div class="tt-row"><span class="tt-label">Population</span><span class="tt-val">${fmtPop(d.total_pop)}</span></div>
                 <div class="tt-row"><span class="tt-label">Dist. to Subway</span><span class="tt-val">${fmtKm(d._nearestKm)} km</span></div>`))
            .on("mouseleave", hideTip);

        // Value labels above bars
        g.selectAll(".bar-value-label").data(rows).join("text")
            .attr("class", "bar-value-label").attr("text-anchor", "middle")
            .attr("x", d => x(d.name) + x.bandwidth() / 2)
            .attr("y", d => y(d._nearestKm) - 7)
            .text(d => `${fmtKm(d._nearestKm)} km`);

        // Minority % below each bar name
        g.selectAll(".minority-sub").data(rows).join("text")
            .attr("class", "chart-annotation").attr("text-anchor", "middle")
            .attr("x", d => x(d.name) + x.bandwidth() / 2)
            .attr("y", cH + 36)
            .text(d => `${fmtPct(d.minority_pct)} min.`);

        g.append("text").attr("class", "chart-annotation").attr("x", cW / 2).attr("y", -14)
            .attr("text-anchor", "middle")
            .text("NYC — borough centroid → nearest subway station (bars ordered by minority %)");

        // Legend for bar color
        const legG = g.append("g").attr("transform", `translate(${cW - 160}, -28)`);
        const lgW = 80, lgH = 8;
        const lgDefs = svg.select("defs").empty() ? svg.append("defs") : svg.select("defs");
        const lgGrad = lgDefs.append("linearGradient").attr("id", "boro-fill-grad");
        [0, .5, 1].forEach(t => lgGrad.append("stop")
            .attr("offset", `${t*100}%`)
            .attr("stop-color", barFill(t)));
        legG.append("rect").attr("width", lgW).attr("height", lgH).attr("rx", 2)
            .attr("fill", "url(#boro-fill-grad)");
        legG.append("text").attr("class","chart-annotation").attr("x", 0).attr("y", lgH + 12)
            .text("Low min. %");
        legG.append("text").attr("class","chart-annotation").attr("x", lgW).attr("y", lgH + 12)
            .attr("text-anchor","end").text("High min. %");
    }

    // =========================================================================
    // 9. SHARED BAR-CHART RENDERER (used by binary charts + comparison)
    // =========================================================================

    function drawBarChart({ svgId, groups, annotation, yLabel }) {
        const svgEl  = document.getElementById(svgId);
        const totalW = svgEl.parentElement.clientWidth - 2;
        const totalH = svgEl.clientHeight || 440;
        const M = { top:32, right:24, bottom:68, left:62 };
        const cW = totalW - M.left - M.right;
        const cH = totalH - M.top  - M.bottom;

        const svg = d3.select(`#${svgId}`)
            .attr("viewBox", `0 0 ${totalW} ${totalH}`)
            .attr("preserveAspectRatio", "xMidYMid meet");
        svg.selectAll("*").remove();
        const g = svg.append("g").attr("transform", `translate(${M.left},${M.top})`);

        const x = d3.scaleBand().domain(groups.map(d => d.label)).range([0, cW]).padding(0.42);
        const yMax = d3.max(groups, d => d.mean + d.std) || 1;
        const y = d3.scaleLinear().domain([0, yMax * 1.2]).range([cH, 0]).nice();

        g.append("g").attr("class", "grid")
            .call(d3.axisLeft(y).tickSize(-cW).tickFormat(""));
        g.append("g").attr("class", "axis")
            .attr("transform", `translate(0,${cH})`)
            .call(d3.axisBottom(x));
        g.append("g").attr("class", "axis")
            .call(d3.axisLeft(y).ticks(6).tickFormat(v => `${v.toFixed(1)} km`));
        g.append("text").attr("class", "axis-label")
            .attr("transform", "rotate(-90)").attr("x", -(cH/2)).attr("y", -50)
            .attr("text-anchor", "middle").text(yLabel);

        const midX = d => x(d.label) + x.bandwidth() / 2;

        g.selectAll(".bar").data(groups).join("rect")
            .attr("class", "bar")
            .attr("x",      d => x(d.label))
            .attr("y",      d => y(d.mean))
            .attr("width",  x.bandwidth())
            .attr("height", d => Math.max(0, cH - y(d.mean)))
            .attr("fill",   d => d.color).attr("rx", 4)
            .on("mousemove", (ev, d) => showTip(ev,
                `<strong>${d.label}</strong>
                 <div class="tt-row"><span class="tt-label">Mean</span><span class="tt-val">${fmtKm(d.mean)} km</span></div>
                 <div class="tt-row"><span class="tt-label">Std Dev</span><span class="tt-val">±${fmtKm(d.std)} km</span></div>
                 <div class="tt-row"><span class="tt-label">n areas</span><span class="tt-val">${d.n}</span></div>`))
            .on("mouseleave", hideTip);

        // Error bars ±1 std dev
        g.selectAll(".ebl").data(groups).join("line").attr("class","error-bar-line")
            .attr("x1", midX).attr("x2", midX)
            .attr("y1", d => y(d.mean + d.std))
            .attr("y2", d => y(Math.max(0, d.mean - d.std)));
        g.selectAll(".ebt").data(groups).join("line").attr("class","error-bar-cap")
            .attr("x1", d => midX(d) - 6).attr("x2", d => midX(d) + 6)
            .attr("y1", d => y(d.mean + d.std)).attr("y2", d => y(d.mean + d.std));
        g.selectAll(".ebb").data(groups).join("line").attr("class","error-bar-cap")
            .attr("x1", d => midX(d) - 6).attr("x2", d => midX(d) + 6)
            .attr("y1", d => y(Math.max(0, d.mean - d.std)))
            .attr("y2", d => y(Math.max(0, d.mean - d.std)));

        // Value labels
        g.selectAll(".bar-value-label").data(groups).join("text")
            .attr("class", "bar-value-label").attr("text-anchor", "middle")
            .attr("x", midX).attr("y", d => y(d.mean) - 10)
            .text(d => `${fmtKm(d.mean)} km`);

        // Δ gap annotation
        if (groups.length === 2) {
            const [a, b] = groups;
            const gap = Math.abs(a.mean - b.mean);
            if (gap > 0.02) {
                const hi = a.mean > b.mean ? a : b;
                g.append("text").attr("class", "chart-annotation").attr("fill", "#f1c40f")
                    .attr("text-anchor", "middle").attr("x", midX(hi)).attr("y", y(hi.mean) - 28)
                    .text(`Δ ${fmtKm(gap)} km gap`);
            }
        }

        if (annotation) {
            g.append("text").attr("class", "chart-annotation")
                .attr("x", cW / 2).attr("y", -14).attr("text-anchor", "middle")
                .text(annotation);
        }
    }

    // =========================================================================
    // 10. COMPARISON CHART
    // =========================================================================

    function buildComparisonChart(nycRows, dcRows, nycHasTractData) {
        const loadEl = document.getElementById("comparison-loading");
        if (loadEl) loadEl.style.display = "none";

        const dcValid  = dcRows.filter(d => d._nearestKm != null && isFinite(d._nearestKm));
        const nycValid = nycRows.filter(d => d._nearestKm != null && isFinite(d._nearestKm));

        // For NYC borough fallback, use a 60% threshold to give cleaner separation:
        // Bronx (90%), Queens (74%), Brooklyn (64%) vs. Manhattan (53%), SI (37%)
        const nycThreshold = nycHasTractData ? 0.50 : 0.60;

        const groups = [
            {
                label: "Minority-Majority\n(NYC)", city:"NYC", color:"#e74c3c",
                rows: nycValid.filter(d => +d.minority_pct >= nycThreshold),
            },
            {
                label: "Non-Minority\n(NYC)", city:"NYC", color:"#2ecc71",
                rows: nycValid.filter(d => +d.minority_pct < nycThreshold),
            },
            {
                label: "Minority-Majority\n(DC)", city:"DC", color:"#c0392b",
                rows: dcValid.filter(d => +d.minority_pct >= 0.50),
            },
            {
                label: "Non-Minority\n(DC)", city:"DC", color:"#27ae60",
                rows: dcValid.filter(d => +d.minority_pct < 0.50),
            },
        ];

        groups.forEach(g => {
            const v = g.rows.map(r => r._nearestKm);
            g.mean = d3.mean(v) || 0;
            g.std  = d3.deviation(v) || 0;
            g.n    = v.length;
        });

        // Render using a wider SVG than the per-city charts
        const svgEl  = document.getElementById("comparison-chart");
        const totalW = svgEl.parentElement.clientWidth - 2;
        const totalH = svgEl.clientHeight || 340;
        const M = { top:30, right:24, bottom:82, left:62 };
        const cW = totalW - M.left - M.right;
        const cH = totalH - M.top  - M.bottom;

        const svg = d3.select("#comparison-chart")
            .attr("viewBox", `0 0 ${totalW} ${totalH}`)
            .attr("preserveAspectRatio", "xMidYMid meet");
        svg.selectAll("*").remove();
        const g = svg.append("g").attr("transform", `translate(${M.left},${M.top})`);

        const x = d3.scaleBand().domain(groups.map(d => d.label)).range([0, cW]).padding(0.3);
        const yMax = d3.max(groups, d => d.mean + d.std) || 1;
        const y = d3.scaleLinear().domain([0, yMax * 1.2]).range([cH, 0]).nice();

        g.append("g").attr("class","grid")
            .call(d3.axisLeft(y).tickSize(-cW).tickFormat(""));
        g.append("g").attr("class","axis")
            .attr("transform", `translate(0,${cH})`)
            .call(d3.axisBottom(x).tickFormat(s => s.replace("\n"," ")));
        g.append("g").attr("class","axis")
            .call(d3.axisLeft(y).ticks(5).tickFormat(v => `${v.toFixed(1)} km`));
        g.append("text").attr("class","axis-label")
            .attr("transform","rotate(-90)").attr("x",-(cH/2)).attr("y",-50)
            .attr("text-anchor","middle")
            .text("Avg. Distance to Nearest Transit Station (km)");

        const midX = d => x(d.label) + x.bandwidth() / 2;

        g.selectAll(".bar").data(groups).join("rect")
            .attr("class","bar")
            .attr("x",      d => x(d.label)).attr("y",d => y(d.mean))
            .attr("width",  x.bandwidth())
            .attr("height", d => Math.max(0, cH - y(d.mean)))
            .attr("fill",   d => d.color).attr("rx",4)
            .on("mousemove",(ev,d) => showTip(ev,
                `<strong>${d.label.replace("\n"," ")}</strong>
                 <div class="tt-row"><span class="tt-label">Mean</span><span class="tt-val">${fmtKm(d.mean)} km</span></div>
                 <div class="tt-row"><span class="tt-label">±Std Dev</span><span class="tt-val">${fmtKm(d.std)} km</span></div>
                 <div class="tt-row"><span class="tt-label">n areas</span><span class="tt-val">${d.n}</span></div>`))
            .on("mouseleave", hideTip);

        // Error bars
        g.selectAll(".ebl").data(groups).join("line").attr("class","error-bar-line")
            .attr("x1",midX).attr("x2",midX)
            .attr("y1",d=>y(d.mean+d.std)).attr("y2",d=>y(Math.max(0,d.mean-d.std)));
        g.selectAll(".ebt").data(groups).join("line").attr("class","error-bar-cap")
            .attr("x1",d=>midX(d)-5).attr("x2",d=>midX(d)+5)
            .attr("y1",d=>y(d.mean+d.std)).attr("y2",d=>y(d.mean+d.std));
        g.selectAll(".ebb").data(groups).join("line").attr("class","error-bar-cap")
            .attr("x1",d=>midX(d)-5).attr("x2",d=>midX(d)+5)
            .attr("y1",d=>y(Math.max(0,d.mean-d.std))).attr("y2",d=>y(Math.max(0,d.mean-d.std)));

        g.selectAll(".bar-value-label").data(groups).join("text")
            .attr("class","bar-value-label").attr("text-anchor","middle")
            .attr("x",midX).attr("y",d=>y(d.mean)-8).attr("font-size","0.7rem")
            .text(d => `${fmtKm(d.mean)}`);

        // City divider lines + labels
        const cityMeta = [
            { city:"NYC", label:"New York City" },
            { city:"DC",  label:"Washington D.C." },
        ];
        cityMeta.forEach(({ city, label }) => {
            const cg = groups.filter(d => d.city === city);
            if (!cg.length) return;
            const x0 = x(cg[0].label);
            const x1 = x(cg[cg.length-1].label) + x.bandwidth();
            g.append("text").attr("class","chart-annotation")
                .attr("x", (x0 + x1) / 2).attr("y", cH + 54)
                .attr("text-anchor","middle").attr("fill","#7c85a2")
                .text(label);
            // subtle separator line between city groups
            if (city === "NYC") {
                g.append("line")
                    .attr("x1", x1 + (x.step() * x.paddingInner() / 2))
                    .attr("x2", x1 + (x.step() * x.paddingInner() / 2))
                    .attr("y1", -10).attr("y2", cH + 10)
                    .attr("stroke","#272d45").attr("stroke-width",1.5)
                    .attr("stroke-dasharray","4,3");
            }
        });

        if (!nycHasTractData) {
            g.append("text").attr("class","chart-annotation").attr("fill","#f1c40f")
                .attr("x", cW / 2).attr("y", -14).attr("text-anchor","middle")
                .text("NYC: borough-level data (run prepare_nyc.py for tract-level) · DC: census-tract-level data");
        }

        // Populate stat cards with computed equity gap percentages
        const [nycMin, nycNon, dcMin, dcNon] = groups;
        function pctGap(minority, nonMinority) {
            return nonMinority.mean > 0.001
                ? Math.round((minority.mean - nonMinority.mean) / nonMinority.mean * 100)
                : 0;
        }
        const nycGap = pctGap(nycMin, nycNon);
        const dcGap  = pctGap(dcMin,  dcNon);
        const aggGap = Math.round((nycGap + dcGap) / 2);
        const fmtGap = v => `${v > 0 ? "+" : ""}${v}%`;
        const getEl  = id => document.getElementById(id);
        if (getEl("stat-nyc-gap")) getEl("stat-nyc-gap").textContent = fmtGap(nycGap);
        if (getEl("stat-dc-gap"))  getEl("stat-dc-gap").textContent  = fmtGap(dcGap);
        if (getEl("stat-agg-gap")) getEl("stat-agg-gap").textContent = `~${aggGap}%`;
    }

    // =========================================================================
    // 11. INIT
    // =========================================================================

    async function init() {
        const [dcResult, nycResult] = await Promise.all([
            loadDC().catch(err => { console.error("DC load failed:", err); return null; }),
            loadNYC().catch(err => { console.error("NYC load failed:", err); return null; }),
        ]);

        if (dcResult) {
            const dcStations = buildMap(CFG.dc, dcResult.geoFeatures);
            // Attach _nearestKm to each DC census-tract demog row
            dcResult.demogRows.forEach(d => {
                d._nearestKm = nearestKm(d.lat, d.lng, dcStations);
            });
            buildBinaryChart(
                CFG.dc, dcResult.demogRows,
                "Avg. Distance to Nearest Metro Station (km)"
            );
        } else {
            ["dc-map-loading","dc-chart-loading"].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.textContent = "DC data failed to load.";
            });
        }

        if (nycResult) {
            const nycStations = buildMap(CFG.nyc, nycResult.geoFeatures);
            // Attach _nearestKm to each NYC demog row (tract centroid or borough centroid)
            nycResult.demogRows.forEach(d => {
                d._nearestKm = nearestKm(d.lat, d.lng, nycStations);
            });

            if (nycResult.hasTractData) {
                buildBinaryChart(
                    CFG.nyc, nycResult.demogRows,
                    "Avg. Distance to Nearest Subway Station (km)"
                );
            } else {
                buildBoroughChart(CFG.nyc, nycResult.demogRows);
            }
        } else {
            ["nyc-map-loading","nyc-chart-loading"].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.textContent = "NYC data failed to load.";
            });
        }

        if (dcResult && nycResult) {
            buildComparisonChart(
                nycResult.demogRows,
                dcResult.demogRows,
                nycResult.hasTractData
            );
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

})();
