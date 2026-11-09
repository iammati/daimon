import { useEffect, useRef, useState } from "react";
import { startGaze, sampleCalibPoint, resetCalibration } from "@/lib/daimon/gaze";

// 9 calibration points in normalized screen coords
const POINTS = [
  [0.1, 0.1], [0.5, 0.1], [0.9, 0.1],
  [0.1, 0.5], [0.5, 0.5], [0.9, 0.5],
  [0.1, 0.9], [0.5, 0.9], [0.9, 0.9],
];

type Props = {
  onDone: () => void;
  onCancel: () => void;
};

export function GazeCalibration({ onDone, onCancel }: Props) {
  const [step, setStep] = useState<"init" | "calibrating" | "done" | "error">("init");
  const [pointIdx, setPointIdx] = useState(0);
  const [samplesLeft, setSamplesLeft] = useState(3);
  const [error, setError] = useState("");
  const sampleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const startCalibration = async () => {
    resetCalibration();
    setStep("calibrating");
    setPointIdx(0);
    setSamplesLeft(3);
    try {
      await startGaze();
    } catch (e) {
      setError(String(e));
      setStep("error");
    }
  };

  const handlePointClick = () => {
    if (step !== "calibrating") return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const pt = POINTS[pointIdx]!;
    const sx = rect.left + pt[0]! * rect.width;
    const sy = rect.top + pt[1]! * rect.height;

    // Sample 3 times with small delay for stability
    let count = 0;
    const doSample = () => {
      const ok = sampleCalibPoint(sx, sy);
      count++;
      if (count < 3) {
        sampleTimer.current = setTimeout(doSample, 100);
        setSamplesLeft(3 - count);
        return;
      }
      setSamplesLeft(3);
      if (!ok) {
        setError("Face not detected. Make sure your face is visible.");
        setStep("error");
        return;
      }
      const next = pointIdx + 1;
      if (next >= POINTS.length) {
        setStep("done");
      } else {
        setPointIdx(next);
      }
    };
    doSample();
  };

  useEffect(() => () => { if (sampleTimer.current) clearTimeout(sampleTimer.current); }, []);

  const pt = POINTS[pointIdx];

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[100] bg-background/95 backdrop-blur-sm"
      style={{ cursor: step === "calibrating" ? "none" : "default" }}
    >
      {step === "init" && (
        <div className="flex h-full flex-col items-center justify-center gap-6">
          <div className="text-center space-y-2">
            <h2 className="font-mono text-[18px] font-semibold text-foreground">Eye tracking calibration</h2>
            <p className="font-mono text-[13px] text-muted-foreground max-w-sm">
              You'll click 9 points on screen while looking at each one. Takes ~20 seconds.
              Camera stays local — no data leaves your machine.
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={startCalibration}
              className="rounded-lg bg-signal px-5 py-2 font-mono text-[13px] text-background font-medium hover:bg-signal/90 transition-colors"
            >
              Start calibration
            </button>
            <button
              onClick={onCancel}
              className="rounded-lg border border-border px-5 py-2 font-mono text-[13px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === "calibrating" && pt && (
        <>
          <div
            className="absolute font-mono text-[11px] text-muted-foreground/60"
            style={{ left: "50%", top: 12, transform: "translateX(-50%)" }}
          >
            Look at the dot, then click it — {pointIdx + 1} / {POINTS.length}
          </div>
          {/* Calibration dot */}
          <button
            onClick={handlePointClick}
            className="absolute flex items-center justify-center"
            style={{
              left: `calc(${pt[0]! * 100}% - 20px)`,
              top: `calc(${pt[1]! * 100}% - 20px)`,
              width: 40,
              height: 40,
            }}
          >
            <span className="block size-4 rounded-full bg-signal animate-pulse" />
          </button>
          {/* Completed dots */}
          {POINTS.slice(0, pointIdx).map((p, i) => (
            <span
              key={i}
              className="absolute block size-2 rounded-full bg-signal/30"
              style={{ left: `calc(${p[0]! * 100}% - 4px)`, top: `calc(${p[1]! * 100}% - 4px)` }}
            />
          ))}
          <div
            className="absolute font-mono text-[10px] text-muted-foreground/40"
            style={{ left: "50%", bottom: 12, transform: "translateX(-50%)" }}
          >
            sampling {4 - samplesLeft}/3
          </div>
        </>
      )}

      {step === "done" && (
        <div className="flex h-full flex-col items-center justify-center gap-6">
          <div className="text-center space-y-2">
            <h2 className="font-mono text-[18px] font-semibold text-signal">Calibration complete</h2>
            <p className="font-mono text-[13px] text-muted-foreground">
              Eye tracking is now active. Use ⌘G to toggle.
            </p>
          </div>
          <button
            onClick={onDone}
            className="rounded-lg bg-signal px-5 py-2 font-mono text-[13px] text-background font-medium hover:bg-signal/90 transition-colors"
          >
            Start tracking
          </button>
        </div>
      )}

      {step === "error" && (
        <div className="flex h-full flex-col items-center justify-center gap-6">
          <div className="text-center space-y-2">
            <h2 className="font-mono text-[18px] font-semibold text-alarm">Calibration failed</h2>
            <p className="font-mono text-[13px] text-muted-foreground max-w-sm whitespace-pre-line">{error}</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => { setStep("init"); setError(""); }}
              className="rounded-lg bg-signal px-5 py-2 font-mono text-[13px] text-background font-medium hover:bg-signal/90 transition-colors"
            >
              Try again
            </button>
            <button
              onClick={onCancel}
              className="rounded-lg border border-border px-5 py-2 font-mono text-[13px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
