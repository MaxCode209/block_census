"""
Populate lodes_block_employment table with LODES (LEHD) workplace employment data.

Downloads Census LODES WAC (Workplace Area Characteristics) files and aggregates
from census block to block group level. Includes:
- Total jobs (C000)
- Jobs by monthly earnings: CE01 ($1,250 or less), CE02 ($1,251-$3,333), CE03 (above $3,333)
- Jobs by age: CA01 (29 or younger), CA02 (30-54), CA03 (55+)
- Jobs by education: CD01-CD04 (when available)
- Jobs by industry sector: CNS01-CNS20 (NAICS supersectors)

Usage:
  python scripts/populate_lodes_block_employment.py           # NC + SC
  python scripts/populate_lodes_block_employment.py --state NC
  python scripts/populate_lodes_block_employment.py --state SC --year 2020
"""
import argparse
import gzip
import io
import sys
from collections import defaultdict
from pathlib import Path

import requests
from sqlalchemy import text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.database import SessionLocal, init_db

# LODES WAC base URL; file naming: {state}_wac_S000_JT00_{year}.csv.gz
LODES_BASE = "https://lehd.ces.census.gov/data/lodes/LODES8"
STATES = {"NC": "nc", "SC": "sc"}
DEFAULT_YEAR = 2021

# Map LODES column names to our table columns
COL_MAP = {
    "C000": "total_jobs",
    "CA01": "jobs_age_29_under",
    "CA02": "jobs_age_30_54",
    "CA03": "jobs_age_55_plus",
    "CE01": "jobs_earnings_1250_or_less",
    "CE02": "jobs_earnings_1251_to_3333",
    "CE03": "jobs_earnings_above_3333",
    "CD01": "jobs_edu_no_diploma",
    "CD02": "jobs_edu_high_school",
    "CD03": "jobs_edu_some_college",
    "CD04": "jobs_edu_bachelors_plus",
    "CNS01": "jobs_sector_agriculture",
    "CNS02": "jobs_sector_mining",
    "CNS03": "jobs_sector_utilities",
    "CNS04": "jobs_sector_construction",
    "CNS05": "jobs_sector_manufacturing",
    "CNS06": "jobs_sector_wholesale",
    "CNS07": "jobs_sector_retail",
    "CNS08": "jobs_sector_transportation",
    "CNS09": "jobs_sector_information",
    "CNS10": "jobs_sector_finance",
    "CNS11": "jobs_sector_real_estate",
    "CNS12": "jobs_sector_professional",
    "CNS13": "jobs_sector_management",
    "CNS14": "jobs_sector_administrative",
    "CNS15": "jobs_sector_education",
    "CNS16": "jobs_sector_health_care",
    "CNS17": "jobs_sector_arts_entertainment",
    "CNS18": "jobs_sector_accommodation_food",
    "CNS19": "jobs_sector_other_services",
    "CNS20": "jobs_sector_public_admin",
}


def _parse_int(val):
    if val is None or val == "":
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


def fetch_and_aggregate_lodes(state_abbr: str, year: int) -> list[dict]:
    """Download LODES WAC file and aggregate to block group level."""
    slug = STATES.get(state_abbr.upper(), state_abbr.lower())
    url = f"{LODES_BASE}/{slug}/wac/{slug}_wac_S000_JT00_{year}.csv.gz"
    print(f"  Downloading {url}...")
    try:
        r = requests.get(url, timeout=120, stream=True)
        r.raise_for_status()
    except Exception as e:
        print(f"  [ERROR] Failed to fetch: {e}")
        return []

    content = r.content
    try:
        raw = gzip.decompress(content)
    except Exception as e:
        print(f"  [ERROR] Failed to decompress: {e}")
        return []

    text_io = io.StringIO(raw.decode("utf-8", errors="replace"))
    lines = text_io.readlines()
    if not lines:
        return []

    header = lines[0].strip().split(",")
    col_indices = {}
    for i, h in enumerate(header):
        h = h.strip().strip('"')
        if h in COL_MAP or h == "w_geocode":
            col_indices[h] = i

    if "w_geocode" not in col_indices:
        print(f"  [WARN] No w_geocode column. Headers: {header[:5]}...")
        return []

    # Aggregate by block group (first 12 chars of w_geocode)
    agg: dict[str, dict] = defaultdict(lambda: {k: 0 for k in COL_MAP.values()})
    agg_state_county: dict[str, tuple[str, str]] = {}

    for line in lines[1:]:
        parts = line.strip().split(",")
        if len(parts) <= col_indices["w_geocode"]:
            continue
        w_geocode = parts[col_indices["w_geocode"]].strip().strip('"')
        if len(w_geocode) < 12:
            continue
        geoid = w_geocode[:12]
        state = w_geocode[:2]
        county = w_geocode[2:5]
        agg_state_county[geoid] = (state, county)

        for lodes_col, our_col in COL_MAP.items():
            if lodes_col in col_indices:
                idx = col_indices[lodes_col]
                if idx < len(parts):
                    v = _parse_int(parts[idx])
                    if v is not None:
                        agg[geoid][our_col] += v

    state_fips = "37" if state_abbr.upper() == "NC" else "45"
    result = []
    for geoid, counts in agg.items():
        state, county = agg_state_county.get(geoid, (state_fips[:2] if len(state_fips) >= 2 else "37", geoid[2:5]))
        rec = {
            "geoid": geoid,
            "state": state,
            "county": county,
            "year": year,
            **counts,
        }
        result.append(rec)

    return result


