import { useEffect, useState } from "react";
import { CheckCircle2, FolderOpen, LoaderCircle, XCircle } from "lucide-react";
import { projectsClient, type ExportJobRecord } from "../infrastructure/projects-client";

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function ExportHistoryModal({
  videoId,
  onClose,
}: {
  videoId: string;
  onClose: () => void;
}) {
  const [jobs, setJobs] = useState<ExportJobRecord[] | null>(null);

  useEffect(() => {
    void projectsClient.listExportJobs(videoId).then(setJobs);
  }, [videoId]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <p className="eyebrow">Export</p>
        <h2>Export history</h2>
        {jobs === null && <p className="tl-source-hint">Loading…</p>}
        {jobs?.length === 0 && <p className="tl-source-hint">No exports yet for this video.</p>}
        {jobs && jobs.length > 0 && (
          <ul className="tl-export-history-list">
            {jobs.map((job) => (
              <li key={job.id} className={`tl-export-history-row ${job.status}`}>
                {job.status === "completed" && <CheckCircle2 size={16} />}
                {job.status === "failed" && <XCircle size={16} />}
                {job.status === "running" && <LoaderCircle className="spin" size={16} />}
                <div className="tl-export-history-meta">
                  <span className="tl-export-history-path" title={job.destinationPath}>{job.destinationPath}</span>
                  <span className="tl-export-history-time">{formatWhen(job.completedAt ?? job.createdAt)}</span>
                  {job.error && <span className="tl-export-history-error">{job.error}</span>}
                </div>
                {job.status === "completed" && (
                  <button className="tl-icon-btn" title="Show in folder" onClick={() => void projectsClient.revealInFileManager(job.destinationPath)}>
                    <FolderOpen size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="footer-actions">
          <button className="secondary" onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  );
}
