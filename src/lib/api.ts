// Типизированный доступ к командам ядра. UI не пишет SQL и не знает о базе.
import { invoke } from "@tauri-apps/api/core";

export interface AppInfo {
  version: string;
  schemaVersion: number;
  supportedSchemaVersion: number;
  dbPath: string;
  preMigrationBackup: string | null;
}

export interface Currency {
  code: string;
  name: string;
  symbol: string;
  minorUnits: number;
}

export type Settings = Record<string, string>;

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  getSettings: () => invoke<Settings>("get_settings"),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  listCurrencies: () => invoke<Currency[]>("list_currencies"),
};
