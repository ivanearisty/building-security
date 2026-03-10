// Re-exports the real or mock API based on VITE_MOCK env var.
// All components should import from this file.

import * as real from "./api";
import * as mock from "./mock-api";

const useMock = import.meta.env.VITE_MOCK === "true";
const impl = useMock ? mock : real;

export const getToken = impl.getToken;
export const setToken = impl.setToken;
export const clearToken = impl.clearToken;
export const login = impl.login;
export const checkAuth = impl.checkAuth;
export const fetchDays = impl.fetchDays;
export const fetchSegments = impl.fetchSegments;
export const fetchClip = impl.fetchClip;
export const saveClip = impl.saveClip;

export type { SegmentsInfo } from "./api";
