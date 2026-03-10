import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { fetchDays, fetchSegments, fetchClip, saveClip } from "./api-client";
import type { SegmentsInfo } from "./api-client";

const MAX_DOWNLOAD_MINUTES = 30;

function hmsToSeconds(hms: string): number {
  const [h, m, s] = hms.split("-").map(Number);
  return h * 3600 + m * 60 + s;
}

function secondsToHM(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function inputToApi(val: string): string {
  return val.replace(":", "-") + "-00";
}

function buildCoverage(segments: string[]): boolean[] {
  const slots = new Array<boolean>(144).fill(false);
  for (const ts of segments) {
    const sec = hmsToSeconds(ts);
    const slot = Math.floor(sec / 600);
    if (slot < 144) slots[slot] = true;
  }
  return slots;
}

function Timeline({
  segments,
  rangeStart,
  rangeEnd,
  onRangeChange,
}: {
  segments: SegmentsInfo;
  rangeStart: string;
  rangeEnd: string;
  onRangeChange: (start: string, end: string) => void;
}) {
  const coverage = useMemo(() => buildCoverage(segments.segments), [segments.segments]);
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<"start" | "end" | null>(null);

  const startSec = hmsToSeconds(inputToApi(rangeStart));
  const endSec = hmsToSeconds(inputToApi(rangeEnd));
  const startPct = (startSec / 86400) * 100;
  const endPct = (endSec / 86400) * 100;

  function pctToTime(pct: number): string {
    const sec = Math.round((pct / 100) * 86400);
    const clamped = Math.max(0, Math.min(86400 - 60, sec));
    const snapped = Math.round(clamped / 300) * 300;
    return secondsToHM(snapped);
  }

  function handlePointer(e: React.PointerEvent, type: "start" | "end") {
    e.preventDefault();
    dragging.current = type;
    barRef.current!.setPointerCapture(e.pointerId);
  }

  function handleMove(e: React.PointerEvent) {
    if (!dragging.current || !barRef.current) return;
    const rect = barRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const time = pctToTime(pct);
    if (dragging.current === "start") {
      onRangeChange(time, rangeEnd);
    } else {
      onRangeChange(rangeStart, time);
    }
  }

  function handleUp() {
    dragging.current = null;
  }

  const hours = [0, 3, 6, 9, 12, 15, 18, 21];

  return (
    <div className="timeline">
      <div className="timeline-labels">
        {hours.map((h) => (
          <span key={h} style={{ left: `${(h / 24) * 100}%` }}>
            {String(h).padStart(2, "0")}
          </span>
        ))}
      </div>
      <div
        className="timeline-bar"
        ref={barRef}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
      >
        {coverage.map((has, i) => (
          <div
            key={i}
            className={`timeline-slot${has ? " has-data" : ""}`}
            style={{ left: `${(i / 144) * 100}%`, width: `${100 / 144}%` }}
          />
        ))}
        <div
          className="timeline-selection"
          style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
        />
        <div
          className="timeline-handle"
          style={{ left: `${startPct}%` }}
          onPointerDown={(e) => handlePointer(e, "start")}
        />
        <div
          className="timeline-handle"
          style={{ left: `${endPct}%` }}
          onPointerDown={(e) => handlePointer(e, "end")}
        />
      </div>
      <div className="timeline-range-label">
        <span>{rangeStart}</span>
        <span>{rangeEnd}</span>
      </div>
    </div>
  );
}

export function Player({ onLogout }: { onLogout: () => void }) {
  const [days, setDays] = useState<string[]>([]);
  const [selectedDay, setSelectedDay] = useState("");
  const [segments, setSegments] = useState<SegmentsInfo>({ segments: [], first: null, last: null });
  const [rangeStart, setRangeStart] = useState("00:00");
  const [rangeEnd, setRangeEnd] = useState("00:30");
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  // In-memory cache: avoids re-fetching segment lists when switching between days
  const segmentCache = useRef<Map<string, SegmentsInfo>>(new Map());

  useEffect(() => {
    fetchDays().then((d) => {
      setDays(d);
      if (d.length > 0) setSelectedDay(d[0]);
    });
  }, []);

  useEffect(() => {
    if (!selectedDay) return;
    revokeClip();

    const cached = segmentCache.current.get(selectedDay);
    if (cached) {
      applySegments(cached);
      return;
    }

    fetchSegments(selectedDay).then((info) => {
      segmentCache.current.set(selectedDay, info);
      applySegments(info);
    });
  }, [selectedDay]);

  function applySegments(info: SegmentsInfo) {
    setSegments(info);
    if (info.first) {
      const firstHM = info.first.slice(0, 5).replace("-", ":");
      setRangeStart(firstHM);
      const firstSec = hmsToSeconds(info.first);
      const endSec = Math.min(
        firstSec + MAX_DOWNLOAD_MINUTES * 60,
        info.last ? hmsToSeconds(info.last) : firstSec + 1800
      );
      setRangeEnd(secondsToHM(endSec));
    }
  }

  function revokeClip() {
    if (clipUrl) {
      URL.revokeObjectURL(clipUrl);
      setClipUrl(null);
    }
    setStatus("");
  }

  const startSec = hmsToSeconds(inputToApi(rangeStart));
  const endSec = hmsToSeconds(inputToApi(rangeEnd));
  const duration = endSec - startSec;
  const tooLong = duration > MAX_DOWNLOAD_MINUTES * 60;
  const invalid = endSec <= startSec;

  const loadClip = useCallback(async () => {
    if (!selectedDay || invalid || tooLong) return;
    revokeClip();
    setLoading(true);
    setStatus("Loading clip...");
    try {
      const url = await fetchClip(selectedDay, inputToApi(rangeStart), inputToApi(rangeEnd));
      setClipUrl(url);
      setStatus("");
      if (videoRef.current) {
        videoRef.current.src = url;
        videoRef.current.load();
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Failed to load clip");
    } finally {
      setLoading(false);
    }
  }, [selectedDay, rangeStart, rangeEnd, invalid, tooLong]);

  function handleSave() {
    if (!clipUrl) return;
    saveClip(clipUrl, `recording_${selectedDay}_${inputToApi(rangeStart)}_to_${inputToApi(rangeEnd)}.mp4`);
  }

  const hasSegments = segments.segments.length > 0;

  return (
    <div className="player-container">
      <header>
        <h1>Building Security</h1>
        <button onClick={onLogout}>Logout</button>
      </header>

      <div className="controls">
        <label>
          Date
          <select value={selectedDay} onChange={(e) => setSelectedDay(e.target.value)}>
            {days.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </label>
        {hasSegments && segments.first && segments.last && (
          <span className="coverage-info">
            {segments.first.replace(/-/g, ":")} – {segments.last.replace(/-/g, ":")}
          </span>
        )}
        {!hasSegments && selectedDay && (
          <span className="coverage-info dim">No recordings</span>
        )}
      </div>

      <div className="video-wrap">
        <video ref={videoRef} controls playsInline />
        {!clipUrl && !loading && (
          <div className="video-placeholder">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
            <span>Select a time range and load clip</span>
          </div>
        )}
        {loading && (
          <div className="video-placeholder">
            <span>Loading clip...</span>
          </div>
        )}
      </div>

      {hasSegments && (
        <>
          <Timeline
            segments={segments}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            onRangeChange={(s, e) => { setRangeStart(s); setRangeEnd(e); }}
          />

          <div className="clip-controls">
            <div className="time-inputs">
              <label>
                From
                <input type="time" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
              </label>
              <span className="separator">–</span>
              <label>
                To
                <input type="time" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
              </label>
              <span className={`dl-duration${invalid || tooLong ? " invalid" : ""}`}>
                {invalid ? "Invalid" : tooLong ? `${Math.round(duration / 60)}m / ${MAX_DOWNLOAD_MINUTES}m max` : `${Math.round(duration / 60)}m`}
              </span>
            </div>

            <div className="clip-actions">
              <button className="primary" onClick={loadClip} disabled={invalid || tooLong || loading}>
                {loading ? "Loading..." : "Load clip"}
              </button>
              {clipUrl && (
                <button onClick={handleSave}>Save</button>
              )}
            </div>

            {status && <span className={`dl-status${status.includes("ail") ? " error" : ""}`}>{status}</span>}
          </div>
        </>
      )}
    </div>
  );
}
