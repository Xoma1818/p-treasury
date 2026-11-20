// Test-only WebView2 adapter for the pinned v0.16.0 Windows build.
// Changes window startup only; the historical core, schema and data code remain intact.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(process.argv[2] ?? 'old');
const configPath = join(root, 'src-tauri/tauri.conf.json');
const sourcePath = join(root, 'src-tauri/src/lib.rs');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (config.version !== '0.16.0' || config.app.windows.length !== 1 || config.app.windows[0].create === false) {
  throw new Error('Unexpected old-build config; refusing instrumentation');
}
let source = readFileSync(sourcePath, 'utf8');
const anchor = '            app.manage(state);';
if (source.split(anchor).length !== 2 || source.includes('WebviewWindowBuilder::from_config')) {
  throw new Error('Unexpected old-build startup; refusing instrumentation');
}
source = source.replace(anchor, anchor + `
            // CI adapter: allow msedgedriver to pass its DevTools port/profile.
            let cfg = &app.config().app.windows[0];
            let mut main = tauri::WebviewWindowBuilder::from_config(app.handle(), cfg)?;
            if let Ok(args) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
                if args.contains("--test-type=webdriver") {
                    main = main.additional_browser_args(&format!("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection {args}"));
                }
            }
            main.build()?;
`);
config.app.windows[0].create = false;
writeFileSync(sourcePath, source);
writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
console.log('Instrumented v0.16.0 window startup for Windows WebDriver; core unchanged');
