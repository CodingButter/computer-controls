/**
 * What the gate listens with, as interfaces.
 *
 * The gate in front of the realtime provider has to answer two questions before
 * any audio is allowed off this machine: is that speech, and was that the
 * phrase. Both answers come from things small enough to run on a CPU next to
 * everything else the hub is doing — a voice-activity detector around a
 * megabyte, and a matcher that is arithmetic over a few hundred numbers.
 *
 * There used to be a third question. A twenty-six megabyte transcriber turned
 * the utterance into text, and a classifier read the text to decide whether it
 * had been addressed to us. It is gone, and this file is most of what is left
 * of it. It failed in three separate ways, all of them structural rather than
 * unlucky: it crashed on inputs too short to be a word, it declined to answer
 * at all often enough that "a failed transcription is a closed gate" became a
 * documented behaviour, and it decided by spelling — which is how "hey mastra"
 * became "he mastered" and locked the owner out of his own machine.
 *
 * The phrase is a shape in the audio now, and nothing on this machine writes
 * down what was said in order to decide whether to listen to it.
 */
export {};
