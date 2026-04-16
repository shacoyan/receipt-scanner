import React from 'react';
import { useNavigate } from 'react-router-dom';

const CompletePage: React.FC = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-md p-10 text-center">
        <div className="mx-auto w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mb-6">
          <svg
            className="w-8 h-8 text-indigo-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
        </div>

        <h1 className="text-2xl font-bold text-indigo-700 mb-3">登録完了</h1>
        <p className="text-gray-500 mb-8">
          レシートの内容が正常に登録されました。
        </p>

        <button
          onClick={() => navigate('/')}
          className="w-full py-3 px-4 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition font-medium"
        >
          もう1枚登録する
        </button>
      </div>
    </div>
  );
};

export default CompletePage;

