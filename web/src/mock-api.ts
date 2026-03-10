/**
 * Mock API for local development — drop-in replacement for api.ts exports.
 * Simulates auth, days, segments, and download without a backend.
 */

import type { SegmentsInfo } from "./api";

const TOKEN_KEY = "bs_token";
const MOCK_TOKEN = "mock-jwt-token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function login(
  username: string,
  password: string
): Promise<{ token: string; username: string; is_admin: boolean }> {
  await delay(300);
  if (username === "ivan" && password === "admin") {
    setToken(MOCK_TOKEN);
    return { token: MOCK_TOKEN, username: "ivan", is_admin: true };
  }
  throw new Error("Invalid credentials");
}

export async function checkAuth(): Promise<{ username: string; is_admin: boolean }> {
  await delay(100);
  if (!getToken()) throw new Error("Unauthorized");
  return { username: "ivan", is_admin: true };
}

export async function fetchDays(): Promise<string[]> {
  await delay(200);
  return ["2026-03-10", "2026-03-09", "2026-03-08"];
}

export async function fetchSegments(date: string): Promise<SegmentsInfo> {
  await delay(200);
  const segments = generateSegments(date);
  return {
    segments,
    first: segments[0] ?? null,
    last: segments[segments.length - 1] ?? null,
  };
}

/** Return a blob URL to a tiny generated MP4-like blob for mock playback */
export async function fetchClip(
  date: string,
  start: string,
  end: string
): Promise<string> {
  await delay(800);
  console.log(`[mock] fetchClip: ${date} ${start} → ${end}`);
  // Create a small black video via canvas + MediaRecorder
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, 320, 180);
  ctx.fillStyle = "#888";
  ctx.font = "16px monospace";
  ctx.fillText(`${date} ${start}→${end}`, 20, 100);
  const stream = canvas.captureStream(1);
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.start();
  await delay(500);
  recorder.stop();
  await new Promise((r) => (recorder.onstop = r));
  stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: "video/webm" });
  return URL.createObjectURL(blob);
}

export function saveClip(blobUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  a.click();
}

// --- helpers ---

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Generate realistic segment timestamps for a day */
function generateSegments(date: string): string[] {
  const segments: string[] = [];
  // Seed based on date so it's consistent
  const seed = date === "2026-03-10" ? 0 : date === "2026-03-09" ? 1 : 2;

  // Simulate gaps: recording from ~02:00-06:00, 08:00-12:00, 14:00-22:00
  const ranges =
    seed === 0
      ? [[2, 6], [8, 12], [14, 22]]
      : seed === 1
        ? [[0, 8], [10, 18], [20, 23]]
        : [[6, 14], [16, 23]];

  for (const [startH, endH] of ranges) {
    for (let h = startH; h < endH; h++) {
      for (let m = 0; m < 60; m += 10) {
        // ~6 segments per 10-min slot (one every ~10s of recording)
        for (let s = 0; s < 60; s += 10) {
          if (m + Math.floor(s / 60) >= 60) break;
          const ts = `${String(h).padStart(2, "0")}-${String(m).padStart(2, "0")}-${String(s).padStart(2, "0")}`;
          segments.push(ts);
        }
      }
    }
  }
  return segments;
}
