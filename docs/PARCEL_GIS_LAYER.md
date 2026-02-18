# Adding Parcel (GIS) Data as a Secondary Filter

## What You Want

1. **Initial step (already in place):** City search → see census block groups, apply filters (income, population, school scores, employment, etc.).
2. **New step:** After narrowing to block groups you like, add a **secondary filter** that:
   - Shows **parcels** only within those selected/liked census blocks.
   - Lets you filter parcels by **land acreage** (e.g. min/max acres) and optionally other attributes (land use, zoning, etc.).

## Difficulty Overview

| Piece | Difficulty | Notes |
|-------|-------------|--------|
| **Data sourcing** | Medium–High | Parcel data is county-by-county; you need a source and ETL. |
| **Data model & ETL** | Medium | New `parcels` table, import from shapefile/GeoJSON, acreage (and optional columns). |
| **Backend API** | Low–Medium | One new endpoint + PostGIS spatial query; your stack already supports this. |
| **Frontend** | Medium | “Selected block groups” state, parcel layer, parcel filters (acreage), draw parcel polygons. |

**Overall: medium.** The app already has PostGIS, block-group geometry, filters, and map layers. The main unknowns are **where you get parcel data** and **how much area** you need (one county vs many).

---

## 1. Data Side

### Where parcel data comes from

- **County GIS / tax assessors:** Parcel layers are usually maintained by counties (shapefile or GeoJSON). NC counties often publish parcel data; formats and licenses vary.
- **State / regional aggregators:** Some states or regional councils publish statewide or multi-county parcel datasets (e.g. NC OneMap, or commercial providers).
- **Attributes you’ll want:** At minimum: **geometry** (polygon), **acreage** (or area in sq ft so you can compute acres). Optional: parcel ID, land use, zoning, address, owner.

### What you need in the DB

- A **parcels** table (or similar) with at least:
  - `id` (primary key)
  - `parcel_id` or equivalent (county identifier)
  - `geometry` (PostGIS `GEOMETRY`, SRID 4326 to match your block groups)
  - `acreage` (or `area_sqft` and compute acres in API/UI)
  - Optional: `county_fips`, `land_use`, `zoning`, `address`
- ETL: script(s) to load shapefile/GeoJSON into this table (e.g. geopandas → insert, or `shp2pgsql` / `ogr2ogr`). You already have patterns for this (e.g. `import_meck_zones.py`, `populate_census_block_groups.py`).

---

## 2. Backend (Flask + PostGIS)

### “Parcels within selected block groups” + acreage filter

- **New endpoint**, e.g. `GET /api/parcels` with:
  - `geoid` — one or more census block group GEOIDs (e.g. `geoid=370199501001,370199501002`).
  - `min_acres` / `max_acres` (optional).
- **Query logic:**
  - Restrict to parcels that **intersect** (or are **within**) the union of the selected block group geometries.
  - PostGIS example (conceptually):
    - Option A: `WHERE ST_Intersects(p.geometry, cbg.geometry) AND cbg.geoid = ANY(:geoids)` (join to `census_block_groups`).
    - Option B: build a single geometry from the selected GEOIDs (e.g. `ST_Union` of block group geometries), then `WHERE ST_Intersects(p.geometry, :union_geom)`.
  - Add `AND p.acreage >= :min_acres AND p.acreage <= :max_acres` when provided.
- **Return:** GeoJSON (or list of features with `geometry` + `acreage`, etc.) so the frontend can draw parcel polygons.

Your existing `get_census_block_groups` already uses `ST_Contains`, `ST_Intersects`, and `ST_AsGeoJSON`; the same patterns apply here.

---

## 3. Frontend (Map + Filters)

### “Selected” or “liked” block groups

