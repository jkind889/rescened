import { API_BASE_URL } from "../../config/api";
import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { getApiErrorMessage } from "../../utils/apiErrors";
import "./export.css";

const EXPORT_PATH = `${API_BASE_URL}/profile/me/export`;
const DATASETS = [
  { id: "reviews", label: "Reviews" },
  { id: "listens", label: "Listens" },
  { id: "boards", label: "Boards" },
];
const FORMATS = [
  { id: "csv", label: "CSV" },
  { id: "json", label: "JSON" },
];

// The server sends no Content-Disposition, so the file is named here with the
// local date, e.g. rescened-reviews-2026-10-28.csv.
function exportFilename(dataset, format, date = new Date()) {
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, "0")).join("-");
  return `rescened-${dataset}-${day}.${format}`;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Owner-only data export rows. Hidden while the server reports exports
// disabled (503).
export default function DataExport() {
  const { getToken, isSignedIn } = useAuth();
  const [available, setAvailable] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isSignedIn) return undefined;
    let isCurrent = true;
    (async () => {
      try {
        const token = await getToken();
        const response = await fetch(EXPORT_PATH, { headers: { Authorization: `Bearer ${token}` } });
        if (isCurrent) setAvailable(response.status !== 503);
      } catch {
        // Unreachable server: the buttons would only fail too.
      }
    })();
    return () => { isCurrent = false; };
  }, [getToken, isSignedIn]);

  async function download(dataset, format) {
    setPending(`${dataset}.${format}`);
    setError("");
    try {
      const token = await getToken();
      const response = await fetch(`${EXPORT_PATH}/${dataset}.${format}`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 503) {
        setAvailable(false);
        return;
      }
      if (!response.ok) {
        setError(await getApiErrorMessage(response, "The export could not be downloaded."));
        return;
      }
      saveBlob(await response.blob(), exportFilename(dataset, format));
    } catch {
      setError("The export could not be downloaded.");
    } finally {
      setPending("");
    }
  }

  if (!available) return null;

  return (
    <section className="edit-profile-panel data-export-panel" aria-labelledby="data-export-title">
      <div className="profile-section-header">
        <h2 id="data-export-title">Export your data</h2>
      </div>
      <ul className="data-export-list">
        {DATASETS.map((dataset) => (
          <li className="data-export-row" key={dataset.id}>
            <span>{dataset.label}</span>
            <div className="data-export-actions">
              {FORMATS.map((format) => (
                <button
                  className="album-action-button"
                  type="button"
                  key={format.id}
                  disabled={Boolean(pending)}
                  aria-busy={pending === `${dataset.id}.${format.id}`}
                  aria-label={`Export ${dataset.label.toLowerCase()} as ${format.label}`}
                  onClick={() => download(dataset.id, format.id)}
                >
                  {pending === `${dataset.id}.${format.id}` ? "Exporting..." : format.label}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="edit-profile-error" role="alert">{error}</p>}
    </section>
  );
}
