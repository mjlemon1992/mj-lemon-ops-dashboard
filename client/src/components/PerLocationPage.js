import React from 'react';
import { useLocations } from '../context/LocationContext';

// Wrapper for per-location pages (Bonus, Time Clock, Fuel Card). On 'All
// locations' it VIEWS the first shop without touching the global selection —
// the group view survives navigation. The inline picker switches shops via an
// explicit user choice (select() persists, as it does from the sidebar).
export default function PerLocationPage({ children }) {
  const { isAll, selectedId, scopeLocations, select } = useLocations();
  const locId = isAll ? (scopeLocations[0] ? scopeLocations[0].id : null) : selectedId;
  if (!locId) return null;
  return (
    <div>
      {isAll && scopeLocations.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', fontSize: '12px', color: 'var(--text3)' }}>
          Showing
          <select value={locId} onChange={(e) => select(e.target.value)} style={{ width: 'auto', fontSize: '12px' }}>
            {scopeLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <span>— group view stays selected in the sidebar</span>
        </div>
      )}
      {children(locId)}
    </div>
  );
}
