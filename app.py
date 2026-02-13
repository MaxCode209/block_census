"""Main Flask application."""
from flask import Flask, render_template
from flask_cors import CORS
from backend.routes import api
from config.config import Config

app = Flask(__name__, 
            template_folder='frontend/templates',
            static_folder='frontend/static')
app.config.from_object(Config)

# Enable CORS for API endpoints
CORS(app)

# Register API blueprint
app.register_blueprint(api)

# Census block groups - register at /block-groups AND /api/census-block-groups
@app.route('/block-groups', methods=['GET'])
@app.route('/api/census-block-groups', methods=['GET'])
def census_block_groups():
    from backend.routes import get_census_block_groups
    return get_census_block_groups()

@app.route('/')
def index():
    """Serve the main map interface."""
    return render_template('index.html', 
                         google_maps_api_key=Config.GOOGLE_MAPS_API_KEY)

@app.route('/ping')
def ping():
    """Simple health check - returns OK."""
    return 'OK'

@app.route('/test')
def test():
    """Test connection page."""
    return render_template('test.html')

if __name__ == '__main__':
    # Initialize database on first run
    from backend.database import init_db
    init_db()
    print('[APP] Census block groups route: /api/census-block-groups and /block-groups')
    # Use port 5001 (5000 can be blocked on Windows). Disable reloader to avoid
    # constant restarts when files change (improves stability for loading pages).
    app.run(debug=Config.DEBUG, host='127.0.0.1', port=5001, use_reloader=False)

