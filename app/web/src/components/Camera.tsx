import { useEffect, useRef, useState } from "react";
import { api } from "../api";

// The K2 serves WebRTC on :8000. It only completes the handshake when the offer
// asks for a two-way (sendrecv) video channel; a recvonly offer gets an answer
// but the connection then stalls. It also seems to allow one viewer at a time,
// so the connection closes whenever this component unmounts.
async function connect(pc: RTCPeerConnection, url: string) {
  pc.addTransceiver("video", { direction: "sendrecv" });
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise<void>((done) => { // send the offer with all candidates in it
    if (pc.iceGatheringState === "complete") return done();
    pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && done());
    setTimeout(done, 2000);
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "plain/text" },
    body: btoa(JSON.stringify({ type: "offer", sdp: pc.localDescription!.sdp })),
  });
  await pc.setRemoteDescription(JSON.parse(atob(await res.text())));
}

type CamState = "connecting" | "live" | "failed" | "none"; // none: no printer set up

export function Camera({ children, openSettings }: { children?: React.ReactNode; openSettings?: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<CamState>("connecting");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setState("connecting");
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pc.ontrack = (e) => {
      if (video.current) video.current.srcObject = e.streams[0];
    };
    const v = video.current;
    const onPlaying = () => alive && setState("live");
    v?.addEventListener("playing", onPlaying);
    const timeout = setTimeout(() => alive && setState((s) => (s === "live" || s === "none" ? s : "failed")), 12_000);
    api<{ camera: string | null }>("/api/printer")
      .then(({ camera }) => (camera ? connect(pc, camera) : alive && setState("none")))
      .catch(() => alive && setState("failed"));
    return () => {
      alive = false;
      clearTimeout(timeout);
      v?.removeEventListener("playing", onPlaying);
      pc.close();
      if (v) v.srcObject = null;
    };
  }, [attempt]);

  return (
    <div className="camera">
      <video ref={video} muted autoPlay playsInline style={{ visibility: state === "live" ? "visible" : "hidden" }} />
      {state !== "live" && (
        <div className="empty" style={{ position: "absolute" }}>
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" />
          </svg>
          {state === "connecting" ? (
            <div className="mono" style={{ fontSize: 12 }}>Connecting to the camera…</div>
          ) : state === "none" ? (
            <>
              <div>No printer set up yet.</div>
              {openSettings && <button className="cta cta-sm" onClick={openSettings}>Add your K2</button>}
            </>
          ) : (
            <>
              <div>No video. The camera allows one viewer; close the Creality app if it's watching.</div>
              <button className="cta cta-sm" onClick={() => setAttempt((a) => a + 1)}>Try again</button>
            </>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
