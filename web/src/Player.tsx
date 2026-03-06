import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { fetchDays, getToken, getRecordingUrl, downloadClip } from "./api";

export function Player({ onLogout }: { onLogout: () => void }) {
  const [days, setDays] = useState<string[]>([]);
  const [selectedDay, setSelectedDay] = useState("");
  const [dlStart, setDlStart] = useState("00:00");
  const [dlEnd, setDlEnd] = useState("00:10");
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
    if (!selectedDay || !videoRef.current) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
    }

    const url = getRecordingUrl(selectedDay);

    if (Hls.isSupported()) {
      const hls = new Hls({
        xhrSetup: (xhr) => {
          const token = getToken();
          if (token) {
            xhr.setRequestHeader("Authorization", `Bearer ${token}`);
          }
        },
      });
      hls.loadSource(url);
      hls.attachMedia(videoRef.current);
      hlsRef.current = hls;
    } else if (videoRef.current.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS — can't inject auth headers, won't work with JWT-protected streams
      videoRef.current.src = url;
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [selectedDay]);

  async function handleDownload() {
    if (!selectedDay) return;
    setDlStatus("Downloading...");
    try {
      const start = dlStart.replace(":", "-") + "-00";
      const end = dlEnd.replace(":", "-") + "-00";
      await downloadClip(selectedDay, start, end);
      setDlStatus("Done");
    } catch (err) {
      setDlStatus(err instanceof Error ? err.message : "Download failed");
    }
  }

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
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      </div>

      <video ref={videoRef} controls playsInline />

      <div className="download">
        <label>
          From: <input type="time" value={dlStart} onChange={(e) => setDlStart(e.target.value)} />
        </label>
        <label>
          To: <input type="time" value={dlEnd} onChange={(e) => setDlEnd(e.target.value)} />
        </label>
        <button onClick={handleDownload}>Download clip</button>
        {dlStatus && <span className="dl-status">{dlStatus}</span>}
      </div>
    </div>
  );
}
