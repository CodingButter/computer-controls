// A shim, not a home: the module moved to src/live/ (segment 03 of the
// realtime-voice client migration). This re-export keeps hub-side imports
// compiling until segment 06 retires them; new code imports from ../live/.
export * from "../live/ear.ts";
