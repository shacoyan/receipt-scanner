import React, { useState, useRef, useCallback } from 'react';

interface DropZoneProps {
  onFiles: (files: File[]) => void;
}

const DropZone: React.FC<DropZoneProps> = ({ onFiles }) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedCount, setSelectedCount] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      const imageFiles = Array.from(files).filter((file) =>
        file.type.startsWith('image/')
      );
      if (imageFiles.length > 0) {
        setSelectedCount(imageFiles.length);
        onFiles(imageFiles);
      }
    },
    [onFiles]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleFiles(e.target.files);
    }
  };

  return (
    <div
      onClick={handleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`
        relative flex flex-col items-center justify-center
        w-full min-h-[300px] p-8
        border-2 border-dashed rounded-2xl cursor-pointer
        transition-all duration-200
        ${
          isDragOver
            ? 'border-indigo-500 bg-indigo-50 scale-[1.02]'
            : 'border-gray-300 bg-white hover:border-indigo-400 hover:bg-indigo-50/50'
        }
      `}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleChange}
        className="hidden"
      />

      {selectedCount > 0 ? (
        <div className="flex flex-col items-center gap-4">
          <div className="text-5xl">🧾</div>
          <p className="text-xl font-bold text-indigo-700">{selectedCount}枚選択済み</p>
          <p className="text-sm text-gray-500">クリックして選び直す</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 text-gray-400">
          <svg
            className="w-16 h-16 text-indigo-300"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
            />
          </svg>
          <div className="text-center">
            <p className="text-lg font-medium text-indigo-600">
              レシート画像をドラッグ&ドロップ
            </p>
            <p className="mt-1 text-sm">またはクリックしてファイルを選択（複数可）</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default DropZone;
