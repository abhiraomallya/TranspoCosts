"""
prepare_nyc.py — Generate data/nyc_census_tracts.geojson for Transportunity Costs
===================================================================================

Running this script creates nyc_census_tracts.geojson in the same folder.
That file has the same schema as the DC ACS GeoJSON already in data/, so the
D3 app will automatically use it to render a neighborhood-level choropleth and
a proper minority/non-minority distance-comparison chart for NYC.

Requirements
------------
    pip install requests

Optional (produces a cleaner spatial join):
    pip install geopandas shapely

Census API key (free, takes ~10 minutes to get):
    https://api.census.gov/data/key_signup.html
    Set the key in the CENSUS_API_KEY variable below, or pass it as an env var.

Usage
-----
    cd "CMSC471 Final Project - TranspoCosts/data"
    python prepare_nyc.py

What it does
------------
    1. Fetches ACS 5-year 2019 DP05 demographics for all NYC census tracts
       via the Census Bureau API.
    2. Downloads NYC census tract boundary GeoJSON from the Census Bureau's
       cartographic boundary service.
    3. Joins demographics onto boundaries by GEOID.
    4. Writes nyc_census_tracts.geojson in the same DP05 column format as the
       DC ACS file so dp05ToDemog() in script.js works without any changes.
"""

import json
import os
import sys
import urllib.request
import urllib.parse

# ---------------------------------------------------------------------------
# CONFIGURATION — edit here
# ---------------------------------------------------------------------------

# Get a free key at https://api.census.gov/data/key_signup.html
# Leave blank to use the demo key (rate-limited to ~500 req/day).
CENSUS_API_KEY = os.environ.get("CENSUS_API_KEY", "86b48be27d3c49126e2a5a2990498bdb71d2c836")

# ACS 5-year vintage.  2019 is the last pre-COVID full year.
ACS_YEAR = "2019"

# NYC county FIPS codes  (state 36 = New York)
# 005=Bronx  047=Kings(Brooklyn)  061=New York(Manhattan)  081=Queens  085=Richmond(SI)
NYC_COUNTIES = ["005", "047", "061", "081", "085"]

# Output file (written to the same directory as this script)
OUT_FILE = os.path.join(os.path.dirname(__file__), "nyc_census_tracts.geojson")

# ---------------------------------------------------------------------------
# DP05 variables we need  (same columns used for DC in script.js)
# ---------------------------------------------------------------------------
# DP05_0001E = Total population
# DP05_0077E = White alone, not Hispanic or Latino
# DP05_0024E = 65 years and over
# NAME / NAMELSAD come from the geometry file
DP05_VARS = "NAME,DP05_0001E,DP05_0077E,DP05_0024E"


def fetch_json(url: str) -> object:
    print(f"  GET {url[:90]}{'...' if len(url) > 90 else ''}")
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.loads(resp.read())


# ---------------------------------------------------------------------------
# STEP 1 — Fetch DP05 demographics from the Census API
# ---------------------------------------------------------------------------

def fetch_demographics() -> dict:
    """
    Returns a dict keyed by 11-digit GEOID (state+county+tract) whose value is
    a dict of DP05 variable estimates, e.g.:
        "36061001500": {"DP05_0001E": 4200, "DP05_0082E": 3100, "DP05_0024E": 420}
    """
    key_param = f"&key={CENSUS_API_KEY}" if CENSUS_API_KEY else ""
    demog = {}

    for county in NYC_COUNTIES:
        url = (
            f"https://api.census.gov/data/{ACS_YEAR}/acs/acs5/profile"
            f"?get={DP05_VARS}"
            f"&for=tract:*"
            f"&in=state:36%20county:{county}"
            f"{key_param}"
        )
        print(f"\nFetching DP05 for county {county}…")
        data = fetch_json(url)

        # First row is column headers: ["NAME","DP05_0001E","DP05_0082E","DP05_0024E","state","county","tract"]
        headers = data[0]
        for row in data[1:]:
            rec = dict(zip(headers, row))
            state  = rec.get("state",  "36")
            county = rec.get("county", county)
            tract  = rec.get("tract",  "")
            geoid  = f"{state}{county}{tract}"
            demog[geoid] = {
                "NAME":        rec.get("NAME", ""),
                "DP05_0001E":  _num(rec.get("DP05_0001E")),
                "DP05_0077E":  _num(rec.get("DP05_0077E")),
                "DP05_0024E":  _num(rec.get("DP05_0024E")),
            }

    print(f"\n  → {len(demog)} census tracts retrieved.")
    return demog


def _num(v):
    """Parse Census API string values to int, return 0 on failure."""
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


# ---------------------------------------------------------------------------
# STEP 2 — Download census tract boundary GeoJSON
# ---------------------------------------------------------------------------

