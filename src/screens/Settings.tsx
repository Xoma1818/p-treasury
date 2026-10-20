import { useQuery } from "@tanstack/react-query";
import { api, isTauri } from "../lib/api";
import { Money } from "../components/Money";

// Этап 0: вкладка «О программе» с версией приложения и схемы данных.
export function Settings() {
  const info = useQuery({ queryKey: ["appInfo"], queryFn: api.appInfo, enabled: isTauri() });
  const currencies = useQuery({ queryKey: ["currencies"], queryFn: api.listCurrencies, enabled: isTauri() });

  return (
    <section className="screen">
      <h1>Настройки</h1>
      <div className="card">
        <h2>О программе</h2>
        {!isTauri() && <p className="muted">Открыто в браузере: данные доступны только в приложении.</p>}
        {info.error && <p className="error">{String(info.error)}</p>}
        {info.data && (
          <dl className="facts">
            <dt>Версия</dt>
            <dd>{info.data.version}</dd>
            <dt>Версия данных</dt>
            <dd>
              {info.data.schemaVersion} из {info.data.supportedSchemaVersion}
            </dd>
            <dt>Файл данных</dt>
            <dd className="mono">{info.data.dbPath}</dd>
            {info.data.preMigrationBackup && (
              <>
                <dt>Копия перед обновлением</dt>
                <dd className="mono">{info.data.preMigrationBackup}</dd>
              </>
            )}
          </dl>
        )}
      </div>
      <div className="card">
        <h2>Валюты</h2>
        <p className="muted">
          Пример суммы: <Money amount={1_497_723} />
        </p>
        <ul className="plain">
          {currencies.data?.map((c) => (
            <li key={c.code}>
              <span className="mono">{c.code}</span> {c.name} ({c.symbol})
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
