"""Which birds are expected in each part of the US, Canada and Mexico.

Reads iNaturalist's open range maps (the "geomodel", one multipolygon per
species, drawn from H3 resolution-4 hexagons) and Natural Earth's country
outlines, and writes:

  <data>/ranges/region.json   the resolution-4 hexagons that make up the area
  <data>/ranges/species.json  every bird species expected somewhere in it,
                              with the number of hexagons it is expected in
  <data>/ranges/cells.json    hexagon -> the taxon ids of the birds expected

Usage: .venv/bin/python tools/ranges.py <data folder>

The data folder holds the downloads and is kept out of the repository:
  inat/iNaturalist_geomodel_Aves_*.gpkg  from s3://inaturalist-open-data/geomodel/geopackages/latest/
  ne/countries50.geojson                 Natural Earth 1:50m admin-0 countries
"""

import glob
import json
import os
import sqlite3
import struct
import sys

import h3
import numpy as np
import shapely
from shapely.geometry import shape

RES = 4
COUNTRIES = {"United States of America", "Canada", "Mexico"}


def region_shape(path):
    """The three countries, without Hawaii, as one shapely geometry."""
    with open(path, encoding="utf-8") as f:
        features = json.load(f)["features"]
    parts = []
    for feature in features:
        if feature["properties"].get("ADMIN") not in COUNTRIES:
            continue
        geometry = shape(feature["geometry"])
        polygons = list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]
        for polygon in polygons:
            centre = polygon.representative_point()
            # Hawaii: the islands in the Pacific south of 30 N and west of 150 W.
            if centre.x < -150 and centre.y < 30:
                continue
            parts.append(polygon)
    return shapely.union_all(parts)


def region_cells(region):
    """Every resolution-4 hexagon that touches the area, so coasts and
    borders aren't left silent."""
    cells = set()
    polygons = list(region.geoms) if region.geom_type == "MultiPolygon" else [region]
    for polygon in polygons:
        cells |= set(h3.h3shape_to_cells_experimental(h3.geo_to_h3shape(polygon), RES, contain="overlap"))
    return sorted(cells)


def gpkg_geometry(blob):
    """A GeoPackage geometry blob: a small header, an optional envelope, then WKB."""
    flags = blob[3]
    envelope = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(flags >> 1) & 7]
    return shapely.from_wkb(blob[8 + envelope:])


def main(data):
    out = os.path.join(data, "ranges")
    os.makedirs(out, exist_ok=True)

    region = region_shape(os.path.join(data, "ne", "countries50.geojson"))
    cells = region_cells(region)
    print(f"{len(cells)} resolution-{RES} hexagons in the area")
    lats, lngs = np.array([h3.cell_to_latlng(c) for c in cells]).T
    west, south, east, north = region.bounds

    expected = {cell: [] for cell in cells}
    species = []
    versions = set()
    for path in sorted(glob.glob(os.path.join(data, "inat", "iNaturalist_geomodel_Aves_*.gpkg"))):
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        table = db.execute("select table_name from gpkg_contents").fetchone()[0]
        rows = db.execute(f'select taxon_id, name, rank, geomodel_version, geom from "{table}"')
        for taxon_id, name, rank, version, blob in rows:
            if rank != "species" or blob is None:
                continue
            geometry = gpkg_geometry(blob)
            gw, gs, ge, gn = geometry.bounds
            if ge < west or gw > east or gn < south or gs > north:
                continue
            shapely.prepare(geometry)
            # The range is made of whole hexagons, so a hexagon is in it
            # exactly when its centre is.
            inside = shapely.contains_xy(geometry, lngs, lats)
            count = int(inside.sum())
            if not count:
                continue
            versions.add(version)
            species.append({"taxon": taxon_id, "name": name, "cells": count})
            for i in np.nonzero(inside)[0]:
                expected[cells[i]].append(taxon_id)
        db.close()

    species.sort(key=lambda s: s["name"])
    empty = sum(1 for v in expected.values() if not v)
    print(f"{len(species)} species; geomodel version(s) {sorted(versions)}; {empty} hexagons with no birds")
    with open(os.path.join(out, "region.json"), "w") as f:
        json.dump({"res": RES, "cells": cells, "geomodel": sorted(versions)}, f)
    with open(os.path.join(out, "species.json"), "w") as f:
        json.dump(species, f, indent=0)
    with open(os.path.join(out, "cells.json"), "w") as f:
        json.dump(expected, f)


if __name__ == "__main__":
    main(sys.argv[1])
