# Murline

A desktop app that helps one person practise piano from imported sheet music with a MIDI keyboard.

## Language

### App

**Rust side**:
The half of the app that runs outside the window: it keeps the global settings and the library's rows, reads and writes the disk, runs the sound engine and listens to the MIDI keyboard. The window asks it for everything it cannot do itself and hears from it when something changes.
_Avoid_: Backend, native side, core, IPC

**Refusal**:
The one shape every command of the Rust side answers with when it cannot do what it was asked: a kind the window may act on (`gone` when the file is no longer there, `refused` when a rule or the sound engine said no, `failed` for anything else) and a sentence that is only ever shown. The window never reads the sentence to decide anything.
_Avoid_: Error string, exception, error message (the sentence is one part of it)

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
The set of pieces the app has imported, with per-piece favorites, history and settings. The list
pane has a search field over its rows, matching title and composer; ⌘F reaches it and Escape clears
it, and what it holds lasts for the session alone. While the field has the focus the arrow keys walk
the selection through the rows it leaves, holding at either end.
_Avoid_: Collection, catalogue

**Score finder**:
The modal that searches every provider at once and downloads one chosen score into the library folder, from where it is imported like a dropped file.
_Avoid_: Store, browser, catalogue search

**Provider**:
One source of scores behind the score finder, searchable by composer and title. Which provider a row came from is shown but never chosen.
_Avoid_: Source, catalogue, repository

**Preview**:
A view of a piece's whole sheet, opened from the library to read the piece through. Read-only for input and grading: no MIDI, no Grade, no Section and no Loop. It can be played, through the sound engine, with a transport and a cursor of its own.
_Avoid_: Viewer, reader, score view

**Piece settings**:
The settings that belong to one piece and are set on the play toolbar while practising it: tempo, hands, metronome, count-in, Flow or Wait, the Section and Loop. Each piece keeps its own, with a built-in starting value and nothing global behind it.
_Avoid_: Per-piece settings, overrides, piece defaults

**Global settings**:
The settings that apply to the whole app rather than to any one piece: sound, look, MIDI, grading, keyboard size and the library folders. The library page's order and its selected piece are kept beside them, remembered for the next launch rather than set in the panel. The Rust side keeps them all and hands them over once at start.
_Avoid_: Preferences, defaults

**Settings panel**:
The modal holding every global setting, grouped into Sound, Look, Playing and Library tabs with one search box reaching across all four. Opened by the status bar's gear or by ⌘, on every screen that has the bar, and while it is open it owns the whole screen's input. It opens on the tab and the scroll place it was last left at, unless the caller names a row to open on.
_Avoid_: Settings dialog, preferences, options

**Status bar**:
The last row of the library, Preview and play screens, one line of small text high. At the far left the cog into the settings panel, then the MIDI cell, which hangs the MIDI popover, and the sound cell, which hangs the sound popover. At the right the keyboard and metronome volumes, which together are the mixer's button, then the output latency, the voices sounding of the most the engine holds, the render load, and the version cell. Every number stands beside its icon in a box of least width, so a digit more or less moves nothing. The cog and the version cell are as high as the bar and reach into its inset, so a press near either lands on it. The boot and onboarding screens have none.
_Avoid_: Footer, status line, taskbar

**Version cell**:
The far right of the status bar: the version running, and beside it a mark for what the release page holds. Number and mark are one button, and what it does is what the mark shows: an amber arrow fetches the version waiting and swaps the app on disk, a green check starts the app again so that version takes over, and a bare number asks the release page again. A version on disk that is not started stays for the next launch.
_Avoid_: Updater, auto-update, upgrade button

**Loading indicator**:
The row of beats that runs wherever the app is waiting on work the user asked for or on the app's own boot, drawn as the falling notes' countdown is: a capsule for the strong beat and dots for the weak ones, travelling right, the one at the right burning out as a new one is born at the left. It leaves only on a beat: the row runs to the next beat, then every mark eases out to the right. The open of a piece is one of those waits: while the play screen or the Preview reads a file, the row stands large over the content area and names the piece it is opening.
_Avoid_: Spinner, progress bar, throbber

