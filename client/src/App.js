import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LocationProvider } from './context/LocationContext';
import Login from './pages/Login';
import Display from './pages/Display';
import Layout from './components/Layout';
import { Destination, DefaultTab, RedirectKeep } from './components/Destination';
import { NUMBERS_TABS, MONEY_TABS, CREW_TABS, SHOP_TABS } from './components/ia';
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

// Advisors land on their board, not the WIP tab they can't use.
function ShopIndex() {
  const { user } = useAuth();
  if (user?.role === 'advisor') return <RedirectKeep to="/shop/reorders" />;
  return <DefaultTab tabs={SHOP_TABS} />;
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

            {/* ── Destinations ── */}
            <Route path="numbers" element={<Destination tabs={NUMBERS_TABS} />}>
              <Route index element={<DefaultTab tabs={NUMBERS_TABS} />} />
              <Route path="scorecard" element={<ProtectedRoute ownerOrPartner><Scorecard /></ProtectedRoute>} />
              <Route path="performance" element={<Performance />} />
              <Route path="goals" element={<Targets />} />
              <Route path="reports" element={<Reports />} />
            </Route>
            <Route path="money" element={<Destination tabs={MONEY_TABS} />}>
              <Route index element={<DefaultTab tabs={MONEY_TABS} />} />
              <Route path="parts" element={<ProtectedRoute ownerOrPartner><PartsRecon /></ProtectedRoute>} />
              <Route path="finance" element={<Finance />} />
              <Route path="fuel" element={<FuelCard />} />
            </Route>
            <Route path="crew" element={<Destination tabs={CREW_TABS} />}>
              <Route index element={<DefaultTab tabs={CREW_TABS} />} />
              <Route path="technicians" element={<Technicians />} />
              <Route path="time-clock" element={<TimeClock />} />
              <Route path="bonus" element={<Bonus />} />
            </Route>
            <Route path="shop" element={<Destination tabs={SHOP_TABS} />}>
              <Route index element={<ShopIndex />} />
              <Route path="wip" element={<Wip />} />
              <Route path="comebacks" element={<Comebacks />} />
              <Route path="notices" element={<Notices />} />
              <Route path="reorders" element={<Reorders />} />
            </Route>
            <Route path="studio" element={<Marketing />} />
            <Route path="studio/approvals" element={<ApprovalsPage />} />
            <Route path="atlas" element={<ProtectedRoute ownerOrPartner><ChiefOfStaff /></ProtectedRoute>} />

            {/* ── Kept as-is: history + print surfaces + admin ── */}
            <Route path="alerts" element={<Alerts />} />
            <Route path="reports/tech-efficiency" element={<ReportTechEfficiency />} />
            <Route path="reports/summary/:kind" element={<ReportSummary />} />
            <Route path="locations" element={<ProtectedRoute ownerOnly><Locations /></ProtectedRoute>} />
            <Route path="users" element={<ProtectedRoute ownerOnly><Users /></ProtectedRoute>} />

            {/* ── Redirects: every pre-Phase-3 URL keeps working, query intact
                 (Inbox deep links, push notifications, bookmarks). The
                 migration-manifest rule: never 404 an old path. ── */}
            <Route path="scorecard" element={<RedirectKeep to="/numbers/scorecard" />} />
            <Route path="performance" element={<RedirectKeep to="/numbers/performance" />} />
            <Route path="targets" element={<RedirectKeep to="/numbers/goals" />} />
            <Route path="reports" element={<RedirectKeep to="/numbers/reports" />} />
            <Route path="technicians" element={<RedirectKeep to="/crew/technicians" />} />
            <Route path="time-clock" element={<RedirectKeep to="/crew/time-clock" />} />
            <Route path="bonus" element={<RedirectKeep to="/crew/bonus" />} />
            <Route path="fuel-card" element={<RedirectKeep to="/money/fuel" />} />
            <Route path="parts" element={<RedirectKeep to="/money/parts" />} />
            <Route path="finance" element={<RedirectKeep to="/money/finance" />} />
            <Route path="wip" element={<RedirectKeep to="/shop/wip" />} />
            <Route path="comebacks" element={<RedirectKeep to="/shop/comebacks" />} />
            <Route path="notices" element={<RedirectKeep to="/shop/notices" />} />
            <Route path="reorders" element={<RedirectKeep to="/shop/reorders" />} />
            <Route path="marketing" element={<RedirectKeep to="/studio" />} />
            <Route path="marketing/approvals" element={<RedirectKeep to="/studio/approvals" />} />
            <Route path="chief-of-staff" element={<RedirectKeep to="/atlas" />} />
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
