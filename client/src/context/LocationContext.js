import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useAuth } from './AuthContext';

// Global location scope. One selection drives every tab via the sidebar switcher.
// 'all' = group view (aggregate / per-location stacked). A uuid = that one shop.
// Managers are locked to their own location and never see 'all'.
const LocationContext = createContext(null);
export const useLocations = () => useContext(LocationContext);

const STORAGE_KEY = 'ops_selected_location';

export function LocationProvider({ children }) {
  const { api, user } = useAuth();
  const [locations, setLocations] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem(STORAGE_KEY) || 'all');

  useEffect(() => {
    if (!user) return;
    api('/locations')
      .then(ls => {
        const list = Array.isArray(ls) ? ls : [];
        setLocations(list);
        // Managers only ever see their own location.
        if (user.role === 'manager' && user.location_id) {
          setSelectedId(user.location_id);
        } else if (selectedId !== 'all' && !list.some(l => l.id === selectedId)) {
          // Persisted id no longer exists -> fall back to group view.
          setSelectedId('all');
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [api, user]); // eslint-disable-line

  const select = useCallback((id) => {
    setSelectedId(id);
    try { localStorage.setItem(STORAGE_KEY, id); } catch (e) { /* ignore */ }
  }, []);

  const isManager = user?.role === 'manager';
  const effectiveId = isManager && user?.location_id ? user.location_id : selectedId;
  const isAll = effectiveId === 'all';
  const active = locations.filter(l => l.active);
  // The shops a tab should render under the current scope.
  const scopeLocations = isAll ? (active.length ? active : locations) : locations.filter(l => l.id === effectiveId);
  const selected = isAll ? null : locations.find(l => l.id === effectiveId) || null;

  return (
    <LocationContext.Provider value={{
      locations, active, loaded,
      selectedId: effectiveId, isAll, selected, scopeLocations,
      canSwitch: !isManager,
      select,
    }}>
      {children}
    </LocationContext.Provider>
  );
}