### Playing

**Play**:
One session of the user playing a piece, from the press of play to the moment the screen is idle again. Either a Practice or a Performance.
_Avoid_: Session, run, attempt

**Practice**:
A play in Flow or Wait mode in which the user may pause, seek, loop and change any setting at any time. Never graded. The place it was left at is kept with the piece, so the piece reopens there rather than at bar one.
_Avoid_: Practice run, practice mode, rehearsal

**Performance**:
A play of the whole piece in Flow mode, from the first bar to the last with repeats, at one tempo and one hands setting, with no pause, seek or setting change. The only kind of play that earns a Grade. Whatever mode, Section and Loop the piece has saved are set aside for its duration and handed back when it ends.
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
A range of whole bars of a piece, picked by dragging on the sheet and kept with the piece. Inert until Loop is on: with Loop off a practice runs through it to the end of the piece.
_Avoid_: Range, loop range, region

**Loop**:
The toggle that gives the Section force: the practice starts at the Section, plays its bars in written order, and wraps from its last bar line back to its start. With no Section, the whole piece wraps. Kept with the piece, as the Section is.
_Avoid_: Repeat, cycle

**Keyboard size**:
The span of keys the on-screen keyboard draws: a fixed number of keys, a custom range, or the span the open piece needs. One global setting, the same for every piece.
_Avoid_: Keyboard preset, key range, keyboard width

**Inactive hand**:
The hand not selected when the hands setting is left or right. Its notes are context only: never expected, never graded, never required by Wait mode, and a strike on one of them is absorbed. With the global setting on it sounds itself as the clock passes it, so the player hears the whole piece, at a level in per cent of either the written velocity or the player's own recent strikes, whichever of the two the velocity mode names.
_Avoid_: Other hand, resting hand, muted hand

**Ghost**:
An inactive-hand note as shown in the falling notes: present so the player sees its rhythm, without pitch colour and without feedback.
_Avoid_: Hint note, shadow note

**Harmony display**:
The part of the play screen that names the chord sounding at the cursor and the next two chords, each in absolute form ("G7/B") and relative to the key as scale degrees ("5⁷/7").
_Avoid_: Chord track, roman numerals

