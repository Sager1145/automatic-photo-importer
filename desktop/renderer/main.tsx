import React from 'react';
import { createRoot } from 'react-dom/client';
import RootApp from './RootApp';
import { Boot } from './Boot';
import './styles.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><RootApp /><Boot /></React.StrictMode>);
