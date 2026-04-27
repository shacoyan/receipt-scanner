import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AnalysisResult } from '../types/receipt';
import { useConfirmForms } from './confirm/useConfirmForms';
import ReceiptForm from './confirm/ReceiptForm';

interface LocationState {
  analyses: AnalysisResult[];
}

const ConfirmPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as LocationState;

  const analyses = state?.analyses;

  const {
    forms,
    loading,
    registered,
    isSubmitDisabled,
    handleChange,
    toggleSplit,
    disableSplit,
    handleSplitChange,
    addSplitRow,
    removeSplitRow,
    autoFillLastSplit,
    handleRegisterAll,
  } = useConfirmForms(analyses);

  if (!analyses || analyses.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">データがありません</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold text-indigo-700 mb-2">解析結果の確認</h1>
        <p className="text-gray-500 mb-8">{forms.length}件のレシートを確認してください</p>

        <div className="space-y-6">
          {forms.map((form, index) => (
            <ReceiptForm
              key={index}
              index={index}
              form={form}
              total={forms.length}
              onChange={(e) => handleChange(index, e)}
              onToggleSplit={() => toggleSplit(index)}
              onDisableSplit={() => disableSplit(index)}
              onSplitChange={(splitIdx, field, value) => handleSplitChange(index, splitIdx, field, value)}
              onAddSplitRow={() => addSplitRow(index)}
              onRemoveSplitRow={(splitIdx) => removeSplitRow(index, splitIdx)}
              onAutoFillLastSplit={() => autoFillLastSplit(index)}
            />
          ))}
        </div>

        <div className="mt-8 flex gap-4">
          <button
            onClick={() => navigate('/')}
            className="flex-1 py-2 px-4 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100 transition"
          >
            戻る
          </button>
          <button
            onClick={handleRegisterAll}
            disabled={isSubmitDisabled}
            className="flex-1 py-2 px-4 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 transition flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full inline-block" />
                <span>{registered}/{forms.length}件登録中...</span>
              </>
            ) : (
              `${forms.length}件をまとめて登録`
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmPage;
