import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LocationProvider } from './context/LocationContext';
import Login from './pages/Login';
import Display from './pages/Display';
import Layout from './components/Layout';
import Home from './pages/Home';
import ChiefOfStaff from './pages/ChiefOfStaff';
import Scorecard from './pages/Scorecard';
import Performance from './pages/Performance';
import Technicians from './pages/Technicians';
import Alerts from './pages/Alerts';
import Reports from './pages/Reports';
import ReportTechEfficiency from './pages/ReportTechEfficiency';
import ReportSummary from './pages/ReportSummary';
import Comebacks from './pages/Comebacks';
import Finance from './pages/Finance';
import Marketing from './pages/Marketing';
import ApprovalsPage from './pages/ApprovalsPage';
import Locations from './pages/Locations';
import Targets from './pages/Targets';
import Notices from './pages/Notices';
import Users from './pages/Users';
import Wip from './pages/Wip';
import Bonus from './pages/Bonus';
import FuelCard from './pages/FuelCard';
import PartsRecon from './pages/PartsRecon';
import ClockKiosk from './pages/ClockKiosk';
import TimeClock from './pages/TimeClock';
import Reorders from './pages/Reorders';

function ProtectedRoute({ children, ownerOnly, ownerOrPartner }) {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#666' }}>Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (ownerOnly && user.role !== 'owner') return <Navigate to="/" replace />;
  if (ownerOrPartner && !['owner', 'partner'].includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

// Everyone gets Home now — for advisors it renders the operational decks only
// (the server strips money fields from their responses regardless).
function RoleHome() {
  return <Home />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/display/:locationId" element={<Display />} />
          <Route path="/clock/:locationId" element={<ClockKiosk />} />
          <Route path="/" element={<ProtectedRoute><LocationProvider><Layout /></LocationProvider></ProtectedRoute>}>
            <Route index element={<RoleHome />} />
            <Route path="reorders" element={<Reorders />} />
            <Route path="chief-of-staff" element={<ProtectedRoute ownerOrPartner><ChiefOfStaff /></ProtectedRoute>} />
            <Route path="scorecard" element={<ProtectedRoute ownerOrPartner><Scorecard /></ProtectedRoute>} />
            <Route path="performance" element={<Performance />} />
            <Route path="technicians" element={<Technicians />} />
            <Route path="alerts" element={<Alerts />} />
            <Route path="reports" element={<Reports />} />
            <Route path="reports/tech-efficiency" element={<ReportTechEfficiency />} />
            <Route path="reports/summary/:kind" element={<ReportSummary />} />
            <Route path="finance" element={<Finance />} />
            <Route path="marketing" element={<Marketing />} />
            <Route path="marketing/approvals" element={<ApprovalsPage />} />
            <Route path="comebacks" element={<Comebacks />} />
            <Route path="bonus" element={<Bonus />} />
            <Route path="fuel-card" element={<FuelCard />} />
            <Route path="parts" element={<ProtectedRoute ownerOrPartner><PartsRecon /></ProtectedRoute>} />
            <Route path="time-clock" element={<TimeClock />} />
  <Route path="wip" element={<Wip />} />
            <Route path="locations" element={<ProtectedRoute ownerOnly><Locations /></ProtectedRoute>} />
            <Route path="targets" element={<Targets />} />
            <Route path="notices" element={<Notices />} />
            <Route path="users" element={<ProtectedRoute ownerOnly><Users /></ProtectedRoute>} />
          </Route>
          {/* No route matched (stale bookmark, mistyped deep link) → Home, not a
              dead black screen. Logged-out users still bounce to /login via the
              ProtectedRoute on "/". */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
