# what3birdsongs

Every place in the US, Canada and Mexico is three birds expected there. Pick two places and hear the trip between them.

> **Preview text.** This README and the page's explanations were written by Claude, Anthropic's AI model, while building the project. They are for preview only and have not yet been reviewed.

what3birdsongs grew out of [what3chords songs](https://github.com/jethatch/what3chords-songs), a recreation of [what3chords](https://github.com/DOSull/what3chords) by David O'Sullivan, Luke Bergmann, Jim Thatcher and Nick Lally: a satire of what3words that gives every square metre of the Earth three guitar chords. Here the vocabulary comes from the place instead. Each spot gets three birds from those expected around it, and each bird sings in a recording someone made and shared.

## What it does

- **Three birds for every place.** The area is divided into H3 resolution-4 hexagons (about 1,770 km²), each with the list of birds that iNaturalist's range maps expect there. Within its hexagon, each spot gets three different birds from that list, picked by shuffling the finer part of its H3 address, the way what3chords picks chords: spots a few metres apart usually share their first bird, while the third changes with almost every step. Click the map to hear a spot.
- **Trips.** Start and end by name (Nominatim, with Photon as a fallback), `lat, lng`, a map click or by dragging the pins. The route is a chain of hexagons: a greedy hex walk worked out in the browser, or the hexagons along a driving route from the public OSRM server. Short, medium or long.
- **The song.** A marker travels the route while each stop's three birds sing in turn, or all together. The pace sets how long each turn lasts. Stops outside the area or out at sea stay quiet.
- **Credits on demand.** Each bird in the player shows its photo and name; selecting it shows who recorded it and took the photo, the licences, a link to the recording on xeno-canto, and xeno-canto's sonogram.
- **Sharing.** The page address carries the trip and the sound settings.
- **Download.** The song renders to a WAV file, with a text file of credits, when the recordings' licences can be combined (see below).
- **Live sessions.** "Go live" follows the device's location: the hexagon you are in plays its birds round and round. Ending the session leaves a replayable route, and a recording of what you heard, licences permitting.

## Where the birds and sounds come from

| What | Source | Terms |
|---|---|---|
| Which birds are expected where | [iNaturalist open range maps](https://www.inaturalist.org/pages/range_maps) (geomodel 2.34) | CC BY 4.0, as stated in the dataset's catalogue listing |
| Recordings | [xeno-canto](https://xeno-canto.org/), one per species, cut to about six seconds | each recordist's Creative Commons licence; no "no derivatives" licences are used |
| Photos | [iNaturalist](https://www.inaturalist.org/), each species' default photo or its first openly licensed one | each photographer's licence |
| Country outlines (for the area) | [Natural Earth](https://www.naturalearthdata.com/) 1:50m | public domain |

Every recording and photo is credited in the page when its bird is selected, and in `data/birds.json`.

**Downloads.** A downloaded song mixes many recordings, and is treated as an adaptation of each. It can be downloaded only when one licence honours all of them; it then goes under the strictest of them (usually CC BY-NC-SA 4.0) and comes with a credits file naming every recordist. A song mixing a share-alike (BY-SA) recording with non-commercial ones can't be downloaded.

`library/ISSUES.md` lists the known limits of all this, for the project's write-up. `library/species.json` lists every species in range and whether it made it into the page, and if not, why.

## Run it

It is a static site with no build step.

```bash
python3 -m http.server 8768
```

Then open <http://localhost:8768>. The map needs WebGL; without it the page runs without the map and says why (add `?nomap` to see that).

## Rebuilding the bird data

The data in `data/`, `audio/` and `img/birds/` is made by the scripts in `tools/`, from downloads kept outside the repository. They need Python 3 with `h3`, `shapely` and `numpy`, and `ffmpeg`.

```bash
python3 tools/ranges.py DATA          # range maps -> birds per hexagon
python3 tools/xenocanto.py search DATA
python3 tools/xenocanto.py choose DATA
python3 tools/xenocanto.py download DATA
python3 tools/photos.py names DATA
python3 tools/photos.py choose DATA
python3 tools/photos.py download DATA
python3 tools/clips.py DATA
python3 tools/build.py DATA .
```

`DATA` must hold `inat/iNaturalist_geomodel_Aves_*.gpkg` (from `s3://inaturalist-open-data/geomodel/geopackages/latest/`) and `ne/countries50.geojson` (Natural Earth admin-0 countries). The xeno-canto scripts read an API key from `~/.config/what3birdsongs/xc-key`; never commit a key. All the download scripts make one request at a time, with a pause between requests, and keep every answer so nothing is asked twice.

## Layout

```
index.html
css/style.css
js/app.js        interface, map, playhead
js/birds.js      a place -> its three birds
js/audio.js      the aviary, the player, offline rendering, live recording
js/licences.js   whether recordings can be mixed into one file, and under what licence
js/grid.js       the H3 grid
js/routing.js    hex walk, road route, recorded paths, track geometry
js/live.js       live sessions: location -> stops
js/link.js       trip and settings <-> URL hash
js/geocode.js    place search
data/birds.json  the catalogue: every bird with its clip, photo and credits
data/ranges/     birds expected per resolution-4 hexagon, in resolution-2 tiles
audio/           the clips
img/birds/       the photos
library/         working lists: species set aside, known issues
tools/           the scripts that build the data
```

## Services and credits

- Place search: Nominatim (OpenStreetMap Foundation) and Photon (Komoot), both free shared services with usage policies.
- Road routes: the OSRM demo server, offered without uptime guarantees.
- Basemap: © CARTO, map data © OpenStreetMap contributors.
- MapLibre GL JS, h3-js and Tone.js load from jsDelivr at pinned versions.
- The route, playback, sharing and live-session code comes from what3chords songs.
