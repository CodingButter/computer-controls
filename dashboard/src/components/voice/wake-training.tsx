"use client";

import { Check, Mic, Square } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { assembleTemplates, TARGET_TAKES } from "@hub/wake/enrollment";
import { putWakeTemplates, type WakeTemplate, type WakeTemplatesView } from "@/lib/hub";
import { CAPTURE_RATE, recordTake as defaultRecordTake, type RecordTake } from "@/lib/wake-capture";
import { cn } from "@/lib/utils";

/**
 * Teaching the machine your voice.
 *
 * The wake phrase is not a word in a transcript any more — it is a shape in the
 * audio, and the shape it compares against has to be yours. This is where you
 * hand it over: three takes, a score under each one, and a save that every
 * listening surface on this hub reads afterwards.
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
 * Re-recording take two drops take three: the scores describe a sequence, and
 * keeping a later take that was scored against the one just replaced would put
 * a number on screen that nothing computed.
 */
export function takesAfterRecording(
  previous: readonly Take[],
  slot: number,
  samples: Int16Array,
): Take[] {
  const kept = previous.slice(0, slot).map((take) => take.samples);
  const next = [...kept, samples];
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
  /** The slot currently recording, or null when the microphone is closed. */
  recording: number | null;
  saving: boolean;
  saved: WakeTemplatesView | null;
  problem: string | null;
  onRecord: (slot: number) => void;
  onSave: () => void;
};

export function WakeTrainingView(props: WakeTrainingViewProps) {
  const { current, takes, recording, saving, saved, problem } = props;
  const slots = Array.from({ length: TARGET_TAKES }, (_, i) => i);
  const complete = takes.length >= TARGET_TAKES;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Train the wake word</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <p className="text-sm text-muted">
          Say <span className="font-medium text-fg">“{ENROLL_PHRASE}”</span> three times, the way
          you would actually say it. The recording stays in this browser; what reaches the hub is a
          fingerprint of the sound, not the sound.
        </p>

        <ol className="flex flex-col gap-2">
          {slots.map((slot) => {
            const take = takes[slot];
            const busy = recording === slot;
            // A person cannot record take three before take two: the score of a
            // take is a statement about the ones before it.
            const reachable = slot <= takes.length;
            return (
              <li
                key={slot}
                data-testid="take-row"
                className="flex items-center gap-3 rounded-xl border border-border bg-well/40 p-3"
              >
                <Button
                  variant={take ? "outline" : "default"}
                  disabled={!reachable || recording !== null || saving}
                  onClick={() => props.onRecord(slot)}
                  aria-label={take ? `Re-record take ${slot + 1}` : `Record take ${slot + 1}`}
                >
                  {busy ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                  <span>{busy ? "Listening…" : take ? "Re-record" : `Take ${slot + 1}`}</span>
                </Button>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm text-fg">
                    {busy
                      ? `Say “${ENROLL_PHRASE}” now.`
                      : take
                        ? scoreLabel(take.score, slot)
                        : "Not recorded yet."}
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
          <Button disabled={!complete || saving || recording !== null} onClick={props.onSave}>
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
  const [recording, setRecording] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<WakeTemplatesView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const record = useCallback(
    async (slot: number) => {
      setProblem(null);
      setSaved(null);
      setRecording(slot);
      try {
        const samples = await recordTake();
        setTakes((previous) => takesAfterRecording(previous, slot, samples));
      } catch (error) {
        setProblem(captureProblem(error));
      } finally {
        setRecording(null);
      }
    },
    [recordTake],
  );

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
      recording={recording}
      saving={saving}
      saved={saved}
      problem={problem}
      onRecord={(slot) => void record(slot)}
      onSave={() => void save()}
    />
  );
}
