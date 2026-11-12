# Artist biography fixtures

`fixtures.js` builds synthetic provider responses for the artist-biography tests. They follow the documented response shapes:

- MusicBrainz web service artist lookup with `inc=url-rels` (`relations[]` with `type: "wikidata"`, `target-type: "url"`, `url.resource`, `ended`): https://musicbrainz.org/doc/MusicBrainz_API
- Wikibase `wbgetentities` (`claims` statements with `id`, `rank`, `mainsnak`, `qualifiers`; `sitelinks.enwiki`; `lastrevid`; `missing`; `redirects`): https://www.mediawiki.org/wiki/Wikibase/API
- MediaWiki Action API `query` with `prop=info|pageprops|revisions` and `redirects=1`, and `parse` with `oldid` and `section=0` (`revid`, `pageid`, `text`, `properties` including `wikibase_item` and `disambiguation`): https://www.mediawiki.org/wiki/API:Main_page and https://www.mediawiki.org/wiki/Extension:Disambiguator

All names, IDs, revisions, and text are invented. No response was captured from a live service, and the tests never contact one. The lead HTML imitates MediaWiki parser output: a hidden short description, a hatnote, an infobox table, an empty paragraph, references, a `noexcerpt` span, and a figure caption, which extraction must skip.
