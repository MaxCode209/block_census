"""Configuration settings for the application."""
import os
from dotenv import load_dotenv

load_dotenv()

def _database_url():
    url = os.getenv('DATABASE_URL', 'postgresql://localhost:5432/real_estate_census')
    # Force Transaction mode (6543) for Supabase pooler to avoid "max clients" in Session mode (5432)
    if 'pooler.supabase.com' in url and ':5432/' in url:
        url = url.replace(':5432/', ':6543/', 1)
    return url

class Config:
    """Application configuration."""
    
    # Database
    DATABASE_URL = _database_url()
    
    # API Keys
    GOOGLE_MAPS_API_KEY = os.getenv('GOOGLE_MAPS_API_KEY', '')
    CENSUS_API_KEY = os.getenv('CENSUS_API_KEY', '')
    
    # Flask
    SECRET_KEY = os.getenv('SECRET_KEY', 'dev-secret-key-change-in-production')
    DEBUG = os.getenv('FLASK_DEBUG', 'True').lower() == 'true'
    
    # Google Sheets
    GOOGLE_SHEETS_CREDENTIALS_PATH = os.getenv('GOOGLE_SHEETS_CREDENTIALS_PATH', 'credentials/google_sheets_credentials.json')
    
    # Boundaries.io (optional - for zip code boundaries)
    BOUNDARIES_IO_API_KEY = os.getenv('BOUNDARIES_IO_API_KEY', '')
    
    # Apify API (for school ratings)
    APIFY_API_TOKEN = os.getenv('APIFY_API_TOKEN', '')
    APIFY_ZILLOW_SCHOOL_ACTOR_ID = 'axlymxp/zillow-school-scraper'
    
    # Census API Settings
    CENSUS_API_BASE_URL = 'https://api.census.gov/data'
    CENSUS_YEAR = '2024'  # ACS 5-year estimates (2020-2024)
    CENSUS_DATASET = 'acs/acs5'  # American Community Survey 5-year

    # Public URL for this app (e.g. https://your-app.onrender.com). Set in production.
    BASE_URL = os.getenv('BASE_URL', '').rstrip('/')

