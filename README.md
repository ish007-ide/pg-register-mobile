# PG Register Mobile - Face Recognition Entry System

A mobile-optimized Progressive Web App (PWA) for PG/hostel guest management using face recognition. This system replaces traditional paper registers with automatic door monitoring and guest tracking.

## 🚀 Quick Start

### Local Development
```bash
# Install dependencies
npm install
cd frontend && npm install

# Start backend
cd backend && npm start

# Start frontend (another terminal)
cd frontend && npm run dev
```

### Mobile Installation
1. Deploy to GitHub Pages (see below)
2. Open in Chrome on mobile
3. Tap "Add to Home Screen"
4. Works offline after first load

## 📱 Features

### Mobile-Optimized
- **PWA Support**: Installable as native app, works offline
- **Touch-Friendly UI**: 44x44px minimum touch targets
- **Responsive Design**: Stacked cards instead of tables
- **Low-Resource Mode**: 640x480 @ 15fps camera for battery efficiency
- **Local Storage**: Complete offline functionality on mobile

### Core Functionality
- **Automatic Face Recognition**: Real-time door monitoring
- **Guest Management**: Add/remove guests with photo enrollment
- **Movement Tracking**: Automatic in/out logging
- **Manual Override**: Manual entry when camera is down
- **Analytics**: Real-time statistics and movement history

### Technical Features
- **Dual-Mode API**: Local storage for mobile, remote API for web
- **Capacitor Integration**: Native Android app ready
- **Network Resiliency**: 8-second timeout, graceful error handling
- **PWA Caching**: Service worker for offline access

## 🏗️ Architecture

```
Mobile Device (PWA)  <--->  Local Storage (Capacitor Preferences)
     OR
Web Browser          <--->  Node.js Backend  <--->  JSON Data Files
```

### Components
- **Frontend**: React + Vite + Tailwind CSS
- **Backend**: Node.js + Express
- **Mobile**: Capacitor + Native Plugins
- **Storage**: Capacitor Preferences (mobile) / JSON files (web)
- **Camera**: WebRTC getUserMedia (browser) / Capacitor Camera (native)

## 📦 Deployment

### GitHub Pages (Recommended)
1. Push code to GitHub
2. GitHub Actions automatically deploys to GitHub Pages
3. Access at `https://username.github.io/repo-name/`
4. Install as PWA on mobile

### Capacitor Android App
```bash
cd frontend
npm run build
npx cap sync android
npx cap open android
```
Build APK in Android Studio.

### Manual Web Server
```bash
cd frontend/dist
npx serve -s . -p 8080
```

## 🔧 Configuration

### Environment Variables

**Frontend (.env)**
```bash
VITE_API_URL=http://localhost:4000          # Backend URL (web only)
VITE_SERVICE_TOKEN=your-token-here         # Service authentication
VITE_MATCH_THRESHOLD=0.42                  # Face recognition threshold
```

**Backend (.env)**
```bash
PORT=4000
SERVICE_TOKEN=your-token-here
CORS_ORIGIN=*
```

### Capacitor Config
```json
{
  "appId": "com.pgregister.mobile",
  "appName": "PG Register Mobile",
  "webDir": "dist"
}
```

## 📋 API Endpoints

### Public Endpoints
- `GET /api/health` - Health check
- `GET /api/summary` - Dashboard statistics
- `GET /api/guests` - Guest list
- `GET /api/guests/:id` - Guest details
- `GET /api/logs` - Movement history
- `GET /api/preview` - Live camera feed

### Protected Endpoints (require SERVICE_TOKEN)
- `POST /api/logs` - Manual movement entry
- `POST /api/enroll` - Start guest enrollment
- `POST /api/preview` - Submit camera frame
- `POST /api/unknown` - Log unrecognized faces

## 🛠️ Development

### Frontend Development
```bash
cd frontend
npm run dev          # Development server
npm run build        # Production build
npm run preview      # Preview production build
```

### Backend Development
```bash
cd backend
npm start            # Production server
npm test             # Run tests
npm run seed         # Populate demo data
```

### Mobile Testing
```bash
cd frontend
npm run build
npx cap sync android
npx cap run android  # Requires connected device
```

## 📱 Mobile vs Web Behavior

### Mobile (Capacitor/Native)
- Uses Capacitor Preferences for storage
- No backend required
- Works completely offline
- Demo data auto-populated
- Native camera permissions

### Web (Browser)
- Uses remote backend API
- Requires running backend server
- Network-dependent
- Shared data across devices
- WebRTC camera access

## 🔒 Security

- **Service Token**: Required for write operations
- **CORS Protection**: Configurable origin restrictions
- **Data Privacy**: Face embeddings never leave local storage
- **Consent Required**: Guest enrollment requires explicit consent

## 📊 Data Storage

### Mobile
- **Guests**: Capacitor Preferences (encrypted)
- **Logs**: Capacitor Preferences
- **Settings**: Capacitor Preferences
- **Photos**: Base64 encoded in local storage

### Web
- **Guests**: `data/guests.json`
- **Logs**: `data/logs.json`
- **Embeddings**: `data/embeddings.json` (never committed)
- **Unknown Faces**: `data/unknown.json`

## 🐛 Troubleshooting

### Camera Not Working
- Check browser permissions
- Ensure HTTPS (required for camera)
- Verify device has camera hardware
- Try fallback to manual entry

### Local Storage Issues
- Clear app data and reinstall
- Check browser storage quota
- Verify Capacitor plugins installed

### Network Errors
- Check API URL configuration
- Verify backend is running
- Test network connectivity
- Check CORS settings

## 📄 License

This project is designed for PG/hostel management. Face recognition data is biometric information under data protection laws - ensure proper consent and compliance.

## 🤝 Contributing

1. Fork the repository
2. Create feature branch
3. Test on both web and mobile
4. Submit pull request

## 📞 Support

For issues or questions, please open a GitHub issue or contact the development team.