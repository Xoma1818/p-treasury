import { queryOptions, useIsFetching, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type UpdateInfo } from "../lib/api";
import { useAppInfo, useSettings } from "../lib/queries";
import { useAction } from "../lib/useAction";
import { ErrorText, Modal } from "./Modal";
import { ReleaseNotes } from "./ReleaseNotes";
import "./updates.css";

const updateQuery = queryOptions({ queryKey: ["available-update"], queryFn: api.checkUpdate, networkMode: "always", staleTime: 0, retry: false });
const releasesUrl = "https://github.com/Xoma1818/p-treasury-releases/releases/latest";

function UpdateModal({ info, portable = false, onClose, focusClose = false }: {
  info: UpdateInfo; portable?: boolean; onClose: () => void; focusClose?: boolean;
}) {
  const install = useAction(api.installUpdate, undefined, { singleSubmit: true, networkMode: "always" });
  const [copy, setCopy] = useState<"idle" | "copied" | "manual">("idle");
  const copyReleaseLink = async () => {
    try {
      await navigator.clipboard.writeText(releasesUrl);
      setCopy("copied");
    } catch {
      setCopy("manual");
    }
  };
  return (
    <Modal title="Доступно обновление" onClose={onClose} focusClose={focusClose} dismissDisabled={install.busy}>
      <p data-testid="update-version">Доступна версия {info.version} (у вас {info.current}).</p>
      <ReleaseNotes text={info.notes ?? ""} version={info.version ?? undefined} />
      {portable ? (
        <div className="portable-update">
          <p>Скачайте ZIP-архив переносной версии со страницы выпусков. Закройте Kazna и замените файл программы в её папке.</p>
          {copy === "manual" && (
            <label>Ссылка для скачивания
              <input readOnly value={releasesUrl} autoFocus onFocus={(event) => event.currentTarget.select()} />
            </label>
          )}
          <span role="status">{copy === "copied" && "Ссылка скопирована."}</span>
        </div>
      ) : <p className="hint">Перед установкой Kazna сохранит резервную копию бюджета и перезапустится после обновления.</p>}
      <ErrorText error={install.error} />
      <div className="actions">
        <span className="spacer" />
        <button className="btn" onClick={onClose} disabled={install.busy}>Позже</button>
        {portable
          ? <button className="btn primary" onClick={copyReleaseLink}>Скопировать ссылку</button>
          : <button className="btn primary" onClick={() => install.run()} disabled={install.busy}>{install.busy ? "Обновляем…" : "Обновить"}</button>}
      </div>
    </Modal>
  );
}

export function UpdatePrompt() {
  const qc = useQueryClient();
  const settings = useSettings().data;
  const appInfo = useAppInfo().data;
  const [checkOnStartup, setCheckOnStartup] = useState<boolean>();
  const [offer, setOffer] = useState<UpdateInfo | null>(null);
  const focusBeforeOffer = useRef<HTMLElement | null>(null);
  // После загрузки фиксируем настройку этого запуска. Изменения действуют со следующего.
  useEffect(() => {
    if (checkOnStartup === undefined && settings && appInfo) {
      setCheckOnStartup(!appInfo.portable && settings.update_check !== "0");
    }
  }, [appInfo, settings, checkOnStartup]);
  useEffect(() => {
    if (!checkOnStartup) return;
    let active = true;
    let waitingForForm: MutationObserver | undefined;
    qc.fetchQuery(updateQuery).then(
      (result) => {
        if (!active || !result.version) return;
        const showWhenFree = () => {
          if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
          waitingForForm?.disconnect();
          focusBeforeOffer.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setOffer(result);
        };
        waitingForForm = new MutationObserver(showWhenFree);
        waitingForForm.observe(document.body, { childList: true, subtree: true });
        showWhenFree();
      },
      () => {}, // Ошибка фоновой проверки не прерывает работу с бюджетом.
    );
    return () => { active = false; waitingForForm?.disconnect(); };
  }, [checkOnStartup, qc]);
  return offer ? <UpdateModal info={offer} focusClose onClose={() => {
    setOffer(null);
    if (focusBeforeOffer.current?.isConnected) focusBeforeOffer.current.focus({ preventScroll: true });
  }} /> : null;
}

