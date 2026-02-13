"""
Populate census_block_groups table with TIGER boundaries + ACS demographics for NC/SC.

Fetches:
  1. ACS 5-year demographics (population, median age, median household income) at block group level
  2. TIGER block group boundaries from Census TIGERweb

Usage:
  python scripts/populate_census_block_groups.py           # NC + SC
  python scripts/populate_census_block_groups.py --state NC  # NC only
  python scripts/populate_census_block_groups.py --state SC  # SC only

Run in a separate terminal from populate_zone_zips.py to avoid resource contention.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import requests
from sqlalchemy import text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.database import SessionLocal, init_db
from config.config import Config


# Tracts_Blocks layer 1 = Census Block Groups; tigerWMS_ACS2022 layer 8 is alternative
TIGERWEB_URLS = [
    "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS2022/MapServer/8/query",
    "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/1/query",
]
CENSUS_API_BASE = "https://api.census.gov/data"
# Use 2023 ACS 5-year (latest stable block group)
CENSUS_YEAR = "2023"
CENSUS_DATASET = "acs/acs5"
STATES = {"NC": "37", "SC": "45"}


def fetch_acs_block_groups(state_fips: str, api_key: str | None = None) -> list[dict]:
    """Fetch ACS demographics for all block groups in a state (by county)."""
    base = f"{CENSUS_API_BASE}/{CENSUS_YEAR}/{CENSUS_DATASET}"
    variables = "NAME,B01001_001E,B01002_001E,B19013_001E,B11001_001E"
    # Geography: block group within state and county
    # First get counties
    counties_url = f"{base}?get=NAME&for=county:*&in=state:{state_fips}&key={api_key}" if api_key else f"{base}?get=NAME&for=county:*&in=state:{state_fips}"
    try:
        r = requests.get(counties_url, timeout=60)
        r.raise_for_status()
        counties_data = r.json()
    except Exception as e:
        print(f"[ERROR] Failed to fetch counties for state {state_fips}: {e}")
        return []

    headers = counties_data[0]
    counties = []
    for row in counties_data[1:]:
        rec = dict(zip(headers, row))
        co = rec.get("county", "")
        if co:
            counties.append(co)

    all_records = []
    for county in counties:
        geo = f"block group:*&in=state:{state_fips}&in=county:{county}"
        url = f"{base}?get={variables}&for={geo}&key={api_key}" if api_key else f"{base}?get={variables}&for={geo}"
        try:
            r = requests.get(url, timeout=90)
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            print(f"[WARN] County {county} failed: {e}")
            continue

        if not data or len(data) < 2:
            continue

        h = data[0]
        for row in data[1:]:
            if len(row) != len(h):
                continue
            rec = dict(zip(h, row))
            state = rec.get("state", "")
            county_code = rec.get("county", "")
            tract = rec.get("tract", "")
            bg = rec.get("block group", "")
            if not all([state, county_code, tract, bg]):
                continue
            geoid = f"{state}{county_code}{tract}{bg}"

            pop = rec.get("B01001_001E")
            pop = int(pop) if pop not in (None, "", "-666666666") else None
            mhi = rec.get("B19013_001E")
            if mhi in (None, "", "-666666666"):
                mhi = None
            else:
                try:
                    mhi = float(mhi)
                    if mhi < 0:
                        mhi = None
                except (ValueError, TypeError):
                    mhi = None
            age = rec.get("B01002_001E")
            if age in (None, "", "-666666666"):
                age = None
            else:
                try:
                    age = float(age)
                    if age < 0:
                        age = None
                except (ValueError, TypeError):
                    age = None
            hh = rec.get("B11001_001E")
            hh = int(hh) if hh not in (None, "", "-666666666") else None

            all_records.append({
                "geoid": geoid,
                "state": state,
                "county": county_code,
                "tract": tract,
                "block_group": bg,
                "population": pop,
                "median_age": age,
                "average_household_income": mhi,
                "total_households": hh,
            })
        time.sleep(0.2)  # Rate limit

    return all_records


def fetch_tiger_boundaries(state_fips: str) -> dict[str, dict]:
    """Fetch TIGER block group boundaries for a state. Returns geoid -> GeoJSON geometry."""
    out = {}
    offset = 0
    step = 1000  # Smaller batches for reliability
    base_url = None

    for url in TIGERWEB_URLS:
        params = {
            "where": f"STATE='{state_fips}'",
            "outFields": "GEOID,STATE,COUNTY,TRACT,BLKGRP",
            "returnGeometry": "true",
            "f": "geojson",
            "outSR": "4326",
            "resultOffset": 0,
            "resultRecordCount": 10,  # Test first
        }
        try:
            r = requests.get(url, params=params, timeout=30)
            r.raise_for_status()
            if not r.text or r.text.strip().startswith("<"):
                continue  # HTML response, try next URL
            fc = r.json()
            if fc.get("features"):
                base_url = url
                break
        except Exception:
            continue

    if not base_url:
        print("[ERROR] All TIGER endpoints returned invalid/empty. Response sample from first:")
        try:
            r = requests.get(TIGERWEB_URLS[0], params={"where": f"STATE='{state_fips}'", "f": "geojson", "returnGeometry": "true", "resultRecordCount": 1}, timeout=15)
            print(f"  Status: {r.status_code}, Body start: {repr(r.text[:300])}")
        except Exception as e:
            print(f"  {e}")
        return {}

    offset = 0
    while True:
        params = {
            "where": f"STATE='{state_fips}'",
            "outFields": "GEOID,STATE,COUNTY,TRACT,BLKGRP",
            "returnGeometry": "true",
            "f": "geojson",
            "outSR": "4326",
            "resultOffset": offset,
            "resultRecordCount": step,
        }
        try:
            r = requests.get(base_url, params=params, timeout=120)
            r.raise_for_status()
            if not r.text or r.text.strip().startswith("<"):
                print(f"[WARN] TIGER returned non-JSON at offset {offset}, stopping")
                break
            fc = r.json()
            if "error" in fc:
                print(f"[WARN] TIGER error: {fc.get('error', {})}")
                break
        except requests.exceptions.JSONDecodeError as e:
            print(f"[ERROR] TIGER fetch at offset {offset}: {e}. Body: {repr(r.text[:300] if r.text else '')}")
            break
        except Exception as e:
            print(f"[ERROR] TIGER fetch at offset {offset}: {e}")
            break

        features = fc.get("features", [])
        if not features:
            break

        for f in features:
            props = f.get("properties", {})
            geoid = props.get("GEOID") or (f"{props.get('STATE','')}{props.get('COUNTY','')}{props.get('TRACT','')}{props.get('BLKGRP','')}")
            if geoid:
                out[geoid] = f.get("geometry")
        offset += step
        if len(features) < step:
            break
        time.sleep(0.3)

    return out


def main():
    parser = argparse.ArgumentParser(description="Populate census_block_groups for NC/SC")
    parser.add_argument("--state", choices=["NC", "SC"], help="State to process (default: both)")
    parser.add_argument("--skip-tiger", action="store_true", help="Skip TIGER boundaries (ACS only)")
    args = parser.parse_args()

    states_to_process = [args.state] if args.state else ["NC", "SC"]
    api_key = getattr(Config, "CENSUS_API_KEY", None) or ""

    init_db()
    db = SessionLocal()

    try:
        for state_name in states_to_process:
            state_fips = STATES[state_name]
            print(f"\n--- {state_name} (FIPS {state_fips}) ---")
            print("Fetching ACS demographics...")
            acs = fetch_acs_block_groups(state_fips, api_key)
            print(f"  Got {len(acs)} block groups")

            boundaries = {}
            if not args.skip_tiger:
                print("Fetching TIGER boundaries...")
                boundaries = fetch_tiger_boundaries(state_fips)
                print(f"  Got {len(boundaries)} boundaries")

            inserted = 0
            updated = 0
            for rec in acs:
                geoid = rec["geoid"]
                geom = boundaries.get(geoid)
                geom_json = json.dumps(geom) if geom else None

                existing = db.execute(
                    text("SELECT id FROM census_block_groups WHERE geoid = :g"),
                    {"g": geoid},
                ).fetchone()

                if existing:
                    params = {
                        "g": geoid,
                        "pop": rec["population"],
                        "age": rec["median_age"],
                        "mhi": rec["average_household_income"],
                        "hh": rec["total_households"],
                        "yr": CENSUS_YEAR,
                    }
                    if geom_json:
                        db.execute(
                            text("""
                                UPDATE census_block_groups SET
                                    population = :pop, median_age = :age, average_household_income = :mhi,
                                    total_households = :hh, data_year = :yr, updated_at = now(),
                                    geometry = ST_Multi(ST_GeomFromGeoJSON(CAST(:geom AS json)))
                                WHERE geoid = :g
                            """),
                            {**params, "geom": geom_json},
                        )
                    else:
                        db.execute(
                            text("""
                                UPDATE census_block_groups SET
                                    population = :pop, median_age = :age, average_household_income = :mhi,
                                    total_households = :hh, data_year = :yr, updated_at = now()
                                WHERE geoid = :g
                            """),
                            params,
                        )
                    updated += 1
                else:
                    params = {
                        "g": geoid,
                        "st": rec["state"],
                        "co": rec["county"],
                        "tr": rec["tract"],
                        "bg": rec["block_group"],
                        "pop": rec["population"],
                        "age": rec["median_age"],
                        "mhi": rec["average_household_income"],
                        "hh": rec["total_households"],
                        "yr": CENSUS_YEAR,
                    }
                    if geom_json:
                        db.execute(
                            text("""
                                INSERT INTO census_block_groups
                                    (geoid, state, county, tract, block_group, population, median_age,
                                     average_household_income, total_households, data_year, geometry)
                                VALUES (:g, :st, :co, :tr, :bg, :pop, :age, :mhi, :hh, :yr, ST_Multi(ST_GeomFromGeoJSON(CAST(:geom AS json))))
                            """),
                            {**params, "geom": geom_json},
                        )
                    else:
                        db.execute(
                            text("""
                                INSERT INTO census_block_groups
                                    (geoid, state, county, tract, block_group, population, median_age,
                                     average_household_income, total_households, data_year)
                                VALUES (:g, :st, :co, :tr, :bg, :pop, :age, :mhi, :hh, :yr)
                            """),
                            params,
                        )
                    inserted += 1

            db.commit()
            print(f"  Inserted: {inserted}, Updated: {updated}")

    finally:
        db.close()

    print("\nDone.")


if __name__ == "__main__":
    main()
