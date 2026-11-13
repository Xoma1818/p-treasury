// 0.34.1: вместо белого окна — понятный экран. Если при отрисовке что-то упало,
// пользователь видит текст ошибки, может перезагрузить окно или открыть Главную,
// а текст можно скопировать и прислать нам. Данные при этом не трогаются.
import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from "react";
import { rememberSection } from "../lib/fine";

interface Props {
  children: ReactNode;
  /** Ошибка в разделе: остальное окно (меню) работает, показываем экран на месте раздела. */
  inline?: boolean;
  /** Карточка Главной: короткая надпись на месте карточки, остальная Главная работает. */
  card?: string;
}

interface State {
  error: Error | null;
  stack: string;
}

export class CrashGuard extends Component<Props, State> {
  state: State = { error: null, stack: "" };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const where = (info.componentStack ?? "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 6).join("\n");
    const js = error instanceof Error && error.stack ? error.stack.split("\n").slice(0, 6).join("\n") : "";
    this.setState({ stack: [js, where].filter(Boolean).join("\n---\n") });
    console.error("Kazna: ошибка отрисовки", error);
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    if (this.props.card)
      return (
        <div className="card crash" data-testid="crash-card">
          <p>
            Карточка «{this.props.card}» не открылась: <span className="error">{error.message}</span>
          </p>
          <button type="button" className="link" onClick={() => this.setState({ error: null, stack: "" })}>
            Открыть ещё раз
          </button>
        </div>
      );
    return <CrashScreen error={error} stack={stack} inline={this.props.inline} onRetry={() => this.setState({ error: null, stack: "" })} />;
  }
}

function CrashScreen({ error, stack, inline, onRetry }: { error: Error; stack: string; inline?: boolean; onRetry: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `${error.message}\n${stack}`.trim();
  const home = () => {
    rememberSection("home");
    window.location.reload();
  };
  return (
    <div className={inline ? "card crash" : "wizard"} data-testid="crash">
      <div className={inline ? "" : "card wizard-card crash"}>
        <h1>Этот экран не открылся</h1>
        <p>Ваши данные в порядке: ошибка только в отображении. Попробуйте открыть экран ещё раз или перейдите на Главную.</p>
        <p className="error" data-testid="crash-message">{error.message}</p>
        <div className="actions">
          <button type="button" className="btn primary" onClick={inline ? onRetry : () => window.location.reload()}>
            Открыть ещё раз
          </button>
          <button type="button" className="btn" onClick={home}>
            На Главную
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              navigator.clipboard?.writeText(text).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }
          >
            {copied ? "Скопировано" : "Скопировать текст ошибки"}
          </button>
        </div>
        <details>
          <summary>Подробности для разработчиков</summary>
          <pre className="crash-stack">{text}</pre>
        </details>
      </div>
    </div>
  );
}

/** Пока ядро открывает данные: через пару секунд — надпись, а не пустое окно. */
export function Opening() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 1500);
    return () => clearTimeout(t);
  }, []);
  if (!slow) return null;
  return (
    <div className="wizard" data-testid="opening">
      <div className="card wizard-card">
        <p>Открываем данные…</p>
        <p className="hint">Если надпись не исчезает больше минуты, закройте Kazna через значок в трее («Выход») и откройте снова.</p>
      </div>
    </div>
  );
}