def main():
    parser = argparse.ArgumentParser(description="Populate lodes_block_employment from Census LODES")
    parser.add_argument("--state", choices=["NC", "SC"], help="State to process (default: both)")
    parser.add_argument("--year", type=int, default=DEFAULT_YEAR, help=f"LODES year (default: {DEFAULT_YEAR})")
    args = parser.parse_args()

    states_to_process = [args.state] if args.state else ["NC", "SC"]
    init_db()
    db = SessionLocal()

    try:
        for state_name in states_to_process:
            print(f"\n--- {state_name} ({args.year}) ---")
            records = fetch_and_aggregate_lodes(state_name, args.year)
            if not records:
                print(f"  No data for {state_name}")
                continue
            print(f"  Aggregated {len(records)} block groups")

            cols = [
                "geoid", "state", "county", "year", "total_jobs",
                "jobs_age_29_under", "jobs_age_30_54", "jobs_age_55_plus",
                "jobs_earnings_1250_or_less", "jobs_earnings_1251_to_3333", "jobs_earnings_above_3333",
                "jobs_edu_no_diploma", "jobs_edu_high_school", "jobs_edu_some_college", "jobs_edu_bachelors_plus",
                "jobs_sector_agriculture", "jobs_sector_mining", "jobs_sector_utilities", "jobs_sector_construction",
                "jobs_sector_manufacturing", "jobs_sector_wholesale", "jobs_sector_retail", "jobs_sector_transportation",
                "jobs_sector_information", "jobs_sector_finance", "jobs_sector_real_estate", "jobs_sector_professional",
                "jobs_sector_management", "jobs_sector_administrative", "jobs_sector_education", "jobs_sector_health_care",
                "jobs_sector_arts_entertainment", "jobs_sector_accommodation_food", "jobs_sector_other_services",
                "jobs_sector_public_admin",
            ]
            stmt = text("""
                INSERT INTO lodes_block_employment (geoid, state, county, year, total_jobs,
                    jobs_age_29_under, jobs_age_30_54, jobs_age_55_plus,
                    jobs_earnings_1250_or_less, jobs_earnings_1251_to_3333, jobs_earnings_above_3333,
                    jobs_edu_no_diploma, jobs_edu_high_school, jobs_edu_some_college, jobs_edu_bachelors_plus,
                    jobs_sector_agriculture, jobs_sector_mining, jobs_sector_utilities, jobs_sector_construction,
                    jobs_sector_manufacturing, jobs_sector_wholesale, jobs_sector_retail, jobs_sector_transportation,
                    jobs_sector_information, jobs_sector_finance, jobs_sector_real_estate, jobs_sector_professional,
                    jobs_sector_management, jobs_sector_administrative, jobs_sector_education, jobs_sector_health_care,
                    jobs_sector_arts_entertainment, jobs_sector_accommodation_food, jobs_sector_other_services,
                    jobs_sector_public_admin)
                VALUES (:geoid, :state, :county, :year, :total_jobs,
                    :jobs_age_29_under, :jobs_age_30_54, :jobs_age_55_plus,
                    :jobs_earnings_1250_or_less, :jobs_earnings_1251_to_3333, :jobs_earnings_above_3333,
                    :jobs_edu_no_diploma, :jobs_edu_high_school, :jobs_edu_some_college, :jobs_edu_bachelors_plus,
                    :jobs_sector_agriculture, :jobs_sector_mining, :jobs_sector_utilities, :jobs_sector_construction,
                    :jobs_sector_manufacturing, :jobs_sector_wholesale, :jobs_sector_retail, :jobs_sector_transportation,
                    :jobs_sector_information, :jobs_sector_finance, :jobs_sector_real_estate, :jobs_sector_professional,
                    :jobs_sector_management, :jobs_sector_administrative, :jobs_sector_education, :jobs_sector_health_care,
                    :jobs_sector_arts_entertainment, :jobs_sector_accommodation_food, :jobs_sector_other_services,
                    :jobs_sector_public_admin)
                ON CONFLICT (geoid) DO UPDATE SET
                    state = EXCLUDED.state, county = EXCLUDED.county, year = EXCLUDED.year,
                    total_jobs = EXCLUDED.total_jobs,
                    jobs_age_29_under = EXCLUDED.jobs_age_29_under, jobs_age_30_54 = EXCLUDED.jobs_age_30_54,
                    jobs_age_55_plus = EXCLUDED.jobs_age_55_plus,
                    jobs_earnings_1250_or_less = EXCLUDED.jobs_earnings_1250_or_less,
                    jobs_earnings_1251_to_3333 = EXCLUDED.jobs_earnings_1251_to_3333,
                    jobs_earnings_above_3333 = EXCLUDED.jobs_earnings_above_3333,
                    jobs_edu_no_diploma = EXCLUDED.jobs_edu_no_diploma, jobs_edu_high_school = EXCLUDED.jobs_edu_high_school,
                    jobs_edu_some_college = EXCLUDED.jobs_edu_some_college, jobs_edu_bachelors_plus = EXCLUDED.jobs_edu_bachelors_plus,
                    jobs_sector_agriculture = EXCLUDED.jobs_sector_agriculture, jobs_sector_mining = EXCLUDED.jobs_sector_mining,
                    jobs_sector_utilities = EXCLUDED.jobs_sector_utilities, jobs_sector_construction = EXCLUDED.jobs_sector_construction,
                    jobs_sector_manufacturing = EXCLUDED.jobs_sector_manufacturing, jobs_sector_wholesale = EXCLUDED.jobs_sector_wholesale,
                    jobs_sector_retail = EXCLUDED.jobs_sector_retail, jobs_sector_transportation = EXCLUDED.jobs_sector_transportation,
                    jobs_sector_information = EXCLUDED.jobs_sector_information, jobs_sector_finance = EXCLUDED.jobs_sector_finance,
                    jobs_sector_real_estate = EXCLUDED.jobs_sector_real_estate, jobs_sector_professional = EXCLUDED.jobs_sector_professional,
                    jobs_sector_management = EXCLUDED.jobs_sector_management, jobs_sector_administrative = EXCLUDED.jobs_sector_administrative,
                    jobs_sector_education = EXCLUDED.jobs_sector_education, jobs_sector_health_care = EXCLUDED.jobs_sector_health_care,
                    jobs_sector_arts_entertainment = EXCLUDED.jobs_sector_arts_entertainment,
                    jobs_sector_accommodation_food = EXCLUDED.jobs_sector_accommodation_food,
                    jobs_sector_other_services = EXCLUDED.jobs_sector_other_services,
                    jobs_sector_public_admin = EXCLUDED.jobs_sector_public_admin,
                    updated_at = now()
            """)

            batch_size = 500
            for i in range(0, len(records), batch_size):
                batch = records[i : i + batch_size]
                try:
                    for rec in batch:
                        params = {c: rec.get(c) for c in cols}
                        db.execute(stmt, params)
                    db.commit()
                except Exception as e:
                    db.rollback()
                    print(f"  [ERROR] Batch at offset {i}, geoid {batch[0].get('geoid')}: {e}")
                    raise
                done = min(i + batch_size, len(records))
                if done % 5000 < batch_size or done >= len(records):
                    print(f"  Progress: {done}/{len(records)}")

            print(f"  Upserted: {len(records)} rows")

    finally:
        db.close()

    print("\nDone.")


if __name__ == "__main__":
    main()
