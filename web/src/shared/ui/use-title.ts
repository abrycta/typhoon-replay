import { useEffect } from "react";

export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    if (title) document.title = `${title} · Typhoon Replay`;
    else document.title = "Typhoon Replay";
  }, [title]);
}
