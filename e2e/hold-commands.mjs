/** Отложить выбранные команды до разрешения теста, сохраняя штатный ответ ядра. */
export async function holdCommands(browser, commands) {
  await browser.execute((names) => {
    let release;
    const waiting = new Promise(done => { release = done; });
    const calls = [];
    const seen = new Set();
    const pause = (name, callback, send) => {
      if (!names.includes(name)) return send();
      // При смене транспорта Tauri сохраняет callback исходного запроса.
      if (!seen.has(callback)) { calls.push(name); seen.add(callback); }
      return waiting.then(send);
    };
    const originalFetch = window.fetch;
    const port = window.chrome?.webview ?? window.webkit?.messageHandlers?.ipc;
    const descriptor = port && Object.getOwnPropertyDescriptor(port, "postMessage");
    if (port) {
      const originalPost = port.postMessage;
      Object.defineProperty(port, "postMessage", { configurable: true, value(message) {
        let envelope;
        if (typeof message === "string" && names.some(name => message.includes(name))) {
          try { envelope = JSON.parse(message); } catch { /* Не сообщение Tauri. */ }
        }
        return pause(envelope?.cmd, envelope?.callback, () => originalPost.call(port, message));
      } });
    }
    window.fetch = (...args) => {
      const [request, init] = args;
      const url = new URL(request instanceof Request ? request.url : request, location.href);
      const name = url.pathname.split("/").pop();
      const callback = new Headers(init?.headers ?? (request instanceof Request ? request.headers : undefined)).get("Tauri-Callback");
      return pause(name, callback === null ? undefined : Number(callback), () => originalFetch(...args));
    };
    window.heldCommands = { calls, release, restore() {
      release();
      window.fetch = originalFetch;
      if (descriptor) Object.defineProperty(port, "postMessage", descriptor);
      else if (port) delete port.postMessage;
      delete window.heldCommands;
    } };
  }, commands);
}
