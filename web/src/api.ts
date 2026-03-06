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

export function getRecordingUrl(date: string): string {
  return `${API_URL}/recordings/${date}/playlist.m3u8`;
}

export async function downloadClip(date: string, start: string, end: string): Promise<void> {
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
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `recording_${date}_${start}_to_${end}.mp4`;
  a.click();
  URL.revokeObjectURL(url);
}
