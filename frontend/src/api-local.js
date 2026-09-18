import { localStorageService } from './services/localStorage';

// Simulate network delay for realistic UX
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export const getSummary = async () => {
  await delay(100);
  return localStorageService.getSummary();
};

export const getGuests = async () => {
  await delay(100);
  return localStorageService.getGuests();
};

export const getGuest = async (id) => {
  await delay(100);
  const guests = await localStorageService.getGuests();
  const guest = guests.find(g => g.id === id);
  if (!guest) throw new Error('guest not found');
  
  // Get logs for this guest
  const logs = await localStorageService.getLogs();
  const guestLogs = logs.filter(log => log.guest_id === id);
  
  return { ...guest, logs: guestLogs };
};

export const getUnknownFaces = async (limit = 20) => {
  await delay(100);
  const faces = await localStorageService.getUnknownFaces();
  return faces.slice(0, limit);
};

export function getLogs({ date, guestId, limit } = {}) {
  return new Promise(async (resolve) => {
    await delay(100);
    const logs = await localStorageService.getLogs();
    
    let filtered = logs;
    if (date) {
      filtered = filtered.filter(log => log.timestamp.startsWith(date));
    }
    if (guestId) {
      filtered = filtered.filter(log => log.guest_id === guestId);
    }
    if (limit) {
      filtered = filtered.slice(0, limit);
    }
    
    resolve(filtered);
  });
}

export function logMovement({ guestId, direction, note }) {
  return new Promise(async (resolve) => {
    await delay(200);
    const log = await localStorageService.addLog({
      guest_id: guestId,
      direction,
      source: 'manual',
      note: note || ''
    });
    resolve({ log, duplicate: false });
  });
}

// Simulated enrollment for local version
export function startEnrollment({ name, roomNo, phone, consent, photos }) {
  return new Promise(async (resolve) => {
    await delay(500);
    
    if (!consent) {
      throw new Error('Consent is required');
    }
    
    const guest = await localStorageService.addGuest({
      name: name.trim(),
      room_no: roomNo.trim(),
      phone: phone.trim(),
      photos: photos || [],
      consent
    });
    
    resolve({
      id: Date.now().toString(),
      name: guest.name,
      photo_count: guest.photo_count,
      status: 'done',
      guest
    });
  });
}

export const getEnrollment = async (jobId) => {
  await delay(100);
  // In local version, enrollment is instant
  return {
    id: jobId,
    status: 'done',
    guest: null
  };
};

// Live door view - using camera stream instead of backend
export const getDoorView = async () => {
  await delay(100);
  return {
    enabled: true,
    reason: 'ok',
    frame: null // No frame from backend, using WebRTC directly
  };
};

export function setDoorViewEnabled(enabled) {
  return new Promise(async (resolve) => {
    await delay(100);
    resolve({ enabled });
  });
}

// Utility functions
export function clockTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

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