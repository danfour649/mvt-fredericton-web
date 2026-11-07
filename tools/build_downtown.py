#!/usr/bin/env python3
"""Build public/data/downtown.json for MVT Fredericton Web.

Pulls the Fredericton game dataset (buildings + roads + water)
from GeoNB's public ArcGIS services — the same sources as the
maps-of-nb downtown game-mesh extract (maps-of-nb/scripts/extract_game_mesh.py).

STAGE 1 (2026-11-07, MVTF6 backport): the bbox grew from the old
downtown-only extract (W -66.652, S 45.955, E -66.628, N 45.97;
219 roads / 1,225 buildings) to greater Fredericton — Northside/
Devon across both bridges, College Hill / UNB, Forest Hill —
W -66.675, S 45.938, E -66.605, N 45.985 (1,478 roads / 11,643
buildings). The south edge is set by the Princess Margaret Bridge:
MVTF6's deck for it spans lat 45.940-45.943, so any south edge
north of ~45.943 silently drops the whole crossing (NBRN segment
11045395). Coordinates are rounded to 5dp (~1 m) — at 6dp the
expanded file's gzip size grew ~15% for no playable difference.

Differences from the maps-of-nb extractor: no orderByFields (the buildings
service rejects OBJECTID_1 there with HTTP 400) and the bbox is queried in a
3x3 grid so every cell stays under the service transfer limit; features are
deduped across cell borders.

WATER (v0.28): the Saint John River was missing from the game entirely —
neither the PMTiles stack (buildings/contours/roads/wetlands only) nor
this extract carried open water; the GeoNB "wetlands" layer is the
regulated marsh/bog inventory, NOT hydrography. Water bodies now come
from GeoNB_DNR_NBHN (NB Hydrographic Network) layer 13 "Water Bodies".
The river features are province-scale polygons (tens of km of bank), so
unlike buildings/roads they are CLIPPED to a padded bbox and simplified
(Douglas-Peucker, 1.5 m) before baking — a few hundred points total.

Output is ONE JSON file in lon/lat (EPSG:4326). The game core projects it to
local metres at load (src/core/geo.ts); nothing game-shaped is baked here.

GeoNB data is distributed under the Open Government Licence - New Brunswick.
Stdlib only.
"""
import json, math, subprocess, sys
from pathlib import Path

REST = "https://geonb.snb.ca/arcgis/rest/services"
BBOX = (-66.675, 45.938, -66.605, 45.985)  # W,S,E,N — Stage 1 (see header)
LAYERS = {
    "buildings": ("GeoNB_SNB_Buildings", 0, "min_g_elev,max_b_elev"),
    "roads": ("GeoNB_Basemap_NBRN", 1, "Number_Of_Lanes,Route_Name_English_1,Formatted_Street_Name,Func_Road_Class,Speed_Restrictions_Both,Dir_of_Traffic_Flow,Road_Segment_ID"),
}
WATER_SERVICE, WATER_LAYER = "GeoNB_DNR_NBHN", 13  # "Water Bodies" polygons
WATER_PAD_DEG = 0.002   # clip margin around the bbox (~200 m)
WATER_SIMPLIFY_M = 1.5  # Douglas-Peucker tolerance, metres

def curl_json(url, params):
    args = ["curl", "-sS", "--fail", "--retry", "3", "--max-time", "120", "-H", "User-Agent: mvt-fredericton-web/0.1"]
    for k, v in params.items():
        args += ["--data-urlencode", f"{k}={v}"]
    args.append(url)
    out = subprocess.run(args, capture_output=True, text=True, timeout=150)
    if out.returncode != 0:
        raise RuntimeError(f"curl failed: {out.stderr.strip()[:200]}")
    return json.loads(out.stdout)

def query_cell(service, layer, fields, env):
    url = f"{REST}/{service}/MapServer/{layer}/query"
    feats, offset = [], 0
    while True:
        gj = curl_json(url, {
            "where": "1=1", "geometry": ",".join(str(x) for x in env),
            "geometryType": "esriGeometryEnvelope", "inSR": "4326", "outSR": "4326",
            "outFields": fields, "returnGeometry": "true", "f": "geojson",
            "resultRecordCount": "2000", "resultOffset": str(offset),
            "spatialRel": "esriSpatialRelIntersects",
        })
        if "error" in gj:
            raise RuntimeError(f"{service}/{layer}: {gj['error']}")
        batch = gj.get("features", [])
        feats.extend(batch)
        if len(batch) < 2000:
            return feats
        offset += len(batch)

def round_coords(obj, nd=5):
    if isinstance(obj, float):
        return round(obj, nd)
    if isinstance(obj, list):
        return [round_coords(x) for x in obj]
    return obj

# --- water: clip + simplify -------------------------------------------------
# Metres per degree at the bbox centre latitude (for DP distances only).
_MLAT = 111132.92 - 559.82 * math.cos(2 * math.radians(45.9625))
_MLON = 111412.84 * math.cos(math.radians(45.9625))

