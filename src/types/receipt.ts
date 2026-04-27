// receipt-scanner 共通型定義
// 5 ファイル間の重複を 1 箇所に集約。フィールドは既存全定義の和集合。

export type ReceiptStatus = 'pending' | 'processing' | 'done' | 'approved' | 'error';

/**
 * OCR 結果 splits の 1 行。
 * tax_code は OCR 由来のため number（緩い）。UI 編集後は SplitItem を使う。
 */
export interface ReceiptResultSplit {
  category: string;
  amount: number;
  tax_code: number;
  description?: string;
}

/**
 * receipts.result_json に格納される OCR 解析結果。
 * uncertainty_reason は ApproveCard / ApprovePage のみ参照（DashboardPage は無視）。
 */
export interface ReceiptResult {
  date: string;
  amount: number;
  store: string;
  category: string;
  tax_code?: number | null;
  splits?: ReceiptResultSplit[] | null;
  uncertainty_reason?: string | null;
}

/**
 * receipts テーブル 1 行に対応するフロント表現。
 */
export interface Receipt {
  id: string;
  image_url: string;
  status: ReceiptStatus;
  result_json: ReceiptResult | null;
  error_message: string | null;
  section_id: string | null;
  created_at: string;
  freee_sent_at: string | null;
  freee_deal_id: string | null;
}

/**
 * GET /api/receipts のレスポンス。
 */
export interface ReceiptsResponse {
  data: Receipt[];
  total: number;
  page: number;
}

/**
 * UI 確定後の split 1 行（ConfirmPage / SplitEditModal で使用）。
 * tax_code は確定値 136 (10%) または 137 (8%)。
 * description は optional（既存 SplitEditModal 互換）。
 */
export interface SplitItem {
  category: string;
  amount: number;
  tax_code: 136 | 137;
  description?: string;
}

/**
 * ConfirmPage の OCR 結果 1 件分（nullable フィールドを含む）。
 * amount/store/category/memo は OCR が判別不能の場合 null になる。
 */
export interface AnalysisResult {
  date: string | null;
  amount: number | null;
  store: string | null;
  category: string | null;
  memo: string | null;
  tax_code?: number | null;
  splits?: SplitItem[] | null;
}
