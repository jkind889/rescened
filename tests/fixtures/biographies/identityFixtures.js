const F = require('./fixtures');
// Identity fixtures are synthetic; they test provider structure, never names.
const nameQualifier = (property = 'P1810', value = 'Fixture alias') => ({ [property]: [{ snaktype: 'value', datavalue: { type: 'string', value } }] });
const performance = (id, direction, extra = {}) => ({ 'type-id': 'dd9886f2-1dfe-4270-97db-283f6839a666', 'target-type': 'artist', type: 'is person', direction, artist: { id, type: 'Person' }, ended: false, begin: '2007', end: null, attributes: [], 'attribute-values': {}, ...extra });
const itemClaim = (property, id, extra = {}) => ({ id: `${F.QID}$${property}-${id}`, rank: 'normal', mainsnak: { snaktype: 'value', property, datavalue: { type: 'wikibase-entityid', value: { id } } }, ...extra });

function soloFixture({ relation = {}, reverse = {}, person = {}, project = {}, human = {} } = {}) {
  return {
    musicbrainz: url => url.pathname.endsWith(F.OTHER_MBID)
      ? F.mbArtist({ id: F.OTHER_MBID, type: 'Person', wikidata: [F.OTHER_QID], extra: [performance(F.ARTIST_MBID, 'forward', reverse)], ...person })
      : F.mbArtist({ type: 'Person', extra: [performance(F.OTHER_MBID, 'backward', relation)] }),
    wikidata: url => url.searchParams.get('ids') === F.OTHER_QID
      ? F.wdEntity({ id: F.OTHER_QID, classes: ['Q5'], claims434: [F.p434(F.OTHER_MBID)], extraClaims: { P463: [itemClaim('P463', F.QID)] }, ...human })
      : F.wdEntity({ extraClaims: { P527: [itemClaim('P527', F.OTHER_QID)] }, ...project }),
  };
}

function aliasFixture({ relation = {}, reverse = {}, person = {}, claims, group = false } = {}) {
  const p434 = claims || [F.p434(F.ARTIST_MBID, { qualifiers: nameQualifier() }), F.p434(F.OTHER_MBID, { qualifiers: nameQualifier('P742', 'Real Name') })];
  return {
    musicbrainz: url => url.pathname.endsWith(F.OTHER_MBID)
      ? F.mbArtist({ id: F.OTHER_MBID, type: 'Person', extra: [performance(F.ARTIST_MBID, 'forward', reverse)], ...person })
      : F.mbArtist({ type: 'Person', extra: [performance(F.OTHER_MBID, 'backward', relation)] }),
    wikidata: () => F.wdEntity({ classes: [group ? 'Q215380' : 'Q5'], claims434: p434 }),
  };
}

module.exports = { nameQualifier, performance, itemClaim, soloFixture, aliasFixture };
