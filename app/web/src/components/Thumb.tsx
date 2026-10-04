import { useEffect, useState } from "react";
import { thumbnail } from "../stage";
import type { Model } from "../types";

export function Thumb({ model }: { model: Model }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!model.file) return;
    thumbnail(model.meshKey, `/api/models/${model.id}/mesh`, model.jobs[0]?.hex ?? null)
      .then((t) => alive && setUrl(t.url))
      .catch(() => alive && setFailed(true));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.meshKey]);
  if (url) return <img src={url} alt="" />;
  return failed ? <span aria-label="No preview">—</span> : <span className="spinner" aria-label="Rendering preview" />;
}
