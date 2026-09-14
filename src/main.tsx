import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

async function start() {
  // Runtime configuration lets a changed .env take effect without rebuilding.
  try {
    const response = await fetch('/api/config');
    if (response.ok) window.label3dConfig = await response.json();
  } catch {
    // Portable static deployments still support local file imports.
  }
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void start();
