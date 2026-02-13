# LODES Block Employment Data

## Overview

The `lodes_block_employment` table stores Census LODES (LEHD Origin-Destination Employment Statistics) workplace employment data, aggregated from census block to block group level. Use this for block-level local employment scoring.

## Source

- **Dataset**: LODES WAC (Workplace Area Characteristics)
- **URL**: https://lehd.ces.census.gov/data/lodes/LODES8/
- **File pattern**: `{state}_wac_S000_JT00_{year}.csv.gz` (e.g., `nc_wac_S000_JT00_2021.csv.gz`)
- **Geography**: Census block → aggregated to block group (12-digit GEOID)

## Variables

### Total & Earnings
| Column | LODES | Description |
|--------|-------|-------------|
| `total_jobs` | C000 | Total jobs in block group |
| `jobs_earnings_1250_or_less` | CE01 | Jobs with monthly earnings ≤ $1,250 |
| `jobs_earnings_1251_to_3333` | CE02 | Jobs with monthly earnings $1,251–$3,333 |
| `jobs_earnings_above_3333` | CE03 | Jobs with monthly earnings > $3,333 |

### Age
| Column | LODES | Description |
|--------|-------|-------------|
| `jobs_age_29_under` | CA01 | Workers 29 or younger |
| `jobs_age_30_54` | CA02 | Workers 30–54 |
| `jobs_age_55_plus` | CA03 | Workers 55+ |

### Education (when available)
| Column | LODES | Description |
|--------|-------|-------------|
| `jobs_edu_no_diploma` | CD01 | Less than high school |
| `jobs_edu_high_school` | CD02 | High school or equivalent |
| `jobs_edu_some_college` | CD03 | Some college or associate |
| `jobs_edu_bachelors_plus` | CD04 | Bachelor's or higher |

### Industry Sectors (NAICS supersectors)
| Column | LODES | Sector |
|--------|-------|--------|
| `jobs_sector_agriculture` | CNS01 | Agriculture |
| `jobs_sector_mining` | CNS02 | Mining |
| `jobs_sector_utilities` | CNS03 | Utilities |
| `jobs_sector_construction` | CNS04 | Construction |
| `jobs_sector_manufacturing` | CNS05 | Manufacturing |
| `jobs_sector_wholesale` | CNS06 | Wholesale trade |
| `jobs_sector_retail` | CNS07 | Retail trade |
| `jobs_sector_transportation` | CNS08 | Transportation/warehousing |
| `jobs_sector_information` | CNS09 | Information |
| `jobs_sector_finance` | CNS10 | Finance/insurance |
| `jobs_sector_real_estate` | CNS11 | Real estate |
| `jobs_sector_professional` | CNS12 | Professional/technical |
| `jobs_sector_management` | CNS13 | Management |
| `jobs_sector_administrative` | CNS14 | Administrative/waste |
| `jobs_sector_education` | CNS15 | Education |
| `jobs_sector_health_care` | CNS16 | Health care |
| `jobs_sector_arts_entertainment` | CNS17 | Arts/entertainment |
| `jobs_sector_accommodation_food` | CNS18 | Accommodation/food |
| `jobs_sector_other_services` | CNS19 | Other services |
| `jobs_sector_public_admin` | CNS20 | Public administration |

## Population

```bash
# NC and SC (default year 2021)
python scripts/populate_lodes_block_employment.py

# NC only
python scripts/populate_lodes_block_employment.py --state NC

# Different year
python scripts/populate_lodes_block_employment.py --state NC --year 2020
```

## Joining with census_block_groups

```sql
SELECT
  cbg.geoid,
  cbg.population,
  cbg.average_household_income,
  lbe.total_jobs,
  lbe.jobs_earnings_above_3333,
  lbe.jobs_sector_health_care
FROM census_block_groups cbg
LEFT JOIN lodes_block_employment lbe ON cbg.geoid = lbe.geoid
WHERE cbg.state = '37';
```

## Local Employment Score (Next Step)

With block-level LODES data, you can design a new employment score using:
- **Job density**: total_jobs / population or households
- **High-earnings share**: jobs_earnings_above_3333 / total_jobs
- **Sector mix**: diversity, white-collar vs service
- **Growth potential**: compare multiple years when available
