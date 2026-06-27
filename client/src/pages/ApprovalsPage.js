import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import ApprovalQueue from '../components/ApprovalQueue';

// Full approvals list — the "view all" target from the marketing tab's compact queue.
// Renders the approval queue with no preview limit, so every draft + ready-to-post shows.
export default function ApprovalsPage() {
  const { api } = useAuth();
  const navigate = useNavigate();
  const [locations, setLocations] = useState([]);
  const [locId, setLocId] = useState(null);

  useEffect(() => {
    api('/locations').then(locs => {
      setLocations(locs);
      const first = locs.filter(l => l.active)[0] || locs[0];
      if (first) setLocId(first.id);
    }).catch(() => {});
  }, [api]);

  const loc = locations.find(l => l.id === locId);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <button onClick={() => navigate('/marketing')} style={{ fontSize: '12px' }}>← Marketing</button>
        <div style={{ fontSize: '15px', fontWeight: 500, color: 'var(--text)' }}>Approvals</div>
        {locations.length > 1 && (
          <select value={locId || ''} onChange={e => setLocId(e.target.value)} style={{ width: 'auto' }}>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
      </div>
      {locId && <ApprovalQueue locId={locId} locName={loc?.name} />}
    </div>
  );
}
