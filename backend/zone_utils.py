"""Utilities for school attendance zone point-in-polygon testing."""
import json
from pathlib import Path
from shapely.geometry import Point, shape, mapping
from shapely.ops import unary_union
from shapely.strtree import STRtree
from typing import Optional, Dict, List, Any, Tuple

try:
    from pyproj import Transformer
    HAS_PYPROJ = True
except ImportError:
    HAS_PYPROJ = False
    print("[WARNING] pyproj not installed - coordinate transformation disabled")

# NCES SABS and similar shapefiles may be in one of these CRSs. We transform to WGS84 for point-in-polygon and mapping.
_SOURCE_CRS_CANDIDATES = [
    "EPSG:3857",   # Web Mercator (some SABS)
    "EPSG:5070",   # NAD83 Albers (USA)
    "EPSG:2264",   # NAD83 State Plane North Carolina
    "EPSG:2273",   # NAD83 State Plane South Carolina
]
_WGS84 = "EPSG:4326"


def _transform_ring(ring: List, transformer) -> List:
    """Transform a single ring of coordinates [[x,y], ...] to WGS84."""
    out = []
    for coord in ring:
        if isinstance(coord[0], (int, float)):
            x, y = float(coord[0]), float(coord[1])
            try:
                lon, lat = transformer.transform(x, y)
                out.append([lon, lat])
            except Exception:
                out.append(coord)
        else:
            out.append(_transform_ring(coord, transformer))
    return out


def _geometry_to_wgs84(geometry: Dict, from_crs: str) -> Optional[Dict]:
    """Transform a GeoJSON geometry from from_crs to WGS84. Returns new geometry dict or None."""
    gtype = _normalize_geom_type(geometry.get("type")) if geometry else None
    if not HAS_PYPROJ or not geometry or gtype not in ("Polygon", "MultiPolygon"):
        return None
    try:
        trans = Transformer.from_crs(from_crs, _WGS84, always_xy=True)
        coords = geometry.get("coordinates")
        if not coords:
            return None
        if gtype == "Polygon":
            new_coords = [_transform_ring(ring, trans) for ring in coords]
        else:
            new_coords = [[_transform_ring(ring, trans) for ring in poly] for poly in coords]
        return {"type": gtype, "coordinates": new_coords}
    except Exception:
        return None


def _coords_look_projected(coords: Any) -> bool:
    """True if first coordinate is outside WGS84 range (likely projected)."""
    while coords and isinstance(coords, list) and len(coords) > 0:
        if isinstance(coords[0], (int, float)):
            break
        coords = coords[0]
    if not coords or len(coords) < 2:
        return False
    try:
        x, y = float(coords[0]), float(coords[1])
        return abs(x) > 180 or abs(y) > 90
    except (TypeError, ValueError):
        return False


def _normalize_geom_type(t: Any) -> Optional[str]:
    """Return 'Polygon' or 'MultiPolygon' for valid type, else None. Accepts any case."""
    if t is None:
        return None
    s = (str(t).strip()).lower()
    if s == "polygon":
        return "Polygon"
    if s == "multipolygon":
        return "MultiPolygon"
    return None


