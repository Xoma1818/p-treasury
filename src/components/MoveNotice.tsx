import { useState } from "react";

/** A single live region per screen. Report the destination after both the
 * command and the refresh of the displayed records have completed. */
export function useMoveNotice() {
  const [text, setText] = useState("");
  const confirm = async (commit: Promise<unknown>, destination: string) => {
    setText("");
    await commit;
    setText(destination);
  };
  return { confirm, status: <span className="sr-only" role="status" aria-atomic="true" data-testid="move-result">{text}</span> };
}
