import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login from './pages/Login';
import Display from './pages/Display';
import Layout from './components/Layout';
import Home from './pages/Home';
import Performance from './pages/Performance';
import Technicians from './pages/Technicians';
import Alerts from './pages/Alerts';
import Reports from './pages/Reports';
import ReportTechEfficiency from './pages/ReportTechEfficiency';
import ReportSummary from './pages/ReportSummary';
import Comebacks from './pages/Comebacks';
import Finance from './pages/Finance';
import Locations from './pages/Locations';
import Targets from './pages/Targets';
import Users from './pages/Users';
import Wip from './pages/Wip';

function ProtectedRoute({ children, ownerOnly, ownerOrPartner }) {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#666' }}>Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (ownerOnly && user.role !== 'owner') return <Navigate to="/" replace />;
  if (ownerOrPartner && !['owner', 'partner'].includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/display/:locationId" element={<Display />} />
          <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route index element={<Home />} />
            <Route path="performance" element={<Performance />} />
            <Route path="technicians" element={<Technicians />} />
            <Route path="alerts" element={<Alerts />} />
            <Route path="reports" element={<ProtectedRoute ownerOrPartner><Reports /></ProtectedRoute>} />
            <Route path="reports/tech-efficiency" element={<ProtectedRoute ownerOrPartner><ReportTechEfficiency /></ProtectedRoute>} />
            <Route path="reports/summary/:kind" element={<ProtectedRoute ownerOrPartner><ReportSummary /></ProtectedRoute>} />
            <Route path="finance" element={<ProtectedRoute ownerOrPartner><Finance /></ProtectedRoute>} />
            <Route path="comebacks" element={<Comebacks />} />
  <Route path="wip" element={<Wip />} />
            <Route path="locations" element={<ProtectedRoute ownerOnly><Locations /></ProtectedRoute>} />
            <Route path="targets" element={<ProtectedRoute ownerOrPartner><Targets /></ProtectedRoute>} />
            <Route path="users" element={<ProtectedRoute ownerOnly><Users /></ProtectedRoute>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