def zone_boundary_to_wgs84(zone_boundary: Any, state_abbr: Optional[str] = None) -> Optional[Dict]:
    """
    Return zone boundary geometry in WGS84 (for point-in-polygon and mapping).
    If stored coords are projected, try common NCES CRSs and return transformed geometry.
    zone_boundary: JSON str or dict. state_abbr: e.g. 'NC', 'SC' for state-specific CRS try.
    """
    if not zone_boundary:
        return None
    try:
        data = json.loads(zone_boundary) if isinstance(zone_boundary, str) else zone_boundary
        if isinstance(data, str):
            data = json.loads(data)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    top_type = (data.get("type") or "").strip().lower()
    if top_type == "feature":
        geom = data.get("geometry")
    elif top_type == "featurecollection":
        feats = data.get("features", [])
        if not feats:
            return None
        geom = feats[0].get("geometry") if isinstance(feats[0], dict) else None
    else:
        geom = data
    if not geom or not isinstance(geom, dict):
        return None
    geom_type = _normalize_geom_type(geom.get("type"))
    if geom_type is None:
        return None
    coords = geom.get("coordinates")
    if not coords:
        return None
    if not _coords_look_projected(coords):
        return {"type": geom_type, "coordinates": coords}
    if not HAS_PYPROJ:
        return None
    # NCES SABS shapefiles use Web Mercator (EPSG:3857). Try 3857 first so we don't
    # wrongly accept state-plane (2264/2273) transforms that also yield valid-looking degrees.
    crs_order = _SOURCE_CRS_CANDIDATES.copy()
    if state_abbr:
        state_abbr = (state_abbr or "").strip().upper()
        if state_abbr == "NC" and "EPSG:2264" in crs_order:
            crs_order.remove("EPSG:2264")
            crs_order.insert(0, "EPSG:2264")
        elif state_abbr == "SC" and "EPSG:2273" in crs_order:
            crs_order.remove("EPSG:2273")
            crs_order.insert(0, "EPSG:2273")
    # Ensure 3857 is tried first (SABS is Web Mercator)
    if "EPSG:3857" in crs_order:
        crs_order.remove("EPSG:3857")
        crs_order.insert(0, "EPSG:3857")
    geom_canonical = {"type": geom_type, "coordinates": coords}
    for crs in crs_order:
        out = _geometry_to_wgs84(geom_canonical, crs)
        if out and _coords_look_projected(out.get("coordinates")) is False:
            return out
    return None


def _boundary_to_shapely_wgs84(zone: Dict):
    """Parse zone_boundary and return Shapely geometry in WGS84 (transform if projected)."""
    boundary = zone.get("zone_boundary")
    state = (zone.get("state") or "").strip().upper()
    geom_dict = zone_boundary_to_wgs84(boundary, state_abbr=state)
    if geom_dict is None:
        return _boundary_to_geometry(boundary)
    try:
        return shape(geom_dict)
    except Exception:
        return _boundary_to_geometry(boundary)

def point_in_polygon(lat: float, lng: float, geojson_boundary: str) -> bool:
    """
    Check if a point (lat, lng) falls within a GeoJSON polygon.
    
    Args:
        lat: Latitude of the point
        lng: Longitude of the point
        geojson_boundary: GeoJSON string (from database)
    
    Returns:
        True if point is within the polygon, False otherwise
    """
    try:
        # Parse GeoJSON
        if isinstance(geojson_boundary, str):
            boundary_data = json.loads(geojson_boundary)
        else:
            boundary_data = geojson_boundary
        
        # Create point
        point = Point(lng, lat)  # Note: shapely uses (x, y) = (lng, lat)
        
        # Create polygon from GeoJSON
        if boundary_data.get('type') == 'Feature':
            geometry = boundary_data.get('geometry')
        elif boundary_data.get('type') == 'FeatureCollection':
            # Use first feature
            features = boundary_data.get('features', [])
            if not features:
                return False
            geometry = features[0].get('geometry')
        else:
            geometry = boundary_data
        
        if not geometry:
            return False
        
        # Create shapely geometry
        polygon = shape(geometry)
        
        # Check if point is within polygon
        return polygon.contains(point)
        
    except Exception as e:
        print(f"Error in point_in_polygon: {e}")
        return False


def find_zoned_schools(lat: float, lng: float, zones: List[Dict], school_level: str) -> Optional[Dict]:
    """
    Find the school zone that contains the given point.
    Zone boundaries are converted to WGS84 when stored in a projected CRS (NCES), so point-in-polygon works correctly.
    """
    point_wgs84 = Point(lng, lat)
    level_zones = [z for z in zones if z.get('school_level', '').lower() == school_level.lower()]
    print(f"[DEBUG] find_zoned_schools: Testing {len(level_zones)} {school_level} zones for point ({lat}, {lng})")

    tested = 0
    for zone in level_zones:
        tested += 1
        if tested % 500 == 0:
            print(f"[DEBUG] find_zoned_schools: Tested {tested}/{len(level_zones)} {school_level} zones...")
        try:
            polygon = _boundary_to_shapely_wgs84(zone)
            if polygon is None:
                continue
            if polygon.contains(point_wgs84):
                print(f"[DEBUG] find_zoned_schools: FOUND MATCH! {school_level} school: {zone.get('school_name')}")
                return zone
        except Exception as e:
            if tested <= 5:
                print(f"[DEBUG] Error checking zone {zone.get('school_name')}: {e}")
            continue
    print(f"[DEBUG] find_zoned_schools: No {school_level} zone found after testing {tested} zones")
    return None