def _clip_ring(ring, w, s, e, n):
    """Sutherland-Hodgman clip of one ring against the rect (convex, so
    clipping outer rings and holes independently is valid)."""
    def clip(poly, inside, inter):
        if not poly:
            return poly
        out, prev = [], poly[-1]
        pin = inside(prev)
        for cur in poly:
            cin = inside(cur)
            if cin:
                if not pin:
                    out.append(inter(prev, cur))
                out.append(cur)
            elif pin:
                out.append(inter(prev, cur))
            prev, pin = cur, cin
        return out
    def ix(a, b, x):
        t = (x - a[0]) / (b[0] - a[0]) if b[0] != a[0] else 0.0
        return [x, a[1] + (b[1] - a[1]) * t]
    def iy(a, b, y):
        t = (y - a[1]) / (b[1] - a[1]) if b[1] != a[1] else 0.0
        return [a[0] + (b[0] - a[0]) * t, y]
    poly = ring[:-1] if ring[0] == ring[-1] else list(ring)
    for inside, inter in (
        (lambda p: p[0] >= w, lambda a, b: ix(a, b, w)),
        (lambda p: p[0] <= e, lambda a, b: ix(a, b, e)),
        (lambda p: p[1] >= s, lambda a, b: iy(a, b, s)),
        (lambda p: p[1] <= n, lambda a, b: iy(a, b, n)),
    ):
        poly = clip(poly, inside, inter)
    if poly and poly[0] != poly[-1]:
        poly.append(list(poly[0]))
    return poly

def _simplify(ring, tol_m):
    """Douglas-Peucker on a closed ring (first point kept as the seam)."""
    pts = ring[:-1] if ring[0] == ring[-1] else list(ring)
    if len(pts) <= 3:
        return ring
    mp = [(p[0] * _MLON, p[1] * _MLAT) for p in pts]
    keep = {0, len(pts) - 1}
    far = max(range(len(pts)), key=lambda i: (mp[i][0] - mp[0][0]) ** 2 + (mp[i][1] - mp[0][1]) ** 2)
    keep.add(far)
    stack = [(0, far), (far, len(pts) - 1)]
    while stack:
        i0, i1 = stack.pop()
        ax, ay = mp[i0]
        bx, by = mp[i1]
        dx, dy = bx - ax, by - ay
        seg = math.hypot(dx, dy)
        dmax, idx = tol_m, -1
        for i in range(i0 + 1, i1):
            px, py = mp[i]
            dist = abs((px - ax) * dy - (py - ay) * dx) / seg if seg else math.hypot(px - ax, py - ay)
            if dist > dmax:
                dmax, idx = dist, i
        if idx > 0:
            keep.add(idx)
            stack.append((i0, idx))
            stack.append((idx, i1))
    out = [pts[i] for i in sorted(keep)]
    out.append(list(out[0]))
    return out

def fetch_water():
    """Saint John River polygons from NBHN, clipped to the padded bbox."""
    w, s, e, n = BBOX
    pad = WATER_PAD_DEG
    feats = query_cell(WATER_SERVICE, WATER_LAYER, "NAME1", (w, s, e, n))
    out = []
    for f in feats:
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        new_polys = []
        for poly in polys:
            rings = []
            for ring in poly:
                c = _clip_ring(ring, w - pad, s - pad, e + pad, n + pad)
                if len(c) < 4:
                    continue
                c = _simplify(c, WATER_SIMPLIFY_M)
                if len(c) >= 4:
                    rings.append(round_coords(c))
            if rings:
                new_polys.append(rings)
        if not new_polys:
            continue
        geom = (
            {"type": "Polygon", "coordinates": new_polys[0]}
            if len(new_polys) == 1
            else {"type": "MultiPolygon", "coordinates": new_polys}
        )
        name = (f.get("properties") or {}).get("NAME1")
        out.append({"type": "Feature", "geometry": geom, "properties": {"NAME1": name} if name else {}})
    return out

def main():
    w, s, e, n = BBOX
    gx, gy = 6, 4
    result = {}
    for name, (service, layer, fields) in LAYERS.items():
        seen, feats = set(), []
        for i in range(gx):
            for j in range(gy):
                env = (w + (e-w)*i/gx, s + (n-s)*j/gy, w + (e-w)*(i+1)/gx, s + (n-s)*(j+1)/gy)
                for f in query_cell(service, layer, fields, env):
                    key = json.dumps(f["geometry"], sort_keys=True)
                    if key in seen:
                        continue
                    seen.add(key)
                    f["geometry"]["coordinates"] = round_coords(f["geometry"]["coordinates"])
                    f["properties"] = {k: v for k, v in (f.get("properties") or {}).items() if v not in (None, "None", " ")}
                    feats.append(f)
        result[name] = {"type": "FeatureCollection", "features": feats}
        print(f"{name}: {len(feats)} features")
    water = fetch_water()
    result["water"] = {"type": "FeatureCollection", "features": water}
    print(f"water: {len(water)} features")
    out = Path(__file__).resolve().parent.parent / "public" / "data" / "downtown.json"
    doc = {
        "meta": {
            "source": "GeoNB ArcGIS services (GeoNB_SNB_Buildings, GeoNB_Basemap_NBRN, GeoNB_DNR_NBHN water bodies) via tools/build_downtown.py; same sources as maps-of-nb downtown game-mesh extract, Stage 1 expanded bbox",
            "licence": "Open Government Licence - New Brunswick (GeoNB data)",
            "bbox": list(BBOX),
            "counts": {k: len(v["features"]) for k, v in result.items()},
        },
        "buildings": result["buildings"],
        "roads": result["roads"],
        "water": result["water"],
    }
    out.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size/1e6:.2f} MB)")

if __name__ == "__main__":
    main()
