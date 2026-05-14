export interface Script {
  id: string;
  name: string;
  description: string;
  /** If true, UI shows a config view before running. The script receives the config. */
  hasConfig?: boolean;
  run: (options?: any) => void | Promise<void>;
}

export interface ScreenToJsonOptions {
  exportImages: boolean;       // export PNG images
  outputMode: 'detailed' | 'compact' | 'backend';  // full JSON / compact / backend spec
  aiEnabled: boolean;           // run AI enrichment
  aiMode: 'bulk' | 'per-screen'; // send all at once vs per-screen + combine
}

export const DEFAULT_SCREEN_TO_JSON_OPTIONS: ScreenToJsonOptions = {
  exportImages: true,
  outputMode: 'detailed',
  aiEnabled: false,
  aiMode: 'per-screen',
};