export function UpdatesCard({ active }: { active: boolean }) {
  const qc = useQueryClient();
  const appInfo = useAppInfo();
  const info = appInfo.data;
  const settings = useSettings();
  const autoCheck = useMutation({
    networkMode: "always",
    mutationFn: (enabled: boolean) => api.setSetting("update_check", enabled ? "1" : "0"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
  const [offer, setOffer] = useState<UpdateInfo | null>(null);
  const [news, setNews] = useState<string | null>(null);
  const requested = useRef<"update" | "news" | null>(null);
  useLayoutEffect(() => {
    if (!active) {
      requested.current = null;
      setOffer(null);
      setNews(null);
    }
  }, [active]);
  const checkButton = useRef<HTMLButtonElement>(null);
  const newsButton = useRef<HTMLButtonElement>(null);
  const checking = useIsFetching({ queryKey: updateQuery.queryKey }) > 0;
  const check = useMutation({
    networkMode: "always",
    mutationFn: () => qc.fetchQuery(updateQuery),
    onSuccess: (result) => { if (requested.current === "update" && result.version) setOffer(result); },
  });
  const history = useMutation({
    networkMode: "always",
    mutationFn: api.changelog,
    onSuccess: (notes) => { if (requested.current === "news") setNews(notes); },
  });
  const result = check.data;
  let status = "";
  if (checking || check.isPending) status = "Проверяем обновления…";
  else if (result) {
    if (!result.configured) status = "Для этой сборки проверка обновлений недоступна.";
    else if (result.version) status = `Доступна версия ${result.version}.`;
    else status = "Установлена последняя версия.";
  }
  return (
    <div id="set-updates" className="card settings-section updates-card" data-testid="updates-card" tabIndex={-1}>
      <div className="updates-overview">
        <div>
          <h2>Обновления</h2>
          {info && <p className="updates-installed">Установлена версия <strong data-testid="app-version">{info.version}</strong></p>}
        </div>
        <div className="btn-group updates-actions">
          <button ref={checkButton} className="btn primary" disabled={!info} aria-disabled={checking || check.isPending || !info}
            onClick={() => {
              if (checking || check.isPending) return;
              requested.current = "update";
              check.mutate();
            }}>Проверить обновления</button>
          <button ref={newsButton} name="releaseNotes" className="link" aria-disabled={history.isPending}
            onClick={() => {
              if (history.isPending) return;
              requested.current = "news";
              history.mutate();
            }}>Что нового</button>
        </div>
      </div>
      {appInfo.isError && <><ErrorText error={String(appInfo.error)} /><button className="link" onClick={() => appInfo.refetch()}>Повторить загрузку сведений</button></>}
      <p className="updates-status" role="status" data-testid="update-result">{status}</p>
      <ErrorText error={check.isError ? String(check.error) : null} />
      {history.isPending && <p className="updates-status" role="status">Загружаем историю версий…</p>}
      <ErrorText error={history.isError ? String(history.error) : null} />
      {info && (info.portable ? (
        <p className="updates-preference">В переносной версии обновления проверяются вручную.</p>
      ) : (
        <label className="updates-preference">
          <span>Проверять обновления при запуске</span>
          <span className="updates-control">
            <input type="checkbox" role="switch" name="updateCheck"
              checked={autoCheck.isPending ? autoCheck.variables : settings.data?.update_check !== "0"}
              disabled={!settings.data} aria-disabled={!settings.data || autoCheck.isPending}
              onChange={(event) => { if (!autoCheck.isPending) autoCheck.mutate(event.target.checked); }} />
            <span className="switch" aria-hidden="true" />
          </span>
        </label>
      ))}
      <ErrorText error={autoCheck.isError ? String(autoCheck.error) : settings.isError ? String(settings.error) : null} />
      <details id="set-technical" className="updates-details" data-testid="about-details">
        <summary>Технические сведения</summary>
        {info ? (
          <dl className="facts">
            <dt>Версия данных</dt><dd>{info.schemaVersion} из {info.supportedSchemaVersion}</dd>
            <dt>Файл данных</dt><dd className="file-path">{info.dbPath}</dd>
            {info.preMigrationBackup && <><dt>Копия перед обновлением</dt><dd className="file-path">{info.preMigrationBackup}</dd></>}
          </dl>
        ) : appInfo.isPending && <p className="hint" role="status">Загружаем сведения…</p>}
      </details>
      {active && offer && info && (
        <UpdateModal info={offer} portable={info.portable} focusClose onClose={() => { setOffer(null); checkButton.current?.focus(); }} />
      )}
      {active && !offer && news !== null && (
        <Modal title="Что нового" focusClose onClose={() => { setNews(null); newsButton.current?.focus(); }} wide>
          <ReleaseNotes text={news} version={info?.version} />
        </Modal>
      )}
    </div>
  );
}