**Key**:
The key in force at a point of the score, read from the key signature: the sharps or flats it carries and its mode. A score with no signature is read in C major.
_Avoid_: Scale (the scale is the key's notes), tonality, key signature (the written sign of it)

**Wheel**:
The circle-of-fifths panel in the falling notes, the wheel of fifths in full, shown in place of the harmony display when the harmony setting names it. Its band is the scale: twelve segments a fifth apart with C at the top, the seven of the key in force faced in their pitch colours and the other five hollow, the tonic in a badge, and the root of the chord sounding now on a segment that stands off the band. Inside it the figure is the chord, a polygon through its tones, and the hub is the chord's name at the centre. Outside it the runner travels its tracks, one arc per move, to reach the next root as the harmony advances.
_Avoid_: Dial, circle, chart, mouse wheel (the pointer's wheel, never this panel)

**Key readout**:
The name of the key in force in the play screen's top bar, which opens a popover of that key's signature and a table of one column per scale degree: the degree number, its note and its function over the triad it stacks into, that triad's notes and its seventh chord, with the relative and parallel keys under it.
_Avoid_: Scale panel, key indicator

**Grade**:
The result of a Performance: one headline number from 0 to 100, with a breakdown into hit rate, timing, velocity, release and extras. A Practice has no grade.
_Avoid_: Score, rating, karaoke score

**Extra**:
A struck key that matches no expected note of the play. Lowers the grade.
_Avoid_: Wrong note, false note

**Miss**:
An expected note the user did not strike within its window. Grades as zero and marks grey on the sheet.
_Avoid_: Skipped note, error

### Sound

**Sound engine**:
The audio graph in the Rust side that turns keyboard and Preview notes into sound, through the instrument, the effect chain and the chosen output device. macOS only; everywhere else it reports itself unavailable and the app runs silently.
_Avoid_: Synth, audio engine, playback engine

**Instrument**:
The one Audio Unit instrument, or file the sound engine plays: an EXS or a SoundFont through the app's own voice engine, a hosted plugin through itself. One at a time, global, remembered across launches.
_Avoid_: Patch, preset, voice, sound font (a SoundFont is one kind of file an instrument is loaded from)

**Role**:
One part of a sampled instrument other than the tone a key-down sounds: the release samples, the key-off noise, the sympathetic resonance and the pedal noise. Each has a level from 0 to 100 per cent, set on the Sound tab and kept per instrument, 0 being off; an instrument offering none, such as a plugin, is not asked about.
_Avoid_: Layer, group, articulation, sample set

**Effect chain**:
The ordered list of Audio Unit effects between the instrument and the output. Each slot has a bypass toggle and keeps its plugin's own settings; a slot whose plugin is not installed keeps its place and is skipped.
_Avoid_: FX chain, rack, inserts, effects bus

**Mixer**:
The popover behind the status bar's two volume cells. It carries the keyboard volume and the metronome's, names the output device and instrument in force, and holds the link into the Sound tab. The settings panel's search opens it too.
_Avoid_: Volume popover, levels, audio dialog

**Sound popover**:
The popover behind the status bar's sound cell. It carries what the Sound tab says about the sound itself: the instrument picker, the roles, the touch, the envelope and the effect chain. The instruments folder and the output device are left to the tab, one link away at its foot. Only the sound cell opens it.
_Avoid_: Instrument popover, sound dialog

**Keyboard volume**:
How loud the whole keyboard sounds, 0 to 200 per cent with 100 the sound as the instrument makes it and 200 twice as loud. It applies after the effect chain, so it sets the finished sound without changing how the instrument or the effects behave. A peak limiter behind it holds the sound inside full scale, so a loud instrument turned up past 100 does not clip at the device.
_Avoid_: Master volume, output gain, level

**Envelope**:
How loud a note is over its own lifetime: the attack it comes in on, the decay down to the sustain it holds at while the key is down, and the release it dies away over once the key comes up. Kept per instrument, so a heavy piano and a thin organ each keep their own. Only a file instrument has one to set; a hosted Audio Unit shapes its notes behind its own window. The engine takes one at once, so the sliders are heard as they move, at one send per frame drawn, and every voice struck after it follows it, with a fixed 3 ms fade at each voice start whatever the attack. Whatever is already sounding plays on unchanged. A load starts the instrument on the same plain hold every file gets, and the one kept for it is sent over that.
_Avoid_: ADSR (the four sliders, not the concept), amp envelope, volume envelope, contour

**Velocity curve**:
The remap from the velocity a key press sends to the velocity the app works in, set by a minimum, a maximum and the shape of the path between them. Velocity 1 lands on the minimum and velocity 127 on the maximum, so the whole of the keyboard's range is squeezed into the band rather than cut off at it. Calibrated by ear. The instrument is played at the output velocity and so is the Preview, and a grade reads the output velocity too. Distinct from the keyboard volume, which sets the finished sound rather than the velocity behind it.
_Avoid_: Velocity sensitivity, dynamics curve, velocity clamp

**Render load**:
What one pass of the sound engine's render block costs: its own time over the time the buffer it filled plays for, as a percent. Rust reports it four times a second beside the voices sounding, and the status bar shows both.
_Avoid_: CPU usage, DSP load, processor time

**Sounding**:
The keys the Sound tab's two plots draw: the ones under the hands, plus the ones let go and still dying away. Each carries the velocity it was struck at and how long it was held, and each is drawn in its own pitch colour, the same colours the lane uses. The touch plot puts one at the height it was struck; the envelope plot walks one along the envelope. A key let go leaves both plots at once, after the envelope's release, so neither is left holding a note the other has finished with. The tab counts them itself and only while the panel is open.
_Avoid_: Active notes, held keys, note pool
