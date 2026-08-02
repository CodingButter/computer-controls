"""Typing that takes as long as typing takes.

Setting a field's contents in one atomic write is the correct thing to do to a
configuration dialog and the wrong thing to do to a person. A message that
materialises whole is unmistakably not typed, and — more practically — a great
many applications never notice it at all, because their input handling listens
for edits rather than for the field being swapped out underneath them.

So text can be delivered as a plan: a sequence of small insertions with waits
between them, shaped like a competent typist rather than like a metronome.

This module holds the shape and none of the delivery. It computes when the
characters go in; the backend puts them there and the server decides whether a
caller is allowed to. Keeping the arithmetic here means the part that is easy to
get subtly wrong — and impossible to eyeball on a live desktop — is the part
that can be tested without a desktop at all.

Nothing here synthesises a keystroke. The cadence is real; the mechanism is
still the toolkit's own editable-text interface, and an application that refuses
that interface refuses it just as clearly slowly as quickly.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

#: Characters per word, by the convention every words-per-minute figure uses —
#: including the space. A "word" is not a word, it is five characters.
CHARACTERS_PER_WORD = 5

#: What a competent, unhurried typist does. Fast enough not to be tedious, slow
#: enough to read as human.
DEFAULT_WPM = 70

#: Below this, a caller is asking for a demonstration rather than a typist;
#: above it, for a machine that is pretending. Both are refused by name rather
#: than silently clamped, because a clamp turns a wrong belief into a surprise.
MIN_WPM = 10
MAX_WPM = 220

#: Pauses that are about the sentence rather than about the keyboard, as
#: multiples of the base interval. A typist slows at a comma and stops at a full
#: stop; without this the rhythm is even and the evenness is what reads as fake.
_PAUSE_AFTER = {
    ",": 2.2,
    ";": 2.4,
    ":": 2.4,
    ".": 3.6,
    "?": 3.6,
    "!": 3.6,
    "\n": 4.0,
}

#: How much any single interval may wander. Real inter-key times are noisier
#: than this, but a plan whose every gap can triple is a plan whose duration
#: nobody can promise, and callers need the duration to set a timeout.
_JITTER = 0.45


@dataclass(frozen=True)
class Keystroke:
    """One insertion and the wait that precedes it."""

    text: str
    delay_ms: int


def interval_ms(wpm: int) -> float:
    """Mean milliseconds between characters at a given words-per-minute."""
    return 60_000.0 / (wpm * CHARACTERS_PER_WORD)


def estimate_ms(text: str, wpm: int = DEFAULT_WPM) -> int:
    """How long typing this will take, before any of it has happened.

    Callers need this before they start: a client whose request timeout is
    shorter than the typing it asked for would report a failure in the middle of
    a success, and the half-typed message would still be sitting there.
    """
    return int(len(text) * interval_ms(wpm))


def split_words(text: str) -> list[str]:
    """Words with their trailing whitespace attached, in order, losing nothing.

    Joining the result must return the input exactly — a plan that drops a
    newline types a different message than the one it was given.
    """
    chunks: list[str] = []
    current = ""
    for character in text:
        if character.isspace():
            current += character
            continue
        if current and current[-1].isspace():
            chunks.append(current)
            current = ""
        current += character
    if current:
        chunks.append(current)
    return chunks


def plan(text: str, wpm: int = DEFAULT_WPM, seed: int | None = None) -> list[Keystroke]:
    """Turn text into timed insertions whose total duration is the honest estimate.

    A word at a time, not a character at a time. That is how dictation software
    drives this same interface — speech-to-text hands an application whole words
    — so an application that has ever been used with a screen reader or a
    dictation tool is already accustomed to receiving text this way. It is also
    a fifth of the round trips for the same rhythm.

    The jitter is deliberately renormalised: gaps vary against each other, and
    then the whole plan is scaled so it still adds up to what `estimate_ms`
    promised. Unnormalised noise makes a plan that runs long exactly as often as
    it runs short, which is fine for one message and useless for a timeout.

    `seed` exists so that tests are about the shape of the rhythm rather than
    about what a random number generator felt like doing.
    """
    if not text:
        return []

    rng = random.Random(seed)
    base = interval_ms(wpm)
    words = split_words(text)

    gaps: list[float] = []
    for index, word in enumerate(words):
        weight = rng.uniform(1 - _JITTER, 1 + _JITTER)
        previous = words[index - 1].rstrip() if index else ""
        weight *= _PAUSE_AFTER.get(previous[-1:], 1.0) if previous else 1.0
        # A word costs its own length: the wait before it stands in for the time
        # spent typing it, so long words take longer and the average holds.
        gaps.append(base * len(word) * weight)

    # Scale to the promised total. The first word carries no wait: the typist
    # was already sitting there.
    target = len(text) * base
    total = sum(gaps)
    scale = target / total if total else 1.0
    gaps = [gap * scale for gap in gaps]

    return [
        Keystroke(text=word, delay_ms=int(gap) if index else 0)
        for index, (word, gap) in enumerate(zip(words, gaps))
    ]
