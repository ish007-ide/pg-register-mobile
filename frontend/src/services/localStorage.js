import { Preferences } from '@capacitor/preferences';

const KEYS = {
  GUESTS: 'pg_guests',
  LOGS: 'pg_logs',
  UNKNOWN_FACES: 'pg_unknown_faces',
  SUMMARY: 'pg_summary'
};

class LocalStorageService {
  async getGuests() {
    const { value } = await Preferences.get({ key: KEYS.GUESTS });
    return value ? JSON.parse(value) : [];
  }

  async saveGuests(guests) {
    await Preferences.set({ key: KEYS.GUESTS, value: JSON.stringify(guests) });
  }

  async getLogs() {
    const { value } = await Preferences.get({ key: KEYS.LOGS });
    return value ? JSON.parse(value) : [];
  }

  async saveLogs(logs) {
    await Preferences.set({ key: KEYS.LOGS, value: JSON.stringify(logs) });
  }

  async getUnknownFaces() {
    const { value } = await Preferences.get({ key: KEYS.UNKNOWN_FACES });
    return value ? JSON.parse(value) : [];
  }

  async saveUnknownFaces(faces) {
    await Preferences.set({ key: KEYS.UNKNOWN_FACES, value: JSON.stringify(faces) });
  }

  async getSummary() {
    const { value } = await Preferences.get({ key: KEYS.SUMMARY });
    return value ? JSON.parse(value) : this.calculateSummary();
  }

  async saveSummary(summary) {
    await Preferences.set({ key: KEYS.SUMMARY, value: JSON.stringify(summary) });
  }

  async calculateSummary() {
    const guests = await this.getGuests();
    const logs = await this.getLogs();
    
    const activeGuests = guests.filter(g => g.active);
    const currentlyIn = activeGuests.filter(g => g.status === 'in').length;
    const currentlyOut = activeGuests.filter(g => g.status === 'out').length;
    
    const today = new Date().toISOString().split('T')[0];
    const movementsToday = logs.filter(log => log.timestamp.startsWith(today)).length;

    return {
      total_guests: activeGuests.length,
      currently_in: currentlyIn,
      currently_out: currentlyOut,
      movements_today: movementsToday,
      unconfirmed: 0,
      day_started: new Date().toISOString()
    };
  }

  async addGuest(guest) {
    const guests = await this.getGuests();
    const newGuest = {
      ...guest,
      id: Date.now().toString(),
      active: true,
      status: 'out',
      last_seen: new Date().toISOString(),
      movements_today: 0,
      photo_count: guest.photos?.length || 0
    };
    guests.push(newGuest);
    await this.saveGuests(guests);
    await this.updateSummary();
    return newGuest;
  }

  async updateGuest(guestId, updates) {
    const guests = await this.getGuests();
    const index = guests.findIndex(g => g.id === guestId);
    if (index !== -1) {
      guests[index] = { ...guests[index], ...updates };
      await this.saveGuests(guests);
      await this.updateSummary();
      return guests[index];
    }
    return null;
  }

  async addLog(log) {
    const logs = await this.getLogs();
    const newLog = {
      ...log,
      id: Date.now().toString(),
      timestamp: log.timestamp || new Date().toISOString()
    };
    logs.unshift(newLog); // Add to beginning
    await this.saveLogs(logs);
    
    // Update guest status
    if (log.guest_id) {
      await this.updateGuestStatus(log.guest_id, log.direction);
    }
    
    await this.updateSummary();
    return newLog;
  }

  async updateGuestStatus(guestId, direction) {
    const guests = await this.getGuests();
    const guest = guests.find(g => g.id === guestId);
    if (guest) {
      guest.status = direction;
      guest.last_seen = new Date().toISOString();
      guest.movements_today = (guest.movements_today || 0) + 1;
      await this.saveGuests(guests);
    }
  }

  async updateSummary() {
    const summary = await this.calculateSummary();
    await this.saveSummary(summary);
    return summary;
  }

  async clearAll() {
    await Preferences.clear();
  }
}

export const localStorageService = new LocalStorageService();