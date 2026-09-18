import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import AddGuest from './pages/AddGuest';
import DoorCamera from './pages/DoorCamera';
import GuestDetail from './pages/GuestDetail';
import GuestList from './pages/GuestList';
import LogEntry from './pages/LogEntry';
import Register from './pages/Register';
import UnknownFaces from './pages/UnknownFaces';

export default function App() {
  return (
    <BrowserRouter>
      <AppLayout>
        <Routes>
          <Route path="/" element={<Register />} />
          <Route path="/camera" element={<DoorCamera />} />
          <Route path="/add" element={<AddGuest />} />
          <Route path="/guests" element={<GuestList />} />
          <Route path="/guests/:id" element={<GuestDetail />} />
          <Route path="/log" element={<LogEntry />} />
          <Route path="/unknown" element={<UnknownFaces />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppLayout>
    </BrowserRouter>
  );
}