- Today: user searches city/zip/address and applies filters; the map shows matching block groups. There is no explicit “selection” of block groups.
- To support “parcels within blocks I like” you need a way to **mark** which block groups are “selected”:
  - **Option A:** “Add to selection” when clicking a block group (store a list of GEOIDs in JS state; optional “Clear selection”).
  - **Option B:** “Use current map results” — treat all block groups currently shown (after search + filters) as the set. No extra click-to-select; “Show parcels” means “parcels in any of the currently displayed block groups.”
- Option B is simpler (no new “selection” UI); Option A is more flexible (user can manually include/exclude blocks).

### Parcel layer and filters

- **Layer:** “Parcels” checkbox (like “Census Block / Zip Boundaries”). When enabled:
  - If you have selected GEOIDs (or “current” block group GEOIDs), call `GET /api/parcels?geoid=...&min_acres=...&max_acres=...`.
  - Draw returned parcel polygons on the map (same approach as block group boundaries: GeoJSON → polygons with a distinct style).
- **Filter panel:** “Parcel filters” section:
  - Min acres: number input.
  - Max acres: number input.
  - “Apply” or live-update when layer is on.
- **Info window:** Clicking a parcel could show acreage, parcel ID, and any other attributes you expose.

---

## 4. Implementation Order

1. **Source and load parcel data** for at least one county (e.g. Mecklenburg) into a `parcels` table with `geometry` and `acreage` (or area).
2. **Add `GET /api/parcels`** with `geoid` (and optional `min_acres`/`max_acres`), using PostGIS to limit to parcels intersecting (or within) the given block group(s).
3. **Frontend:** Decide “selected block groups” (current results vs click-to-select). Then add parcel layer + acreage filters and wire them to the new API.

Once parcels are in the DB and the API works, the frontend is mostly reusing your existing patterns (layer toggles, filter panel, GeoJSON drawing).

---

## 5. Time Estimate: NC Statewide

| Scenario | Effort | Notes |
|----------|--------|--------|
| **One county (e.g. Mecklenburg)** | **~1 week** | One parcel source, one ETL pipeline, API + frontend. |
| **NC statewide (100 counties)** | **~2–4 weeks** | Most of the work is data, not app code. |

**Why statewide is heavier**

- Parcel data is maintained **per county**. NC has 100 counties; each may have different:
  - Download format (shapefile, GeoJSON, FGDB, REST)
  - Schema (parcel ID, acreage vs area_sqft, land use field names)
  - Update frequency and licensing
- You either:
  - **Aggregate from 100 sources:** discover, download, normalize schema, fix geometry (SRID, validity), load. That’s typically **2–3 weeks** of ETL and QA, plus **~1 week** for API + frontend.
  - **Use a single statewide or vendor source:** If NC OneMap or a commercial vendor (e.g. CoreLogic, Regrid) offers a single NC parcel dataset, ETL drops to **~1 week** and total build is closer to **~2 weeks**.

So: **~2–4 weeks for NC-only** is a reasonable range, with the high end if you’re stitching counties yourself and the low end if you have one clean statewide/vendor source.

---

## 6. Alternative: Export Blocks → LandVision

**Idea:** Keep your app as the “filter to good census blocks” tool; then **export** those blocks and open them in **LandVision** (or similar) as a layer. Use LandVision for parcel data, acreage filters, and site-level work.

### Workflow

1. In your app: city search → apply filters (income, schools, employment, etc.) → map shows only block groups that pass.
2. **Export:** “Export selected block groups” → download a file (GeoJSON or shapefile) with:
   - Block group boundaries (geometry)
   - GEOID and any key attributes (e.g. population, MHI, school scores) so LandVision can display or filter.
3. In **LandVision:** Import that file as a **custom layer** (e.g. “NC blocks – our criteria”).
4. In LandVision: turn on **parcels** (and any other layers), use its **acreage/parcel filters** to find sites inside your block group layer.

### Pros

- **No parcel ETL or hosting:** LandVision already has parcel data; you don’t build or maintain a parcels table.
- **Faster to value:** Export feature can be done in **~2–4 days** (button + API that returns current filtered block groups as GeoJSON/shapefile). No need to source or load NC parcel data.
- **Fits how many shops work:** Site selection in your tool → detailed parcel/ownership work in a dedicated platform.
- **One export, many uses:** Same export can be used in LandVision, QGIS, or other GIS tools.

