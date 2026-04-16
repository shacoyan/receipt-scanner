import React, { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import UploadPage from './pages/UploadPage';

const DashboardPage = lazy(() => import('./pages/DashboardPage'));

const App: React.FC = () => {
  return (
    <Routes>
      <Route path="/" element={<UploadPage />} />
      <Route path="/dashboard" element={
        <Suspense fallback={<div className="min-h-screen flex items-center justify-center">読み込み中...</div>}>
          <DashboardPage />
        </Suspense>
      } />
    </Routes>
  );
};

export default App;
