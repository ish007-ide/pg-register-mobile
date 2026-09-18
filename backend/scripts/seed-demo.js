/**
 * Fill data/ with a plausible day so you can build and test the dashboard
 * before the camera, the mini PC or the model pack exist.
 *
 *   node backend/scripts/seed-demo.js
 *
 * Writes guests.json and logs.json only — no embeddings, so the recognition
 * service will still refuse to start until you've run a real enrollment.
 */

const fs = require('fs');
const path = require('path');

const DATA = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '../../data');

const NAMES = [
  'Asha Kulkarni', 'Rohit Deshmukh', 'Meera Joshi', 'Vikram Rane',
  'Sneha Patil', 'Aditya Bhosale', 'Priya Naik', 'Karan Shetty',
  'Nikita Sawant', 'Omkar Gaikwad', 'Ritu Mehta', 'Sameer Pawar',
  'Tanvi Kadam', 'Harsh Chavan', 'Divya Salunkhe', 'Yash Thorat',
  'Isha Bhagat', 'Neeraj Kulkarni', 'Pooja More', 'Siddharth Jadhav',
];

const guests = NAMES.map((name, i) => ({
  id: `demo${String(i + 1).padStart(2, '0')}`,
  name,
  room_no: String(101 + Math.floor(i / 2)),
  phone: '',
  active: true,
  consent_recorded: true,
  enrolled_at: new Date(Date.now() - 30 * 864e5).toISOString(),
  photo_count: 4,
}));

const logs = [];
const start = new Date();
start.setHours(4, 0, 0, 0);
if (start > new Date()) start.setDate(start.getDate() - 1);

let seq = 0;
guests.forEach((guest, i) => {
  if (i % 7 === 0) return; // a few people never left today

  const leaveHour = 7 + (i % 5);
  const out = new Date(start);
  out.setHours(leaveHour, (i * 13) % 60);
  if (out > new Date()) return;

  logs.push({
    id: `log_seed_${seq++}`,
    event_id: null,
    guest_id: guest.id,
    guest_name: guest.name,
    room_no: guest.room_no,
    direction: 'out',
    timestamp: out.toISOString(),
    confidence: Number((0.52 + Math.random() * 0.3).toFixed(3)),
    source: 'camera',
    inferred: i % 4 === 0,
    flagged: false,
    note: '',
    created_at: out.toISOString(),
  });

  const back = new Date(out.getTime() + (5 + (i % 6)) * 3600e3);
  if (back < new Date() && i % 3 !== 0) {
    logs.push({
      id: `log_seed_${seq++}`,
      event_id: null,
      guest_id: guest.id,
      guest_name: guest.name,
      room_no: guest.room_no,
      direction: 'in',
      timestamp: back.toISOString(),
      confidence: Number((0.5 + Math.random() * 0.3).toFixed(3)),
      source: i % 9 === 0 ? 'manual' : 'camera',
      inferred: false,
      flagged: false,
      note: i % 9 === 0 ? 'camera offline' : '',
      created_at: back.toISOString(),
    });
  }
});

fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'guests.json'), JSON.stringify(guests, null, 2));
fs.writeFileSync(path.join(DATA, 'logs.json'), JSON.stringify(logs, null, 2));
fs.writeFileSync(path.join(DATA, 'unknown.json'), JSON.stringify([], null, 2));

console.log(`Seeded ${guests.length} guests and ${logs.length} movements into ${DATA}`);
console.log('Delete data/*.json before enrolling real guests.');
