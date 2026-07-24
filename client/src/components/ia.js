// Phase 3 IA — the ONE definition of destinations and their tabs.
// RULE: every tab MUST carry an explicit `roles` array. Destination treats a
// roleless tab as visible to everyone (incl. advisors) while Layout's advisor
// filter is allow-list — omitting roles would make the two disagree. App.js
// builds the route tree from this; Layout derives nav roles from it. Tabs are
// PATH-based so each page's internal ?tab= deep links keep working untouched.
export const OPM = ['owner', 'partner', 'manager'];
export const ALL4 = ['owner', 'partner', 'manager', 'advisor'];
export const NUMBERS_TABS = [
  { path: '/numbers/scorecard', label: 'Scorecard', roles: ['owner', 'partner'] },
  { path: '/numbers/performance', label: 'Performance', roles: OPM },
  { path: '/numbers/goals', label: 'Goals', roles: OPM },
  { path: '/numbers/reports', label: 'Reports', roles: OPM },
];
export const MONEY_TABS = [
  { path: '/money/parts', label: 'Parts', roles: ['owner', 'partner'] },
  { path: '/money/finance', label: 'Finance', roles: OPM },
  { path: '/money/fuel', label: 'Fuel card', roles: OPM },
];
export const CREW_TABS = [
  { path: '/crew/technicians', label: 'Technicians', roles: OPM },
  { path: '/crew/time-clock', label: 'Time clock', roles: OPM },
  { path: '/crew/bonus', label: 'Bonus', roles: OPM },
];
export const SHOP_TABS = [
  { path: '/shop/wip', label: 'Committed WIP', roles: OPM },
  { path: '/shop/comebacks', label: 'Comebacks', roles: ALL4 },
  { path: '/shop/notices', label: 'TV notices', roles: ALL4 },
  { path: '/shop/reorders', label: 'Re-orders', roles: ALL4 },
];

// A destination's nav visibility = the union of its tabs' roles.
export const tabRoles = (tabs) => [...new Set(tabs.flatMap(t => t.roles || []))];
