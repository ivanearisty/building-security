const API_URL = import.meta.env.VITE_API_URL as string;

const TOKEN_KEY = "bs_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (res.status === 401) {
    clearToken();
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function login(
  username: string,
  password: string
): Promise<{ token: string; username: string; is_admin: boolean }> {
  const data = await apiFetch<{ token: string; username: string; is_admin: boolean }>(
    "/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }
  );
  setToken(data.token);
  return data;
}

export async function checkAuth(): Promise<{ username: string; is_admin: boolean }> {
  return apiFetch("/auth/me");
}

export async function fetchDays(): Promise<string[]> {
  const data = await apiFetch<{ days: string[] }>("/api/days");
  return data.days;
}

export interface SegmentsInfo {
  segments: string[];
  first: string | null;
  last: string | null;
}

export async function fetchSegments(date: string): Promise<SegmentsInfo> {
  return apiFetch(`/api/segments/${date}`);
}

/** Fetch a clip as a blob URL for playback. Caller must revoke when done. */
export async function fetchClip(date: string, start: string, end: string): Promise<string> {
  const token = getToken();
  const res = await fetch(
    `${API_URL}/api/download?date=${date}&start=${start}&end=${end}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || "Download failed");
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/** Save a blob URL to disk. */
export function saveClip(blobUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  a.click();
}
