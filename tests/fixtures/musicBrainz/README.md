# MusicBrainz discography fixture

`browse-radiohead-album-website-default.json` was captured on 2026-11-11 from the official MusicBrainz web service:

```
GET https://musicbrainz.org/ws/2/release-group?artist=a74b1b7f-71a5-4011-9441-d0b5e4122711&type=album&release-group-status=website-default&inc=artist-credits&limit=100&fmt=json
```

It is trimmed to the fields Rescened reads: the browse count and offset, and per release group its ID, title, primary and secondary types, first release date, and artist credit names and IDs. MusicBrainz core metadata is CC0. The fixture contains no cover artwork. Tests use it offline; they never contact MusicBrainz.
