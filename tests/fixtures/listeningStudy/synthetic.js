// Hand-authored fictional data. No real account or provider capture is represented here.
const tracks = (count, artist = "Study Artist") => Array.from({ length: count }, (_, i) => ({ title: `Track ${i + 1}`, artist }));
function album(title, count, artist = "Study Artist") {
  return { album: { name: title, artist, tracks: { track: tracks(count, artist).map((t, i) => ({ name: t.title, artist: { name: t.artist }, "@attr": { rank: String(i + 1) } })) } } };
}
function recent(title, positions, start = 1600000000, artist = "Study Artist") {
  return { recenttracks: { track: positions.map((p, i) => ({ name: `Track ${p}`, artist: { "#text": artist }, album: { "#text": title }, date: { uts: String(start + i * 180) } })), "@attr": { totalPages: "1" } } };
}
function editions() {
  return [
    { id: "test:standard", pairId: "test", kind: "standard", aliases: ["Study Album"], tracks: tracks(10) },
    { id: "test:deluxe", pairId: "test", kind: "deluxe", aliases: ["Study Album (Deluxe)"], tracks: tracks(18) },
  ];
}
module.exports = { tracks, album, recent, editions };
