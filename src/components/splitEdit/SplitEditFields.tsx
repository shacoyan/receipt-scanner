import React from 'react';

interface SplitEditFieldsProps {
  date: string;
  store: string;
  sectionId: string;
  totalAmount: number;
  sections: string[];
  onChangeDate: (v: string) => void;
  onChangeStore: (v: string) => void;
  onChangeSection: (v: string) => void;
  onChangeTotalAmount: (v: number) => void;
}

const SplitEditFields: React.FC<SplitEditFieldsProps> = ({
  date,
  store,
  sectionId,
  totalAmount,
  sections,
  onChangeDate,
  onChangeStore,
  onChangeSection,
  onChangeTotalAmount,
}) => {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-700">日付</label>
        <input
          type="date"
          value={date}
          onChange={(e) => onChangeDate(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-700">店名</label>
        <input
          type="text"
          value={store}
          onChange={(e) => onChangeStore(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-700">部門</label>
        <select
          value={sectionId}
          onChange={(e) => onChangeSection(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
        >
          <option value="">未設定</option>
          {sections.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-700">総額</label>
        <input
          type="number"
          step={1}
          min={1}
          value={totalAmount || ''}
          onChange={(e) => onChangeTotalAmount(Number(e.target.value) || 0)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
        />
      </div>
    </div>
  );
};

export default SplitEditFields;
