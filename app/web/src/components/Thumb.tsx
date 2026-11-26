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
    thumbnail(model.id, model.meshKey, model.jobs[0]?.hex ?? null, model.jobs[0]?.parts.map((p) => p.hex))
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setFailed(true));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.meshKey]);
  if (url) return <img src={url} alt="" />;
  if (!model.file) return <span aria-label="Not drawn yet">✦</span>; // a new model Claude hasn't drawn yet
  return failed ? <span aria-label="No preview">—</span> : <span className="spinner" aria-label="Rendering preview" />;
}
