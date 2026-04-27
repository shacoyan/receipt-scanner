export const CATEGORIES = [
  '消耗品費',
  '交通費',
  '接待交際費',
  '会議費',
  '通信費',
  '雑費',
  '仕入高',
] as const;

export const TAX_OPTIONS = [
  { value: 136, label: '10% 標準' },
  { value: 137, label: '8% 軽減（食品）' },
] as const;
