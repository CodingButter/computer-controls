"use client";

import { Check, Mic, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { assembleTemplates, TARGET_TAKES } from "@hub/wake/enrollment";
import { putWakeTemplates, type WakeTemplate, type WakeTemplatesView } from "@/lib/hub";
import { CAPTURE_RATE, recordTake as defaultRecordTake, type RecordTake } from "@/lib/wake-capture";
import {
  COUNTDOWN_TICK_MS,
  IDLE,
  afterTake,
  afterTick,
  isRunning,
  startAt,
  walkthroughMessage,
  walkthroughProgress,
  type Walkthrough,
} from "@/lib/wake-walkthrough";
import { cn } from "@/lib/utils";

/**
 * Teaching the machine your voice.
 *
 * The wake phrase is not a word in a transcript any more — it is a shape in the
 * audio, and the shape it compares against has to be yours. This is where you
 * hand it over: a guided run through every take, a score under each one, and a
 * save that every listening surface on this hub reads afterwards.
 *
 * It is a walkthrough rather than a row of buttons because of what it is asking
 * for. The takes are meant to be the same phrase said the same way, and a
 * person who has to find and press a button between each one says it a little
 * differently each time — a bit clipped, a bit rushed, aimed at the mouse. One
 * press, a countdown, and a beep at each end leaves their hands and their
 * attention where the microphone is, and the recording is of somebody talking
 * rather than somebody operating a form.
 *
 * The score is not decoration. It is computed with the same matcher the gate
 * runs later, so a take that reads below half is a take the gate would refuse,
 * and a person can hear that while they are still standing at the microphone
 * rather than three days later when the orb ignores them.
 *
 * The recording never leaves the browser. What is saved is a sequence of
 * cepstral frames, which is arithmetic about a sound and not the sound: nothing
 * on the hub can play back what was said here.
 *
 * The file is split the way the rest of the dashboard splits: a view that is a
 * function of its props, and a shell around it holding the microphone and the
 * network. The tests render the view, because the view is what a person meets.
 */

/** The phrase, fixed. A wake word a person can change is a wake word they mistype. */
export const ENROLL_PHRASE = "hey mastra";

export type Take = { samples: Int16Array; score: number };

/**
 * The take sequence after recording into a slot.
 *
 * The scores describe a sequence — each take against the ones before it — so
 * replacing take two invalidates the numbers under takes three and four. They
 * are rescored rather than discarded. Dropping them was the older answer, and
 * it was answering the right question: a take kept with a score computed
 * against a recording that no longer exists is a number nothing stands behind.
 * Rescoring removes the reason instead of paying for it, and nobody loses three
 * good takes to fix one bad one.
 */
export function takesAfterRecording(
  previous: readonly Take[],
  slot: number,
  samples: Int16Array,
): Take[] {
  const next = previous.map((take) => take.samples);
  next[slot] = samples;
  const { scores } = assembleTemplates(next, {
    phrase: ENROLL_PHRASE,
    sampleRate: CAPTURE_RATE,
  });
  return next.map((s, i) => ({ samples: s, score: scores[i] ?? 0 }));
}

/** What the person is told about a take, in the terms the gate decides in. */
export function scoreLabel(score: number, index: number): string {
  if (index === 0) return "First take — nothing to compare it with yet.";
  if (score >= 0.75) return "Sounds like the others.";
  if (score >= 0.5) return "Close enough for the gate to open.";
  return "Too far from your other takes — say it the same way and re-record.";
}

/** Why the microphone did not open, in words a person can act on. */
export function captureProblem(error: unknown): string {
  if (error instanceof Error && error.name === "NotAllowedError") {
    return "The browser refused the microphone. Allow it for this page and try again.";
  }
  return error instanceof Error ? error.message : "The microphone could not be opened.";
}

export type WakeTrainingViewProps = {
  current: WakeTemplatesView | null;
  takes: readonly Take[];
  /** Where the walkthrough has got to. */
  phase: Walkthrough;
  saving: boolean;
  saved: WakeTemplatesView | null;
  problem: string | null;
  onStart: () => void;
  onStop: () => void;
  onRerecord: (slot: number) => void;
  onSave: () => void;
};

export function WakeTrainingView(props: WakeTrainingViewProps) {
  const { current, takes, phase, saving, saved, problem } = props;
  const slots = Array.from({ length: TARGET_TAKES }, (_, i) => i);
  const complete = takes.length >= TARGET_TAKES;
  const running = isRunning(phase);
  const progress = walkthroughProgress(phase, takes.length);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Train the wake word</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <p className="text-sm text-muted">
          Say <span className="font-medium text-fg">“{ENROLL_PHRASE}”</span> {TARGET_TAKES} times,
          the way you would actually say it. Press start once and it will count you in and beep for
          each take — you should not need the keyboard again. The recording stays in this browser;
          what reaches the hub is a fingerprint of the sound, not the sound.
        </p>

        <div className="flex items-center gap-3 rounded-xl border border-border bg-well/40 p-3">
          {running ? (
            <Button variant="outline" onClick={props.onStop} disabled={saving}>
              <Square className="h-4 w-4" />
              <span>Stop</span>
            </Button>
          ) : (
            <Button onClick={props.onStart} disabled={saving}>
              <Mic className="h-4 w-4" />
              <span>{takes.length > 0 ? "Start over" : "Start"}</span>
            </Button>
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <span data-testid="walkthrough-status" role="status" className="text-sm text-fg">
              {walkthroughMessage(phase, ENROLL_PHRASE)}
            </span>
            <span data-testid="walkthrough-progress" className="text-xs text-muted">
              Take {progress.step} of {progress.of}
            </span>
          </div>
        </div>

        <ol className="flex flex-col gap-2">
          {slots.map((slot) => {
            const take = takes[slot];
            const busy = phase.kind === "recording" && phase.slot === slot;
            const counting = phase.kind === "countdown" && phase.slot === slot;
            return (
              <li
                key={slot}
                data-testid="take-row"
                className={cn(
                  "flex items-center gap-3 rounded-xl border border-border bg-well/40 p-3",
                  (busy || counting) && "border-accent",
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm text-fg">
                    Take {slot + 1} —{" "}
                    {busy
                      ? `say “${ENROLL_PHRASE}” now.`
                      : counting
                        ? "coming up."
                        : take
                          ? scoreLabel(take.score, slot)
                          : "not recorded yet."}
                  </span>
                  {take && slot > 0 ? (
                    <span
                      data-testid="take-score"
                      className={cn("text-xs", take.score >= 0.5 ? "text-accent" : "text-muted")}
                    >
                      Match {Math.round(take.score * 100)}%
                    </span>
                  ) : null}
                </div>
                {/* Only a take that exists can be replaced, and only while the
                    microphone is free — one take at a time, always. */}
                {take ? (
                  <Button
                    variant="outline"
                    disabled={running || saving}
                    onClick={() => props.onRerecord(slot)}
                    aria-label={`Re-record take ${slot + 1}`}
                  >
                    <Mic className="h-4 w-4" />
                    <span>Re-record</span>
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>

        {problem ? (
          <p data-testid="wake-problem" className="text-sm text-danger" role="alert">
            {problem}
          </p>
        ) : null}

        {saved ? (
          <p data-testid="wake-saved" className="flex items-center gap-2 text-sm text-accent">
            <Check className="h-4 w-4" />
            Saved {saved.templates.length} takes. Every listening surface on this hub now compares
            against your voice.
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <Button disabled={!complete || saving || running} onClick={props.onSave}>
            {saving ? "Saving…" : "Save my voice"}
          </Button>
          <span className="text-xs text-muted">
            {current?.enrolled
              ? `${current.templates.length} takes already stored — saving replaces them.`
              : "Nothing is enrolled yet, so nothing is listening for you."}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export type WakeTrainingProps = {
  /** What the hub already holds, so the panel can tell a first enrolment from a replacement. */
  current: WakeTemplatesView | null;
  /** Injected so a page can be driven without a microphone. */
  recordTake?: RecordTake;
  /** Injected for the same reason. */
  save?: (templates: readonly Omit<WakeTemplate, "id">[]) => Promise<WakeTemplatesView>;
};

export function WakeTraining(props: WakeTrainingProps) {
  const recordTake = props.recordTake ?? defaultRecordTake;
  const [takes, setTakes] = useState<Take[]>([]);
  const collected = useRef<Take[]>([]);
  const [phase, setPhase] = useState<Walkthrough>(IDLE);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<WakeTemplatesView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * The clock and the microphone, driven by the phase.
   *
   * Everything that decides anything is in `wake-walkthrough.ts`; this only
   * waits. A countdown sets one timer, a recording opens the microphone once,
   * and the cleanup cancels both — a walkthrough that keeps ticking after Stop
   * is a page that beeps at somebody who has walked away.
   */
  useEffect(() => {
    if (phase.kind === "countdown") {
      const timer = setTimeout(() => setPhase(afterTick), COUNTDOWN_TICK_MS);
      return () => clearTimeout(timer);
    }
    if (phase.kind !== "recording") return;

    const slot = phase.slot;
    let abandoned = false;
    void (async () => {
      try {
        const samples = await recordTake();
        if (abandoned) return;
        // This is the only place takes are written, so the ref and the state
        // cannot disagree — and reading the ref keeps the phase transition out
        // of a state updater, which has to stay pure.
        const next = takesAfterRecording(collected.current, slot, samples);
        collected.current = next;
        setTakes(next);
        setPhase(afterTake(next.length));
      } catch (error) {
        if (abandoned) return;
        // A microphone that will not open will not open on the next take
        // either. Stop, say why, and let them fix it and press start again.
        setProblem(captureProblem(error));
        setPhase(IDLE);
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [phase, recordTake]);

  const start = useCallback((slot: number) => {
    setProblem(null);
    setSaved(null);
    setPhase(startAt(slot));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setProblem(null);
    try {
      const { templates } = assembleTemplates(
        takes.map((take) => take.samples),
        { phrase: ENROLL_PHRASE, sampleRate: CAPTURE_RATE },
      );
      const stored = await (props.save ?? putWakeTemplates)(templates);
      setSaved(stored);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The hub refused the enrolment.");
    } finally {
      setSaving(false);
    }
  }, [props, takes]);

  return (
    <WakeTrainingView
      current={props.current}
      takes={takes}
      phase={phase}
      saving={saving}
      saved={saved}
      problem={problem}
      // Start is start over: the takes are a sequence scored against each
      // other, and beginning again means beginning at the first one.
      onStart={() => {
        collected.current = [];
        setTakes([]);
        start(0);
      }}
      onStop={() => setPhase(IDLE)}
      onRerecord={(slot) => start(slot)}
      onSave={() => void save()}
    />
  );
}
