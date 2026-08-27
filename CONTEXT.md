# Piano

A desktop app that helps one person practise piano from imported sheet music with a MIDI keyboard.

## Language

### Library

**Piece**:
One imported musical work as a library entry: its score plus settings, favorite flag and play history.
_Avoid_: Song, file

**Score**:
The musical content of a piece as read from its file: notes, tempo, key, chords. Built fresh from the file every time the piece opens; it changes only when the file changes.
_Avoid_: Sheet (see Sheet), model, timeline

**Library folder**:
The folder on disk where the app keeps every piece's MusicXML file. The user may edit, add or remove files there with other software; its location is a global setting.
_Avoid_: Storage, data directory

**Indexing**:
Reading a piece's file once to produce its summary for the library page (title, length, range, key, tempo facts). Runs at import and again whenever the file changes.
_Avoid_: Caching, scanning, import (import is the act of adding the file; indexing is what follows)

**Library**:
The set of pieces the app has imported, with per-piece favorites, history and settings.
_Avoid_: Collection, catalogue

**Score finder**:
The modal that searches every provider at once and downloads one chosen score into the library folder, from where it is imported like a dropped file.
_Avoid_: Store, browser, catalogue search

**Provider**:
One source of scores behind the score finder, searchable by composer and title. Which provider a row came from is shown but never chosen.
_Avoid_: Source, catalogue, repository

**Preview**:
A view of a piece's whole sheet, opened from the library to read the piece through. Read-only for input and grading: no cursor, no MIDI, no Grade. It can be played, through the sound engine, with a transport of its own.
_Avoid_: Viewer, reader, score view

**Piece settings**:
Settings that apply to one piece (tempo, metronome, count-in, hands, keyboard). A piece setting that is unset falls back to the global setting.

**Global settings**:
Settings that apply to the whole app: the default value of every piece setting, used when a piece has no value of its own, and everything that is never per piece (grade windows and weights, lane look, MIDI device, velocity offset, theme).
_Avoid_: Preferences, defaults

### Playing

**Play**:
One session of the user playing a piece, from the press of play to the moment the screen is idle again. Either a Practice or a Performance.
_Avoid_: Session, run, attempt

**Practice**:
A play in Flow or Wait mode in which the user may pause, seek, loop and change any setting at any time. Never graded.
_Avoid_: Practice run, practice mode, rehearsal

**Performance**:
A play of the whole piece in Flow mode, from the first bar to the last with repeats, at one tempo and one hands setting, with no pause, seek or setting change. The only kind of play that earns a Grade.
_Avoid_: Performance run, performance mode, test, exam

**Sheet**:
The rendered notation of a piece, as drawn on screen.
_Avoid_: Notation view, note stand, score (see Score)

**Flow mode**:
A play in which the cursor advances at tempo whether or not the user plays.
_Avoid_: Normal mode, playback

**Wait mode**:
A play in which the cursor glides at tempo but stops at any onset the user has not yet satisfied: held exactly its required notes, struck close together, with no stray key held. Tempo never changes to follow the user.
_Avoid_: Play-to-continue, practice mode

**Stop**:
An onset the cursor stands at in Wait mode until the user satisfies it. An onset satisfied inside its matching window before the cursor arrives is not a stop.
_Avoid_: Pause, checkpoint

**Matching window**:
The span of time around an onset in which a strike counts for it: the early tolerance before the onset in Wait mode, and the span in which Grade pairs a strike with a note in Flow mode. One global setting for both.
_Avoid_: Hit window, tolerance

**Onset**:
One moment in the score at which one or more notes start. The unit Wait mode waits at and Grade evaluates; the cursor moves continuously between onsets.
_Avoid_: Beat, step, chord

**Section**:
A range of whole bars of a piece, picked by dragging on the sheet. Inert until Loop is on: with Loop off a practice runs through it to the end of the piece.
_Avoid_: Range, loop range, region

**Loop**:
The toggle that gives the Section force: the practice starts at the Section, plays its bars in written order, and wraps from its last bar line back to its start. With no Section, the whole piece wraps.
_Avoid_: Repeat, cycle

**Inactive hand**:
The hand not selected when the hands setting is left or right. Its notes are context only: never expected, never graded, never required by Wait mode, and a strike on one of them is absorbed.
_Avoid_: Other hand, resting hand, muted hand

**Ghost**:
An inactive-hand note as shown in the falling notes: present so the player sees its rhythm, without pitch colour and without feedback.
_Avoid_: Hint note, shadow note

**Harmony display**:
The part of the play screen that names the chord sounding at the cursor and the next two chords, each in absolute form ("G7/B") and relative to the key as scale degrees ("5⁷/7").
_Avoid_: Chord track, roman numerals

**Grade**:
The result of a Performance: one headline number from 0 to 100, with a breakdown into hit rate, timing, velocity, release and extras. A Practice has no grade.
_Avoid_: Score, rating, karaoke score

**Extra**:
A struck key that matches no expected note of the play. Lowers the grade.
_Avoid_: Wrong note, false note

**Miss**:
An expected note the user did not strike within its window. Grades as zero and marks grey on the sheet.
_Avoid_: Skipped note, error
