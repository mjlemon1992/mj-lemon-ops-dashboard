import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLocations } from '../context/LocationContext';
import ApprovalQueue from '../components/ApprovalQueue';

// Full approvals list — the "view all" target from the marketing tab's compact queue.
// Renders the approval queue with no preview limit, so every draft + ready-to-post shows.
// Scopes to the global location switcher: a specific shop -> that shop's approvals; in
// "All locations" mode (no single shop) it keeps a local picker, defaulting to the first
// active shop. (Previously it always defaulted to the first active shop, so clicking
// "N approvals waiting" from another shop's workspace landed on the wrong, empty queue.)
export default function ApprovalsPage() {
  const navigate = useNavigate();
  const { locations, active, selectedId, isAll } = useLocations();
  const [picked, setPicked] = useState(null);
  const fallback = (active[0] || locations[0])?.id || null;
  const locId = isAll ? (picked || fallback) : selectedId;
  const loc = locations.find(l => l.id === locId);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <button onClick={() => navigate('/marketing')} style={{ fontSize: '12px' }}>← Marketing</button>
        <div style={{ fontSize: '15px', fontWeight: 500, color: 'var(--text)' }}>Approvals</div>
        {isAll && locations.length > 1 ? (
          <select value={locId || ''} onChange={e => setPicked(e.target.value)} style={{ width: 'auto' }}>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        ) : (
          loc && <span style={{ fontSize: '12px', color: 'var(--text3)' }}>{loc.name}</span>
        )}
      </div>
      {locId && <ApprovalQueue locId={locId} locName={loc?.name} />}
    </div>
  );
}
