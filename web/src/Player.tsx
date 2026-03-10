import { useEffect, useRef, useState, useMemo } from "react";
import Hls from "hls.js";
import { fetchDays, fetchSegments, getToken, getRecordingUrl, downloadClip } from "./api";
import type { SegmentsInfo } from "./api";

const MAX_DOWNLOAD_MINUTES = 30;

/** Convert "HH-MM-SS" to total seconds since midnight */
function hmsToSeconds(hms: string): number {
  const [h, m, s] = hms.split("-").map(Number);
  return h * 3600 + m * 60 + s;
}

/** Convert total seconds to "HH:MM" for display */
function secondsToHM(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Convert "HH:MM" input value to "HH-MM-SS" for API */
function inputToApi(val: string): string {
  return val.replace(":", "-") + "-00";
}

/** Build coverage buckets: for each 10-min slot (144 total), is there a segment? */
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
  dlStart,
  dlEnd,
  onRangeChange,
}: {
  segments: SegmentsInfo;
  dlStart: string;
  dlEnd: string;
  onRangeChange: (start: string, end: string) => void;
}) {
  const coverage = useMemo(() => buildCoverage(segments.segments), [segments.segments]);
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<"start" | "end" | null>(null);

  const startSec = hmsToSeconds(inputToApi(dlStart));
  const endSec = hmsToSeconds(inputToApi(dlEnd));
  const startPct = (startSec / 86400) * 100;
  const endPct = (endSec / 86400) * 100;

  function pctToTime(pct: number): string {
    const sec = Math.round((pct / 100) * 86400);
    const clamped = Math.max(0, Math.min(86400 - 60, sec));
    // Snap to 5-min increments
    const snapped = Math.round(clamped / 300) * 300;
    return secondsToHM(snapped);
  }

  function handlePointer(e: React.PointerEvent, type: "start" | "end") {
    e.preventDefault();
    dragging.current = type;
    const el = barRef.current!;
    el.setPointerCapture(e.pointerId);
  }

  function handleMove(e: React.PointerEvent) {
    if (!dragging.current || !barRef.current) return;
    const rect = barRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const time = pctToTime(pct);
    if (dragging.current === "start") {
      onRangeChange(time, dlEnd);
    } else {
      onRangeChange(dlStart, time);
    }
  }

  function handleUp() {
    dragging.current = null;
  }

  // Hour labels
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
        {/* Selection overlay */}
        <div
          className="timeline-selection"
          style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
        />
        {/* Drag handles */}
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
    </div>
  );
}

export function Player({ onLogout }: { onLogout: () => void }) {
  const [days, setDays] = useState<string[]>([]);
  const [selectedDay, setSelectedDay] = useState("");
  const [segments, setSegments] = useState<SegmentsInfo>({ segments: [], first: null, last: null });
  const [dlStart, setDlStart] = useState("00:00");
  const [dlEnd, setDlEnd] = useState("00:30");
  const [dlStatus, setDlStatus] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    fetchDays().then((d) => {
      setDays(d);
      if (d.length > 0) setSelectedDay(d[0]);
    });
  }, []);

  useEffect(() => {
    if (!selectedDay) return;

    // Load segments for timeline
    fetchSegments(selectedDay).then((info) => {
      setSegments(info);
      if (info.first) {
        const firstHM = info.first.slice(0, 5).replace("-", ":");
        setDlStart(firstHM);
        // Default end = first + 30 min, clamped to last segment
        const firstSec = hmsToSeconds(info.first);
        const endSec = Math.min(firstSec + MAX_DOWNLOAD_MINUTES * 60, info.last ? hmsToSeconds(info.last) : firstSec + 1800);
        setDlEnd(secondsToHM(endSec));
      }
    });

    // Load HLS stream
    if (!videoRef.current) return;
    if (hlsRef.current) hlsRef.current.destroy();

    const url = getRecordingUrl(selectedDay);

    if (Hls.isSupported()) {
      const hls = new Hls({
        xhrSetup: (xhr) => {
          const token = getToken();
          if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        },
      });
      hls.loadSource(url);
      hls.attachMedia(videoRef.current);
      hlsRef.current = hls;
    } else if (videoRef.current.canPlayType("application/vnd.apple.mpegurl")) {
      videoRef.current.src = url;
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [selectedDay]);

  // Compute download duration for validation
  const dlStartSec = hmsToSeconds(inputToApi(dlStart));
  const dlEndSec = hmsToSeconds(inputToApi(dlEnd));
  const dlDuration = dlEndSec - dlStartSec;
  const dlTooLong = dlDuration > MAX_DOWNLOAD_MINUTES * 60;
  const dlInvalid = dlEndSec <= dlStartSec;

  function handleRangeChange(start: string, end: string) {
    setDlStart(start);
    setDlEnd(end);
  }

  async function handleDownload() {
    if (!selectedDay || dlInvalid || dlTooLong) return;
    setDlStatus("Downloading...");
    try {
      await downloadClip(selectedDay, inputToApi(dlStart), inputToApi(dlEnd));
      setDlStatus("Done");
    } catch (err) {
      setDlStatus(err instanceof Error ? err.message : "Download failed");
    }
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
          Date:
          <select
            value={selectedDay}
            onChange={(e) => setSelectedDay(e.target.value)}
          >
            {days.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </label>
        {hasSegments && segments.first && segments.last && (
          <span className="coverage-info">
            {segments.first.replace(/-/g, ":")} – {segments.last.replace(/-/g, ":")}
            {" "}({segments.segments.length} segments)
          </span>
        )}
        {!hasSegments && selectedDay && (
          <span className="coverage-info dim">No recordings</span>
        )}
      </div>

      <video ref={videoRef} controls playsInline />

      {hasSegments && (
        <>
          <Timeline
            segments={segments}
            dlStart={dlStart}
            dlEnd={dlEnd}
            onRangeChange={handleRangeChange}
          />

          <div className="download">
            <label>
              From:
              <input
                type="time"
                value={dlStart}
                onChange={(e) => setDlStart(e.target.value)}
              />
            </label>
            <label>
              To:
              <input
                type="time"
                value={dlEnd}
                onChange={(e) => setDlEnd(e.target.value)}
              />
            </label>
            <span className="dl-duration">
              {dlInvalid
                ? "Invalid range"
                : dlTooLong
                  ? `${Math.round(dlDuration / 60)}min (max ${MAX_DOWNLOAD_MINUTES})`
                  : `${Math.round(dlDuration / 60)}min`}
            </span>
            <button onClick={handleDownload} disabled={dlInvalid || dlTooLong}>
              Download clip
            </button>
            {dlStatus && <span className="dl-status">{dlStatus}</span>}
          </div>
        </>
      )}
    </div>
  );
}
