import axios from 'axios';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000';

// Check if running in Capacitor (mobile app) or deployed web (use local storage)
const isCapacitor = typeof window !== 'undefined' && window.Capacitor !== undefined;
const isDeployedWeb = typeof window !== 'undefined' && (
  window.location.hostname !== 'localhost' && 
  window.location.hostname !== '127.0.0.1' &&
  !window.location.hostname.includes('10.122')
);

// Use local storage for Capacitor apps or deployed web
const useLocalStorage = isCapacitor || isDeployedWeb;

// Helper to get local API dynamically
const getLocalApi = async () => {
  if (!localApi) {
    localApi = await import('./api-local');
  }
  return localApi;
};

const apiClient = axios.create({
  baseURL: BASE,
  timeout: 8000,
  headers: {
    'Content-Type': 'application/json',
  },
});

apiClient.interceptors.response.use(
  (response) => response.data,
  (error) => {
    if (error.code === 'ECONNABORTED') {
      throw new Error('Request timed out. Please check your connection and try again.');
    }
    if (!error.response) {
      throw new Error('Network error. Please check your connection and try again.');
    }
    const body = error.response.data || {};
    throw new Error(body.error || `Request failed (${error.response.status})`);
  }
);

async function call(path, options = {}) {
  const { method = 'GET', body, headers = {} } = options;
  const config = {
    method,
    url: path,
    headers: { ...headers },
  };
  if (body) {
    config.data = body;
  }
  return apiClient.request(config);
}

/** Writes carry the shared token. It gates the LAN, not the user. */
function serviceHeaders() {
  return import.meta.env.VITE_SERVICE_TOKEN
    ? { 'X-Service-Token': import.meta.env.VITE_SERVICE_TOKEN }
    : {};
}

export const getSummary = async () => {
  if (useLocalStorage) {
    const api = await getLocalApi();
    return api.getSummary();
  }
  return call('/api/summary');
};

export const getGuests = async () => {
  if (useLocalStorage) {
    const api = await getLocalApi();
    return api.getGuests();
  }
  return call('/api/guests');
};

export const getGuest = async (id) => {
  if (useLocalStorage) {
    const api = await getLocalApi();
    return api.getGuest(id);
  }
  return call(`/api/guests/${id}`);
};

export const getUnknownFaces = async (limit = 20) => {
  if (useLocalStorage) {
    const api = await getLocalApi();
    return api.getUnknownFaces(limit);
  }
  return call(`/api/unknown?limit=${limit}`);
};

export async function getLogs({ date, guestId, limit } = {}) {
  if (useLocalStorage) {
    const api = await getLocalApi();
    return api.getLogs({ date, guestId, limit });
  }
  const q = new URLSearchParams();
  if (date) q.set('date', date);
  if (guestId) q.set('guest_id', guestId);
  if (limit) q.set('limit', String(limit));
  const qs = q.toString();
  return call(`/api/logs${qs ? `?${qs}` : ''}`);
}

/** Manual override, for when the camera or the recognition service is down. */
export async function logMovement({ guestId, direction, note }) {
  if (useLocalStorage) {
    const api = await getLocalApi();
    return api.logMovement({ guestId, direction, note });
  }
  return call('/api/logs', {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify({ guest_id: guestId, direction, source: 'manual', note }),
  });
}

// --------------------------------------------------------------------------
// Live door view
// --------------------------------------------------------------------------

/**
 * One frame, plus the boxes to draw over it.
 *
 * Asking is what keeps the feed alive: the recognition service only encodes
 * pictures while this is being called. Stop calling and the mini PC stops
 * working for it, within a few seconds, without anyone pressing anything.
 */
export const getDoorView = async () => {
  if (useLocalStorage) {
    const api = await getLocalApi();
    return api.getDoorView();
  }
  return call('/api/preview');
};

export async function setDoorViewEnabled(enabled) {
  if (useLocalStorage) {
    const api = await getLocalApi();
    return api.setDoorViewEnabled(enabled);
  }
  return call('/api/preview/state', {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify({ enabled }),
  });
}

// --------------------------------------------------------------------------
// Adding a guest
// --------------------------------------------------------------------------

/** Starts the enrollment and returns a job to poll. */
export async function startEnrollment({ name, roomNo, phone, consent, photos }) {
  if (useLocalStorage) {
    const api = await getLocalApi();
    return api.startEnrollment({ name, roomNo, phone, consent, photos });
  }
  return call('/api/enroll', {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify({ name, room_no: roomNo, phone, consent, photos }),
  });
}

export const getEnrollment = async (jobId) => {
  if (useLocalStorage) {
    const api = await getLocalApi();
    return api.getEnrollment(jobId);
  }
  return call(`/api/enroll/${jobId}`);
};

/** "2026-09-18T19:04:11Z" -> "7:04 pm" */
export function clockTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Coarse but readable: "12 min ago", "3 hr ago", "yesterday". */
export function timeAgo(iso) {
  if (!iso) return 'never';
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
