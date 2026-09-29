import patchNotes from "../content/patchNotes.json";
import "./PatchNotes.css";

const releases = [...patchNotes].sort((a, b) => b.date.localeCompare(a.date));
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export default function PatchNotes() {
  return (
    <section className="patch-notes-page" aria-labelledby="patch-notes-title">
      <header className="patch-notes-header">
        <p className="patch-notes-kicker">The latest at Rescened</p>
        <h1 id="patch-notes-title">Patch notes</h1>
        <p>New features, thoughtful improvements, and little fixes. All in one place.</p>
      </header>

      {releases.length === 0 ? (
        <p className="patch-notes-empty">Our first update is on its way. Check back soon.</p>
      ) : (
        <ol className="patch-notes-list" aria-label="Updates, newest first">
          {releases.map((release, index) => (
            <li key={release.id}>
              <article className="patch-note" id={release.id} aria-labelledby={`${release.id}-title`}>
                <div className="patch-note-meta">
                  <time dateTime={release.date}>
                    {dateFormatter.format(new Date(`${release.date}T00:00:00Z`))}
                  </time>
                  {index === 0 && <span className="patch-note-latest">Latest update</span>}
                </div>
                <div className="patch-note-content">
                  <h2 id={`${release.id}-title`}>
                    <a href={`#${release.id}`}>{release.title}</a>
                  </h2>
                  <p>{release.summary}</p>
                  <ul>
                    {release.changes.map((change) => <li key={change}>{change}</li>)}
                  </ul>
                </div>
              </article>
            </li>
          ))}
        </ol>
      )}
      <p className="patch-notes-footer">Made for the love of music. Always getting better.</p>
    </section>
  );
}
