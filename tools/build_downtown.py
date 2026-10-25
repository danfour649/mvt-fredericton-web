#!/usr/bin/env python3
"""Build public/data/downtown.json for MVT Fredericton Web.

Pulls the downtown Fredericton game dataset (buildings + roads) from GeoNB's
public ArcGIS services — the same sources and bbox as the maps-of-nb downtown
game-mesh extract (maps-of-nb/scripts/extract_game_mesh.py, W -66.652,
S 45.955, E -66.628, N 45.97).

Differences from the maps-of-nb extractor: no orderByFields (the buildings
service rejects OBJECTID_1 there with HTTP 400) and the bbox is queried in a
3x3 grid so every cell stays under the service transfer limit; features are
deduped across cell borders.

Output is ONE JSON file in lon/lat (EPSG:4326). The game core projects it to
local metres at load (src/core/geo.ts); nothing game-shaped is baked here.

GeoNB data is distributed under the Open Government Licence - New Brunswick.
Stdlib only.
"""
import json, subprocess, sys
from pathlib import Path

REST = "https://geonb.snb.ca/arcgis/rest/services"
BBOX = (-66.652, 45.955, -66.628, 45.97)  # W,S,E,N
LAYERS = {
    "buildings": ("GeoNB_SNB_Buildings", 0, "min_g_elev,max_b_elev"),
    "roads": ("GeoNB_Basemap_NBRN", 1, "Number_Of_Lanes,Route_Name_English_1,Formatted_Street_Name,Func_Road_Class,Speed_Restrictions_Both,Dir_of_Traffic_Flow,Road_Segment_ID"),
}

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

def round_coords(obj, nd=6):
    if isinstance(obj, float):
        return round(obj, nd)
    if isinstance(obj, list):
        return [round_coords(x) for x in obj]
    return obj

def main():
    w, s, e, n = BBOX
    gx, gy = 3, 3
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
    out = Path(__file__).resolve().parent.parent / "public" / "data" / "downtown.json"
    doc = {
        "meta": {
            "source": "GeoNB ArcGIS services (GeoNB_SNB_Buildings, GeoNB_Basemap_NBRN) via tools/build_downtown.py; same bbox/sources as maps-of-nb downtown game-mesh extract",
            "licence": "Open Government Licence - New Brunswick (GeoNB data)",
            "bbox": list(BBOX),
            "counts": {k: len(v["features"]) for k, v in result.items()},
        },
        "buildings": result["buildings"],
        "roads": result["roads"],
    }
    out.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size/1e6:.2f} MB)")

if __name__ == "__main__":
    main()