### Cons

- **Two tools:** Users leave your app for parcel-level analysis; not a single integrated experience.
- **LandVision license:** Requires LandVision (or similar) subscription.
- **Manual step:** Export → open LandVision → import layer (can be documented; optional: “Open in LandVision” link or instructions).

### What’s built in the app (LandVision path)

- **Export endpoint:** `GET /api/census-block-groups/export?format=shapefile` or `format=geojson`, with the **same query params** as the map (city, state, zip_code, lat, lng, min_income, min_population, school scores, employment scores, etc.). Returns either a **ZIP** (shapefile) or a **GeoJSON** file.
- **UI:** **“Export for LandVision”** button in the Actions panel. Search by city/zip/address, apply filters, then click to download a LandVision-ready shapefile ZIP (or use `format=geojson` for other GIS tools).
- **Shapefile details:** ZIP contains `.shp`, `.shx`, `.dbf`, `.prj` at the **top level** (no nested folder), WGS84 projection. Polygons are simplified if they exceed LandVision’s 10,000 vertices per polygon limit. Attributes include geoid, tract, blk_grp, pop, med_age, mhi, school ratings (elem_r, mid_r, high_r), les, eas.

### How to add the export as a layer in LandVision

1. In your app: run a **city/zip/address search**, apply any **filters** (income, schools, employment), then click **“Export for LandVision”**. The browser downloads a ZIP (e.g. `block_groups_landvision_YYYYMMDD_HHMM.zip`).
2. In **LandVision:**  
   - Click the **Layers** icon on the toolbar.  
   - Click **More Layers** at the bottom of the Layers panel.  
   - Choose a folder (USER for just you, SHARE for the team) or create one.  
   - Open the **Load Data** dropdown and select **Shapefile**.  
   - Give the layer a name (e.g. “NC block groups – our criteria”).  
   - Click **Choose File** and select your **ZIP file** (the one from the app; do **not** put the files in a subfolder inside the ZIP).  
   - Click **Upload**, then **Add Layer to Map** when it’s done.
3. In LandVision you can now turn on **Parcels** (and other layers) and use its **acreage/parcel filters** to find sites inside the block groups that passed your criteria.

**LandVision shapefile rules (we follow these):**  
- ZIP must contain only the four files (`.shp`, `.shx`, `.dbf`, `.prj`) with **no nested folders**.  
- Max **30 MB** per ZIP.  
- Max **10,000 vertices per polygon** (we simplify automatically if over that).

---

## 7. NC Parcel Data Hints

- **NC OneMap / NC State:** Sometimes has links to county parcel data or statewide compilations.
- **County GIS:** Mecklenburg, Wake, etc. often have parcel shapefiles or services; check county GIS or tax assessor sites.
- **Licensing:** Confirm terms of use (internal vs commercial, attribution).

---

## Summary

| Approach | NC statewide (approx.) | Best when |
|----------|-------------------------|-----------|
| **Build parcel layer in your app** | **2–4 weeks** (driven by parcel data ETL) | You want one integrated tool and are okay sourcing/loading NC parcel data (or using a vendor). |
| **Export blocks → LandVision** | **~2–4 days** (export API + download button + docs) | You already use (or will use) LandVision; parcel data and acreage filters stay in LandVision. |

- **In-app parcels:** Feasible; main effort is parcel data and ETL; API + frontend reuse your existing patterns.
- **LandVision path:** Much faster; your app stays the “filter to good blocks” step; LandVision is the parcel/acreage layer. Add an export that uses the same filters as the map so the file matches what the user sees.

If you tell me which path you prefer (in-app parcels vs export for LandVision), I can outline the exact API and UI (e.g. export endpoint contract, or “selected blocks” + parcel layer).
