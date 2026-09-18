import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// Initialize demo data for mobile version
import { localStorageService } from './services/localStorage';
import { Capacitor } from '@capacitor/core';

const initDemoData = async () => {
  const isCapacitor = Capacitor.isNativePlatform();
  
  if (isCapacitor) {
    const guests = await localStorageService.getGuests();
    if (guests.length === 0) {
      // Add demo data for first-time mobile users
      await localStorageService.addGuest({
        name: 'Demo Guest 1',
        room_no: '101',
        phone: '9876543210',
        photos: [],
        consent: true
      });
      await localStorageService.addGuest({
        name: 'Demo Guest 2', 
        room_no: '102',
        phone: '9876543211',
        photos: [],
        consent: true
      });
    }
  }
};

initDemoData().then(() => {
  createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
