-- LODES (LEHD Origin-Destination Employment Statistics) block-level employment data
-- Aggregated to census block group for use with census_block_groups.
-- Source: Census LODES WAC files (Workplace Area Characteristics)
-- Variables: total jobs, jobs by earnings, jobs by industry sector

CREATE TABLE IF NOT EXISTS lodes_block_employment (
    id SERIAL PRIMARY KEY,
    geoid VARCHAR(12) NOT NULL UNIQUE,
    state VARCHAR(2) NOT NULL,
    county VARCHAR(3) NOT NULL,
    year INTEGER NOT NULL,
    -- Total jobs (C000)
    total_jobs INTEGER,
    -- Jobs by monthly earnings (CE01, CE02, CE03)
    jobs_earnings_1250_or_less INTEGER,
    jobs_earnings_1251_to_3333 INTEGER,
    jobs_earnings_above_3333 INTEGER,
    -- Jobs by age (CA01, CA02, CA03)
    jobs_age_29_under INTEGER,
    jobs_age_30_54 INTEGER,
    jobs_age_55_plus INTEGER,
    -- Jobs by education (CD01-CD04) - when available
    jobs_edu_no_diploma INTEGER,
    jobs_edu_high_school INTEGER,
    jobs_edu_some_college INTEGER,
    jobs_edu_bachelors_plus INTEGER,
    -- Industry sectors (CNS01-CNS20) - NAICS supersectors
    jobs_sector_agriculture INTEGER,
    jobs_sector_mining INTEGER,
    jobs_sector_utilities INTEGER,
    jobs_sector_construction INTEGER,
    jobs_sector_manufacturing INTEGER,
    jobs_sector_wholesale INTEGER,
    jobs_sector_retail INTEGER,
    jobs_sector_transportation INTEGER,
    jobs_sector_information INTEGER,
    jobs_sector_finance INTEGER,
    jobs_sector_real_estate INTEGER,
    jobs_sector_professional INTEGER,
    jobs_sector_management INTEGER,
    jobs_sector_administrative INTEGER,
    jobs_sector_education INTEGER,
    jobs_sector_health_care INTEGER,
    jobs_sector_arts_entertainment INTEGER,
    jobs_sector_accommodation_food INTEGER,
    jobs_sector_other_services INTEGER,
    jobs_sector_public_admin INTEGER,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lodes_block_employment_geoid ON lodes_block_employment(geoid);
CREATE INDEX IF NOT EXISTS idx_lodes_block_employment_state_county ON lodes_block_employment(state, county);
CREATE INDEX IF NOT EXISTS idx_lodes_block_employment_year ON lodes_block_employment(year);

COMMENT ON TABLE lodes_block_employment IS 'LODES workplace employment aggregated to census block group. Source: Census LODES WAC files. For block-level local employment scoring.';
