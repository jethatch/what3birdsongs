# Issues to address in the write-up

*Written by Claude while building what3birdsongs, as a working list for the project's disclaimer. A preview document, not a statement by the project's authors.*

## Ranges: which birds a place gets

- **Source.** iNaturalist's open range maps ("geomodel", version 2.34, published September 2026), from iNaturalist's open-data bucket on AWS. The licence is taken as stated in the Earth Engine catalogue listing (CC BY 4.0); iNaturalist's own range-map page could not be read by Claude's tools (it refused automated requests).
- **The maps are predictions,** from a model trained on iNaturalist sightings. They are only as good as where people go birding with phones: dense around cities and in the US, thinner in northern Canada and parts of Mexico.
- **The maps are generous.** "Expected nearby" includes birds that are rare, seasonal or vagrant in a place. Examples found while testing: Allen's Hummingbird (a West Coast bird) is expected in scattered hexagons as far east as Massachusetts, and LeConte's Sparrow around Boston. Nothing was filtered out; every species the model expects in a hexagon is in that hexagon's list.
- **Introduced and escaped birds.** The maps include non-native species wherever they are seen, so a Yellow-collared Lovebird (an African parrot, presumably from escaped pets) can be one of a Boston spot's three birds.
- **No seasons.** A bird expected somewhere at any time of year sings there in every season: summer warblers in January, winter ducks in July.
- **A fault in the range files, repaired.** For 27 species whose ranges ring a pole (Arctic birds whose ranges cross the Bering Strait, such as Bank Swallow, Peregrine Falcon, Osprey and Arctic Tern, and some Antarctic seabirds), iNaturalist's exported outlines close with a detour down the 180th meridian to the opposite pole. Read as stored, Snow Petrel and Adélie Penguin covered almost all of North America. For those outlines, which side is the range was decided by where iNaturalist has research-grade, non-captive sightings of the species in North America (tools/poles.py fetches iNaturalist's map grid of sightings; tools/ranges.py picks the side holding more of them). Where a bird has almost no sightings on either side, that part of its range is left out. This is a judgement on top of the model, made automatically.
- **Hexagon size.** The lists are per H3 resolution-4 hexagon (about 1,770 km²), so a city park and the farmland 20 km away share a list.
- **Area.** The US (without Hawaii), Canada and Mexico, from Natural Earth's 1:50m country outlines, including every hexagon that touches them. Hexagons along the borders with Guatemala and Belize, and along the coasts, therefore reach a little past the countries; their lists still come from the range maps.
- **Taxonomy.** Species and English names follow iNaturalist. xeno-canto follows a different taxonomy (IOC), so some species are named differently there or split or lumped differently, and a recording found under the same scientific name may not be quite the same bird.

## Addresses

- **A spot's birds** are picked by arithmetic on its H3 address within its resolution-4 hexagon, not by how common they are there, so many places sound exotic.
- **A route's stops** are coarser hexagons. Each plays the birds of one spot inside it, picked by the hexagon's own ID, so a stop always sounds the same; clicking elsewhere in it gives different birds.

## Recordings

- **Source.** xeno-canto, through its API (v3), with Jim Thatcher's personal API key, used only by the build script on one machine; the page itself never calls the API. Requests were made one at a time with pauses between them and identified by the project's name and address.
- **One recording per species,** chosen by a score: songs over calls, recordings made in the US, Canada or Mexico, higher quality ratings, fewer other species in the background, no playback used, a reasonable length. The choice is automatic and has not been checked by ear.
- **The clip** is about six seconds: where the bird is loudest (or where an annotation in the recording says it sings), high-passed, brought to an even loudness, faded in and out, and re-encoded as a 40 kbit/s mono MP3. That is a derivative of each recording.
- **A few clips are very short or very quiet** (seven are under three seconds, because the recordings are; two are much quieter than the rest).
- **Licences.** Only Creative Commons licences that allow derivatives are used: no "no derivatives" recordings. Most recordings are non-commercial (BY-NC or BY-NC-SA).
- **Species set aside.** Species with no recording under their iNaturalist name, or none with a usable licence, or restricted species whose recordings xeno-canto withholds, are not in the page. They are listed, with the reason, in `library/species.json` for sorting out later.

## Photos

- **Source.** Each species' default photo on iNaturalist, or the first openly licensed one if the default isn't, downloaded at iNaturalist's "small" size. To keep the site small, photos are re-saved at up to 240 pixels and lower JPEG quality, except those under "no derivatives" licences, which are used exactly as iNaturalist serves them.
- **Credit** is shown when a bird is selected; most photos are CC BY-NC.
- **Sonograms** in the credits pop-up are xeno-canto's own images of the whole recording, loaded from xeno-canto only when someone opens the pop-up. Whether they carry the recording's licence was not confirmed.

## Downloads

- **A downloaded song mixes many recordings.** It is treated, cautiously, as an adaptation of each. A song can be downloaded only if one licence can honour all of its recordings: then it goes under the strictest of them (usually CC BY-NC-SA 4.0), with a credits file naming every recordist. A song that mixes a "BY-SA" recording with non-commercial ones can't be downloaded; the recording picker avoids "BY-SA" recordings where it can for that reason.
- **Licence versions** (3.0 and 4.0) are treated as compatible, since both allow adaptations under later versions with the same elements.
- **Live recordings** follow the same rule, crediting every bird on the travelled route (whether or not each was heard for long).

## The idea itself

- The same address problem as what3chords: a grid laid over everything from outside, and a vocabulary someone else chose. Here the vocabulary is drawn from the place, but through a model's prediction, one taxonomy's names and one site's recordings.
- English names only.

## Added 28 October 2026 (to review)

- **Species found under other names.** 24 species xeno-canto files under a different genus (for example Cooper's Hawk as *Accipiter cooperii*, where iNaturalist has *Astur cooperii*) were matched by their English names and added, taking the most common xeno-canto name among the results. Each match was accepted without being checked by hand, so the site now has 1,599 birds; the list is in the build data (`xc/byname-used.json`). Adding birds changes every address whose hexagon expects one of them.
- **Waves at sea.** Stops out at sea, or outside the area, now play one turn of waves instead of silence. The recording is generic, "Ocean Waves on a Tropical Beach" by Jarrod Stanley (CC0, Wikimedia Commons), not from these coasts; xeno-canto had no surf recordings from the US or Canada. Its page also names "J.D. Savanyu" in the description, so the attribution needs checking. Land beyond the borders (Cuba, Guatemala) also gets waves for now, and a large coastal hexagon on a short route can pick its spot offshore and play waves.
- **Disclaimer.** A first draft, written by Claude, is in "How it works", linked from the launch notice; it is to be reviewed and updated.
