import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<React.StrictMode><App /></React.StrictMode>);

// PWA: register the service worker (production only)
if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((err) => {
      console.warn('SW registration failed:', err);
    });
  });
}

// Auto-update: an open session never noticed a new deploy, so the user had to
// force-quit the PWA after every ship. This watches the deployed bundle hash and
// shows a one-tap Refresh banner when it changes. SW-agnostic; reload() hits the
// network-first shell and pulls the new bundle.
if (process.env.NODE_ENV === 'production') {
  const running = (() => {
    const s = document.querySelector('script[src*="/static/js/main."]');
    const m = s && s.src.match(/main\.[a-z0-9]+\.js/);
    return m ? m[0] : null;
  })();
  let shown = false;
  let poll = null;
  const showBanner = () => {
    if (shown) return; shown = true;
    if (poll) clearInterval(poll);   // stop polling once the banner is up
    const bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;display:flex;align-items:center;gap:14px;background:#16181B;color:#fff;border:1px solid rgba(255,255,255,0.14);border-radius:12px;padding:11px 14px 11px 16px;font:500 13px -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,0.4)';
    const txt = document.createElement('span'); txt.textContent = 'A new version is available.';
    const btn = document.createElement('button');
    btn.textContent = 'Refresh';
    btn.style.cssText = 'background:#F05423;color:#fff;border:0;border-radius:8px;padding:7px 14px;font:600 13px inherit;cursor:pointer';
    btn.onclick = () => window.location.reload();
    bar.appendChild(txt); bar.appendChild(btn);
    document.body.appendChild(bar);
  };
  const check = async () => {
    try {
      const html = await (await fetch('/', { cache: 'no-store' })).text();
      const m = html.match(/main\.[a-z0-9]+\.js/);
      if (m && running && m[0] !== running) showBanner();
    } catch (_) { /* offline / transient — ignore */ }
  };
  poll = setInterval(check, 120000);
  window.addEventListener('focus', check);
}
