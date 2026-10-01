// Square board thumbnail built from the board's first albums:
// 1 album fills the square, 2-3 show the first two side by side,
// and 4 or more show the first four as a 2x2 grid.
function previewLayout(count) {
  if (count >= 4) return { name: "quad", size: 4 };
  if (count >= 2) return { name: "pair", size: 2 };
  if (count === 1) return { name: "single", size: 1 };
  return { name: "empty", size: 0 };
}

export default function BoardPreview({ albums = [] }) {
  const layout = previewLayout(albums.length);

  return (
    <div className="board-preview-grid" data-layout={layout.name} aria-hidden="true">
      {albums.slice(0, layout.size).map((album, index) => (
        album?.cover
          ? <img key={album.albumId || index} src={album.cover} alt="" loading="lazy" />
          : <span key={album?.albumId || index} />
      ))}
    </div>
  );
}