def find_all_zoned_schools(lat: float, lng: float, zones: List[Dict]) -> Dict[str, List[Dict]]:
    """
    Find ALL attendance zones (NCES/Meck) that contain the given point, grouped by level.
    Uses intersects (more robust than contains) and a tiny buffer for edge cases.
    """
    print(f"[ZONED SCHOOLS] find_all_zoned_schools: point ({lat}, {lng}), testing {len(zones)} zones")
    result = {'elementary': [], 'middle': [], 'high': []}
    point_wgs84 = Point(lng, lat)
    # ~15m buffer helps with points near zone boundaries (geocoding precision)
    point_buffered = point_wgs84.buffer(0.00015)
    def _norm_level(s):
        s = (s or '').lower().strip()
        if not s or s == 'other': return None
        if 'elem' in s or s == 'elementary': return 'elementary'
        if 'mid' in s or s == 'middle': return 'middle'
        if 'high' in s: return 'high'
        return s if s in ('elementary', 'middle', 'high') else None

    for zone in zones:
        level = _norm_level(zone.get('school_level'))
        if level is None or level not in result:
            continue
        try:
            polygon = _boundary_to_shapely_wgs84(zone)
            if polygon is not None and polygon.intersects(point_buffered):
                result[level].append(zone)
        except Exception:
            continue
    counts = {k: len(v) for k, v in result.items()}
    print(f"[ZONED SCHOOLS / NCES] find_all_zoned_schools result: {counts}")
    return result


def _boundary_to_geometry(boundary: Any):
    """Parse zone_boundary (GeoJSON str or dict) to Shapely geometry. Returns None on failure. Accepts any case for type."""
    if not boundary:
        return None
    try:
        if isinstance(boundary, str):
            data = json.loads(boundary)
        else:
            data = boundary
        if not isinstance(data, dict):
            return None
        top = (data.get("type") or "").strip().lower()
        if top == "feature":
            geom = data.get("geometry")
        elif top == "featurecollection":
            features = data.get("features", [])
            if not features:
                return None
            geom = features[0].get("geometry") if isinstance(features[0], dict) else None
        else:
            geom = data
        if not geom or not isinstance(geom, dict):
            return None
        gtype = _normalize_geom_type(geom.get("type"))
        if gtype is None:
            return None
        canonical = {"type": gtype, "coordinates": geom.get("coordinates")}
        if not canonical.get("coordinates"):
            return None
        return shape(canonical)
    except Exception:
        return None


def load_zip_polygon(zip_code: str, boundaries_dir: str = 'data/zip_boundaries') -> Optional[Any]:
    """
    Load ZCTA boundary for zip as Shapely polygon (or multi-polygon).
    Reads from data/zip_boundaries/{zip_code}.geojson. Returns None if file missing or invalid.
    """
    path = Path(boundaries_dir) / f"{zip_code}.geojson"
    if not path.exists():
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if data.get('type') == 'Feature':
            geom = data.get('geometry')
        elif data.get('type') == 'FeatureCollection':
            features = data.get('features', [])
            if not features:
                return None
            geom = features[0].get('geometry')
        else:
            geom = data
        if not geom:
            return None
        gtype = _normalize_geom_type(geom.get("type"))
        if gtype and geom.get("coordinates"):
            geom = {"type": gtype, "coordinates": geom["coordinates"]}
        return shape(geom)
    except Exception:
        return None