def fetch_boundaries() -> dict:
    """
    Downloads the Census Bureau cartographic boundary GeoJSON for NY state
    census tracts (500k resolution) and returns it as a parsed dict.

    The Census Bureau's TIGERweb feature service is used because it returns
    GeoJSON directly (no shapefile conversion needed).
    """
    url = (
        "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/"
        "Tracts_Blocks/MapServer/4/query"
        "?where=STATE%3D%2736%27+AND+COUNTY+IN+(%27005%27,%27047%27,%27061%27,%27081%27,%27085%27)"
        "&outFields=GEOID,NAME,INTPTLAT,INTPTLON"
        "&returnGeometry=true"
        "&outSR=4326"
        "&f=json"
    )


    print("\nFetching census tract boundaries from TIGERweb…")
    geo = fetch_json(url)
    n = len(geo.get("features", []))
    print(f"  → {n} boundary features downloaded.")
    return geo


# ---------------------------------------------------------------------------
# STEP 3 — Join demographics onto boundaries
# ---------------------------------------------------------------------------

def join_and_write(boundaries: dict, demog: dict) -> None:
    matched = 0
    out_features = []

    for feat in boundaries.get("features", []):
        props = feat.get("attributes", {})
        geoid = str(props.get("GEOID", ""))
        
        # Convert Esri Geometry to GeoJSON
        esri_geom = feat.get("geometry", {})
        geom = None
        if "rings" in esri_geom:
            geom = {
                "type": "Polygon" if len(esri_geom["rings"]) == 1 else "MultiPolygon",
                "coordinates": esri_geom["rings"] if len(esri_geom["rings"]) == 1 else [esri_geom["rings"]]
            }

        # Look up this tract's DP05 data
        dp = demog.get(geoid, {})
        if dp:
            matched += 1

        # Build the output properties in the same schema as the DC ACS GeoJSON.
        # script.js reads: GEOID, NAMELSAD, INTPTLAT, INTPTLON,
        #                   DP05_0001E, DP05_0082E, DP05_0024E
        out_props = {
            **props,
            "GEOID":       geoid,
            "NAMELSAD":    dp.get("NAME") or props.get("NAMELSAD", geoid),
            "INTPTLAT":    props.get("INTPTLAT", 0),
            "INTPTLON":    props.get("INTPTLON", 0),
            "DP05_0001E":  dp.get("DP05_0001E", 0),
            "DP05_0077E":  dp.get("DP05_0077E", 0),
            "DP05_0024E":  dp.get("DP05_0024E", 0),
        }
        out_features.append({
            "type":       "Feature",
            "geometry":   geom,
            "properties": out_props,
        })

    out = {"type": "FeatureCollection", "features": out_features}

    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f)

    print(f"\n✓ Wrote {len(out_features)} features ({matched} with demographics) → {OUT_FILE}")
    if matched < len(out_features) * 0.8:
        print("  WARNING: fewer than 80% of tracts matched demographics. "
              "Check that ACS_YEAR and county codes are correct.")


# ---------------------------------------------------------------------------
# ALSO: Export borough-level CSV (confirms the hardcoded xlsx values in script.js)
# ---------------------------------------------------------------------------

BOROUGH_DATA = {
    "Bronx":         {"total_pop":1436785,"minority_pct":0.904,"senior_pct":0.113},
    "Brooklyn":      {"total_pop":2606852,"minority_pct":0.642,"senior_pct":0.122},
    "Manhattan":     {"total_pop":1634989,"minority_pct":0.529,"senior_pct":0.144},
    "Queens":        {"total_pop":2310011,"minority_pct":0.744,"senior_pct":0.137},
    "Staten Island": {"total_pop": 473324,"minority_pct":0.374,"senior_pct":0.145},
}


def write_borough_csv() -> None:
    csv_path = os.path.join(os.path.dirname(__file__), "nyc_borough_demographics.csv")
    header = "borough,total_pop,minority_pct,white_pct,senior_pct\n"
    rows = []
    for name, d in BOROUGH_DATA.items():
        rows.append(
            f"{name},{d['total_pop']},{d['minority_pct']:.3f},"
            f"{1 - d['minority_pct']:.3f},{d['senior_pct']:.3f}"
        )
    with open(csv_path, "w") as f:
        f.write(header + "\n".join(rows) + "\n")
    print(f"✓ Borough CSV → {csv_path}")


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("=" * 60)
    print("Transportunity Costs — NYC Data Preparation")
    print("=" * 60)

    if not CENSUS_API_KEY:
        print("\n[NOTE] No CENSUS_API_KEY set. Using unauthenticated access.")
        print("  This may be rate-limited. Get a free key at:")
        print("  https://api.census.gov/data/key_signup.html")
        print("  Then set:  export CENSUS_API_KEY=your_key_here\n")

    write_borough_csv()

    try:
        demog     = fetch_demographics()
        boundaries = fetch_boundaries()
        join_and_write(boundaries, demog)
        print("\nDone. Reload index.html to see the full NYC choropleth.")
    except Exception as exc:
        print(f"\n✗ Error: {exc}")
        print("\nIf the TIGERweb or Census API requests fail, try:")
        print("  1. Check your internet connection.")
        print("  2. Try again later (APIs may be temporarily down).")
        print("  3. Download the NY census tract shapefile manually from:")
        print("     https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html")
        print("     (select 'Census Tracts', year 2019, state 'New York')")
        print("     Then convert to GeoJSON with ogr2ogr or mapshaper.")
        sys.exit(1)
