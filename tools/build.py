"""Puts the site's bird data together from the downloads.

Reads, from the data folder:
  ranges/species.json, ranges/cells.json   (tools/ranges.py)
  xc/chosen.json, xc/unmatched.json        (tools/xenocanto.py choose)
  clips/clips.json, clips/*.mp3            (tools/clips.py)
  inat/photos.json, inat/photos/*          (tools/photos.py)

Writes, in the repository:
  audio/<taxon>.mp3          the clips
  img/birds/<taxon>.<ext>    the photos, as iNaturalist served them
  data/birds.json            the catalogue: every bird with a clip, in a
                             fixed order (by iNaturalist taxon id)
  data/ranges/<tile>.json    for each H3 resolution-2 tile, its
                             resolution-4 hexagons and, as a bitset over
                             the catalogue, the birds expected in each
  library/species.json       every species in range, and whether it made
                             it in, and if not, why: for sorting out later

Usage: .venv/bin/python tools/build.py <data folder> <repository>
"""

import base64
import json
import os
import shutil
import sys
from collections import defaultdict

import h3

VERSION = "1.0"
TILE_RES = 2


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def licence_code(url):
    """https://creativecommons.org/licenses/by-nc-sa/4.0/ -> by-nc-sa 4.0"""
    parts = [p for p in (url or "").split("/") if p]
    if "licenses" in parts:
        i = parts.index("licenses")
        return " ".join(parts[i + 1:i + 3])
    if "publicdomain" in parts:
        return "cc0"
    return url or ""


def main(data, repo):
    species = load(os.path.join(data, "ranges", "species.json"))
    cells = load(os.path.join(data, "ranges", "cells.json"))
    region = load(os.path.join(data, "ranges", "region.json"))
    chosen = {b["taxon"]: b for b in load(os.path.join(data, "xc", "chosen.json"))}
    unmatched = {b["taxon"]: b for b in load(os.path.join(data, "xc", "unmatched.json"))}
    clips = load(os.path.join(data, "clips", "clips.json"))
    photos = {p["taxon"]: p for p in load(os.path.join(data, "inat", "photos.json"))}
    photo_files = {int(os.path.splitext(f)[0]): f for f in os.listdir(os.path.join(data, "inat", "photos"))}

    audio_dir = os.path.join(repo, "audio")
    image_dir = os.path.join(repo, "img", "birds")
    for folder in (audio_dir, image_dir, os.path.join(repo, "data", "ranges"), os.path.join(repo, "library")):
        os.makedirs(folder, exist_ok=True)

    library = []
    birds = []
    for bird in sorted(species, key=lambda b: b["taxon"]):
        taxon = bird["taxon"]
        rec = chosen.get(taxon)
        clip = clips.get(str(taxon))
        photo = photos.get(taxon, {})
        status = {"taxon": taxon, "name": bird["name"], "en": photo.get("en"), "hexagons": bird["cells"]}
        if not rec:
            status["why"] = unmatched.get(taxon, {}).get("why", "no recording chosen")
        elif not clip or clip.get("xc") != rec["xc"]:
            status["why"] = "recording not downloaded or not cut yet"
        library.append(status)
        if "why" in status:
            continue
        shutil.copyfile(os.path.join(data, "clips", f"{taxon}.mp3"), os.path.join(audio_dir, f"{taxon}.mp3"))
        entry = {
            "taxon": taxon,
            "name": photo.get("en") or rec.get("en") or bird["name"],
            "sci": bird["name"],
            "clip": f"../audio/{taxon}.mp3",
            "rec": {
                "xc": rec["xc"],
                "by": rec.get("rec"),
                "lic": licence_code(rec.get("lic")),
                "licUrl": rec.get("lic"),
                "type": rec.get("type"),
                "where": rec.get("cnt"),
                "sono": rec.get("sono"),
                "at": clip.get("start"),
            },
        }
        if taxon in photo_files and photo.get("photo"):
            shutil.copyfile(os.path.join(data, "inat", "photos", photo_files[taxon]), os.path.join(image_dir, photo_files[taxon]))
            entry["photo"] = f"../img/birds/{photo_files[taxon]}"
            entry["photoBy"] = photo["photo"].get("attribution")
            entry["photoLic"] = photo["photo"].get("licence")
            entry["inat"] = photo.get("inat")
        birds.append(entry)

    index = {b["taxon"]: i for i, b in enumerate(birds)}
    size = (len(birds) + 7) // 8
    tiles = defaultdict(dict)
    for cell, taxa in cells.items():
        bits = bytearray(size)
        for taxon in taxa:
            i = index.get(taxon)
            if i is not None:
                bits[i // 8] |= 128 >> (i % 8)
        tiles[h3.cell_to_parent(cell, TILE_RES)][cell] = base64.b64encode(bytes(bits)).decode()
    ranges_dir = os.path.join(repo, "data", "ranges")
    for name in os.listdir(ranges_dir):
        os.remove(os.path.join(ranges_dir, name))
    for tile, content in tiles.items():
        with open(os.path.join(ranges_dir, f"{tile}.json"), "w") as f:
            json.dump(content, f, separators=(",", ":"))

    with open(os.path.join(repo, "data", "birds.json"), "w", encoding="utf-8") as f:
        json.dump({
            "version": VERSION,
            "geomodel": region.get("geomodel"),
            "tileRes": TILE_RES,
            "tiles": sorted(tiles),
            "birds": birds,
        }, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(repo, "library", "species.json"), "w", encoding="utf-8") as f:
        json.dump(library, f, ensure_ascii=False, indent=1)
    missing = sum(1 for s in library if "why" in s)
    print(f"{len(birds)} birds in the catalogue, {missing} species set aside; {len(tiles)} range tiles")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