def zones_intersecting_zip(zip_polygon: Any, zones: List[Dict]) -> List[Dict]:
    """Return list of zones whose boundary polygon intersects the zip polygon. Uses WGS84 (zones transformed if projected)."""
    result = []
    for zone in zones:
        geom = _boundary_to_shapely_wgs84(zone)
        if geom is None:
            continue
        try:
            if zip_polygon.intersects(geom):
                result.append(zone)
        except Exception:
            continue
    return result


# Simplify tolerance in degrees (~5m) - speeds up polygon intersection without visible loss
_SIMPLIFY_TOLERANCE = 0.00005


def zones_intersecting_zip_diagnostic(zip_polygon: Any, zones: List[Dict]) -> Tuple[List[Dict], Dict]:
    """
    Same as zones_intersecting_zip but also returns diagnostic counts.
    Uses STRtree spatial index for fast intersection queries (avoids O(n) full scan).
    Attaches _shapely_geom to each zone to avoid re-parsing in zone_geometry_in_zip.
    """
    zones_with_geom = 0
    zone_list = []
    geom_list = []
    for zone in zones:
        geom = zone.get('_shapely_geom')
        if geom is None:
            geom = _boundary_to_shapely_wgs84(zone)
        if geom is None:
            continue
        zones_with_geom += 1
        zone['_shapely_geom'] = geom
        zone_list.append(zone)
        geom_list.append(geom)
    if not geom_list:
        diag = {"zones_total": len(zones), "zones_with_geometry": 0, "intersecting_count": 0}
        return [], diag
    try:
        tree = STRtree(geom_list)
        indices = tree.query(zip_polygon, predicate="intersects")
        if hasattr(indices, 'tolist'):
            indices = indices.tolist()
        elif not isinstance(indices, list):
            indices = list(indices)
        result = [zone_list[i] for i in indices]
    except Exception:
        result = []
        for zone, geom in zip(zone_list, geom_list):
            try:
                if zip_polygon.intersects(geom):
                    result.append(zone)
            except Exception:
                continue
    diag = {"zones_total": len(zones), "zones_with_geometry": zones_with_geom, "intersecting_count": len(result)}
    return result, diag


def group_zones_by_district(zones: List[Dict]) -> List[Dict]:
    """Group zones by school_district. Returns list of { district_id, district_name, zones }."""
    by_district = {}
    for z in zones:
        d = (z.get('school_district') or '').strip() or 'Unknown'
        if d not in by_district:
            by_district[d] = []
        by_district[d].append(z)
    return [
        {'district_id': d, 'district_name': d if d != 'Unknown' else 'Unknown', 'zones': zlist}
        for d, zlist in by_district.items()
    ]


def zone_geometry_in_zip(zip_polygon: Any, zone: Dict) -> Optional[Dict]:
    """Clip a single zone to the zip polygon. Returns GeoJSON geometry or None.
    Filters out degenerate (zero-area) results that would render invisibly.
    Uses zone['_shapely_geom'] if set (from zones_intersecting_zip_diagnostic) to avoid re-parsing.
    Uses full-precision geometry (no simplify) so adjacent zone boundaries align correctly."""
    geom = zone.get('_shapely_geom')
    if geom is None:
        geom = _boundary_to_shapely_wgs84(zone)
    if geom is None:
        return None
    try:
        inter = zip_polygon.intersection(geom)
        if inter.is_empty:
            return None
        if hasattr(inter, 'area') and inter.area < 1e-12:
            return None
        return mapping(inter)
    except Exception:
        return None


def district_geometry_in_zip(zip_polygon: Any, district_zones: List[Dict]) -> Optional[Dict]:
    """
    Compute the part of the zip that lies in this district (intersection of zip with each zone, unioned).
    Returns GeoJSON geometry in WGS84 (plottable on web maps).
    """
    pieces = []
    for z in district_zones:
        geom = z.get('_shapely_geom') or _boundary_to_shapely_wgs84(z)
        if geom is None:
            continue
        try:
            inter = zip_polygon.intersection(geom)
            if not inter.is_empty:
                pieces.append(inter)
        except Exception:
            continue
    if not pieces:
        return None
    try:
        merged = unary_union(pieces)
        if merged.is_empty:
            return None
        return mapping(merged)
    except Exception:
        return None
