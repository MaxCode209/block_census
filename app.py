"""Main Flask application."""
from flask import Flask, render_template, request, jsonify
from flask_cors import CORS
from config.config import Config

app = Flask(__name__, 
            template_folder='frontend/templates',
            static_folder='frontend/static')
app.config.from_object(Config)

# Port we run on (for absolute URLs in export so browser hits this server)
EXPORT_BASE_URL = 'http://127.0.0.1:5001'

# Enable CORS for API endpoints
CORS(app)

# Census block groups - register BEFORE blueprint so this handler runs first for /api/census-block-groups
@app.route('/block-groups', methods=['GET'])
@app.route('/api/census-block-groups', methods=['GET'])
def census_block_groups():
    import zipfile
    import io
    from flask import Response
    fmt = (request.args.get('format') or '').strip().lower()
    if fmt == 'test-zip':
        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, 'w', zipfile.ZIP_STORED) as zf:
            zf.writestr('hello.txt', b'LandVision export test - if you see this, download is OK')
        zip_bytes = zip_buf.getvalue()
        r = Response(zip_bytes, mimetype='application/zip')
        r.headers['Content-Disposition'] = 'attachment; filename="test_download.zip"'
        r.headers['Content-Length'] = len(zip_bytes)
        return r
    from backend.routes import get_census_block_groups
    return get_census_block_groups()

# Export for LandVision (other URLs)
@app.route('/export-landvision', methods=['GET'], strict_slashes=False)
@app.route('/export-landvision/', methods=['GET'])
@app.route('/api/census-block-groups/export', methods=['GET'], strict_slashes=False)
@app.route('/api/export/landvision', methods=['GET'], strict_slashes=False)
def export_census_block_groups_route():
    print(f"[EXPORT] Request received: path={request.path!r}")
    try:
        from backend.routes import export_census_block_groups
        return export_census_block_groups()
    except Exception as e:
        import traceback
        print(f"[ERROR] Export route failed: {e}\n{traceback.format_exc()}")
        return jsonify({"error": f"Export handler failed: {str(e)}"}), 500

# Register API blueprint after app routes so /api/census-block-groups is handled above
from backend.routes import api
app.register_blueprint(api)

@app.route('/')
def index():
    """Serve the main map interface."""
    return render_template('index.html', 
                         google_maps_api_key=Config.GOOGLE_MAPS_API_KEY,
                         export_base_url=EXPORT_BASE_URL)

@app.route('/ping')
def ping():
    """Simple health check - returns OK."""
    return 'OK'

@app.route('/test-zip-download')
def test_zip_download():
    """Returns a minimal ZIP file. No blueprint - app only. Use to verify downloads: http://127.0.0.1:5001/test-zip-download"""
    import zipfile
    import io
    from flask import Response
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, 'w', zipfile.ZIP_STORED) as zf:
        zf.writestr('hello.txt', b'LandVision export test - if you see this, download is OK')
    zip_bytes = zip_buf.getvalue()
    r = Response(zip_bytes, mimetype='application/zip')
    r.headers['Content-Disposition'] = 'attachment; filename="test_download.zip"'
    r.headers['Content-Length'] = len(zip_bytes)
    return r

@app.route('/export-test')
def export_test():
    """Simple test to verify export routing works. Open http://127.0.0.1:5001/export-test"""
    return jsonify({"ok": True, "message": "Export routing works", "path": "/export-test"})

@app.route('/test')
def test():
    """Test connection page."""
    return render_template('test.html')

if __name__ == '__main__':
    # Initialize database on first run
    from backend.database import init_db
    init_db()
    print('[APP] Census block groups route: /api/census-block-groups and /block-groups')
    # Log export routes so we can confirm LandVision export URL
    with app.app_context():
        for rule in app.url_map.iter_rules():
            if 'export' in rule.rule or 'landvision' in rule.rule:
                print(f'[APP] Export route: {rule.rule}')
    # Use port 5001 (5000 can be blocked on Windows). Disable reloader to avoid
    # constant restarts when files change (improves stability for loading pages).
    app.run(debug=Config.DEBUG, host='127.0.0.1', port=5001, use_reloader=False)

