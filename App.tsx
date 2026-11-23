import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, ScrollView, Keyboard, Pressable, StyleSheet, StatusBar,
  Modal, TextInput, Platform, Alert as NativeAlert, AppState, Switch, useWindowDimensions, Image, Linking, PanResponder, PixelRatio, Animated, Easing,
} from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Defs, Line, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import * as Speech from "expo-speech";
import * as DocumentPicker from "expo-document-picker";
import { createAudioPlayer } from "expo-audio";
import * as ImagePicker from "expo-image-picker";
import { useVideoPlayer, VideoView } from "expo-video";
// expo-file-system has no web version, so it's only loaded on the phone.
const IS_WEB = Platform.OS === "web";
const FS: any = IS_WEB ? null : require("expo-file-system");
// Pop-up menus. On the phone these are the system alerts; on the web (where those don't exist) AlertHost draws them.
type AlertButton = { text?: string; style?: "default" | "cancel" | "destructive"; onPress?: () => void };
type AlertRequest = { title: string; message?: string; buttons: AlertButton[] };
let showWebAlert: ((r: AlertRequest) => void) | null = null;
const Alert = {
  alert(title: string, message?: string, buttons?: AlertButton[]) {
    if (!IS_WEB) return NativeAlert.alert(title, message, buttons as any);
    const list = buttons?.length ? buttons : [{ text: "OK" }];
    if (showWebAlert) showWebAlert({ title, message, buttons: list });
    else if (typeof window !== "undefined") window.alert([title, message].filter(Boolean).join("\n\n"));
  },
};
const GAP = 8; // screen sides and gaps between sections
const ISLAND_BOTTOM_OFFSET = 11; // island's bottom edge sits ~11pt above the safe-area inset
const LINE_OFFSET = 11; // hour lines sit 5pt (row padding) + 6pt (line margin) below a row's top
// Event blocks are drawn true to their length. What's inside shrinks with them:
// 40pt and up: full; under 40: compact; under MINI: one small line; under SLIVER: a thin bar with a little label tag on it.
// Blocks under MINI have no resize grip (it would cover them; change their length in the editor) but a taller invisible touch area.
const TAG_H = 12; // height of the smallest text box: the label tag of a thin event
const MIN_BLOCK = TAG_H / 2; // the shortest a block is drawn (even a 1-minute event stays visible)
const MINI = 22, SLIVER = 11;
const MIN_LANE = 34; // narrowest side-by-side lane; past that many lanes, the extra events fold into a "+N" block
const NARROW = 46; // side-by-side blocks thinner than this write their title along the bar (when they're tall enough)
// The start time shown in a block (none when it's on the hour: the hour label already says it). `compact` drops "am"/"pm" for the
// one-line labels: the left column is always morning and the right always afternoon, so it's never in doubt.
const startLabel = (ev: CalEvent, segStart: number, showTimes: boolean, compact = false) =>
  showTimes && ev.start === segStart && segStart % 3600 !== 0 ? (compact ? shortTime(ev.start).replace(/[ap]m$/, "") : shortTime(ev.start)) : "";
// A short event's one-line label, longest first: each step drops something (the time, then the marks) before the title gets cut.
const miniLabels = (ev: CalEvent, start: string) => {
  const mark = ev.important ? `${SHAPE_GLYPHS[ev.shape ?? "star"]} ` : "", rep = ev.repeat !== "none" ? " ↻" : "";
  return [...new Set([`${start ? `${start} ` : ""}${mark}${ev.title}${rep}`, `${mark}${ev.title}${rep}`, ev.title])];};
// Roughly how wide text draws (bold, average letter about 0.6 of the font size), so labels can be laid out before they're drawn.
const textW = (text: string, size: number) => Math.ceil(text.length * size * 0.6);
const tagWidth = (label: string) => textW(label, 8) + 10; // tag padding 5 + 5
const wrapLines = (height: number) => Math.max(1, Math.floor((height - 4) / 9)); // lines of 8pt text a block of this height holds
const LABEL_WIDTH = 30; // room for "12pm" in each hour row
const ITEM_H = 32; // scroll wheel row height
const VISIBLE = 5; // wheel rows showing at once
let DEFAULT_ALERT = 10 * 60; // seconds before start for a new reminder; Root keeps these three in step with the settings
let CLOCK24 = false;
let WEEK_START = 0; // 0 = Sunday, 1 = Monday
const COLORS_KEY = "yearline:colors:v1"; // custom colors you saved
const STOP_KEY = "yearline:stopped:v1"; // reminders you've tapped, so they stop repeating
const MAX_REPEATS = 30; // most notifications scheduled for one repeating reminder
const MAX_SCHEDULED = 60; // iOS keeps about 64 pending notifications per app
const LOOKAHEAD_DAYS = 60; // how far ahead repeating events are scheduled
// One sound at a time: starting a new one stops the old, and with `toggle` a second press on the same sound just stops it.
let playing: ReturnType<typeof createAudioPlayer> | null = null;
let playingUri = "";
function stopSound() { try { playing?.pause(); playing?.remove(); } catch {} playing = null; playingUri = ""; }
function playSound(uri: string, toggle = false) {
  const again = !!playing && playingUri === uri;
  stopSound();
  if (toggle && again) return;
  try {
    const p = createAudioPlayer(uri);
    playing = p; playingUri = uri;
    p.addListener("playbackStatusUpdate", (st) => { if (st.didJustFinish && playing === p) stopSound(); });
    p.play();
  } catch { stopSound(); }
}
// Show reminders even while the app is open.
if (!IS_WEB) Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const d = n.request.content.data ?? {};
    if (d.speak) Speech.speak(n.request.content.title ?? ""); // read the title aloud when the app is open
    if (d.soundUri) playSound(d.soundUri as string); // your own sound, played by the app while it's open
    return {
    shouldShowAlert: true, shouldShowBanner: true, shouldShowList: true, shouldPlaySound: !d.speak && !d.soundUri, shouldSetBadge: false,};},
});
const KEY_V2 = "yearline:events:v2"; // flat list, minutes, weekly option
// Swiping between the year and the calendar: how long the finger must be down, and how far it must go sideways, before the page moves.
const PAGE_DELAY = 100; // ms
const PAGE_SLOP = 30; // points
const KEY = "yearline:events:v3"; // flat list, seconds, repeat: none/daily/days
const DARK = "#171717"; // ink on bright colors (same in every theme)
const EVENT_COLORS = ["#F39A42", "#F26D6D", "#F2A7C3", "#E8C547", "#7BC47F", "#3FB8A5", "#5AA9E6", "#6C7BEF", "#C792EA", "#A67C52", "#9AA3AE", "#F5F5F5"];
type Theme = {
  id: string; name: string; light?: boolean;
  bg: string; panel: string; panelLight: string; accent: string; text: string; muted: string; line: string; faint: string;};
const mix = (a: string, b: string, t: number) => {
  const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
  const c = (sh: number) => Math.round(((x >> sh) & 255) * t + ((y >> sh) & 255) * (1 - t)).toString(16).padStart(2, "0");
  return `#${c(16)}${c(8)}${c(0)}`;};
const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;};
const luma = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;};
// Builds a whole theme from four colors; the rest are blends of the text color into the panel.
const makeTheme = (id: string, name: string, bg: string, panel: string, accent: string, text: string): Theme => ({
  id, name, bg, panel, accent, text, light: luma(bg) > 0.6,
  panelLight: mix(text, panel, 0.1), line: mix(text, panel, 0.18), muted: mix(text, panel, 0.55), faint: mix(text, panel, 0.3),});
// ---- Readable colors for any theme ----
// Contrast is measured the standard way (WCAG contrast ratio: 1 = identical, 21 = black on white). Every color a theme uses is
// checked against what it sits on, and only the ones that fall short are moved, toward lighter on dark backgrounds or darker on
// light ones, and only as far as needed, so they keep their hue. The built-in themes already pass, so they look as designed.
const lin = (v: number) => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
const contrast = (a: string, b: string) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// `fg` moved toward `to` (by default whichever of white or black stands out more from `bg`) until it reaches `ratio`. A color that
// has to be rescued goes on to `aim` (a little past the minimum) so it looks deliberate rather than barely-there.
const ensure = (fg: string, bg: string, ratio: number, to = contrast("#FFFFFF", bg) >= contrast("#000000", bg) ? "#FFFFFF" : "#000000", aim = ratio) => {
  if (contrast(fg, bg) >= ratio) return fg;
  ratio = aim;
  let lo = 0, hi = 1;
  for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2; if (contrast(mix(to, fg, m), bg) >= ratio) hi = m; else lo = m; }
  return mix(to, fg, hi);};
// A color that nearly vanishes into its background (a white event on a light theme, say) gets a thin edge in a deeper or
// lighter shade of itself. Colors that already stand out get nothing.
const edgeOn = (color: string, bg: string) => (contrast(color, bg) < 1.4 ? { borderWidth: 1, borderColor: ensure(color, bg, 1.9) } : null);
// Every color the app draws with, worked out from a theme. Targets: body text 7:1, hints 4.5:1 (WCAG AA), the accent 3:1 (the
// standard for buttons and highlights); fills, lines and the week highlight just enough to see at a glance without shouting.
type Palette = { bg: string; panel: string; panelLight: string; line: string; grid: string; text: string; muted: string; faint: string; accent: string;
  tint: string; today: string; selected: string; selInk: string; week: string; danger: string; light: boolean };
const PALETTES = new WeakMap<Theme, Palette>();
function palette(t: Theme): Palette {
  const known = PALETTES.get(t);
  if (known) return known;
  const bg = t.bg, panel = ensure(t.panel, bg, 1.05);
  const text = ensure(ensure(t.text, panel, 7, undefined, 11), bg, 7);
  const accent = ensure(ensure(t.accent, panel, 3, undefined, 3.6), bg, 3);
  const panelLight = ensure(t.panelLight, panel, 1.1, text); // chips, buttons and boxes: a step toward the text color
  const line = ensure(t.line, panel, 1.3, text);
  const selected = mix(accent, bg, 0.65);
  const p: Palette = {
    bg, panel, panelLight, line, text, accent, selected,
    grid: ensure(line, bg, 1.3, text),
    muted: ensure(ensure(t.muted, panel, 4.5, undefined, 5.2), panelLight, 3.5),
    faint: ensure(t.faint, bg, 2),
    tint: mix(accent, panel, 0.16),
    today: mix(accent, bg, 0.25),
    selInk: inkOn(selected),
    week: ensure(bg, bg, 1.15, text), // this week: the background nudged toward the text color, so lighter on dark and darker on light
    danger: ensure(ensure("#F26D6D", panel, 3.5), bg, 3.5),
    light: lum(bg) > 0.4,};
  PALETTES.set(t, p);
  return p;}
const THEMES: Theme[] = [
  { id: "midnight", name: "Midnight", bg: "#111315", panel: "#1B1E22", panelLight: "#25292F", accent: "#F39A42", text: "#F2F2F2", muted: "#858B94", line: "#343940", faint: "#555B64" },
  { id: "black", name: "Black", bg: "#000000", panel: "#0C0C0D", panelLight: "#1A1A1C", accent: "#F5C542", text: "#F5F5F5", muted: "#8A8A90", line: "#2A2A2D", faint: "#4A4A50" },
  { id: "ocean", name: "Ocean", bg: "#0C141C", panel: "#14202C", panelLight: "#1E2E3E", accent: "#4FB3E8", text: "#EAF3FA", muted: "#7F95A8", line: "#2B3E50", faint: "#475B6D" },
  { id: "forest", name: "Forest", bg: "#0E1410", panel: "#16201A", panelLight: "#213027", accent: "#7BC47F", text: "#EEF5EF", muted: "#83958A", line: "#2D3F34", faint: "#4A5E52" },
  { id: "rose", name: "Rose", bg: "#150F12", panel: "#21181C", panelLight: "#31242A", accent: "#F26D8F", text: "#F7EDF0", muted: "#9A8790", line: "#42323A", faint: "#65525B" },
  { id: "violet", name: "Violet", bg: "#110F18", panel: "#1A1724", panelLight: "#272336", accent: "#A98BF5", text: "#F0EDFA", muted: "#8E88A3", line: "#383350", faint: "#5A5472" },
  { id: "light", name: "Light", light: true, bg: "#F1F2F5", panel: "#FFFFFF", panelLight: "#E7E9EE", accent: "#E8741A", text: "#1A1C1F", muted: "#6B717B", line: "#D3D6DC", faint: "#B3B8C1" },
  makeTheme("sunset", "Sunset", "#1A1014", "#26171C", "#FF7A59", "#FBEFEA"),
  makeTheme("mint", "Mint", "#0B1513", "#12211E", "#3FD1B0", "#E8F7F3"),
  makeTheme("crimson", "Crimson", "#140C0D", "#1F1214", "#E5484D", "#F8ECEC"),
  makeTheme("slate", "Slate", "#14171C", "#1D2129", "#8AA4FF", "#E9EDF5"),
  makeTheme("coffee", "Coffee", "#17110D", "#231A14", "#D4A373", "#F3EAE0"),
  makeTheme("neon", "Neon", "#08080F", "#11111C", "#39FF88", "#EDEDFF"),
  makeTheme("sand", "Sand", "#F5EFE4", "#FFFBF2", "#C2672D", "#2B241B"),
  makeTheme("sky", "Sky", "#EAF2FA", "#FFFFFF", "#2F7DD1", "#14202E"),
  makeTheme("blossom", "Blossom", "#FBEFF3", "#FFFFFF", "#D6457A", "#2A1A20"),];
const THEMES_KEY = "yearline:themes:v1"; // custom themes you made
let CUSTOM: Theme[] = []; // kept in step with the Root state so applyTheme can find them
// Current palette. applyTheme() swaps these and rebuilds the styles; the app is remounted afterwards.
let BG = "", PANEL = "", PANEL_LIGHT = "", ORANGE = "", TEXT = "", MUTED = "", LINE = "", GRID = "", FAINT = "", WEEK = "", TINT = "", SOFT = "", STRONG = "", SEL_INK = "", DANGER = "";
let THEME: Theme = THEMES[0];
function applyTheme(id: string) {
  THEME = [...THEMES, ...CUSTOM].find((x) => x.id === id) ?? THEMES[0];
  ({ bg: BG, panel: PANEL, panelLight: PANEL_LIGHT, accent: ORANGE, text: TEXT, muted: MUTED, line: LINE, grid: GRID, faint: FAINT,
    week: WEEK, tint: TINT, today: SOFT, selected: STRONG, selInk: SEL_INK, danger: DANGER } = palette(THEME));
  styles = buildStyles();}
const PREFS_KEY = "yearline:prefs:v1";
type Prefs = {
  theme: string; showTimes: boolean; showInfo: boolean; defaultReminder: boolean;
  clock24: boolean; weekStart: number; showNow: boolean; showDots: boolean; showWeekday: boolean; reminders: boolean;
  defaultLength: number; alertSeconds: number; // seconds
};
const DEFAULT_PREFS: Prefs = {
  theme: "midnight", showTimes: true, showInfo: true, defaultReminder: true,
  clock24: false, weekStart: 0, showNow: true, showDots: true, showWeekday: true, reminders: true, defaultLength: 3600, alertSeconds: 600,};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
// Repeat chips. "Every [n] days" is an interval repeat; the number is typed into a box inside the chip.
type RepeatChip = "none" | "daily" | "every" | "days"; // "days" (weekdays picked) lights no chip
const REPEATS: [RepeatChip, string, string][] = [["none", "Never", "Repeat Never"], ["daily", "Daily", "Repeat Daily"]];
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const alertText = (secs: number, after?: boolean) => (secs === 0 ? "At start" : `${formatDuration(secs)} ${after ? "after" : "before"}`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const newId = () => Math.random().toString(36).slice(2, 10);
const pad = (n: number) => String(n).padStart(2, "0");
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const nums = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i));
const HOURS_12 = nums(12, (i) => String(i + 1));
const HOURS_24 = nums(24, String);
const SIXTY = nums(60, pad);
type RepeatKind = "none" | "daily" | "days" | "interval";
type EndMode = "never" | "days" | "date";
type Media = { id: string; kind: "image" | "video" | "youtube"; uri: string };
type Step = { id: string; text: string; media?: Media[] };
// Repeating reminder: keeps notifying until you tap it or a time limit passes.
type Sound = "default" | "silent" | "speak" | "custom";
type Nag = {
  every: number; // seconds between notifications
  from: "alert" | "start" | "custom"; // where repeating begins: the reminder time, the event start, or an offset from the start
  before: boolean; // custom only: the offset is before the event start
  offset: number; // custom only: seconds from the event start
  until: "start" | "end" | "after"; // stop when the event starts, when it ends, or some time after it ends
  after: number; // seconds after the event ends (until "after")
  tap: boolean; // stop repeating once you tap a notification
};
const DEFAULT_NAG: Nag = { every: 300, from: "alert", before: false, offset: 0, until: "end", after: 600, tap: true };
type CalEvent = {
  id: string;
  title: string;
  start: number; // seconds after midnight, 0–86399
  duration: number; // seconds, start + duration <= 86400
  color: string;
  date: string; // first day it happens, "YYYY-MM-DD"
  repeat: RepeatKind;
  days: number[]; // weekdays (0 = Sunday) used when repeat is "days"
  interval?: number; // with repeat "interval": days between repeats, 2 or more (2 = every other day), counted from `date`
  skip: string[]; // single days removed from a repeating event
  steps?: Step[]; // the event's sequence, e.g. a workout's exercises
  checks?: Record<string, string[]>; // per day: ids of steps ticked off
  nag?: Nag; // repeating reminder, used when `alert` is set
  alert?: number; // seconds from the start to the first notification (0 = at start); none = no reminder
  sound?: Sound; // notification sound; none = default
  soundUri?: string; soundName?: string; soundFile?: string; // your own sound: app copy, display name, copy iOS can play as a notification sound
  alertAfter?: boolean; // the first notification comes after the event starts instead of before
  important?: boolean; // marked on the month grid
  shape?: ShapeKind; // the marker's shape (default star)
  markColor?: string; // the marker's color (none = the event's color)
  until?: string; // last day a repeating event happens, "YYYY-MM-DD" (none = forever)
  always?: boolean; // repeating for all time: also shows on days before `date` (otherwise it starts on `date`)
};
type Draft = Omit<CalEvent, "id" | "skip" | "steps" | "checks"> & { id?: string; endMode: EndMode; endDays: number; steps: Step[] };
type Layout = {
  placed: { ev: CalEvent; lane: number; lanes: number; span: number }[];
  more: { start: number; end: number; events: CalEvent[]; lane: number; lanes: number }[]; // folded events: a "+N" block each
  spans: Map<string, [number, number]>; // where each event's block is drawn (snapped; see drawnSpan)
};
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function parseKey(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);}
function weekStart(date: Date) {
  const d = new Date(date);
  d.setDate(d.getDate() - ((d.getDay() - WEEK_START + 7) % 7));
  d.setHours(0, 0, 0, 0);
  return d.getTime();}
function ordinal(n: number) {
  const suffix = n >= 11 && n <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;}
// seconds -> [hours, minutes, seconds]
const hms = (t: number) => [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60] as const;
// "9:05 am", or "9:05:30 am" when seconds aren't zero (or are forced). 86400 wraps to 12:00 am.
function formatTime(t: number, forceSeconds = false) {
  const [h, m, s] = hms(t);
  const secs = forceSeconds || s ? `:${pad(s)}` : "";
  return CLOCK24 ? `${pad(h % 24)}:${pad(m)}${secs}` : `${(h % 24) % 12 || 12}:${pad(m)}${secs} ${h % 24 < 12 ? "am" : "pm"}`;}
// Compact for the timeline: "9am", "9:05pm", "9:05:30pm".
function shortTime(t: number) {
  const [h, m, s] = hms(t);
  if (CLOCK24) return `${pad(h % 24)}:${pad(m)}${s ? `:${pad(s)}` : ""}`;
  return `${(h % 24) % 12 || 12}${m || s ? `:${pad(m)}` : ""}${s ? `:${pad(s)}` : ""}${h % 24 < 12 ? "am" : "pm"}`;}
function formatDuration(t: number) {
  const [h, m, s] = hms(t);
  return [h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(" ") || "0s";}
// Does this event happen on the day with this key and weekday?
function occursOn(ev: CalEvent, key: string, dow: number) {
  if (ev.skip.includes(key)) return false;
  if (key < ev.date && !(ev.always && ev.repeat !== "none")) return false; // "all time" repeats reach back before the first day
  if (ev.until && key > ev.until) return false;
  if (ev.repeat === "daily") return true;
  if (ev.repeat === "days") return ev.days.includes(dow);
  if (ev.repeat === "interval") {
    const n = Math.max(2, ev.interval ?? 2);
    return ((daysFrom(ev.date, key) % n) + n) % n === 0;} // works for days before `date` too
  return key === ev.date;}
// Days from an event's first day to this one. Rounded, so daylight saving changes don't matter.
const daysFrom = (from: string, key: string) => Math.round((parseKey(key).getTime() - parseKey(from).getTime()) / 86400000);
// Earlier versions added a preset workout plan. It's removed once, so the calendar starts empty; events you made yourself stay.
const PLAN_SEED_KEYS = ["yearline:seed:workouts:v1", "yearline:seed:workouts:v2", "yearline:seed:workouts:v3"];
const PLAN_IDS = ["workout-", "mealprep-", "shower-", "breakfast-"]; // id prefixes of the preset events
async function removePresets(list: CalEvent[]): Promise<CalEvent[]> {
  try {
    const flags = await Promise.all(PLAN_SEED_KEYS.map((k) => AsyncStorage.getItem(k)));
    if (!flags.some(Boolean)) return list;
    const kept = list.filter((e) => !PLAN_IDS.some((p) => e.id.startsWith(p)));
    await AsyncStorage.setItem(KEY, JSON.stringify(kept)); // saved before the flags go, so the cleanup can't half-happen
    await AsyncStorage.multiRemove(PLAN_SEED_KEYS);
    return kept;
  } catch { return list; }}
// Blocks are drawn on a time grid whose step is the smallest whole number of minutes that's at least MIN_BLOCK tall at the current
// hour height (half the smallest text box) and divides the hour evenly, so blocks still line up with the hour lines: about 10
// minutes on a phone. Each edge rounds to the nearest step, and a block is at least one step tall. Only the drawing snaps: the
// event's times stay exact, and so do the times written on it. The event being dragged is drawn exactly (`exact`), so it follows
// the finger, then settles onto the grid when it's let go.
const STEPS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60]; // minutes that divide an hour
const snapFor = (hourHeight: number) => 60 * (STEPS.find((m) => (m / 60) * hourHeight >= MIN_BLOCK) ?? 60); // seconds
function drawnSpan(ev: CalEvent, snap: number, exact = false): [number, number] {
  const end = ev.start + ev.duration;
  if (exact) return [ev.start, end];
  const s = Math.round(ev.start / snap) * snap;
  return [s, Math.max(Math.round(end / snap) * snap, s + snap)];}
// Gives each event a lane so events whose drawn blocks overlap sit side by side. At most `maxLanes` lanes fit at a readable width:
// when more are needed, the last lane becomes a "+N" block over just the times that overflow, listing the events folded into it.
// Events that fit keep their lanes (including the last one, at times when nothing overflows).
function layoutEvents(events: CalEvent[], snap: number, exactId?: string, maxLanes = Infinity): Layout {
  // Snapped spans. Events that don't really overlap mustn't look like they do (a short event stretched to one step can reach past
  // where the next one's start rounded to): a later block starts where an earlier one ends, and stays at least one step tall.
  const span = new Map<string, [number, number]>();
  const byStart = [...events].sort((a, b) => a.start - b.start);
  for (const e of byStart) {
    let [s, end] = drawnSpan(e, snap, e.id === exactId);
    if (e.id !== exactId) for (const p of byStart) {
      if (p === e) break;
      if (p.start + p.duration <= e.start) s = Math.max(s, span.get(p.id)![1]);}
    span.set(e.id, [s, Math.max(end, s + (e.id === exactId ? 0 : snap))]);}
  const st = (e: CalEvent) => span.get(e.id)![0], en = (e: CalEvent) => span.get(e.id)![1];
  const sorted = [...events].sort((a, b) => st(a) - st(b));
  const placed: Layout["placed"] = [], more: Layout["more"] = [];
  // Only events that actually overlap share a row of lanes; the rest keep the full width.
  for (let i = 0, groupEnd = 0; i < sorted.length; ) {
    const group: { ev: CalEvent; lane: number; lanes: number; span: number }[] = [];
    const laneEnds: number[] = [];
    groupEnd = st(sorted[i]);
    for (; i < sorted.length && (group.length === 0 || st(sorted[i]) < groupEnd); i++) {
      const ev = sorted[i];
      let lane = laneEnds.findIndex((end) => end <= st(ev));
      if (lane === -1) lane = laneEnds.push(0) - 1;
      laneEnds[lane] = en(ev);
      groupEnd = Math.max(groupEnd, en(ev));
      group.push({ ev, lane, lanes: 0, span: 1 });
    }
    const lanes = Math.min(laneEnds.length, maxLanes);
    const overlaps = (a: CalEvent, b: CalEvent) => st(a) < en(b) && en(a) > st(b);
    // Folded: everything past the last lane, plus what's in the last lane at the same times (the "+N" block takes that spot).
    const folded = group.filter((g) => g.lane >= lanes);
    folded.push(...group.filter((g) => g.lane === lanes - 1 && folded.some((f) => overlaps(f.ev, g.ev))));
    const shown = group.filter((g) => !folded.includes(g));
    for (const g of shown) {
      g.lanes = lanes;
      // Stretch over the lanes to the right that nothing else uses while this event runs.
      const busy = (l: number) => group.some((o) => o !== g && (o.lane === l || (l === lanes - 1 && folded.includes(o))) && overlaps(o.ev, g.ev));
      while (g.lane + g.span < lanes && !busy(g.lane + g.span)) g.span++;
    }
    placed.push(...shown);
    // Folded events that overlap merge into one block.
    for (const f of folded.sort((x, y) => st(x.ev) - st(y.ev))) {
      const last = more[more.length - 1];
      if (last && st(f.ev) < last.end && last.lane === lanes - 1) { last.events.push(f.ev); last.end = Math.max(last.end, en(f.ev)); }
      else more.push({ start: st(f.ev), end: en(f.ev), events: [f.ev], lane: lanes - 1, lanes });}
  }
  return { placed, more, spans: span };}
// The previous version stored minutes and had "weekly". Convert to seconds; weekly becomes a one-day "days" repeat.
const upgradeV2 = (list: any[]): CalEvent[] =>
  list.map((e) => {
    const weekly = e.repeat === "weekly";
    return {
      ...e,
      start: e.start * 60,
      duration: e.duration * 60,
      repeat: weekly ? "days" : e.repeat ?? "none",
      days: weekly ? [parseKey(e.date).getDay()] : e.days ?? [],
      skip: e.skip ?? [],};});
async function loadEvents(): Promise<CalEvent[]> {
  let raw = await AsyncStorage.getItem(KEY);
  // Reminders were briefly saved in minutes as `remind`; convert them to `alert` seconds.
  if (raw) return JSON.parse(raw).map(({ remind, ...e }: any) => (remind !== undefined && e.alert === undefined ? { ...e, alert: remind * 60 } : e));
  raw = await AsyncStorage.getItem(KEY_V2);
  return raw ? upgradeV2(JSON.parse(raw)) : [];}
// Web reminders: timers that fire while the page is open.
let webTimers: ReturnType<typeof setTimeout>[] = [];
function clearWebTimers() { webTimers.forEach(clearTimeout); webTimers = []; }
function fireWebReminder(ev: CalEvent, body: string) {
  if (ev.sound === "speak") Speech.speak(ev.title);
  else if (ev.sound === "custom" && ev.soundUri) playSound(ev.soundUri);
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      const reg = (navigator as any).serviceWorker?.ready as Promise<any> | undefined;
      if (reg) reg.then((r) => r.showNotification(ev.title, { body, tag: ev.id })).catch(() => new Notification(ev.title, { body }));
      else new Notification(ev.title, { body });}
  } catch {}
  Alert.alert(ev.title, body);}
let syncRun = 0; // lets a newer sync cancel an older one that is still scheduling
// Replaces every scheduled notification with the upcoming ones for these events.
async function syncReminders(events: CalEvent[]) {
  const run = ++syncRun;
  try {
    if (!IS_WEB) {
      if (!(await Notifications.getPermissionsAsync()).granted) return;
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync("events", { name: "Events", importance: Notifications.AndroidImportance.HIGH });}
      await Notifications.cancelAllScheduledNotificationsAsync();}
    const stopped = new Set<string>(JSON.parse((await AsyncStorage.getItem(STOP_KEY)) ?? "[]"));
    const now = Date.now();
    const base = new Date();
    const due: { at: number; ev: CalEvent; occ: string; startMs: number }[] = [];
    for (let i = 0; i < LOOKAHEAD_DAYS; i++) {
      const day = addDays(base, i);
      const key = dayKey(day);
      // Wall-clock time on this day, so daylight saving changes don't shift it.
      const at = (secs: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, secs).getTime();
      for (const ev of events) {
        if (ev.alert === undefined || !occursOn(ev, key, day.getDay())) continue;
        const occ = `${ev.id}|${key}`;
        if (stopped.has(occ)) continue;
        const first = at(ev.start + (ev.alertAfter ? ev.alert : -ev.alert));
        const times = [first];
        const n = ev.nag;
        if (n) {
          const step = n.every * 1000;
          const from = n.from === "alert" ? first : at(ev.start + (n.from === "start" ? 0 : n.before ? -n.offset : n.offset));
          const limit = at(ev.start + (n.until === "start" ? 0 : ev.duration + (n.until === "after" ? n.after : 0)));
          let t = from;
          if (t <= now) t += Math.ceil((now - t) / step) * step; // skip repeats already in the past
          for (let c = 0; t <= limit && c < MAX_REPEATS; t += step, c++) if (t !== first) times.push(t);}
        for (const t of times) if (t > now) due.push({ at: t, ev, occ, startMs: at(ev.start) });}}
    due.sort((a, b) => a.at - b.at);
    const bodyFor = (at: number, ev: CalEvent, startMs: number) => {
      const steps = ev.steps?.length ? ` · ${plural(ev.steps.length, "step")}` : "";
      const when = Math.abs(at - startMs) < 1000 ? "Starting now" : at < startMs ? `Starts at ${formatTime(ev.start)}` : `Started at ${formatTime(ev.start)}`;
      return `${when}${steps}`;};
    if (IS_WEB) { // a web app can't schedule notifications, so reminders fire while Yearline is open (or was just left)
      clearWebTimers();
      for (const { at, ev, startMs } of due) {
        const wait = at - Date.now();
        if (wait > 2 * 86400000) break;
        webTimers.push(setTimeout(() => fireWebReminder(ev, bodyFor(at, ev, startMs)), Math.max(0, wait)));}
      return;}
    for (const { at, ev, occ, startMs } of due.slice(0, MAX_SCHEDULED)) {
      if (run !== syncRun) return;
      const body = bodyFor(at, ev, startMs);
      await Notifications.scheduleNotificationAsync({
        content: { title: ev.title, body, sound: ev.sound === "silent" ? false : ev.sound === "custom" && ev.soundFile ? ev.soundFile : true, data: { occ, tap: !!ev.nag?.tap, speak: ev.sound === "speak", soundUri: ev.sound === "custom" ? ev.soundUri : undefined } },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(at), channelId: "events" },});}
  } catch {
    // Reminders are best-effort; the calendar still works without them.
  }}
type WheelProps = { values: string[]; index: number; onChange: (index: number) => void };
// One snapping column, like the pickers in the iPhone Clock app.
function Wheel({ values, index, onChange }: WheelProps) {
  const ref = useRef<ScrollView>(null);
  const current = useRef(index);
  // If the value changes from outside (e.g. the length gets clamped), move the wheel to match.
  useEffect(() => {
    if (current.current !== index) {
      current.current = index;
      ref.current?.scrollTo({ y: index * ITEM_H, animated: false });}
  }, [index]);
  const settle = (y: number) => {
    const i = clamp(Math.round(y / ITEM_H), 0, values.length - 1);
    current.current = i;
    if (i !== index) onChange(i);};
  // The web has no "scroll ended" events: settle a moment after scrolling stops, and snap onto the row.
  const webTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { if (IS_WEB) setTimeout(() => ref.current?.scrollTo({ y: index * ITEM_H, animated: false }), 0); return () => clearTimeout(webTimer.current); }, []);
  const webScroll = IS_WEB ? {
    scrollEventThrottle: 16,
    onScroll: (e: any) => {
      const y = e.nativeEvent.contentOffset.y;
      clearTimeout(webTimer.current);
      webTimer.current = setTimeout(() => {
        const i = clamp(Math.round(y / ITEM_H), 0, values.length - 1);
        if (Math.abs(y - i * ITEM_H) > 1) ref.current?.scrollTo({ y: i * ITEM_H, animated: true });
        settle(y);}, 120);},
  } : {};
  return (<ScrollView
      ref={ref}
      style={styles.wheel}
      showsVerticalScrollIndicator={false}
      snapToInterval={ITEM_H}
      decelerationRate="fast"
      contentOffset={{ x: 0, y: index * ITEM_H }}
      contentContainerStyle={{ paddingVertical: ITEM_H * 2 }}
      onScrollBeginDrag={Keyboard.dismiss}
      {...webScroll}
      onMomentumScrollEnd={(e) => settle(e.nativeEvent.contentOffset.y)}
      // A slow release has no momentum phase, so settle here too.
      onScrollEndDrag={(e) => Math.abs(e.nativeEvent.velocity?.y ?? 0) < 0.05 && settle(e.nativeEvent.contentOffset.y)}>
      {values.map((v, i) => <WheelItem key={i} v={v} on={i === index} />)}</ScrollView>);}
// Memoized: picking a value redraws just the two rows whose highlight changes, not the whole wheel.
const WheelItem = memo(({ v, on }: { v: string; on: boolean }) => <View style={styles.wheelItem}><Text style={[styles.wheelText, on && styles.wheelTextOn]}>{v}</Text></View>);
function WheelSet({ columns }: { columns: (WheelProps & { label: string })[] }) {
  return (<View>
      <View style={styles.wheelLabels}>
        {columns.map((c, i) => <Text key={i} style={styles.wheelLabel}>{c.label}</Text>)}</View>
      <View style={styles.wheelsRow}>
        <View style={styles.wheelBand} pointerEvents="none" />
        {columns.map((c, i) => <Wheel key={i} values={c.values} index={c.index} onChange={c.onChange} />)}</View></View>);}
type PickerProps = { value: number; onChange: (seconds: number) => void };
// Time of day: hour, minute, second, am/pm. Value is seconds after midnight.
function StartPicker({ value, onChange }: PickerProps) {
  const [h24, m, s] = hms(value);
  const pm = h24 >= 12 ? 1 : 0;
  const h12 = h24 % 12 || 12;
  const build = (h: number, min: number, sec: number, p: number) =>
    onChange(((h % 12) + p * 12) * 3600 + min * 60 + sec);
  if (CLOCK24) {
    return <WheelSet columns={[
      { label: "hour", values: HOURS_24, index: h24, onChange: (i) => onChange(i * 3600 + m * 60 + s) },
      { label: "min", values: SIXTY, index: m, onChange: (i) => onChange(h24 * 3600 + i * 60 + s) },
      { label: "sec", values: SIXTY, index: s, onChange: (i) => onChange(h24 * 3600 + m * 60 + i) },
    ]} />;}
  return (<WheelSet
      columns={[
        { label: "hour", values: HOURS_12, index: h12 - 1, onChange: (i) => build(i + 1, m, s, pm) },
        { label: "min", values: SIXTY, index: m, onChange: (i) => build(h12, i, s, pm) },
        { label: "sec", values: SIXTY, index: s, onChange: (i) => build(h12, m, i, pm) },
        { label: "", values: ["AM", "PM"], index: pm, onChange: (i) => build(h12, m, s, i) },]}/>);}
// Length: hours, minutes, seconds. Value is seconds.
function LengthPicker({ value, onChange }: PickerProps) {
  const [h, m, s] = hms(value);
  const build = (hh: number, mm: number, ss: number) => onChange(hh * 3600 + mm * 60 + ss);
  return (<WheelSet
      columns={[
        { label: "hours", values: HOURS_24, index: h, onChange: (i) => build(i, m, s) },
        { label: "min", values: SIXTY, index: m, onChange: (i) => build(h, i, s) },
        { label: "sec", values: SIXTY, index: s, onChange: (i) => build(h, m, i) },]}/>);}
// h in degrees (0–360), s and v from 0 to 1.
function hsvToHex(h: number, s: number, v: number) {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));};
  return "#" + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("").toUpperCase();}
function hexToHsv(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max ? d / max : 0, max];}
// Text color that stays readable on top of a colored event block.
// Text on a colored fill: dark or white, whichever stands out more from it.
function inkOn(hex: string) {
  return contrast(DARK, hex) >= contrast("#FFFFFF", hex) ? DARK : "#FFFFFF";}
type PadEvent = { nativeEvent: { locationX: number; locationY: number } };
// A touch area that reports where you press or drag, as 0–1 across and down.
function Pad({ style, onChange, children }: { style: object; onChange: (x: number, y: number) => void; children: React.ReactNode }) {
  const size = useRef({ w: 1, h: 1 });
  const lock = React.useContext(ScrollLock);
  const go = (e: PadEvent) =>
    onChange(clamp(e.nativeEvent.locationX / size.current.w, 0, 1), clamp(e.nativeEvent.locationY / size.current.h, 0, 1));
  return (<View
      style={style}
      onLayout={(e) => { size.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height }; }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      // The scroll area is locked the instant a finger lands, before it could start scrolling, and freed when it lifts.
      onTouchStart={() => lock(true)} onTouchEnd={() => lock(false)} onTouchCancel={() => lock(false)}
      onResponderGrant={go}
      onResponderMove={go}>
      {/* Children ignore touches so the coordinates stay relative to the pad. */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">{children}</View></View>);}
// Saturation across, brightness down, for the chosen hue.
function SvSquare({ hue, sat, val, onChange }: { hue: number; sat: number; val: number; onChange: (sat: number, val: number) => void }) {
  return (<Pad style={styles.svSquare} onChange={(x, y) => onChange(x, 1 - y)}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="sat" x1="0" y1="0" x2="1" y2="0"><Stop offset="0" stopColor="#FFFFFF" stopOpacity="1" /><Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" /></LinearGradient>
          <LinearGradient id="val" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#000000" stopOpacity="0" /><Stop offset="1" stopColor="#000000" stopOpacity="1" /></LinearGradient></Defs>
        <Rect width="100%" height="100%" fill={hsvToHex(hue, 1, 1)} />
        <Rect width="100%" height="100%" fill="url(#sat)" />
        <Rect width="100%" height="100%" fill="url(#val)" /></Svg>
      <View style={[styles.svThumb, { left: `${sat * 100}%`, top: `${(1 - val) * 100}%` }]} /></Pad>);}
// The rainbow strip down the side.
function HueBar({ hue, onChange }: { hue: number; onChange: (hue: number) => void }) {
  return (<Pad style={styles.hueBar} onChange={(_, y) => onChange(y * 359.9)}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="hue" x1="0" y1="0" x2="0" y2="1">
            {nums(7, (i) => <Stop key={i} offset={String(i / 6)} stopColor={hsvToHex(i * 60, 1, 1)} />)}</LinearGradient></Defs>
        <Rect width="100%" height="100%" fill="url(#hue)" /></Svg>
      <View style={[styles.hueThumb, { top: `${(hue / 360) * 100}%` }]} /></Pad>);}
// A small editable number/text box. It follows the value from outside except while you're typing in it.
function Field({ label, value, sanitize, onCommit, text }: { label: string; value: string; sanitize: (t: string) => string; onCommit: (t: string) => void; text?: boolean }) {
  const [typed, setTyped] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setTyped(value); }, [value]);
  return (<View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput value={typed}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; setTyped(value); }}
        onChangeText={(t) => { const c = sanitize(t); setTyped(c); if (c) onCommit(c); }}
        keyboardType={text ? "default" : "number-pad"} autoCapitalize="characters" autoCorrect={false} selectTextOnFocus style={styles.fieldInput}/></View>);}
const END_MODES: [EndMode, string, string][] = [["never", "Never", "End Never"], ["days", "After", "End After"], ["date", "On date", "End On date"]];
const DAY_COUNTS = nums(365, (i) => String(i + 1));
const SHORT_MONTHS = MONTHS.map((m) => m.slice(0, 3));
function EndPicker({ draft, onChange }: { draft: Draft; onChange: (p: Partial<Draft>) => void }) {
  const startYear = parseKey(draft.date).getFullYear();
  const [y, mo, d] = (draft.until ?? draft.date).split("-").map(Number);
  // Builds a valid end date; it can't be earlier than the first day of the event.
  const build = (yy: number, mm: number, dd: number) => {
    const last = new Date(yy, mm, 0).getDate();
    const key = `${yy}-${pad(mm)}-${pad(Math.min(dd, last))}`;
    onChange({ until: key < draft.date ? draft.date : key });};
  return (<View style={{ gap: 10 }}>
      <Choices value={draft.endMode} options={END_MODES} onPick={(endMode) => onChange({ endMode })} />
      {draft.endMode === "days" && (<WheelSet columns={[{ label: "days", values: DAY_COUNTS, index: clamp(draft.endDays, 1, 365) - 1, onChange: (i) => onChange({ endDays: i + 1 }) }]} />)}
      {draft.endMode === "date" && (<WheelSet
          columns={[
            { label: "month", values: SHORT_MONTHS, index: mo - 1, onChange: (i) => build(y, i + 1, d) },
            { label: "day", values: nums(new Date(y, mo, 0).getDate(), (i) => String(i + 1)), index: d - 1, onChange: (i) => build(y, mo, i + 1) },
            { label: "year", values: nums(11, (i) => String(startYear + i)), index: clamp(y - startYear, 0, 10), onChange: (i) => build(startYear + i, mo, d) },]}/>)}</View>);}
function Chip({ label, active, round, dim, a11y, onPress }: {
  label: string; active: boolean; round?: boolean; dim?: boolean; a11y: string; onPress: () => void;
}) {
  return (<Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={a11y} style={[round ? styles.dayChip : styles.chip, active && (round ? styles.dayChipOn : styles.chipOn), dim && styles.dimmed]}>
      <Text style={[round ? styles.dayChipText : styles.chipText, active && styles.chipTextOn]}>{label}</Text></Pressable>);}
// The "Every [n] days" repeat chip: a chip with a number box in the middle. Tap the chip to pick it (or to turn it off when lit); tap the box to type.
function EveryChip({ active, dim, interval, onPress, onFocus, onChangeText }: {
  active: boolean; dim?: boolean; interval?: number; onPress: () => void; onFocus: () => void; onChangeText: (t: string) => void;
}) {
  const word = [styles.chipText, active && styles.chipTextOn];
  return (<Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel="Repeat every few days" style={[styles.chip, styles.everyChip, active && styles.chipOn, dim && styles.dimmed]}>
      <Text style={word}>Every</Text>
      <TextInput value={interval ? String(interval) : ""} onFocus={onFocus} onChangeText={onChangeText} keyboardType="number-pad" returnKeyType="done" maxLength={3} selectTextOnFocus
        placeholder="2" placeholderTextColor={MUTED} accessibilityLabel="Number of days between repeats" style={[styles.everyInput, active && styles.everyInputOn]} />
      <Text style={word}>{interval === 1 ? "day" : "days"}</Text></Pressable>);}
// A row of tabs, each with a label and its current value: [id, label, value]. `tight` fits five across.
function Tabs<T extends string>({ value, tabs, onPick, tight }: { value: T; tabs: [T, string, string][]; onPick: (id: T) => void; tight?: boolean }) {
  return (<View style={[styles.tabs, tight && { gap: 6 }]}>
      {tabs.map(([id, label, v]) => (<Pressable key={id} onPress={() => onPick(id)} style={[styles.tab, tight && { paddingHorizontal: 8 }, value === id && styles.chipOn]}>
          <Text style={styles.tabLabel}>{label}</Text>
          <FitText style={styles.tabValue} numberOfLines={1} adjustsFontSizeToFit>{v}</FitText></Pressable>))}</View>);}
// A row of chips where exactly one option is active: [value, label, accessibility label].
function Choices<T>({ value, options, onPick, dim, wrap }: { value: T; options: [T, string, string][]; onPick: (v: T) => void; dim?: boolean; wrap?: boolean }) {
  return <View style={[styles.chips, wrap && styles.chipsWrap]}>{options.map(([v, label, a11y]) => <Chip key={label} label={label} a11y={a11y} active={value === v} dim={dim} onPress={() => onPick(v)} />)}</View>;}
// Read at render time (not module load) so they follow the current theme. [background, text, weight, outline]
const buttonLook = (kind: "save" | "cancel" | "delete") =>
  ({
    save: [ORANGE, inkOn(ORANGE), "800", mix(ORANGE, "#FFFFFF", 0.4)],
    cancel: [PANEL_LIGHT, TEXT, "600", MUTED],
    delete: [alpha(DANGER, 0.18), DANGER, "700", DANGER],
  } as const)[kind];
function Btn({ kind, label, onPress }: { kind: "save" | "cancel" | "delete"; label: string; onPress: () => void }) {
  const [bg, color, fontWeight, outline] = buttonLook(kind);
  return (<Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={[styles.button, { backgroundColor: bg, borderColor: outline }]}>
      <Text style={[styles.buttonText, { color, fontWeight }]}>{label}</Text></Pressable>);}
// Bottom sheet shell shared by the editor, sequence list and checklist.
// `tall` stretches it up to just under the black bar at the top of the screen (the event editor).
// A tall sheet has a fixed height: the content scrolls (unless `plain`) and the `footer` buttons stay pinned to the bottom.
function SheetBox({ children, tall, plain, footer, onDismiss }: { children: React.ReactNode; tall?: boolean; plain?: boolean; footer?: React.ReactNode; onDismiss: () => void }) {
  const { top, bottom } = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  // Drag the grab bar at the top down to dismiss: past ~110pt (or a quick flick) it slides away and calls onDismiss, otherwise it springs back.
  const y = useRef(new Animated.Value(0)).current;
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const back = () => Animated.spring(y, { toValue: 0, useNativeDriver: true }).start();
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => Keyboard.dismiss(),
    onPanResponderMove: (_, g) => y.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_, g) => {
      if (g.dy > 110 || g.vy > 1.2) Animated.timing(y, { toValue: 1000, duration: 180, useNativeDriver: true }).start(() => dismiss.current()); // stays off-screen: resetting it here would flash the old content back before the screen changes
      else back();},
    onPanResponderTerminate: back,
  })).current;
  return (<Animated.View style={[styles.sheet, { paddingBottom: Math.max(bottom, 16), transform: [{ translateY: y }] }, tall && { height: height - (top - ISLAND_BOTTOM_OFFSET) }]}>
      <View {...pan.panHandlers} accessible accessibilityLabel="Drag down to close" style={styles.grabArea}><View style={styles.grabber} /></View>
      {!tall ? children : plain ? <View style={[styles.sheetBody, { flex: 1 }]}>{children}</View> : (<LockScroll style={[{ flex: 1 }]} contentContainerStyle={[styles.sheetBody]} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets showsVerticalScrollIndicator={false}>{children}</LockScroll>)}
      {footer}</Animated.View>);}
type DayCellProps = {
  date: Date; inMonth: boolean; isToday: boolean; isSelected: boolean; inWeek: boolean;
  marks: string; // important events that day as "shape:color", comma separated (up to 4)
  weekday: boolean; // show the weekday name
  onPress: (date: Date) => void;};
// Memoized: only the cells whose props change re-render.
const DayCell = memo(function DayCell({ date, inMonth, isToday, isSelected, inWeek, marks, weekday, onPress }: DayCellProps) {
  return (<Pressable
      onPress={() => onPress(date)}
      accessibilityLabel={date.toDateString()}
      style={[
        styles.calendarCell,
        inMonth && styles.monthCell,
        inWeek && inMonth && styles.currentWeekCell,
        isToday && styles.todayCell,
        isSelected && styles.selectedCell,]}>
      <View style={styles.dayNumber}>
        <Text style={[styles.dayText, !inMonth && styles.outsideMonthText, isSelected && styles.selectedText]}>
          {date.getDate()}</Text></View>
      {inMonth && weekday && <Text style={[styles.weekdayLabel, isSelected && styles.selectedText]}>{DAYS[date.getDay()].slice(0, 3)}</Text>}
      {!!marks && (<View style={styles.eventDots}>
          {marks.split(",").map((m, i) => <Shape key={i} kind={m.split(":")[0] as ShapeKind} color={m.split(":")[1]} size={10} />)}</View>)}</Pressable>);});
const SHAPE_PATHS = {
  star: "M12 2.5l2.9 6.2 6.8.8-5 4.7 1.3 6.7L12 17.6 6 20.9l1.3-6.7-5-4.7 6.8-.8z",
  circle: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  square: "M4 4h16v16H4z",
  diamond: "M12 2.5 21.5 12 12 21.5 2.5 12z",
  heart: "M12 21s-8-5.2-8-11a4.6 4.6 0 0 1 8-3 4.6 4.6 0 0 1 8 3c0 5.8-8 11-8 11z",
  triangle: "M12 3 22 20H2z",
  hexagon: "M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z",
  cross: "M9 3h6v6h6v6h-6v6H9v-6H3V9h6z",};
type ShapeKind = keyof typeof SHAPE_PATHS;
const SHAPE_KINDS = Object.keys(SHAPE_PATHS) as ShapeKind[];
const SHAPE_GLYPHS: Record<ShapeKind, string> = { star: "★", circle: "●", square: "■", diamond: "◆", heart: "♥", triangle: "▲", hexagon: "⬢", cross: "✚" };
const Shape = ({ kind, color, size }: { kind: ShapeKind; color: string; size: number }) => (<Svg width={size} height={size} viewBox="0 0 24 24"><Path d={SHAPE_PATHS[kind]} fill={color} stroke={edgeOn(color, BG)?.borderColor ?? color} strokeWidth={1.5} strokeLinejoin="round" /></Svg>);
const youtubeId = (url: string) => /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/.exec(url)?.[1];
// Picked files live in a temporary cache, so copy them somewhere permanent (falls back to the original if that fails).
async function keepFile(uri: string) {
  try {
    const dir = new FS.Directory(FS.Paths.document, "media");
    if (!dir.exists) dir.create();
    const dest = new FS.File(dir, `${newId()}${/\.\w+$/.exec(uri)?.[0] ?? ""}`);
    new FS.File(uri).copy(dest);
    return dest.uri;
  } catch { return uri; }}
// On the web, picked files only last until the page closes, so they're kept inside the saved data as text (data URLs).
// Space there is small (a few MB in all), so photos are shrunk and big files are turned away.
async function fileToDataUrl(uri: string, maxBytes: number): Promise<string | null> {
  const blob = await (await fetch(uri)).blob();
  if (blob.size > maxBytes) return null;
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(blob); });}
async function shrinkImage(uri: string, max = 1080): Promise<string | null> {
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new (window as any).Image(); i.onload = () => res(i); i.onerror = rej; i.src = uri; });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.72);
  } catch { return null; }}
// Copies a chosen audio file into the app. wav/aiff/caf copies also go in Library/Sounds, the one place iOS looks for notification sounds.
async function pickSound() {
  const r = await DocumentPicker.getDocumentAsync({ type: "audio/*", copyToCacheDirectory: true });
  const a = r.canceled ? undefined : r.assets[0];
  if (!a) return undefined;
  if (IS_WEB) {
    const data = await fileToDataUrl(a.uri, 600_000).catch(() => null);
    if (!data) { Alert.alert("Sound too big", "Pick a sound file under 600 KB."); return undefined; }
    return { soundUri: data, soundName: a.name, soundFile: undefined };}
  const ext = (/\.(\w+)$/.exec(a.name)?.[1] ?? "caf").toLowerCase();
  const name = `${newId()}.${ext}`;
  let uri = a.uri, file: string | undefined;
  try { const dir = new FS.Directory(FS.Paths.document, "sounds"); if (!dir.exists) dir.create(); const dest = new FS.File(dir, name); new FS.File(a.uri).copy(dest); uri = dest.uri; } catch {}
  if (["wav", "aiff", "aif", "caf"].includes(ext)) {
    try { const lib = new FS.Directory(FS.Paths.document.parentDirectory, "Library", "Sounds"); lib.create({ idempotent: true, intermediates: true }); new FS.File(uri).copy(new FS.File(lib, name)); file = name; } catch {}
  }
  return { soundUri: uri, soundName: a.name, soundFile: file };
}
async function pickMedia(): Promise<Media[]> {
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], allowsMultipleSelection: true, quality: 0.8 });
  if (r.canceled) return [];
  if (IS_WEB) {
    const kept: Media[] = [];
    let skipped = 0;
    for (const a of r.assets) {
      const video = a.type === "video" || /^data:video|\.(mp4|mov|m4v|webm)$/i.test(a.uri);
      const uri = video ? await fileToDataUrl(a.uri, 1_500_000).catch(() => null) : await shrinkImage(a.uri);
      if (uri) kept.push({ id: newId(), kind: video ? "video" : "image", uri }); else skipped++;}
    if (skipped) Alert.alert("Some files weren't added", "Videos over 1.5 MB don't fit in the web app's storage. Add a YouTube link instead.");
    return kept;}
  return Promise.all(r.assets.map(async (a) => ({ id: newId(), kind: a.type === "video" ? "video" : "image", uri: await keepFile(a.uri) }) as Media));}
function MediaThumb({ m, onPress, onRemove }: { m: Media; onPress: () => void; onRemove?: () => void }) {
  const yt = m.kind === "youtube" ? youtubeId(m.uri) : undefined;
  const src = m.kind === "image" ? m.uri : yt ? `https://img.youtube.com/vi/${yt}/hqdefault.jpg` : undefined;
  return (<View style={styles.thumb}>
      <Pressable onPress={onPress} accessibilityLabel={`Open ${m.kind}`} style={styles.thumbFill}>
        {src && <Image source={{ uri: src }} style={StyleSheet.absoluteFill} />}
        {m.kind !== "image" && <Text style={styles.thumbPlay}>▶</Text>}</Pressable>
      {onRemove && <Pressable onPress={onRemove} accessibilityLabel="Remove" style={styles.thumbX}><Text style={styles.thumbXText}>✕</Text></Pressable>}</View>);}
const MediaRow = ({ media, onOpen, onRemove }: { media?: Media[]; onOpen: (m: Media) => void; onRemove?: (id: string) => void }) =>
  media?.length ? <View style={styles.mediaRow}>{media.map((m) => <MediaThumb key={m.id} m={m} onPress={() => onOpen(m)} onRemove={onRemove && (() => onRemove(m.id))} />)}</View> : null;
function VideoBox({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => p.play());
  return <VideoView player={player} style={styles.viewerMedia} nativeControls contentFit="contain" />;}
// Full-screen viewer for a photo or video.
function MediaViewer({ media, onClose }: { media: Media | null; onClose: () => void }) {
  const { top } = useSafeAreaInsets();
  return (<Modal visible={!!media} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.viewer}>
        {media?.kind === "image" && <Image source={{ uri: media.uri }} style={styles.viewerMedia} resizeMode="contain" />}
        {media?.kind === "video" && <VideoBox uri={media.uri} />}
        <Pressable onPress={onClose} accessibilityLabel="Close" style={[styles.viewerClose, { top: top + 8 }]}><Text style={styles.thumbXText}>✕</Text></Pressable></View></Modal>);}
// Photos and videos open in the viewer; YouTube links open in YouTube or the browser.
const openMedia = (m: Media, show: (m: Media) => void) => (m.kind === "youtube" ? Linking.openURL(m.uri).catch(() => {}) : show(m));
const doneIds = (ev: CalEvent, key: string) =>
  (ev.checks?.[key] ?? []).filter((id) => ev.steps?.some((st) => st.id === id));
// " · 2/6" for events with a sequence, otherwise nothing.
const progress = (ev: CalEvent, key: string) =>
  ev.steps?.length ? ` · ${doneIds(ev, key).length}/${ev.steps.length}` : "";
// Brief extras shown inside an event block: reminder, and sequence progress with the next step.
function blockInfo(ev: CalEvent, key: string) {
  const reminder = ev.alert === undefined ? "" : `\uE000${alertText(ev.alert, ev.alertAfter)}${ev.nag ? ` · every ${formatDuration(ev.nag.every)}` : ""}`;
  let sequence = "";
  if (ev.steps?.length) {
    const done = doneIds(ev, key);
    const next = ev.steps.find((st) => !done.includes(st.id));
    sequence = `✓ ${done.length}/${ev.steps.length}${next ? ` · ${next.text}` : " · done"}`;}
  return { reminder, sequence };}
type DetailProps = {
  ev: CalEvent; dayLabel: string; checked: string[];
  onToggle: (stepId: string) => void; onReset: () => void; onEdit: () => void; onClose: () => void;};
// Opens when you tap an event that has a sequence: the list to work through.
// The events folded into a "+N" block or a "+N" tag, as a list: tap one to open it.
function MoreSheet({ events, onOpen, onClose }: { events: CalEvent[]; onOpen: (ev: CalEvent) => void; onClose: () => void }) {
  const from = Math.min(...events.map((e) => e.start)), to = Math.max(...events.map((e) => e.start + e.duration));
  return (<SheetBox onDismiss={onClose}>
      <Text style={styles.sheetTitle}>{plural(events.length, "event")}</Text>
      <Text style={styles.detailMeta}>{formatTime(from)} – {formatTime(to)}</Text>
      <ScrollView style={styles.stepList} showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {[...events].sort((a, b) => a.start - b.start).map((ev) => (<Pressable key={ev.id} onPress={() => onOpen(ev)} accessibilityLabel={`Open ${ev.title}`} style={styles.moreRow}>
            <View style={[styles.detailDot, { backgroundColor: ev.color }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.seqRowText} numberOfLines={1}>{ev.important ? `${SHAPE_GLYPHS[ev.shape ?? "star"]} ` : ""}{ev.title}{ev.repeat !== "none" ? " ↻" : ""}</Text>
              <Text style={styles.seqRowValue}>{formatTime(ev.start)} – {formatTime(ev.start + ev.duration)}</Text></View></Pressable>))}</ScrollView>
      <View style={styles.buttonRow}><Btn kind="cancel" label="Close" onPress={onClose} /></View></SheetBox>);}
function DetailSheet({ ev, dayLabel, checked, onToggle, onReset, onEdit, onClose }: DetailProps) {
  const steps = ev.steps ?? [];
  const [viewer, setViewer] = useState<Media | null>(null);
  return (<SheetBox onDismiss={onClose}>
      <View style={styles.detailTitleRow}>
        <View style={[styles.detailDot, { backgroundColor: ev.color }]} />
        <Text style={[styles.sheetTitle, { flex: 1 }]} numberOfLines={2}>{ev.title}</Text></View>
      <Text style={styles.detailMeta}>
        {dayLabel} · {formatTime(ev.start)} – {formatTime(ev.start + ev.duration)} · {checked.length} of {steps.length} done</Text>
      <ScrollView style={[styles.stepList]} showsVerticalScrollIndicator={false}>
        {steps.map((st, i) => {
          const on = checked.includes(st.id);
          return (<View key={st.id} style={styles.checkBlock}>
              <Pressable onPress={() => onToggle(st.id)} accessibilityLabel={`${st.text}, ${on ? "done" : "not done"}`} style={styles.checkRow}>
                <View style={[styles.checkBox, on && styles.checkBoxOn]}>
                  {on && <Text style={styles.checkMark}>✓</Text>}</View>
                <Text style={[styles.checkText, on && styles.checkTextOn]}>{i + 1}. {st.text}</Text></Pressable>
              <MediaRow media={st.media} onOpen={(m) => openMedia(m, setViewer)} /></View>);})}</ScrollView>
      <View style={styles.buttonRow}>
        <Btn kind="cancel" label="Reset" onPress={onReset} />
        <Btn kind="cancel" label="Edit" onPress={onEdit} />
        <Btn kind="save" label="Done" onPress={onClose} /></View>
      <MediaViewer media={viewer} onClose={() => setViewer(null)} /></SheetBox>);}
type PanCallbacks = { onTap: () => void; onBegin: () => void; onMove: (dx: number, dy: number) => void; onEnd: () => void; onHold?: () => void;
  onRelease?: () => void; // the finger lifted (or the touch was cancelled), whatever the press turned out to be
  onHoldStart?: () => void; onHoldCancel?: () => void }; // a hold began counting down / stopped short (moved or lifted)
const HOLD_MS = 700; // how long an event block is held before its menu opens
// Press-and-hold feedback, the same on everything that reveals more on a long press: while the finger stays down a soft shade
// sweeps across it, reaching the far edge just as the hold triggers; then it flashes and fades. Let go early, or start dragging,
// and it eases away. `overlay` goes inside the pressed thing, which must clip what's inside it.
function useHoldFx(ms: number, ink: string) {
  const sweep = useRef(new Animated.Value(0)).current, shade = useRef(new Animated.Value(0)).current;
  return useMemo(() => ({
    start: () => {
      sweep.setValue(0);
      shade.setValue(0.2);
      Animated.timing(sweep, { toValue: 1, duration: ms, easing: Easing.linear, useNativeDriver: false }).start();},
    cancel: () => { sweep.stopAnimation(); Animated.timing(shade, { toValue: 0, duration: 160, useNativeDriver: false }).start(); },
    fire: () => {
      sweep.stopAnimation();
      sweep.setValue(1);
      Animated.sequence([Animated.timing(shade, { toValue: 0.4, duration: 70, useNativeDriver: false }), Animated.timing(shade, { toValue: 0, duration: 280, useNativeDriver: false })]).start();},
    overlay: (<Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: ink, opacity: shade,
      width: sweep.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }} />),
  }), [ms, ink]);}
// A button with the hold feedback when it has a long press (otherwise a plain Pressable). `ink`: the shade's color, set to stand
// out on the button.
function HoldPressable({ onLongPress, delayLongPress = 500, ink = TEXT, style, children, onPressIn, onPressOut, ...rest }: React.ComponentProps<typeof Pressable> & { ink?: string; children?: React.ReactNode }) {
  const fx = useHoldFx(delayLongPress, ink);
  if (!onLongPress) return <Pressable {...rest} style={style} onPressIn={onPressIn} onPressOut={onPressOut}>{children}</Pressable>;
  return (<Pressable {...rest} delayLongPress={delayLongPress} style={[style as any, { overflow: "hidden" }]}
      onPressIn={(e) => { fx.start(); onPressIn?.(e); }} onPressOut={(e) => { fx.cancel(); onPressOut?.(e); }}
      onLongPress={(e) => { fx.fire(); onLongPress(e); }}>{children}{fx.overlay}</Pressable>);}
// Picks the nearest target within `thr` seconds, otherwise rounds to `step` seconds.
const snapNear = (raw: number, targets: number[], thr: number, step = 60) => {
  const best = targets.reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a), targets[0]);
  return Math.abs(best - raw) <= thr ? best : Math.round(raw / step) * step;};
// A press that becomes a drag once the finger moves a few points, a hold if it stays down, or a tap if it's quick.
let lastTouchEnd = 0; // when any press last ended, so a hold timer from an earlier press can never fire later
// Web: when a finger lifts from an event (after a tap, hold or drag), the browser also sends a "click" to whatever is under it,
// which by then can be a menu or sheet that just opened. That one click is swallowed so it can't close the menu or press a button.
let swallowClickUntil = 0;
if (IS_WEB && typeof document !== "undefined") {
  document.addEventListener("click", (e) => { if (Date.now() < swallowClickUntil) { e.stopPropagation(); e.preventDefault(); swallowClickUntil = 0; } }, true);}
const endTouch = () => { lastTouchEnd = Date.now(); if (IS_WEB) swallowClickUntil = Date.now() + 450; };
function usePan(cbs: PanCallbacks) {
  const cb = useRef(cbs);
  cb.current = cbs;
  const moved = useRef(false);
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holding = useRef(false); // a hold is counting down
  const stopHold = () => { clearTimeout(timer.current); if (holding.current) { holding.current = false; cb.current.onHoldCancel?.(); } };
  const down = useRef(false); // a finger is on it right now
  const lift = () => { if (down.current) { down.current = false; cb.current.onRelease?.(); } };
  // An event that disappears mid-press can't open the menu afterwards, and still reports the touch as over.
  useEffect(() => () => { stopHold(); lift(); }, []);
  return useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        down.current = true;
        moved.current = false;
        held.current = false;
        clearTimeout(timer.current);
        const began = Date.now();
        if (cb.current.onHold) {
          holding.current = true;
          cb.current.onHoldStart?.();
          timer.current = setTimeout(() => {
            holding.current = false;
            if (!moved.current && lastTouchEnd < began) { held.current = true; cb.current.onHold?.(); } else cb.current.onHoldCancel?.();}, HOLD_MS);}
        cb.current.onBegin();},
      onPanResponderMove: (_, g) => {
        const dist = Math.hypot(g.dx, g.dy);
        if (dist > 4) stopHold(); // any real movement means drag, never hold
        if (held.current || (!moved.current && dist < 6)) return;
        moved.current = true;
        clearTimeout(timer.current);
        cb.current.onMove(g.dx, g.dy);},
      onPanResponderRelease: () => {
        endTouch();
        stopHold();
        lift();
        if (moved.current) cb.current.onEnd();
        else if (!held.current) cb.current.onTap();},
      onPanResponderTerminate: () => { endTouch(); stopHold(); lift(); if (moved.current) cb.current.onEnd(); },})
  ).current.panHandlers;}
function DragBlock({ style, a11y, hitSlop, ink, children, ...cbs }: PanCallbacks & { style: any; a11y: string; hitSlop?: { top: number; bottom: number }; ink: string; children: React.ReactNode }) {
  const fx = useHoldFx(HOLD_MS, ink);
  const pan = usePan(cbs.onHold ? { ...cbs, onHoldStart: fx.start, onHoldCancel: fx.cancel, onHold: () => { fx.fire(); cbs.onHold?.(); } } : cbs);
  return <View {...pan} hitSlop={hitSlop} accessible accessibilityRole="button" accessibilityLabel={a11y} onAccessibilityTap={cbs.onTap} style={style}>{fx.overlay}{children}</View>;}
// The grip along the bottom edge of an event: drag it to change when the event ends.
function ResizeGrip({ ink, ...cbs }: PanCallbacks & { ink: string }) {
  return <View {...usePan(cbs)} accessibilityLabel="Drag to change the end time" style={styles.grip}><View style={[styles.gripBar, { backgroundColor: ink }]} /></View>;}
// Lets a color picker stop the scroll area it sits in from scrolling while a finger is on it, so dragging down picks a color.
const ScrollLock = React.createContext<(locked: boolean) => void>(() => {});
function LockScroll({ scrollEnabled = true, ...props }: React.ComponentProps<typeof ScrollView>) {
  const [locked, setLocked] = useState(false);
  return <ScrollLock.Provider value={setLocked}><ScrollView {...props} scrollEnabled={scrollEnabled && !locked} /></ScrollLock.Provider>;}
// Text marked adjustsFontSizeToFit shrinks until it fits on the phone. The web can't do that by itself (it cuts the text off
// with "…" instead), so there the font is stepped down after each layout until the text fits.
function FitText(props: React.ComponentProps<typeof Text>) {
  return IS_WEB && props.adjustsFontSizeToFit ? <WebFitText {...props} /> : <Text {...props} />;}
function WebFitText({ minimumFontScale = 0.5, adjustsFontSizeToFit, ...rest }: React.ComponentProps<typeof Text>) {
  const ref = useRef<any>(null);
  const fit = useCallback(() => {
    const el = ref.current as HTMLElement | null;
    if (!el || !el.style) return;
    el.style.fontSize = "";
    const base = parseFloat(getComputedStyle(el).fontSize);
    if (!base) return;
    for (let scale = 1; el.scrollWidth > el.clientWidth + 0.5 && scale > minimumFontScale; ) {
      scale = Math.max(minimumFontScale, scale - 0.04);
      el.style.fontSize = `${(base * scale).toFixed(2)}px`;}
  }, [minimumFontScale]);
  useLayoutEffect(fit);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let w = -1;
    const ro = new ResizeObserver(() => { if (el.clientWidth !== w) { w = el.clientWidth; fit(); } });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);
  return <Text ref={ref} {...rest} />;}
// Pages that keep their scroll position when the app redraws (picking a theme or a setting redraws everything).
const keptScroll: Record<string, number> = {};
function useKeptScroll(name: string) {
  const ref = useRef<ScrollView>(null);
  useEffect(() => {
    const y = keptScroll[name];
    if (!y) return;
    ref.current?.scrollTo({ y, animated: false });
    const t = setTimeout(() => ref.current?.scrollTo({ y, animated: false }), 0); // again once the page has its full height
    return () => clearTimeout(t);
  }, []);
  return { ref, scrollEventThrottle: 16, onScroll: (e: any) => { keptScroll[name] = e.nativeEvent.contentOffset.y; } };}
// A drawn bell (not an emoji) that takes the text's color.
const Bell = ({ size, color }: { size: number; color: string }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Path d="M12 2a1.6 1.6 0 0 0-1.6 1.6v.6C7.8 4.9 6 7.2 6 10v4l-2 2.5V18h16v-1.5L18 14v-4c0-2.8-1.8-5.1-4.4-5.8v-.6A1.6 1.6 0 0 0 12 2zM10 19.5a2 2 0 0 0 4 0z" fill={color} /></Svg>);
// Detail line in an event block. A leading  stands for the bell icon.
function Detail({ text, color, style, size }: { text: string; color: string; style: any; size: number }) {
  if (!text.startsWith("")) return <Text style={[style, { color }]} numberOfLines={1}>{text}</Text>;
  return (<View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 2, maxWidth: "100%" }}>
      <Bell size={size} color={color} />
      <Text style={[style, { color, flexShrink: 1 }]} numberOfLines={1}>{text.slice(1)}</Text></View>);}
type Now = { column: number; offset: number; label: string; below: boolean; exact: number }; // below: label under the line; exact: the hour row to highlight while it is exactly that hour (else -1)
// The text of one event, drawn in its own layer above the current-time line.
// Memoized: while one event is dragged, the others keep the same props and aren't redrawn.
const EventLabel = memo(function EventLabel({ ev, selKey, top, height, left, width, narrowMode, narrowW = 0, segStart, segEnd, ce, showTimes, showInfo, raised, shift, text = "", tagX = 0, tagY = 0, tagW = 0 }: {
  ev: CalEvent; selKey: string; top: number; height: number; left: string; width: string; segStart: number; segEnd: number; ce: number;
  narrowMode?: "wrap" | "upright"; narrowW?: number; // a thin side-by-side block (see the column) and its width: label wrapped small, or running up the bar
  text?: string; // one-line label the column picked for a short or narrow block (the longest version that fits)
  tagX?: number; tagY?: number; tagW?: number; // where the column placed this event's tag, if it has one (left, top and width, in points)
  showTimes: boolean; showInfo: boolean; raised: boolean; shift: number | null; // shift: sideways nudge while moving (null = not moving)
}) {
  const tight = height < 40; // small blocks squeeze everything in at a smaller size
  const color = inkOn(ev.color);
  // An hour label already shows the time when it falls exactly on the hour (or the column edge for ends).
  const startText = startLabel(ev, segStart, showTimes);
  const endAt = ev.start + ev.duration;
  const endText = showTimes && endAt === segEnd && (segEnd % 3600 !== 0 || segEnd === ce) ? shortTime(endAt) : "";
  const timeW = Math.max(startText.length, endText.length) * 5 + 10;
  const info = blockInfo(ev, selKey);
  const detail = showInfo ? [info.reminder, info.sequence].filter(Boolean) : [];
  const detailLines = tight ? 0 : height >= 58 && detail.length > 1 ? 2 : detail.length ? 1 : 0; // as many as fit
  const times = [startText, endText].filter(Boolean).join(" – ");
  const inset = [tight && styles.eventInnerShort, { paddingLeft: !tight && times ? timeW : 5 }];
  const place = [raised && { zIndex: 20 }, shift !== null && { transform: [{ translateX: shift }] }];
  if (narrowMode === "upright") { // the label runs up the bar, where there's room for it
    const len = height - 6, thick = narrowW - 2;
    return (<View pointerEvents="none" style={[styles.eventGhost, ...place, { top, height, left, width }]}>
        <View style={[styles.upright, { width: len, height: thick, left: (narrowW - len) / 2, top: (height - thick) / 2 }]}>
          <Text style={[styles.miniText, styles.uprightText, { color }]} numberOfLines={thick >= 22 ? 2 : 1}>{text}</Text></View></View>);}
  if (narrowMode) // small text, wrapped over as many lines as the block holds
    return (<View pointerEvents="none" style={[styles.eventGhost, ...place, { top, height, left, width }]}>
        <View style={styles.wrapInner}><Text style={[styles.miniText, styles.uprightText, { color }]} numberOfLines={wrapLines(height)}>{text}</Text></View></View>);
  if (height < MINI) {
    // One line: start time (when it isn't on the hour) and title. Too thin even for that: the line sits in a tag centered on the bar.
    const sliver = tagW > 0;
    const label = text;
    return (<View pointerEvents="none" style={[styles.eventGhost, sliver && styles.sliverGhost, ...place, sliver ? { top: tagY, height: TAG_H, left: tagX, width: tagW } : { top, height, left, width }]}>
        <View style={sliver ? [styles.sliverTag, { backgroundColor: ev.color }, edgeOn(ev.color, PANEL)] : styles.miniInner}>
          <Text style={[styles.miniText, { color }]} numberOfLines={1}>{label}</Text></View></View>);}
  return (<View pointerEvents="none" style={[styles.eventGhost, ...place, { top, height, left, width }]}>
      <View pointerEvents="none" style={[styles.eventInner, ...inset]}>
        {tight ? (!!times && (<View style={styles.tightTimes}>
              {!!startText && <Text style={[styles.tightText, { color }]} numberOfLines={1}>{startText}</Text>}
              {!!endText && <Text style={[styles.tightText, { color }]} numberOfLines={1}>{endText}</Text>}</View>)
        ) : (<>
            {!!startText && <Text style={[styles.eventTime, { color, top: 3 }]} numberOfLines={1}>{startText}</Text>}
            {!!endText && <Text style={[styles.eventTime, { color, bottom: 3 }]} numberOfLines={1}>{endText}</Text>}
          </>)}
        <View style={styles.eventBody}>
          <FitText style={[styles.eventText, styles.eventTitle, { color }, tight && styles.tightTitle]} numberOfLines={tight || detailLines ? 1 : 2} adjustsFontSizeToFit={tight} minimumFontScale={0.6}>
            {ev.important ? `${SHAPE_GLYPHS[ev.shape ?? "star"]} ` : ""}{ev.title}{ev.repeat !== "none" ? " ↻" : ""}{detailLines || (tight && detail.length) ? "" : progress(ev, selKey)}</FitText>
          {tight && detail.length > 0 && <Detail text={detail.join(" · ")} color={color} style={styles.tightText} size={8} />}
          {detailLines === 2
            ? detail.map((d) => <Detail key={d} text={d} color={color} style={styles.eventDetail} size={10} />)
            : detailLines === 1 && <Detail text={detail.join(" · ")} color={color} style={styles.eventDetail} size={10} />}</View></View></View>);});
// The colored block of one event and its touch handling. Memoized like EventLabel.
const EventBlock = memo(function EventBlock({ ev, column, top, height, left, width, dragging, shift, grip, onEdit, onHold, onDragBegin, onDragMove, onDragEnd, onTouchEnd }: {
  ev: CalEvent; column: number; top: number; height: number; left: string; width: string; dragging: boolean; shift: number | null; grip: boolean;
  onEdit: (ev: CalEvent) => void; onHold: (ev: CalEvent) => void;
  onDragBegin: (ev: CalEvent, mode: "move" | "resize", column: number) => void; onDragMove: (dx: number, dy: number) => void; onDragEnd: () => void; onTouchEnd: () => void;
}) {
  const place = [shift !== null && { transform: [{ translateX: shift }] }, { top, height, left, width }];
  return (<DragBlock
      onTap={() => onEdit(ev)}
      onHold={() => onHold(ev)}
      onBegin={() => onDragBegin(ev, "move", column)}
      onMove={onDragMove}
      onEnd={onDragEnd}
      onRelease={onTouchEnd}
      a11y={`Edit ${ev.title}. Drag to move it, or hold for more.`}
      ink={inkOn(ev.color)}
      hitSlop={height < MINI ? { top: (MINI - height) / 2, bottom: (MINI - height) / 2 } : undefined} // short blocks stay easy to grab
      style={[styles.eventBlock, height < 40 && styles.eventBlockShort, height < MINI && { paddingVertical: 0 }, dragging && styles.eventDragging, { backgroundColor: ev.color }, edgeOn(ev.color, PANEL), ...place]}>
      {grip && (height >= MINI || dragging) && <ResizeGrip ink={inkOn(ev.color)} onTap={() => onEdit(ev)} onBegin={() => onDragBegin(ev, "resize", column)} onMove={onDragMove} onEnd={onDragEnd} onRelease={onTouchEnd} />}</DragBlock>);});
// Where in the pressed element the finger was, from the top. The web's press events don't carry locationY, so it's worked out
// from the element's position there.
function pressY(e: any) {
  let y = e?.nativeEvent?.locationY;
  if (!Number.isFinite(y) && IS_WEB) {
    const r = e?.currentTarget?.getBoundingClientRect?.(), ne = e?.nativeEvent ?? {};
    const cy = ne.clientY ?? ne.changedTouches?.[0]?.clientY;
    y = r && Number.isFinite(cy) ? cy - r.top : 0;}
  return Number.isFinite(y) ? y : 0;}
// The tappable hour rows with their lines. Memoized: they don't change while dragging.
const HourRows = memo(function HourRows({ column, hourHeight, onAdd }: { column: number; hourHeight: number; onAdd: (hour: number, y: number) => void }) {
  return (<>
      {Array.from({ length: 12 }, (_, i) => {
        const hour = column * 12 + i;
        return (<Pressable key={hour} onPress={(e) => onAdd(hour, pressY(e))} accessibilityLabel={`Add event at ${formatTime(hour * 3600)}`} style={[styles.hourRow, { height: hourHeight }]}>
            <View style={{ width: LABEL_WIDTH }} />
            <View style={styles.hourLine} /></Pressable>);})}
    </>);});
// The outlined hour labels on top. Memoized: 12 labels × 9 Text views each.
const HourLabels = memo(function HourLabels({ column, hourHeight, exact }: { column: number; hourHeight: number; exact: number }) {
  return (<View style={[StyleSheet.absoluteFill, { zIndex: 10 }]} pointerEvents="none">
      {Array.from({ length: 12 }, (_, i) => {
        const hour = column * 12 + i;
        const label = CLOCK24 ? pad(hour) : `${hour % 12 || 12}${column === 0 ? "am" : "pm"}`;
        return (<View key={hour} style={{ position: "absolute", left: 0, top: i * hourHeight + 5 }}>
            {exact === i
              ? (<View style={styles.hourOn}><Text style={styles.hourOnText}>{label}</Text></View>)
              : <Text style={styles.hourLabel}>{label}</Text>}</View>);})}</View>);});
// Memoized: typing in the editor doesn't redraw the timeline.
const Column = memo(function Column({ column, areaW, onMore, selKey, hourHeight, layout, now, showTimes, showInfo, drag, dragShift, placing, onAdd, onEdit, onHold, onDragBegin, onDragMove, onDragEnd, onTouchEnd }: {
  column: number; areaW: number; onMore: (events: CalEvent[]) => void; selKey: string; hourHeight: number; layout: Layout; now: Now | null; showTimes: boolean; showInfo: boolean; // areaW: width of the event area, in points
  drag: { id: string; mode: "move" | "resize"; col: number } | null; dragShift: number; // dragShift: how far a moved event is nudged sideways into the other column
  placing: boolean; // choosing where to put a copy: events ignore touches so you can tap anywhere
  onAdd: (hour: number, y: number) => void; onEdit: (ev: CalEvent) => void; onHold: (ev: CalEvent) => void;
  onDragBegin: (ev: CalEvent, mode: "move" | "resize", column: number) => void; onDragMove: (dx: number, dy: number) => void; onDragEnd: () => void;
  onTouchEnd: () => void; // a finger left an event (lets the page swipe again)
}) {
  const colStart = column * 43200; // seconds
  // Where each event is drawn in this column.
  const geo = [];
  for (const { ev, lane, lanes, span } of layout.placed) {
    // A moved event stays in the column where the drag began (so the gesture isn't lost) and is drawn wherever it's now.
    const moving = drag?.id === ev.id && drag.mode === "move";
    if (moving && drag.col !== column) continue;
    const cs = moving ? (ev.start >= 43200 ? 43200 : 0) : colStart;
    const ce = cs + 43200;
    const segStart = Math.max(ev.start, cs); // the part of the event in this column (exact, for the times written on it)
    const segEnd = Math.min(ev.start + ev.duration, ce);
    const [ds, de] = layout.spans.get(ev.id)!; // and the part of its snapped block
    const drawStart = Math.max(ds, cs), drawEnd = Math.min(de, ce);
    if (segEnd <= segStart || drawEnd <= drawStart) continue;
    const height = Math.max(((drawEnd - drawStart) / 3600) * hourHeight, MIN_BLOCK);
    const top = ((drawStart - cs) / 3600) * hourHeight + LINE_OFFSET;
    const l = (lane / lanes) * areaW, r = ((lane + span) / lanes) * areaW;
    geo.push({ ev, cs, ce, segStart, segEnd, height, top, moving, l, r, lane, lanes, span, labels: miniLabels(ev, startLabel(ev, segStart, showTimes, true)) });}
  // Labels of short and narrow events are chosen here, together, so they don't land on each other. First, the space that text
  // inside blocks already uses (where tags mustn't go): the title side of each block, and its times on the left.
  const picked = new Map<string, string>(); // event id -> the label it shows
  const taken: { t: number; b: number; l: number; r: number }[] = [];
  const fits = (labels: string[], room: number, size: number) => labels.find((x) => textW(x, size) <= room) ?? labels[labels.length - 1];
  const narrow = new Map<string, { mode: "wrap" | "upright"; w: number }>();
  const tagged = new Set<string>(); // events whose label goes in a tag: thin ones, and short ones whose label won't fit inside
  for (const g of geo) {
    const w = g.r - g.l, b = g.top + g.height, cy = g.top + g.height / 2;
    if (g.height < SLIVER) { tagged.add(g.ev.id); continue; }
    if (w < NARROW && g.height >= MINI) { // thin side-by-side block: wrap a small label if it fits, else run it up the bar
      const lines = wrapLines(g.height), wrap = g.labels.find((x) => Math.ceil(textW(x, 8) / (w - 6)) <= lines);
      const upright = !wrap && g.height > w;
      narrow.set(g.ev.id, { mode: upright ? "upright" : "wrap", w });
      picked.set(g.ev.id, wrap ?? (upright ? fits(g.labels, g.height - 6, 9) : g.labels[g.labels.length - 1]));
      taken.push({ t: g.top, b, l: g.l, r: g.r });
    } else if (g.height < MINI) { // one line, right-aligned; if even the shortest label won't fit inside, it gets a tag instead
      const label = fits(g.labels, w - 10, 8);
      if (textW(label, 8) > w - 10) { tagged.add(g.ev.id); continue; }
      picked.set(g.ev.id, label);
      taken.push({ t: cy - 5, b: cy + 5, l: Math.max(g.l, g.r - 5 - textW(label, 8)), r: g.r - 5 });
    } else { // the block's own text: title and details centered on the right, times on the left (as EventLabel draws them)
      const tight = g.height < 40, endAt = g.ev.start + g.ev.duration;
      const start = startLabel(g.ev, g.segStart, showTimes);
      const end = showTimes && endAt === g.segEnd && (g.segEnd % 3600 !== 0 || g.segEnd === g.ce) ? shortTime(endAt) : "";
      const timeW = start || end ? Math.max(start.length, end.length) * 5 + 10 : 0;
      const info = showInfo ? blockInfo(g.ev, selKey) : null, details = [info?.reminder, info?.sequence].filter(Boolean) as string[];
      const bodyH = tight ? 11 + (details.length ? 9 : 0) : details.length ? 13 + (g.height >= 58 ? details.length : 1) * 11 : 26;
      const span = Math.max(textW(`${g.ev.important ? "★ " : ""}${g.ev.title} ↻`, tight ? 9 : 10), ...details.map((d) => textW(d, 9)));
      taken.push({ t: cy - bodyH / 2, b: cy + bodyH / 2, l: Math.max(g.l + timeW, g.r - 5 - span), r: g.r - 5 });
      if (tight && timeW) { const th = (start ? 8 : 0) + (end ? 8 : 0); taken.push({ t: cy - th / 2, b: cy + th / 2, l: g.l + 4, r: g.l + timeW }); }
      if (!tight && start) taken.push({ t: g.top + 3, b: g.top + 14, l: g.l + 4, r: g.l + timeW });
      if (!tight && end) taken.push({ t: b - 14, b: b - 3, l: g.l + 4, r: g.l + timeW });}}
  // "+N" blocks for folded events (see layoutEvents).
  const mores = layout.more.flatMap((m) => {
    const a = Math.max(m.start, colStart), b = Math.min(m.end, colStart + 43200);
    if (b <= a) return [];
    const top = ((a - colStart) / 3600) * hourHeight + LINE_OFFSET, height = ((b - a) / 3600) * hourHeight;
    const l = (m.lane / m.lanes) * areaW, r = ((m.lane + 1) / m.lanes) * areaW;
    taken.push({ t: top, b: top + height, l, r });
    return [{ ...m, top, height, l, r }];});
  // Then the tags, top to bottom, by fixed rules, so nothing overlaps and every tag stays level with its bar:
  //   1. a tag sits at the right end of its lane, unless the tag just above would touch it: then at the left end (they zigzag).
  //      Bars snap to a grid at least half a tag tall, so a tag can only ever meet the tag right above or below it, never two
  //      rows away: two sides are always enough.
  //   2. two tags sharing a row share its width: both step down together (the time goes first, then the marks) until they fit.
  //   3. if even their titles can't both fit, the later one folds into the earlier, which reads "Meds +1" and lists them when
  //      tapped. (So is a tag that would meet tags on both sides.) A readable title and a count beat two titles cut in half.
  //   4. other events' text in the row is stepped around the same way; with no tag to fold into, a tag left with too little
  //      room shows the most of its title that fits, or nothing if that's under 24pt (its bar can still be tapped).
  const tags = new Map<string, { x: number; y: number; w: number }>();
  const groups = new Map<string, CalEvent[]>(); // a tag's event id -> the events folded into it (that one first)
  const tagRects = new Map<string, (typeof taken)[number] & { side: "l" | "r" }>(); // each tag's entry in `taken`, and its side
  const geoOf = new Map(geo.map((g) => [g.ev.id, g]));
  const setTag = (id: string, label: string, t: number, l: number, w: number, side: "l" | "r") => {
    const rect = tagRects.get(id) ?? { t, b: t + TAG_H, l: 0, r: 0, side };
    if (!tagRects.has(id)) { tagRects.set(id, rect); taken.push(rect); }
    Object.assign(rect, { l, r: l + w, side });
    picked.set(id, label);
    tags.set(id, { x: l, y: t, w });};
  // The room a tag has on one side of [lo, hi] at row t: from that edge to the nearest thing in the way (3pt clear), ignoring `skip`.
  const roomAt = (t: number, lo: number, hi: number, side: "l" | "r", skip?: object) => {
    let a = lo, b = hi;
    for (const o of taken) if (o !== skip && o.t < t + TAG_H && o.b > t && o.r > lo && o.l < hi) {
      if (side === "r") a = Math.max(a, o.r + 3); else b = Math.min(b, o.l - 3);}
    return { a, b };};
  const longest = (labels: string[], room: number) => labels.find((x) => tagWidth(x) <= room);
  for (const g of geo.filter((x) => tagged.has(x.ev.id)).sort((x, y) => x.top + x.height / 2 - (y.top + y.height / 2))) {
    const t = g.top + g.height / 2 - TAG_H / 2;
    const near = [...tagRects].filter(([, o]) => o.t < t + TAG_H && o.b > t && o.l < g.r && o.r > g.l);
    const sides = new Set(near.map(([, o]) => o.side));
    if (sides.size < 2) {
      const side = sides.has("r") ? "l" : "r";
      let { a, b } = roomAt(t, g.l, g.r, side);
      let label = longest(g.labels, b - a);
      if (!label && near.length) { // share the row: shorten the neighbor as little as possible so this one fits
        const [nid, rect] = near[0], n = geoOf.get(nid)!;
        // Both step down together (time, then marks), so neither keeps more than the other while the other loses its title.
        const pairs = g.labels.flatMap((_, i) => n.labels.map((_, j) => [i, j])).sort((p, q) => Math.max(...p) - Math.max(...q) || p[0] + p[1] - q[0] - q[1]);
        for (const [i, j] of pairs) {
          const tw = tagWidth(n.labels[j]), nl = rect.side === "r" ? rect.r - tw : rect.l;
          const room = side === "l" ? nl - 3 - a : b - (nl + tw + 3);
          if (tagWidth(g.labels[i]) <= room) { setTag(nid, n.labels[j], rect.t, nl, tw, rect.side); label = g.labels[i]; break; }}
        ({ a, b } = roomAt(t, g.l, g.r, side));}
      const room = b - a;
      if (!label && !near.length && room >= 24) label = g.labels[g.labels.length - 1]; // only text in the way: cut to the room there is
      if (label) { const w = Math.min(tagWidth(label), room); setTag(g.ev.id, label, t, side === "r" ? b - w : a, w, side); continue; }
      if (!near.length) continue;}
    // Fold into the nearer tag in the way, which keeps as much of its label as fits beside the count.
    const [hid, rect] = near.sort(([, p], [, q]) => Math.abs(p.t - t) - Math.abs(q.t - t))[0], h = geoOf.get(hid)!;
    const group = groups.get(hid) ?? [h.ev];
    group.push(g.ev);
    groups.set(hid, group);
    const { a, b } = roomAt(rect.t, h.l, h.r, rect.side, rect);
    const label = [...h.labels.map((x) => `${x} +${group.length - 1}`), `+${group.length}`].find((x) => tagWidth(x) <= b - a) ?? `+${group.length}`;
    const w = Math.min(tagWidth(label), b - a);
    setTag(hid, label, rect.t, rect.side === "r" ? b - w : a, w, rect.side);}
  const texts: React.ReactNode[] = []; // event text, drawn above the current-time line
  const blocks: React.ReactNode[] = [];
  for (const { ev, ce, segStart, segEnd, height, top, moving, lane, lanes, span } of geo) {
    const left = `${(lane / lanes) * 100}%`, width = `${(span / lanes) * 100}%`;
    const dragged = drag?.id === ev.id;
    const shift = moving ? dragShift : null;
    const tag = tags.get(ev.id);
    texts.push(<EventLabel key={ev.id} ev={ev} selKey={selKey} top={top} height={height} left={left} width={width} segStart={segStart} segEnd={segEnd} ce={ce} showTimes={showTimes} showInfo={showInfo} raised={dragged} shift={shift} narrowMode={narrow.get(ev.id)?.mode} narrowW={narrow.get(ev.id)?.w} text={picked.get(ev.id)} tagX={tag?.x} tagY={tag?.y} tagW={tag?.w} />);
    blocks.push(<EventBlock key={ev.id} ev={ev} column={column} top={top} height={height} left={left} width={width} dragging={dragged} shift={shift}
      grip={ev.start + ev.duration === segEnd || (dragged && drag!.col === column)}
      onEdit={onEdit} onHold={onHold} onDragBegin={onDragBegin} onDragMove={onDragMove} onDragEnd={onDragEnd} onTouchEnd={onTouchEnd} />);}
  return (<View style={[styles.timeColumn, drag?.col === column && { zIndex: 30 }]}>
      <HourRows column={column} hourHeight={hourHeight} onAdd={onAdd} />
      <View style={styles.eventLayer} pointerEvents={placing ? "none" : "box-none"}>{blocks}
        {[...groups].map(([id, evs]) => { const tg = tags.get(id)!;
          return <Pressable key={`group-${id}`} onPress={() => onMore(evs)} accessibilityLabel={`${evs.length} events. Show them.`} style={{ position: "absolute", left: tg.x, top: tg.y, width: tg.w, height: TAG_H }} />;})}
        {mores.map((m) => (<Pressable key={`more-${m.start}`} onPress={() => onMore(m.events)} accessibilityLabel={`${m.events.length} more events. Show them.`}
            style={[styles.moreBlock, { top: m.top, height: m.height, left: m.l, width: m.r - m.l }]}>
            <Text style={[styles.moreText, m.height < MINI && { fontSize: 8, lineHeight: 9 }]} numberOfLines={1}>+{m.events.length}</Text>
            {m.height >= 26 && (<View style={styles.moreDots}>
                {m.events.slice(0, 6).map((e) => <View key={e.id} style={[styles.moreDot, { backgroundColor: e.color }]} />)}</View>)}</Pressable>))}</View>
      {now?.column === column && (<View pointerEvents="none" style={[styles.currentTimeLine, { top: now.offset }]}>
          <View style={styles.currentTimeDot} />
          <View style={styles.currentTimeRule} />
          {now.exact < 0 && (<View style={[styles.currentTimeLabel, now.below ? { top: 4 } : { bottom: 4 }]}>
              <FitText style={styles.currentTimeText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{now.label}</FitText></View>)}</View>)}
      <View style={[styles.eventLayer, { zIndex: 7 }]} pointerEvents="none">{texts}</View>
      <HourLabels column={column} hourHeight={hourHeight} exact={now?.column === column ? now.exact : -1} /></View>);});
type SheetProps = {
  draft: Draft; isSeries: boolean; customColors: string[];
  onAddColor: (color: string) => void; onDeleteColor: (color: string) => void;
  onChange: (patch: Partial<Draft>) => void;
  onSave: () => void; onDelete: () => void; onSkip: () => void; onClose: () => void;};
// Mounted only while an event is open, so the Starts/Length tab resets each time.
function Sheet({ draft, isSeries, customColors, onAddColor, onDeleteColor, onChange, onSave, onDelete, onSkip, onClose }: SheetProps) {
  const [picker, setPicker] = useState<"start" | "length" | "until">("start");
  const [view, setView] = useState<"main" | "steps" | "alert" | "color">("main");
  const [target, setTarget] = useState<"color" | "markColor">("color"); // which color the picker page is editing
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hsv, setHsv] = useState<[number, number, number]>(() => hexToHsv(draft.color));
  const [atab, setAtab] = useState<"notify" | "repeat" | "from" | "until" | "sound">("notify");
  const setStart = (t: number) => {
    const start = clamp(t, 0, 86399);
    onChange({ start, duration: Math.min(draft.duration, 86400 - start) });};
  const setLength = (t: number) => onChange({ duration: clamp(t, 1, 86400 - draft.start) });
  // Tapping a day switches repeat to "days". While greyed out, the first tap on an already-picked day just wakes the row up.
  const toggleDay = (d: number) => {
    const picked = draft.days.includes(d);
    if (draft.repeat !== "days") onChange({ repeat: "days", days: picked ? draft.days : [...draft.days, d] });
    else {
      const days = picked ? draft.days.filter((x) => x !== d) : [...draft.days, d];
      onChange(days.length ? { days } : { days, repeat: "none" }); // none left: back to Never
    }};
  // Tapping the other chip switches to it. Tapping the active one deselects it: picked days take over, or with none picked Never and Daily swap.
  const pickRepeat = (r: RepeatKind) => {
    if (r !== draft.repeat) onChange({ repeat: r });
    else if (draft.days.length) onChange({ repeat: "days" });
    else onChange({ repeat: r === "none" ? "daily" : "none" });};
  // Which chip is lit: any interval lights the "Every [n] days" chip.
  const chip: RepeatChip = draft.repeat === "interval" ? "every" : draft.repeat;
  const pickChip = (c: RepeatChip) => {
    if (c !== "every") return pickRepeat(c);
    if (c === chip) return onChange({ repeat: "none" }); // tapping the lit interval chip turns repeating off
    onChange({ repeat: "interval", interval: (draft.interval ?? 0) >= 2 ? draft.interval : 2 });};
  // Typing (or tapping into) the box inside the chip also switches the repeat to it.
  const setInterval_ = (t: string) => {
    const n = parseInt(t.replace(/[^0-9]/g, "").slice(0, 3), 10);
    onChange({ repeat: "interval", interval: Number.isFinite(n) ? n : 0 });}; // 0 while the box is empty
  const focusInterval = () => { if (draft.repeat !== "interval") onChange({ repeat: "interval", interval: (draft.interval ?? 0) >= 1 ? draft.interval : 2 }); };
  const repeating = draft.repeat !== "none";
  const active = picker === "until" && !repeating ? "start" : picker;
  const untilLabel =
    draft.endMode === "never" ? "Never"
    : draft.endMode === "days" ? plural(draft.endDays, "day")
    : parseKey(draft.until ?? draft.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const tabs: ["start" | "length" | "until", string, string][] = [
    ["start", "Starts", formatTime(draft.start, true)],
    ["length", "Length", formatDuration(draft.duration)],
    ...(repeating ? [["until", "Repeats until", untilLabel] as ["until", string, string]] : []),];
  const setStep = (id: string, text: string) =>
    onChange({ steps: draft.steps.map((st) => (st.id === id ? { ...st, text } : st)) });
  const addStep = () => {
    const id = newId();
    setFocusId(id);
    onChange({ steps: [...draft.steps, { id, text: "" }] });};
  const palette = [...EVENT_COLORS, ...customColors];
  const confirmDeleteColor = (c: string) =>
    Alert.alert("Delete this color?", "Events that already use it keep it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => onDeleteColor(c) },]);
  const filled = draft.steps.filter((st) => st.text.trim() || st.media?.length).length;
  const [linkFor, setLinkFor] = useState<string | null>(null); // step whose link box is open
  const [link, setLink] = useState("");
  const [viewer, setViewer] = useState<Media | null>(null);
  const lastTap = useRef({ color: "", at: 0 });
  // Tapping a color picks it; tapping an unsaved one twice quickly adds it to your colors.
  const tapColor = (c: string, key: "color" | "markColor") => {
    const now = Date.now();
    if (lastTap.current.color === c && now - lastTap.current.at < 350 && !palette.includes(c)) onAddColor(c);
    lastTap.current = { color: c, at: now };
    onChange({ [key]: c });};
  // The scrolling color frame, for the event's color or its marker's color. Unsaved picks stay visible at the end.
  const swatches = (key: "color" | "markColor") => {
    const cur = draft[key];
    const list = cur && !palette.includes(cur) ? [...palette, cur] : palette;
    return (<>
        <ScrollView style={styles.colorFrame} contentContainerStyle={styles.colorRow} nestedScrollEnabled>
          {key === "markColor" && <Chip label="Event color" a11y="Marker uses the event color" active={!cur} onPress={() => onChange({ markColor: undefined })} />}
          {list.map((c) => (<HoldPressable
              key={c}
              ink={inkOn(c)}
              onPress={() => tapColor(c, key)}
              onLongPress={customColors.includes(c) ? () => confirmDeleteColor(c) : undefined}
              accessibilityLabel={customColors.includes(c) ? "Saved color. Hold to delete." : "Pick color"}
              style={[styles.colorChip, { backgroundColor: c }, edgeOn(c, PANEL), cur === c && { borderColor: inkOn(c), transform: [{ scale: 1.15 }] }]}>
              {cur === c && <Text style={[styles.colorCheck, { color: inkOn(c) }]}>✓</Text>}</HoldPressable>))}
          <Pressable onPress={() => { setHsv(hexToHsv(cur ?? draft.color)); setTarget(key); setView("color"); }} accessibilityLabel="Add a custom color" style={[styles.colorChip, styles.customChip]}>
            <Text style={styles.customPlus}>+</Text></Pressable></ScrollView>
        {!!cur && !palette.includes(cur) && <Text style={styles.detailMeta}>Double-tap the new color to add it to your colors.</Text>}
      </>);};
  const setMedia = (id: string, fn: (m: Media[]) => Media[]) => onChange({ steps: draft.steps.map((st) => (st.id === id ? { ...st, media: fn(st.media ?? []) } : st)) });
  const addPicked = async (id: string) => { const got = await pickMedia(); if (got.length) setMedia(id, (m) => [...m, ...got]); };
  const addLink = (id: string) => {
    if (!youtubeId(link)) return Alert.alert("YouTube link", "Paste a youtube.com or youtu.be link.");
    setMedia(id, (m) => [...m, { id: newId(), kind: "youtube", uri: link.trim() }]);
    setLink(""); setLinkFor(null);};
  const alertLabel =
    draft.alert === undefined ? "None" : alertText(draft.alert, draft.alertAfter);
  const alertRow = alertLabel + (draft.alert !== undefined && draft.nag ? " · repeats" : "");
  if (view === "color") {
    const [h, sat, val] = hsv;
    const cur = (target === "markColor" ? draft.markColor : undefined) ?? draft.color;
    const set = (next: [number, number, number]) => { setHsv(next); onChange({ [target]: hsvToHex(...next) }); };
    const setColor = (hex: string) => { setHsv(hexToHsv(hex)); onChange({ [target]: hex }); };
    const saved = EVENT_COLORS.includes(cur) || customColors.includes(cur);
    const rgb = [16, 8, 0].map((sh) => (parseInt(cur.slice(1), 16) >> sh) & 255);
    const light = val * (1 - sat / 2); // HSL lightness
    const hsl = [h, light === 0 || light === 1 ? 0 : (val - light) / Math.min(light, 1 - light), light];
    const digits = (t: string) => t.replace(/\D/g, "").slice(0, 3);
    // One row of three number boxes: [label, current value, max, set].
    const row = (key: string, boxes: [string, number, number, (n: number) => void][]) => (<View key={key} style={styles.fieldRow}>
        {boxes.map(([label, value, max, commit]) => <Field key={label} label={label} value={String(Math.round(value))} sanitize={digits} onCommit={(t) => commit(Math.min(max, Number(t)))} />)}</View>);
    const setRgb = (i: number, n: number) => setColor("#" + rgb.map((x, k) => (k === i ? n : x).toString(16).padStart(2, "0")).join("").toUpperCase());
    const setHsvAt = (i: number, n: number) => { const next: [number, number, number] = [h, sat, val]; next[i] = i === 0 ? n : n / 100; set(next); };
    const setHslAt = (i: number, n: number) => {
      const x = [...hsl]; x[i] = i === 0 ? n : n / 100;
      const v = x[2] + x[1] * Math.min(x[2], 1 - x[2]);
      set([x[0], v ? 2 * (1 - x[2] / v) : 0, v]);};
    return (<SheetBox key="color" tall onDismiss={() => setView("main")} footer={<View style={styles.buttonRow}>{!saved && <Btn kind="cancel" label="Add to my colors" onPress={() => onAddColor(cur)} />}<Btn kind="save" label="Done" onPress={() => setView("main")} /></View>}>
        <Text style={styles.sheetTitle}>{target === "markColor" ? "Marker color" : "Color"}</Text>
        <View style={styles.pickerRow}>
          <SvSquare hue={h} sat={sat} val={val} onChange={(x, y) => set([h, x, y])} />
          <HueBar hue={h} onChange={(nh) => set([nh, sat, val])} /></View>
        <View style={styles.colorPreviewRow}>
          <View style={[styles.colorPreview, { backgroundColor: cur }]} />
          <Field label="HEX" text value={cur.slice(1)} sanitize={(t) => t.replace(/[^0-9a-fA-F]/g, "").slice(0, 6).toUpperCase()} onCommit={(t) => t.length === 6 && setColor(`#${t}`)} /></View>
        {row("rgb", [["R", rgb[0], 255, (n) => setRgb(0, n)], ["G", rgb[1], 255, (n) => setRgb(1, n)], ["B", rgb[2], 255, (n) => setRgb(2, n)]])}
        {row("hsv", [["H", h, 360, (n) => setHsvAt(0, n)], ["S", sat * 100, 100, (n) => setHsvAt(1, n)], ["V", val * 100, 100, (n) => setHsvAt(2, n)]])}
        {row("hsl", [["H", hsl[0], 360, (n) => setHslAt(0, n)], ["S", hsl[1] * 100, 100, (n) => setHslAt(1, n)], ["L", hsl[2] * 100, 100, (n) => setHslAt(2, n)]])}</SheetBox>);}
  if (view === "alert") {
    const n = draft.nag;
    const on = draft.alert !== undefined;
    const setNag = (p: Partial<Nag>) => onChange({ nag: { ...(n ?? DEFAULT_NAG), ...p } });
    const need = (what: string) => <Text style={styles.detailMeta}>{what}</Text>;
    const tabs4: [typeof atab, string, string][] = [
      ["notify", "Notify", draft.alert === undefined ? "Off" : alertText(draft.alert, draft.alertAfter)],
      ["repeat", "Repeat", n && on ? `every ${formatDuration(n.every)}` : "Off"],
      ["from", "From", !n ? "-" : n.from === "alert" ? "Reminder" : n.from === "start" ? "Event start" : `${formatDuration(n.offset)} ${n.before ? "before" : "after"}`],
      ["until", "Until", !n ? "-" : n.until === "start" ? "Event starts" : n.until === "end" ? "Event ends" : `+${formatDuration(n.after)}`],
      ["sound", "Sound", draft.sound === "silent" ? "Silent" : draft.sound === "speak" ? "Speak" : draft.sound === "custom" ? "Yours" : "Default"],];
    return (<SheetBox key="alert" tall onDismiss={() => setView("main")} footer={<View style={styles.buttonRow}><Btn kind="save" label="Done" onPress={() => setView("main")} /></View>}>
        <Text style={styles.sheetTitle}>Reminder</Text>
        <Tabs value={atab} tabs={tabs4} onPick={setAtab} tight />
        {atab === "notify" && (<>
            {need("When you get the first notification, before or after the event starts. Set it to 0 to be notified at the start.")}
            <Choices value={on} options={[[false, "Off", "Reminder off"], [true, "On", "Reminder on"]]} onPick={(v) => onChange({ alert: v ? draft.alert ?? DEFAULT_ALERT : undefined })} />
            {on && <Choices value={!!draft.alertAfter} options={[[false, "Before start", "Notify before start"], [true, "After start", "Notify after start"]]} onPick={(alertAfter) => onChange({ alertAfter })} />}
            {on && <LengthPicker value={draft.alert!} onChange={(t) => onChange({ alert: clamp(t, 0, 86399) })} />}
          </>)}
        {atab === "sound" && (!on ? need("Turn the reminder on first (Notify tab).") : (<>
            {need("Pick what you hear. \"Read title\" speaks the event title aloud when the notification arrives while Yearline is open (and when you tap it); with the app closed, iPhone plays the normal sound instead.")}
            <Choices value={draft.sound ?? "default"} options={[["default", "Default sound", "Default sound"], ["silent", "Silent", "No sound"], ["speak", "Read title", "Read the title aloud"], ["custom", "Your sound", "Use your own sound"]]} onPick={async (sound) => { if (sound === "custom" && !draft.soundUri) { const got = await pickSound(); if (got) onChange({ sound, ...got }); } else onChange({ sound: sound as Sound }); }} />
            {draft.sound === "custom" && draft.soundUri && (<>
                {need(`${draft.soundName ?? "Your sound"}${draft.soundFile ? "" : " (plays when Yearline is open; for the lock screen use a .wav, .aiff or .caf file)"}`)}
                <Chip label="Hear it now" active={false} a11y="Preview your sound" onPress={() => playSound(draft.soundUri!, true)} />
                <Chip label="Choose a different file" active={false} a11y="Pick another sound file" onPress={async () => { const got = await pickSound(); if (got) onChange(got); }} />
              </>)}
            {draft.sound === "speak" && <Chip label="Hear it now" active={false} a11y="Preview reading the title" onPress={async () => { if (await Speech.isSpeakingAsync()) Speech.stop(); else Speech.speak(draft.title.trim() || "Untitled event"); }} />}
          </>))}
        {atab === "repeat" && (!on ? need("Turn the reminder on first (Notify tab).") : (<>
            {need("Keep notifying every hour, minute and second you choose.")}
            <Choices value={!!n} options={[[false, "Off", "Repeat off"], [true, "On", "Repeat on"]]} onPick={(v) => (v ? setNag({}) : onChange({ nag: undefined }))} />
            {n && <LengthPicker value={n.every} onChange={(t) => setNag({ every: clamp(t, 1, 86399) })} />}
          </>))}
        {atab === "from" && (!n || !on ? need("Turn on Repeat first.") : (<>
            {need("When the repeating starts.")}
            <Choices value={n.from} options={[["alert", "Reminder time", "Repeat from reminder"], ["start", "Event start", "Repeat from event start"], ["custom", "Custom", "Repeat from custom time"]]} onPick={(from) => setNag({ from })} />
            {n.from === "custom" && (<>
                <Choices value={n.before} options={[[true, "Before start", "Before event start"], [false, "After start", "After event start"]]} onPick={(before) => setNag({ before })} />
                <LengthPicker value={n.offset} onChange={(t) => setNag({ offset: clamp(t, 0, 86399) })} />
              </>)}
          </>))}
        {atab === "until" && (!n || !on ? need("Turn on Repeat first.") : (<>
            {need("When the repeating stops.")}
            <Choices value={n.until} options={[["start", "Event starts", "Stop when event starts"], ["end", "Event ends", "Stop when event ends"], ["after", "After it ends", "Stop after event ends"]]} onPick={(until) => setNag({ until })} />
            {n.until === "after" && <LengthPicker value={n.after} onChange={(t) => setNag({ after: clamp(t, 0, 86399) })} />}
            <Chip label="Stop when I tap it" a11y="Stop repeating when tapped" active={n.tap} onPress={() => setNag({ tap: !n.tap })} />
          </>))}</SheetBox>);}
  if (view === "steps") {
    return (<SheetBox key="steps" tall plain onDismiss={() => setView("main")} footer={<View style={styles.buttonRow}><Btn kind="cancel" label="Add step" onPress={addStep} /><Btn kind="save" label="Done" onPress={() => setView("main")} /></View>}>
        <Text style={styles.sheetTitle}>Sequence</Text>
        <Text style={styles.detailMeta}>List what to do, in order. Tap the event later to work through it.</Text>
        <ScrollView style={[styles.stepList, { maxHeight: undefined, flex: 1 }]} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets showsVerticalScrollIndicator={false}>
          {draft.steps.map((st, i) => (<View key={st.id} style={styles.stepBlock}>
            <View style={styles.stepRow}>
              <Text style={styles.stepNum}>{i + 1}</Text>
              <TextInput value={st.text} onChangeText={(t) => setStep(st.id, t)} placeholder="e.g. Squats 3 x 10" placeholderTextColor={MUTED} autoFocus={st.id === focusId} returnKeyType="done" style={styles.stepInput} />
              <Pressable onPress={() => onChange({ steps: draft.steps.filter((x) => x.id !== st.id) })} accessibilityLabel="Remove step" style={styles.stepRemove}>
                <Text style={styles.stepRemoveText}>✕</Text></Pressable></View>
            <MediaRow media={st.media} onOpen={(m) => openMedia(m, setViewer)} onRemove={(mid) => setMedia(st.id, (all) => all.filter((x) => x.id !== mid))} />
            <View style={styles.mediaButtons}>
              <Chip label="＋ Photo / video" a11y="Add photo or video" active={false} onPress={() => addPicked(st.id)} />
              <Chip label="＋ YouTube link" a11y="Add YouTube link" active={linkFor === st.id} onPress={() => { setLink(""); setLinkFor(linkFor === st.id ? null : st.id); }} /></View>
            {linkFor === st.id && (<View style={styles.linkRow}>
                <TextInput value={link} onChangeText={setLink} placeholder="https://youtu.be/..." placeholderTextColor={MUTED} autoFocus autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="done" onSubmitEditing={() => addLink(st.id)} style={styles.stepInput} />
                <Chip label="Add" a11y="Add link" active onPress={() => addLink(st.id)} /></View>)}</View>))}</ScrollView>
        <MediaViewer media={viewer} onClose={() => setViewer(null)} /></SheetBox>);}
  return (<SheetBox key="main" tall onDismiss={onClose} footer={<View style={styles.buttonRow}>{draft.id ? (<><Btn kind="delete" label={isSeries ? "Delete all" : "Delete"} onPress={onDelete} />{isSeries && <Btn kind="cancel" label="Skip day" onPress={onSkip} />}</>) : (<Btn kind="cancel" label="Cancel" onPress={onClose} />)}<Btn kind="save" label="Save" onPress={onSave} /></View>}>
      <Text style={styles.sheetTitle}>{draft.id ? "Edit event" : "New event"}</Text>
      <TextInput value={draft.title} onChangeText={(title) => onChange({ title })} placeholder="Title" placeholderTextColor={MUTED} returnKeyType="done" style={styles.input} />
      <Tabs value={active} tabs={tabs} onPick={setPicker} />
      {active === "start" && <StartPicker value={draft.start} onChange={setStart} />}
      {active === "length" && <LengthPicker value={draft.duration} onChange={setLength} />}
      {active === "until" && <EndPicker draft={draft} onChange={onChange} />}
      <Text style={styles.endsText}>Ends {formatTime(draft.start + draft.duration, true)}</Text>
      <Text style={styles.rowLabel}>Repeat</Text>
      <View style={[styles.chips, styles.chipsWrap]}>
        {REPEATS.map(([v, label, a11y]) => <Chip key={v} label={label} a11y={a11y} active={chip === v} dim={draft.repeat === "days"} onPress={() => pickChip(v)} />)}
        <EveryChip active={chip === "every"} dim={draft.repeat === "days"} interval={draft.interval} onPress={() => pickChip("every")} onFocus={focusInterval} onChangeText={setInterval_} /></View>
      <View style={styles.dayChips}>
        {[0, 1, 2, 3, 4, 5, 6].map((k) => (k + WEEK_START) % 7).map((d) => (<Chip key={d} round label={DAY_LETTERS[d]} a11y={DAYS[d]} active={draft.days.includes(d)} dim={draft.repeat !== "days"} onPress={() => toggleDay(d)} />))}</View>
      {repeating && (<>
          <Text style={styles.rowLabel}>Repeats from</Text>
          <Choices value={!!draft.always} options={[[false, "Starting now", "Repeat starting from this event's day"], [true, "All time", "Repeat on every matching day, past days too"]]} onPick={(always) => onChange({ always })} />
        </>)}
      <Pressable onPress={() => setView("alert")} accessibilityLabel="Edit reminder" style={styles.seqRow}>
        <Text style={styles.seqRowText}>Reminder</Text>
        <Text style={styles.seqRowValue}>{alertRow}  ›</Text></Pressable>
      <Pressable onPress={() => onChange({ important: !draft.important })} accessibilityLabel="Toggle important" style={styles.seqRow}>
        <Text style={styles.seqRowText}>Important</Text>
        <Text style={[styles.seqRowValue, draft.important && styles.starOn]}>{draft.important ? "Shown on the month" : "Off"}</Text></Pressable>
      {draft.important && (<>
          <View style={styles.shapeRow}>
            {SHAPE_KINDS.map((k) => (<Pressable key={k} onPress={() => onChange({ shape: k })} accessibilityLabel={`${k} marker`} style={[styles.shapeChip, (draft.shape ?? "star") === k && styles.chipOn]}>
                <Shape kind={k} color={draft.markColor ?? draft.color} size={20} /></Pressable>))}</View>
          {swatches("markColor")}
        </>)}
      <Pressable onPress={() => setView("steps")} accessibilityLabel="Edit sequence" style={styles.seqRow}>
        <Text style={styles.seqRowText}>Sequence</Text>
        <Text style={styles.seqRowValue}>{filled ? plural(filled, "step") : "None"}  ›</Text></Pressable>
      {swatches("color")}
      {customColors.length > 0 && <Text style={styles.detailMeta}>Hold one of your saved colors to delete it.</Text>}</SheetBox>);}
export default function App() {
  return (<SafeAreaProvider>
      <Root /></SafeAreaProvider>);}
type Tab = "home" | "themes" | "settings";
const TABS: [Tab, string][] = [["themes", "Themes"], ["home", "Home"], ["settings", "Settings"]];
// Tab icons, drawn on a 24x24 grid.
// The tab bar icons (their colors come from the palette, so they already read on the tab bar).
function TabIcon({ tab, color }: { tab: Tab; color: string }) {
  const stroke = { stroke: color, strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", fill: "none" } as const;
  return (<Svg width={24} height={24} viewBox="0 0 24 24">
      {tab === "home" && (<>
          <Path d="M3 11.5 12 4l9 7.5" {...stroke} />
          <Path d="M5.5 10v9.5h4.5v-5.5h4v5.5h4.5V10" {...stroke} />
        </>)}
      {tab === "themes" && (<>
          <Circle cx={12} cy={12} r={8.5} {...stroke} />
          <Path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill={color} />
        </>)}
      {tab === "settings" && (<>
          <Circle cx={12} cy={12} r={3} {...stroke} />
          <Circle cx={12} cy={12} r={6.6} {...stroke} />
          {Array.from({ length: 8 }, (_, i) => {
            const a = (i * Math.PI) / 4, x = Math.cos(a), y = Math.sin(a);
            return <Line key={i} x1={12 + x * 6.6} y1={12 + y * 6.6} x2={12 + x * 9.6} y2={12 + y * 9.6} {...stroke} strokeWidth={2.6} strokeLinecap="butt" />;})}
        </>)}</Svg>);}
function Root() {
  const insets = useSafeAreaInsets();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [customs, setCustoms] = useState<Theme[]>([]);
  const [reload, setReload] = useState(0); // bumping this remounts the pages, so they reload from storage
  useEffect(() => {
    Promise.all([AsyncStorage.getItem(PREFS_KEY), AsyncStorage.getItem(THEMES_KEY)])
      .then(([raw, themes]) => { CUSTOM = themes ? JSON.parse(themes) : []; setCustoms(CUSTOM); setPrefs({ ...DEFAULT_PREFS, ...(raw ? JSON.parse(raw) : {}) }); })
      .catch(() => setPrefs(DEFAULT_PREFS));
  }, []);
  if (!prefs) return <View style={{ flex: 1, backgroundColor: "#000000" }} />;
  CUSTOM = customs;
  CLOCK24 = prefs.clock24;
  WEEK_START = prefs.weekStart;
  DEFAULT_ALERT = prefs.alertSeconds;
  if (THEME.id !== prefs.theme || !BG) applyTheme(prefs.theme); // before anything renders
  const update = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    AsyncStorage.setItem(PREFS_KEY, JSON.stringify(next)).catch(() => {});};
  const storeCustoms = (next: Theme[]) => { CUSTOM = next; setCustoms(next); AsyncStorage.setItem(THEMES_KEY, JSON.stringify(next)).catch(() => {}); };
  // Saving selects the theme, and rebuilds the styles in case it's the one already in use.
  const saveTheme = (t: Theme) => {
    storeCustoms(customs.some((c) => c.id === t.id) ? customs.map((c) => (c.id === t.id ? t : c)) : [...customs, t]);
    update({ theme: t.id });
    applyTheme(t.id);
    setReload((n) => n + 1);};
  const deleteTheme = (id: string) => { storeCustoms(customs.filter((c) => c.id !== id)); if (prefs.theme === id) update({ theme: "midnight" }); };
  async function wipe(keys: string[], cancelReminders: boolean) {
    await AsyncStorage.multiRemove(keys).catch(() => {});
    if (cancelReminders) { if (IS_WEB) clearWebTimers(); else await Notifications.cancelAllScheduledNotificationsAsync().catch(() => {}); }
    setReload((n) => n + 1);}
  return (<View key={`${prefs.theme}:${reload}:${prefs.clock24}:${prefs.weekStart}`} style={styles.container}>
      <StatusBar barStyle={lum(BG) > 0.4 ? "dark-content" : "light-content"} backgroundColor={BG} />
      <View style={styles.page}>
        <View style={[styles.page, tab !== "home" && styles.hidden]}>
          <Calendar prefs={prefs} /></View>
        {tab === "themes" && <ThemesPage current={prefs.theme} customs={customs} onPick={(id) => update({ theme: id })} onSave={saveTheme} onDelete={deleteTheme} />}
        {tab === "settings" && <SettingsPage prefs={prefs} onChange={update} onWipe={wipe} />}</View>
      <View style={[styles.tabBar, { height: Math.max(insets.top - ISLAND_BOTTOM_OFFSET, 34) }]}>
        {TABS.map(([id, label]) => (<Pressable key={id} onPress={() => setTab(id)} accessibilityRole="tab" accessibilityState={{ selected: tab === id }} accessibilityLabel={label} style={styles.tabItem}>
            <TabIcon tab={id} color={tab === id ? ORANGE : MUTED} /></Pressable>))}</View>
      <View pointerEvents="none" style={[styles.statusBackground, { height: insets.top - ISLAND_BOTTOM_OFFSET }]} />
      <AlertHost /></View>);}
// Draws Alert.alert on the web: a small card with the buttons stacked.
function AlertHost() {
  const [req, setReq] = useState<AlertRequest | null>(null);
  useEffect(() => { showWebAlert = setReq; return () => { if (showWebAlert === setReq) showWebAlert = null; }; }, []);
  if (!IS_WEB) return null;
  const cancel = req?.buttons.find((b) => b.style === "cancel");
  const pick = (b?: AlertButton) => { setReq(null); b?.onPress?.(); };
  return (<Modal visible={!!req} transparent animationType="fade" onRequestClose={() => pick(cancel)}>
      <View style={styles.alertRoot}>
        <Pressable style={styles.backdrop} onPress={() => pick(cancel)} accessibilityLabel="Close" />
        <View style={styles.alertBox}>
          <Text style={styles.alertTitle}>{req?.title}</Text>
          {!!req?.message && <Text style={styles.alertMessage}>{req.message}</Text>}
          {req?.buttons.map((b, i) => (<Pressable key={i} onPress={() => pick(b)} accessibilityRole="button" style={styles.alertButton}>
              <Text style={[styles.alertButtonText, b.style === "destructive" && { color: DANGER }, b.style === "cancel" && { color: MUTED, fontWeight: "600" }]}>{b.text ?? "OK"}</Text></Pressable>))}</View></View></Modal>);}
// Backups (web): everything Yearline saves, in one file you can keep in Files and restore later.
async function exportBackup() {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith("yearline:"));
    const pairs = await AsyncStorage.multiGet(keys);
    const json = JSON.stringify({ app: "yearline", version: 1, saved: new Date().toISOString(), data: Object.fromEntries(pairs) });
    const name = `yearline-backup-${dayKey(new Date())}.json`;
    const file = new (window as any).File([json], name, { type: "application/json" });
    const nav = navigator as any;
    if (nav.canShare?.({ files: [file] })) { await nav.share({ files: [file], title: "Yearline backup" }); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e: any) { if (e?.name !== "AbortError") Alert.alert("Backup failed", String(e?.message ?? e)); }}
function importBackup() {
  const input = document.createElement("input");
  input.type = "file"; input.accept = "application/json,.json";
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const parsed = JSON.parse(await f.text());
      if (parsed?.app !== "yearline" || typeof parsed.data !== "object") throw new Error("This isn't a Yearline backup file.");
      const entries = Object.entries(parsed.data as Record<string, string>).filter(([k, v]) => k.startsWith("yearline:") && typeof v === "string");
      Alert.alert("Restore this backup?", `From ${new Date(parsed.saved).toLocaleString()}. It replaces all your current events, themes and settings.`, [
        { text: "Cancel", style: "cancel" },
        { text: "Restore", style: "destructive", onPress: async () => {
          const old = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith("yearline:"));
          await AsyncStorage.multiRemove(old);
          await AsyncStorage.multiSet(entries);
          window.location.reload(); } },]);
    } catch (e: any) { Alert.alert("Couldn't restore", String(e?.message ?? e)); }};
  input.click();}
function PageHeader({ title }: { title: string }) {
  const insets = useSafeAreaInsets();
  return <Text style={[styles.pageTitle, { marginTop: insets.top - ISLAND_BOTTOM_OFFSET + GAP }]}>{title}</Text>;}
function ThemeCard({ t: theme, selected, onPress, onEdit }: { t: Theme; selected: boolean; onPress?: () => void; onEdit?: () => void }) {
  const t = { ...palette(theme), name: theme.name };
  return (<Pressable onPress={onPress} accessibilityLabel={`${t.name} theme`} style={[styles.themeCard, { backgroundColor: t.bg, borderColor: selected ? t.accent : t.line }]}>
      <View style={[styles.themePreview, { backgroundColor: t.panel, borderColor: t.line }]}>
        <View style={[styles.themeDot, { backgroundColor: t.accent }]} />
        <View style={[styles.themeBar, { backgroundColor: t.text }]} />
        <View style={[styles.themeBar, { backgroundColor: t.muted, width: 22 }]} /></View>
      <Text style={[styles.themeName, { color: t.text }]} numberOfLines={1}>{t.name}</Text>
      {onEdit && <Pressable onPress={onEdit} accessibilityLabel={`Edit ${t.name}`} style={[styles.themeEdit, { borderColor: t.line }]}><Text style={[styles.themeEditText, { color: t.muted }]}>Edit</Text></Pressable>}
      {selected && <Text style={[styles.themeCheck, { color: t.accent }]}>✓</Text>}</Pressable>);}
function ThemesPage({ current, customs, onPick, onSave, onDelete }: {
  current: string; customs: Theme[]; onPick: (id: string) => void; onSave: (t: Theme) => void; onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState<Theme | "new" | null>(null);
  const kept = useKeptScroll("themes");
  return (<ScrollView {...kept} style={styles.page} contentContainerStyle={styles.pageBody}>
      <PageHeader title="Themes" />
      {THEMES.map((t) => <ThemeCard key={t.id} t={t} selected={current === t.id} onPress={() => onPick(t.id)} />)}
      {customs.length > 0 && <Text style={styles.sectionLabel}>YOUR THEMES</Text>}
      {customs.map((t) => <ThemeCard key={t.id} t={t} selected={current === t.id} onPress={() => onPick(t.id)} onEdit={() => setEditing(t)} />)}
      <Pressable onPress={() => setEditing("new")} accessibilityLabel="Make a custom theme" style={styles.settingButton}>
        <Text style={styles.settingLabel}>＋ Make your own theme</Text></Pressable>
      {editing && (<ThemeEditor
          initial={editing === "new" ? null : editing}
          onSave={(t) => { setEditing(null); onSave(t); }}
          onDelete={editing === "new" ? undefined : () => { const id = editing.id; setEditing(null); onDelete(id); }}
          onClose={() => setEditing(null)}/>)}</ScrollView>);}
type Slot = "bg" | "panel" | "accent" | "text";
const SLOTS: [Slot, string][] = [["bg", "Background"], ["panel", "Panel"], ["accent", "Accent"], ["text", "Text"]];
// Pick four colors and a name; everything else is worked out from them. Shows a live preview.
function ThemeEditor({ initial, onSave, onDelete, onClose }: { initial: Theme | null; onSave: (t: Theme) => void; onDelete?: () => void; onClose: () => void }) {
  const { top, bottom } = useSafeAreaInsets();
  const id = useRef(initial?.id ?? `custom-${newId()}`).current;
  const [name, setName] = useState(initial?.name ?? "My theme");
  const [c, setC] = useState<Record<Slot, string>>({ bg: (initial ?? THEME).bg, panel: (initial ?? THEME).panel, accent: (initial ?? THEME).accent, text: (initial ?? THEME).text });
  const [slot, setSlot] = useState<Slot>("accent");
  const [hsv, setHsv] = useState(() => hexToHsv(c.accent));
  const t = makeTheme(id, name.trim() || "My theme", c.bg, c.panel, c.accent, c.text);
  const setColor = (hex: string, next = hexToHsv(hex)) => { setC({ ...c, [slot]: hex }); setHsv(next); };
  const [h, sat, val] = hsv;
  return (<Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={[styles.page, { paddingTop: top + 8, paddingBottom: Math.max(bottom, 16) }]}>
        <LockScroll contentContainerStyle={[styles.pageBody, { paddingBottom: 12 }]} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
          <Text style={styles.pageTitle}>{initial ? "Edit theme" : "New theme"}</Text>
          <ThemeCard t={t} selected />
          {(() => {
            const p = palette(t), moved = (["text", "accent", "muted"] as const).filter((k) => p[k].toLowerCase() !== t[k].toLowerCase());
            return moved.length > 0 && <Text style={styles.settingHint}>Adjusted so everything stays easy to read: the preview above shows the colors the app will use.</Text>;})()}
          <TextInput value={name} onChangeText={setName} placeholder="Theme name" placeholderTextColor={MUTED} maxLength={20} returnKeyType="done" style={styles.input} />
          <View style={styles.fieldRow}>
            {SLOTS.map(([k, label]) => (<Pressable key={k} onPress={() => { setSlot(k); setHsv(hexToHsv(c[k])); }} accessibilityLabel={label} style={[styles.slotChip, slot === k && styles.chipOn]}>
                <View style={[styles.slotDot, { backgroundColor: c[k] }]} />
                <FitText style={styles.slotText} numberOfLines={1} adjustsFontSizeToFit>{label}</FitText></Pressable>))}</View>
          <View style={styles.pickerRow}>
            <SvSquare hue={h} sat={sat} val={val} onChange={(x, y) => setColor(hsvToHex(h, x, y), [h, x, y])} />
            <HueBar hue={h} onChange={(nh) => setColor(hsvToHex(nh, sat, val), [nh, sat, val])} /></View>
          <Field label="HEX" text value={c[slot].slice(1)} sanitize={(x) => x.replace(/[^0-9a-fA-F]/g, "").slice(0, 6).toUpperCase()} onCommit={(x) => x.length === 6 && setColor(`#${x}`)} /></LockScroll>
        <View style={[styles.buttonRow, { paddingHorizontal: GAP * 2 }]}>
          {onDelete ? <Btn kind="delete" label="Delete" onPress={onDelete} /> : <Btn kind="cancel" label="Cancel" onPress={onClose} />}
          <Btn kind="save" label="Save" onPress={() => onSave(t)} /></View></View></Modal>);}
// A setting's name with its hint underneath.
const SettingHead = ({ label, hint, flex }: { label: string; hint?: string; flex?: boolean }) => (<View style={flex && { flex: 1 }}>
    <Text style={styles.settingLabel}>{label}</Text>
    {!!hint && <Text style={styles.settingHint}>{hint}</Text>}</View>);
function SettingRow({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (<View style={styles.settingRow}>
      <SettingHead label={label} hint={hint} flex />
      <Switch value={value} onValueChange={onChange} trackColor={{ true: ORANGE, false: LINE }} /></View>);}
function SettingChoice<T>({ label, hint, value, options, onPick }: { label: string; hint?: string; value: T; options: [T, string][]; onPick: (v: T) => void }) {
  return (<View style={styles.settingBox}>
      <SettingHead label={label} hint={hint} />
      <Choices value={value} options={options.map(([v, l]) => [v, l, `${label}: ${l}`] as [T, string, string])} onPick={onPick} /></View>);}
// One box each for hours, minutes and seconds. Type freely; the value is clamped as you go and tidied when you leave the box.
function DurBox({ value, unit, onCommit }: { value: number; unit: string; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (<View style={styles.durCell}>
      <TextInput value={text} keyboardType="number-pad" maxLength={2} selectTextOnFocus accessibilityLabel={unit}
        onChangeText={(t) => { const d = t.replace(/\D/g, ""); setText(d); onCommit(d ? parseInt(d, 10) : 0); }}
        onBlur={() => setText(String(value))}
        style={styles.durInput}/>
      <Text style={styles.durUnit}>{unit}</Text></View>);}
function DurationSetting({ label, hint, value, min, max, onChange }: { label: string; hint?: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  const h = Math.floor(value / 3600), m = Math.floor((value % 3600) / 60), sec = value % 60;
  const set = (nh: number, nm: number, ns: number) => onChange(clamp(nh * 3600 + Math.min(59, nm) * 60 + Math.min(59, ns), min, max));
  return (<View style={styles.settingBox}>
      <SettingHead label={label} hint={hint} />
      <View style={styles.durRow}>
        <DurBox value={h} unit="hr" onCommit={(n) => set(Math.min(24, n), m, sec)} />
        <DurBox value={m} unit="min" onCommit={(n) => set(h, n, sec)} />
        <DurBox value={sec} unit="sec" onCommit={(n) => set(h, m, n)} /></View></View>);}
function SettingsPage({ prefs, onChange, onWipe }: {
  prefs: Prefs; onChange: (p: Partial<Prefs>) => void; onWipe: (keys: string[], cancelReminders: boolean) => void;
}) {
  // A button that asks before it runs: [button label, alert title, alert text, confirm button, action].
  const reset = (label: string, title: string, body: string, action: string, run: () => void, danger?: boolean) => (
    <Pressable style={styles.settingButton} onPress={() => Alert.alert(title, body, [{ text: "Cancel", style: "cancel" }, { text: action, style: "destructive", onPress: run }])}>
      <Text style={[styles.settingLabel, danger && { color: DANGER }]}>{label}</Text></Pressable>);
  const toggle = (key: "showTimes" | "showInfo" | "defaultReminder" | "showNow" | "showDots" | "showWeekday" | "reminders", label: string, hint: string) =>
    <SettingRow label={label} hint={hint} value={prefs[key]} onChange={(v) => onChange({ [key]: v })} />;
  const kept = useKeptScroll("settings");
  return (<ScrollView {...kept} style={styles.page} contentContainerStyle={styles.pageBody}>
      <PageHeader title="Settings" />
      <Text style={styles.sectionLabel}>DISPLAY</Text>
      <SettingChoice label="Time format" hint="Hour labels, event times and the time pickers" value={prefs.clock24} options={[[false, "12-hour"], [true, "24-hour"]]} onPick={(clock24) => onChange({ clock24 })} />
      <SettingChoice label="Week starts on" value={prefs.weekStart} options={[[0, "Sunday"], [1, "Monday"]]} onPick={(weekStart) => onChange({ weekStart })} />
      {toggle("showNow", "Current-time line", "The orange line on today's timeline")}
      {toggle("showDots", "Important markers", "Shapes on days with important events")}
      {toggle("showWeekday", "Weekday names", "Mon, Tue... in each day of the month")}
      <Text style={styles.sectionLabel}>EVENT BLOCKS</Text>
      {toggle("showTimes", "Start and end times", "Shown inside events on the timeline")}
      {toggle("showInfo", "Reminder and sequence info", "Reminder and next step under the title")}
      <Text style={styles.sectionLabel}>NEW EVENTS</Text>
      <DurationSetting label="Default length" hint="How long a new event lasts" value={prefs.defaultLength} min={60} max={86400} onChange={(defaultLength) => onChange({ defaultLength })} />
      {toggle("defaultReminder", "Remind me by default", "New events start with a reminder")}
      <DurationSetting label="Default reminder" hint="How long before the start" value={prefs.alertSeconds} min={0} max={86400} onChange={(alertSeconds) => onChange({ alertSeconds })} />
      <Text style={styles.sectionLabel}>NOTIFICATIONS</Text>
      {toggle("reminders", "Reminders", "Turn off to silence every reminder. Events keep their reminder settings.")}
      {IS_WEB && (<>
          <Text style={styles.sectionLabel}>BACKUP</Text>
          <Pressable style={styles.settingButton} onPress={exportBackup} accessibilityRole="button"><SettingHead label="Save a backup" hint="A file with all your events, themes and settings. Keep it in Files." /></Pressable>
          <Pressable style={styles.settingButton} onPress={importBackup} accessibilityRole="button"><SettingHead label="Restore a backup" hint="Replaces everything with a backup file" /></Pressable>
        </>)}
      <Text style={styles.sectionLabel}>DATA</Text>
      {reset("Reset saved colors", "Reset saved colors?", "Your custom colors are removed. Events that use them keep them.", "Reset", () => onWipe([COLORS_KEY], false))}
      {reset("Reset settings", "Reset settings?", "Every setting on this page goes back to its default. Your theme and events stay.", "Reset", () => onChange({ ...DEFAULT_PREFS, theme: prefs.theme }))}
      {reset("Clear all events", "Clear all events?", "This permanently deletes every event, including repeating ones. This can't be undone.", "Clear all", () => onWipe([KEY, KEY_V2, STOP_KEY], true), true)}</ScrollView>);}
// One month of the year page. Memoized: picking a day redraws only the months it touches, not all 365 days.
const YearMonth = memo(function YearMonth({ year, m, sel, today, marks, onDay, onMonth }: {
  year: number; m: number; sel: number; today: number; // selected day and today in this month (0 = not in it)
  marks: string; // marker color for each day, comma separated ("" = none)
  onDay: (d: Date) => void; onMonth: (y: number, m: number) => void;
}) {
  const first = (new Date(year, m, 1).getDay() - WEEK_START + 7) % 7;
  const colors = marks.split(",");
  return (<View style={styles.yearMonth}>
      <Pressable onPress={() => onMonth(year, m)} accessibilityLabel={`${MONTHS[m]} ${year}`} style={styles.yearMonthTitle}>
        <Text style={[styles.yearMonthText, today > 0 && styles.todayTitle]} numberOfLines={1}>{MONTHS[m]}</Text></Pressable>
      <View style={styles.yearDays}>
        {Array.from({ length: first }, (_, i) => <View key={`b${i}`} style={styles.yearCell} />)}
        {colors.map((mark, i) => {
          const date = new Date(year, m, i + 1);
          return (<Pressable key={i} onPress={() => onDay(date)} accessibilityLabel={date.toDateString()}
              style={[styles.yearCell, i + 1 === today && styles.todayCell, i + 1 === sel && styles.selectedCell, !!mark && { backgroundColor: mark }, !!mark && edgeOn(mark, BG)]}>
              <Text style={[styles.yearDay, i + 1 === sel && styles.selectedText, !!mark && { color: inkOn(mark), fontWeight: "800" }]}>{i + 1}</Text></Pressable>);})}</View></View>);});
// The whole year at a glance: swipe right from the calendar to get here. Days with important events are filled with their marker color.
// Memoized: it sits next to the calendar, so without this it would redraw on every frame of an event drag.
const YearView = memo(function YearView({ year, selKey, todayKey, events, onYear, onDay, onMonth, scrollable }: {
  year: number; selKey: string; todayKey: string; events: CalEvent[]; onYear: (y: number) => void; onDay: (d: Date) => void; onMonth: (y: number, m: number) => void;
  scrollable: boolean; // off while a swipe is moving the pages
}) {
  const insets = useSafeAreaInsets();
  // Per month: each day's marker color, comma separated, so each month gets one string it can compare cheaply.
  const marks = useMemo(() => {
    const important = events.filter((e) => e.important);
    return MONTHS.map((_, m) => nums(new Date(year, m + 1, 0).getDate(), (i) => {
      const d = new Date(year, m, i + 1);
      const hit = important.find((e) => occursOn(e, dayKey(d), d.getDay()));
      return hit ? hit.markColor ?? hit.color : "";}).join(","));
  }, [events, year]);
  const dayIn = (key: string, m: number) => (key.slice(0, 7) === `${year}-${pad(m + 1)}` ? Number(key.slice(8)) : 0);
  return (<View style={{ flex: 1, paddingTop: insets.top - ISLAND_BOTTOM_OFFSET + GAP, paddingHorizontal: GAP }}>
      <View style={styles.yearHeader}>
        <Pressable hitSlop={10} onPress={() => onYear(year - 1)} accessibilityLabel="Previous year" style={styles.arrowButton}><Text style={styles.arrowText}>‹</Text></Pressable>
        <Text style={[styles.dailyTitle, year === Number(todayKey.slice(0, 4)) && styles.todayTitle]} accessibilityRole="header">{year}</Text>
        <Pressable hitSlop={10} onPress={() => onYear(year + 1)} accessibilityLabel="Next year" style={styles.arrowButton}><Text style={styles.arrowText}>›</Text></Pressable></View>
      <ScrollView scrollEnabled={scrollable} contentContainerStyle={[styles.yearGrid]} showsVerticalScrollIndicator={false}>
        {MONTHS.map((name, m) => <YearMonth key={name} year={year} m={m} sel={dayIn(selKey, m)} today={dayIn(todayKey, m)} marks={marks[m]} onDay={onDay} onMonth={onMonth} />)}
      </ScrollView></View>);});
function Calendar({ prefs }: { prefs: Prefs }) {
  const insets = useSafeAreaInsets();
  const [today, setToday] = useState(new Date());
  const [selected, setSelected] = useState(new Date());
  const [timelineHeight, setTimelineHeight] = useState(0);
  const [pagerH, setPagerH] = useState(0);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [customColors, setCustomColors] = useState<string[]>([]);
  const [colorsLoaded, setColorsLoaded] = useState(false);
  const [syncTick, setSyncTick] = useState(0); // bumped to rebuild reminders
  // The displayed month always follows the selected date.
  const month = selected.getMonth();
  const year = selected.getFullYear();
  const [yearShown, setYearShown] = useState(year); // the year page can browse other years without moving the selected day
  useEffect(() => setYearShown(year), [year]);
  const selKey = dayKey(selected);
  const selDow = selected.getDay();
  const todayKey = dayKey(today);
  const titleStyle = [styles.dailyTitle, selKey === todayKey && styles.todayTitle];
  // Clock: tick once a minute, aligned to the minute boundary.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      setToday(new Date());
      interval = setInterval(() => setToday(new Date()), 60000);
    }, (60 - new Date().getSeconds()) * 1000);
    return () => { clearTimeout(timeout); if (interval) clearInterval(interval); };
  }, []);
  // Load events once, then save on every change.
  useEffect(() => {
    loadEvents().then(removePresets).then(setEvents).catch(() => {})
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => { if (loaded) AsyncStorage.setItem(KEY, JSON.stringify(events)).catch(() => {}); }, [events, loaded]);
  // Saved custom colors.
  useEffect(() => {
    AsyncStorage.getItem(COLORS_KEY)
      .then((raw) => raw && setCustomColors(JSON.parse(raw)))
      .catch(() => {})
      .finally(() => setColorsLoaded(true));
  }, []);
  useEffect(() => { if (colorsLoaded) AsyncStorage.setItem(COLORS_KEY, JSON.stringify(customColors)).catch(() => {}); }, [customColors, colorsLoaded]);
  // Rebuild reminders when events change, a new day starts, or the app comes back to the front.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => st === "active" && setSyncTick((t) => t + 1));
    return () => sub.remove();
  }, []);
  // Tapping a repeating reminder stops the rest of its repeats.
  useEffect(() => {
    if (IS_WEB) return;
    const sub = Notifications.addNotificationResponseReceivedListener(async (r) => {
      const { occ, tap, speak } = (r.notification.request.content.data ?? {}) as { occ?: string; tap?: boolean; speak?: boolean };
      if (speak) Speech.speak(r.notification.request.content.title ?? "");
      if (!occ || !tap) return;
      try {
        const old: string[] = JSON.parse((await AsyncStorage.getItem(STOP_KEY)) ?? "[]");
        const cutoff = dayKey(addDays(new Date(), -1));
        await AsyncStorage.setItem(STOP_KEY, JSON.stringify([...old, occ].filter((o) => o.split("|")[1] >= cutoff)));
        const all = await Notifications.getAllScheduledNotificationsAsync();
        await Promise.all(all.filter((n) => n.content.data?.occ === occ).map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier)));
      } catch {}});
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!loaded) return;
    if (prefs.reminders) syncReminders(events);
    else if (IS_WEB) clearWebTimers();
    else Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
  }, [events, loaded, todayKey, syncTick, prefs.reminders]);
  /* month grid: 6 weeks, plus markers for important events */
  const days = useMemo(() => {
    const first = (new Date(year, month, 1).getDay() - WEEK_START + 7) % 7;
    return Array.from({ length: 42 }, (_, i) => new Date(year, month, i - first + 1));
  }, [year, month]);
  // Only events marked important show on the month.
  const marks = useMemo(
    () => days.map((d) => d.getMonth() !== month || !prefs.showDots ? "" : events.filter((e) => e.important && occursOn(e, dayKey(d), d.getDay())).slice(0, 4).map((e) => `${e.shape ?? "star"}:${e.markColor ?? e.color}`).join(",")),
    [days, month, events, prefs.showDots]);
  const thisWeek = weekStart(today);
  const goToday = () => setSelected(new Date());
  function changeMonth(direction: number) {
    const next = new Date(year, month + direction, 1);
    // Landing on the current month selects today instead of the 1st.
    const isCurrent = next.getMonth() === today.getMonth() && next.getFullYear() === today.getFullYear();
    setSelected(isCurrent ? new Date() : next);}
  /* timeline: GAP of padding above the first row and GAP above the bottom safe area; 12 rows share the rest */
  const bottomPad = GAP; // the tab bar underneath handles the safe area
  const hourHeight = timelineHeight > 0 ? (timelineHeight - GAP - bottomPad) / 12 : 40;
  const dayEvents = useMemo(
    () => events.filter((e) => occursOn(e, selKey, selected.getDay())),
    [events, selKey, selected]);
  // Dragging: `drag` is the live start/length of the event being moved; it's saved when you let go.
  type Drag = { id: string; start: number; duration: number; mode: "move" | "resize"; col: number };
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragBase = useRef<{ ev: CalEvent; mode: "move" | "resize"; col: number } | null>(null);
  const dragNow = useRef<Drag | null>(null);
  const dragFrame = useRef(0); // pending redraw for the drag, so several moves in one frame cost one render
  useEffect(() => () => cancelAnimationFrame(dragFrame.current), []);
  // From the moment a finger lands on an event until it lifts, the page can't be swiped over to the year.
  // A ref, not state: the pager checks it mid-gesture and it has to be current right away.
  const eventTouch = useRef(false);
  const touchEnd = useCallback(() => { eventTouch.current = false; }, []);
  const { width: winW } = useWindowDimensions();
  const colW = (winW - 2 * (GAP + 2) - 9) / 2;
  /* Pager: the year sits to the left of the calendar (page 0), the calendar is page 1. Swipe right to see the year.
     Nothing moves until the finger has been down for PAGE_DELAY and has gone PAGE_SLOP points sideways
     (mostly sideways, toward the other page). After that the page follows the finger from where it is, with no jump. */
  const pageRef = useRef<0 | 1>(1);
  const winRef = useRef(winW);
  winRef.current = winW;
  const slide = useRef(new Animated.Value(-winW)).current; // horizontal position of the two pages
  const [paging, setPaging] = useState(false); // while a swipe is moving the pages, the year's list doesn't scroll
  const goPage = useCallback((p: 0 | 1, animated = true) => {
    pageRef.current = p;
    const to = -p * winRef.current;
    if (animated) Animated.spring(slide, { toValue: to, useNativeDriver: true, bounciness: 0, speed: 16 }).start();
    else slide.setValue(to);
  }, [slide]);
  useEffect(() => { slide.setValue(-pageRef.current * winW); }, [winW, slide]); // rotation or resize keeps the same page in view
  const downAt = useRef(0);
  const grabDx = useRef(0); // how far the finger had already gone when the swipe took over
  const pagerPan = useRef(PanResponder.create({
    // Only notes when the finger came down. Returning false leaves the touch with whatever is under it.
    onStartShouldSetPanResponderCapture: () => { downAt.current = Date.now(); return false; },
    onMoveShouldSetPanResponderCapture: (_, g) => {
      if (eventTouch.current) return false; // an event is being touched, held or dragged
      if (Date.now() - downAt.current < PAGE_DELAY) return false;
      if (Math.abs(g.dx) < PAGE_SLOP || Math.abs(g.dx) < Math.abs(g.dy) * 1.5) return false;
      return pageRef.current === 1 ? g.dx > 0 : g.dx < 0; // only toward the other page
    },
    onPanResponderGrant: (_, g) => { slide.stopAnimation(); grabDx.current = g.dx; setPaging(true); },
    onPanResponderMove: (_, g) => {
      const w = winRef.current;
      slide.setValue(clamp(-pageRef.current * w + g.dx - grabDx.current, -w, 0));},
    onPanResponderTerminationRequest: () => false,
    onPanResponderRelease: (_, g) => finishSwipe(g.dx - grabDx.current, g.vx),
    onPanResponderTerminate: (_, g) => finishSwipe(g.dx - grabDx.current, g.vx),
  })).current;
  // Year page taps. Stable callbacks, so the memoized year page doesn't redraw with the calendar.
  const pickYearDay = useCallback((d: Date) => { setSelected(d); goPage(1); }, [goPage]);
  const pickYearMonth = useCallback((y: number, m: number) => {
    const now = new Date();
    setSelected(m === now.getMonth() && y === now.getFullYear() ? now : new Date(y, m, 1));
    goPage(1);}, [goPage]);
  // Flips if the page went a third of the way, or was flicked toward the other page; otherwise it slides back.
  function finishSwipe(dx: number, vx: number) {
    const toward = pageRef.current === 1 ? 1 : -1; // + is toward the year
    const went = dx * toward;
    const flip = went > winRef.current / 3 || (went > 10 && vx * toward > 0.4);
    goPage(flip ? (pageRef.current === 1 ? 0 : 1) : pageRef.current);
    setPaging(false);}
  const shownEvents = useMemo(() => (drag ? dayEvents.map((e) => (e.id === drag.id ? { ...e, start: drag.start, duration: drag.duration } : e)) : dayEvents), [dayEvents, drag]);
  const maxLanes = drag ? Infinity : Math.max(2, Math.floor((colW - LABEL_WIDTH) / MIN_LANE)); // no folding mid-drag: the dragged event must stay put
  const layout = useMemo(() => layoutEvents(shownEvents, snapFor(hourHeight), drag?.id, maxLanes), [shownEvents, hourHeight, drag?.id, maxLanes]);
  const [moreList, setMoreList] = useState<CalEvent[] | null>(null); // events of a tapped "+N" block
  // Always start from the saved event, never from a copy that's mid-drag.
  const dragBegin = useCallback((ev: CalEvent, mode: "move" | "resize", col: number) => {
    eventTouch.current = true; // runs the instant the event is touched, before any movement
    dragNow.current = null;
    dragBase.current = { ev: dayEvents.find((e) => e.id === ev.id) ?? ev, mode, col };
  }, [dayEvents]);
  // Snaps to the hour lines and to the edges of the other events (and to the whole minute otherwise).
  const dragMove = useCallback((dx: number, dy: number) => {
    const base = dragBase.current;
    if (!base) return;
    const { ev, mode, col } = base;
    const nearest = (raw: number, targets: number[]) => snapNear(raw, targets, (8 / hourHeight) * 3600);
    const hours = Array.from({ length: 25 }, (_, h) => h * 3600);
    const edges = dayEvents.filter((o) => o.id !== ev.id).flatMap((o) => [o.start, o.start + o.duration]);
    const dSec = (dy / hourHeight) * 3600;
    let next;
    if (mode === "move") {
      // Dragging sideways past halfway jumps to the other column (AM <-> PM), and only toward the other column.
      const raw = ev.start + dSec + (col === 0 && dx > colW / 2 ? 43200 : col === 1 && dx < -colW / 2 ? -43200 : 0);
      const start = clamp(nearest(raw, [...hours, ...edges, ...[...hours, ...edges].map((t) => t - ev.duration)]), 0, 86400 - ev.duration);
      next = { id: ev.id, start, duration: ev.duration, mode, col };
    } else {
      const end = clamp(nearest(ev.start + ev.duration + dSec, [...hours, ...edges]), ev.start + 60, 86400);
      next = { id: ev.id, start: ev.start, duration: end - ev.start, mode, col };}
    // Touch moves arrive faster than the screen redraws, and most land on the same snapped time: only redraw when it changes, at most once a frame.
    const prev = dragNow.current;
    if (prev && prev.start === next.start && prev.duration === next.duration) return;
    dragNow.current = next;
    if (!dragFrame.current) dragFrame.current = requestAnimationFrame(() => { dragFrame.current = 0; setDrag(dragNow.current); });
  }, [dayEvents, hourHeight, colW]);
  // Hold an event for the menu. Duplicate then waits for a tap on the timeline to say where the copy goes.
  const [placing, setPlacing] = useState<CalEvent | null>(null);
  const holdEvent = useCallback((ev: CalEvent) => {
    if (dragNow.current) return; // never offer delete/duplicate in the middle of a drag
    eventTouch.current = false; // the menu takes over the touch, so its end may never arrive
    const orig = dayEvents.find((e) => e.id === ev.id) ?? ev;
    const repeating = orig.repeat !== "none";
    Alert.alert(orig.title, undefined, [
      { text: "Duplicate", onPress: () => setPlacing(orig) },
      ...(repeating ? [{ text: "Delete this day", style: "destructive" as const, onPress: () => edit(orig.id, (e) => ({ ...e, skip: [...e.skip, selKey] })) }] : []),
      { text: repeating ? "Delete all" : "Delete", style: "destructive" as const, onPress: () => setEvents((prev) => prev.filter((e) => e.id !== orig.id)) },
      { text: "Cancel", style: "cancel" as const },]);
  }, [dayEvents, selKey]);
  // The copy lands on the day you're viewing, starting where you tapped (snapped to hours, other events, or 5 minutes).
  const placeCopy = (hour: number, y: number) => {
    if (!placing) return;
    const dur = placing.duration;
    const targets = [...Array.from({ length: 25 }, (_, h) => h * 3600), ...dayEvents.flatMap((o) => [o.start, o.start + o.duration])];
    const raw = hour * 3600 + (Math.max(0, y - LINE_OFFSET) / hourHeight) * 3600;
    const start = clamp(snapNear(raw, [...targets, ...targets.map((t) => t - dur)], (8 / hourHeight) * 3600, 300), 0, 86400 - dur);
    const copy: CalEvent = {
      ...placing, id: newId(), date: selKey, start, skip: [], checks: undefined,
      steps: placing.steps?.map((st) => ({ ...st, id: newId() })),
      until: placing.until && placing.until >= selKey ? placing.until : undefined,};
    setEvents((prev) => [...prev, copy]);
    setPlacing(null);};
  const dragEnd = useCallback(() => {
    const d = dragNow.current;
    cancelAnimationFrame(dragFrame.current);
    dragFrame.current = 0;
    dragNow.current = null;
    dragBase.current = null;
    setDrag(null);
    if (d) setEvents((prev) => prev.map((e) => (e.id === d.id ? { ...e, start: d.start, duration: d.duration } : e)));
  }, []);
  const hour = today.getHours();
  const minute = today.getMinutes();
  const isTodaySel = selKey === todayKey;
  const now = useMemo<Now | null>(
    () =>
      isTodaySel && prefs.showNow
        ? {
            column: hour < 12 ? 0 : 1,
            offset: ((hour % 12) + minute / 60) * hourHeight + LINE_OFFSET,
            label: CLOCK24 ? `${pad(hour)}:${pad(minute)}` : `${hour % 12 || 12}:${pad(minute)}`, // am/pm is implied by the column
            below: minute < 30, // sits on the side of the line farther from the nearest hour label
            exact: minute === 0 ? hour % 12 : -1,}
        : null,
    [isTodaySel, prefs.showNow, hour, minute, hourHeight]);
  /* event editing */
  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const openNew = useCallback(
    (h: number) =>
      setDraft({
        title: "", start: h * 3600, duration: Math.min(prefs.defaultLength, 86400 - h * 3600), color: EVENT_COLORS[0],
        date: selKey, repeat: "none", days: [selDow], important: false, shape: "star",
        endMode: "never", endDays: 30, until: selKey, steps: [], alert: prefs.defaultReminder ? DEFAULT_ALERT : undefined,}),
    [selKey, selDow, prefs.defaultLength, prefs.defaultReminder, prefs.alertSeconds]);
  const openExisting = useCallback((ev: CalEvent) =>
    setDraft({
      id: ev.id, title: ev.title, start: ev.start, duration: ev.duration, color: ev.color,
      date: ev.date, repeat: ev.repeat,
      days: ev.days.length ? ev.days : [parseKey(ev.date).getDay()], interval: ev.interval, always: ev.always,
      endMode: ev.until ? "date" : "never", endDays: 30, until: ev.until ?? ev.date,
      steps: ev.steps ?? [], alert: ev.alert, alertAfter: ev.alertAfter, sound: ev.sound, soundUri: ev.soundUri, soundName: ev.soundName, soundFile: ev.soundFile, nag: ev.nag, important: ev.important, shape: ev.shape ?? "star", markColor: ev.markColor,
    }), []);
  // Events with a sequence open the checklist; others open the editor.
  const openEvent = useCallback(
    (ev: CalEvent) => (ev.steps?.length ? setViewingId(ev.id) : openExisting(ev)),
    [openExisting]);
  const viewing = viewingId ? events.find((e) => e.id === viewingId) ?? null : null;
  const closeAll = () => { setDraft(null); setViewingId(null); setMoreList(null); };
  const edit = (id: string, fn: (e: CalEvent) => CalEvent) =>
    setEvents((prev) => prev.map((e) => (e.id === id ? fn(e) : e)));
  const toggleStep = (stepId: string) =>
    viewing && edit(viewing.id, (e) => {
      const cur = e.checks?.[selKey] ?? [];
      return { ...e, checks: { ...e.checks, [selKey]: cur.includes(stepId) ? cur.filter((x) => x !== stepId) : [...cur, stepId] } };});
  const resetSteps = () => viewing && edit(viewing.id, (e) => ({ ...e, checks: { ...e.checks, [selKey]: [] } }));
  const isSeries = !!draft?.id && (events.find((e) => e.id === draft.id)?.repeat ?? "none") !== "none";
  function save() {
    if (!draft) return;
    const old = draft.id ? events.find((e) => e.id === draft.id) : undefined;
    const wasSeries = !!old && old.repeat !== "none";
    const start = wasSeries && draft.repeat === "none" ? selKey : draft.date;
    let until: string | undefined;
    if (draft.repeat !== "none") {
      if (draft.endMode === "days") until = dayKey(addDays(parseKey(start), draft.endDays - 1));
      else if (draft.endMode === "date") until = (draft.until ?? start) < start ? start : draft.until;}
    const event: CalEvent = {
      id: draft.id ?? `${Date.now()}`,
      title: draft.title.trim() || "Untitled",
      start: draft.start,
      duration: draft.duration,
      color: draft.color,
      // Turning a series into a one-off keeps the day being viewed.
      date: start,
      // "Every 1 day" is just daily; an empty box counts as every other day.
      repeat: draft.repeat === "interval" && draft.interval === 1 ? "daily" : draft.repeat,
      days: draft.days.length ? draft.days : [selected.getDay()],
      interval: draft.repeat === "interval" && draft.interval !== 1 ? Math.max(2, draft.interval || 2) : undefined,
      skip: draft.repeat === "none" ? [] : old?.skip ?? [],
      until,
      always: draft.repeat !== "none" && draft.always ? true : undefined,
      steps: draft.steps.map((st) => ({ ...st, text: st.text.trim() })).filter((st) => st.text || st.media?.length),
      checks: old?.checks,
      alert: draft.alert,
      alertAfter: draft.alert === undefined ? undefined : draft.alertAfter,
      sound: draft.alert === undefined || draft.sound === "default" ? undefined : draft.sound,
      ...(draft.alert !== undefined && draft.sound === "custom" ? { soundUri: draft.soundUri, soundName: draft.soundName, soundFile: draft.soundFile } : {}),
      important: draft.important || undefined,
      shape: draft.important ? draft.shape : undefined,
      markColor: draft.important ? draft.markColor : undefined,
      nag: draft.alert === undefined ? undefined : draft.nag,};
    // Ask for permission the first time a reminder is set, then rebuild the schedule.
    if (event.alert !== undefined) {
      if (IS_WEB) {
        try { if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission().finally(() => setSyncTick((t) => t + 1)); } catch {}
        setSyncTick((t) => t + 1);}
      else Notifications.requestPermissionsAsync().then(() => setSyncTick((t) => t + 1)).catch(() => {});}
    if (draft.id) edit(draft.id, () => event);
    else setEvents((prev) => [...prev, event]);
    setDraft(null);}
  // Long-press the Today button: ask first, then delete every event.
  function confirmClear() {
    if (!events.length) return Alert.alert("No events", "There are no events to clear.");
    Alert.alert("Clear all events?", `This permanently deletes ${plural(events.length, "event")}, including repeating ones. This can't be undone.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Clear all", style: "destructive", onPress: () => setEvents([]) },]);}
  // Removes the event and every repeat of it.
  function remove() {
    if (draft?.id) setEvents((prev) => prev.filter((e) => e.id !== draft.id));
    setDraft(null);}
  // Removes only the day being viewed from a repeating event.
  function skipDay() {
    if (draft?.id) edit(draft.id, (e) => ({ ...e, skip: [...e.skip, selKey] }));
    setDraft(null);}
  return (<View style={styles.container}>
      <View {...pagerPan.panHandlers} style={{ flex: 1, overflow: "hidden" }} onLayout={(e) => setPagerH(e.nativeEvent.layout.height)}>
      <Animated.View style={{ flexDirection: "row", width: winW * 2, height: pagerH, transform: [{ translateX: slide }] }}>
      <View style={{ width: winW, height: pagerH }}>
        <YearView year={yearShown} selKey={selKey} todayKey={todayKey} events={events} onYear={setYearShown} scrollable={!paging}
          onDay={pickYearDay} onMonth={pickYearMonth} /></View>
      <View style={{ width: winW, height: pagerH }}>
      <View style={[styles.content, {
          paddingTop: insets.top - ISLAND_BOTTOM_OFFSET + GAP,
          paddingHorizontal: GAP,}]}>
        {/* MONTH GRID */}
        <View style={styles.calendarGrid}>
          {days.map((date, i) => (<DayCell key={i} date={date} inMonth={date.getMonth() === month} isToday={dayKey(date) === todayKey} isSelected={dayKey(date) === selKey} inWeek={weekStart(date) === thisWeek} marks={marks[i]} weekday={prefs.showWeekday} onPress={setSelected} />))}</View>
        {/* DATE HEADER */}
        <View style={styles.dailyHeader}>
          <View style={styles.headerLeft}>
            <HoldPressable hitSlop={10} onPress={goToday} onLongPress={confirmClear} delayLongPress={600} accessibilityLabel="Go to today. Long press to clear all events." style={styles.todayButton}>
              <Text style={[styles.todayButtonText, selKey === todayKey && styles.todayTitle]}>Today</Text></HoldPressable>
            <FitText style={[titleStyle, styles.weekdayTitle]} numberOfLines={1} adjustsFontSizeToFit>{DAYS[selected.getDay()]},</FitText></View>
          <View style={styles.titleRow}>
            <Pressable hitSlop={10} onPress={() => changeMonth(-1)} accessibilityLabel="Previous month" style={styles.arrowButton}>
              <Text style={styles.arrowText}>‹</Text></Pressable>
            <Pressable onPress={goToday} accessibilityLabel="Jump to today" style={styles.monthLabel}>
              <Text style={titleStyle} numberOfLines={1}>{MONTHS[month]}</Text></Pressable>
            <Pressable hitSlop={10} onPress={() => changeMonth(1)} accessibilityLabel="Next month" style={styles.arrowButton}>
              <Text style={styles.arrowText}>›</Text></Pressable></View>
          <View style={styles.headerRight}>
            <Text style={titleStyle} numberOfLines={1}>{ordinal(selected.getDate())}</Text>
            <FitText style={titleStyle} numberOfLines={1} adjustsFontSizeToFit>
              {pad(selected.getDate())}/{pad(month + 1)}/{year}</FitText></View></View>
        {/* TIMELINE */}
        <View style={[styles.timelineContainer, { paddingBottom: bottomPad }]} onLayout={(e) => setTimelineHeight(e.nativeEvent.layout.height)}>
          {placing && (<View style={styles.placeBar} pointerEvents="box-none">
              <Text style={styles.placeText} numberOfLines={1}>Tap where to put the copy of “{placing.title}”</Text>
              <Pressable onPress={() => setPlacing(null)} accessibilityLabel="Cancel duplicate" style={styles.placeCancel}><Text style={styles.placeText}>Cancel</Text></Pressable></View>)}
          <View style={styles.timelineColumns}>
            {[0, 1].map((c) => (<Column key={c} column={c} areaW={colW - LABEL_WIDTH} onMore={setMoreList} selKey={selKey} hourHeight={hourHeight} layout={layout} now={now} showTimes={prefs.showTimes} showInfo={prefs.showInfo} drag={drag} dragShift={drag ? ((drag.start >= 43200 ? 1 : 0) - drag.col) * (colW + 9) : 0} placing={!!placing} onAdd={placing ? placeCopy : openNew} onEdit={openEvent} onHold={holdEvent} onDragBegin={dragBegin} onDragMove={dragMove} onDragEnd={dragEnd} onTouchEnd={touchEnd} />))}</View></View></View></View>
</Animated.View></View>
      {/* EVENT EDITOR */}
      <Modal visible={draft !== null || viewing !== null || moreList !== null} transparent animationType="slide" onRequestClose={closeAll}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.backdrop} onPress={closeAll} accessibilityLabel="Close" />
          {!draft && !viewing && moreList && (<MoreSheet events={moreList} onOpen={(ev) => { setMoreList(null); openEvent(ev); }} onClose={() => setMoreList(null)} />)}
          {!draft && viewing && (<DetailSheet
              ev={viewing}
              dayLabel={selected.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
              checked={doneIds(viewing, selKey)}
              onToggle={toggleStep}
              onReset={resetSteps}
              onEdit={() => { setViewingId(null); openExisting(viewing); }}
              onClose={closeAll}/>)}
          {draft && (<Sheet
              draft={draft}
              isSeries={isSeries}
              customColors={customColors}
              onAddColor={(c) => setCustomColors((prev) => (prev.includes(c) || EVENT_COLORS.includes(c) ? prev : [...prev, c]))}
              onDeleteColor={(c) => setCustomColors((prev) => prev.filter((x) => x !== c))}
              onChange={patch}
              onSave={save}
              onDelete={remove}
              onSkip={skipDay}
              onClose={() => setDraft(null)}/>)}</View></Modal></View>);}
function buildStyles() {
// Shared pieces.
const chipBase = { backgroundColor: PANEL_LIGHT, borderWidth: 1.5, borderColor: "transparent" } as const;
const centered = { alignItems: "center", justifyContent: "center" } as const;
const small = { fontSize: 12, fontWeight: "600", color: MUTED } as const;
return StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  page: { flex: 1, backgroundColor: BG },
  hidden: { display: "none" },
  pageBody: { paddingHorizontal: GAP * 2, paddingBottom: 24, gap: 10 },
  pageTitle: { color: TEXT, fontSize: 26, fontWeight: "800", marginBottom: 6 },
  sectionLabel: { color: MUTED, fontSize: 12, fontWeight: "700", letterSpacing: 0.8, marginTop: 12 },
  settingRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: PANEL, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 },
  settingButton: { minHeight: 52, justifyContent: "center", backgroundColor: PANEL, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 },
  settingLabel: { color: TEXT, fontSize: 15, fontWeight: "600" },
  settingHint: { color: MUTED, fontSize: 13, marginTop: 2 },
  themeCard: { flexDirection: "row", alignItems: "center", gap: 14, borderRadius: 14, borderWidth: 2, padding: 12 },
  themePreview: { width: 84, height: 44, borderRadius: 8, borderWidth: 1, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8 },
  themeDot: { width: 14, height: 14, borderRadius: 7 },
  themeBar: { width: 14, height: 5, borderRadius: 3 },
  themeName: { flex: 1, fontSize: 16, fontWeight: "700" },
  themeEdit: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  themeEditText: { fontSize: 13, fontWeight: "700" },
  slotChip: { ...chipBase, flex: 1, flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 10 },
  slotDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1, borderColor: LINE },
  slotText: { color: TEXT, fontSize: 12, fontWeight: "700", flex: 1 },
  themeCheck: { fontSize: 20, fontWeight: "800" },
  tabBar: { flexDirection: "row", backgroundColor: PANEL, borderTopWidth: 1, borderTopColor: LINE },
  tabItem: { flex: 1, alignItems: "center", justifyContent: "center" },
  statusBackground: { position: "absolute", top: 0, left: 0, right: 0, backgroundColor: "#000000" },
  content: { flex: 1 },
  /* month grid */
  calendarGrid: { flexDirection: "row", flexWrap: "wrap", marginBottom: GAP },
  calendarCell: { width: `${100 / 7}%`, height: 36, alignItems: "flex-start", justifyContent: "flex-start" },
  monthCell: { borderWidth: 0.5, borderColor: GRID },
  currentWeekCell: { backgroundColor: WEEK },
  dayNumber: { alignSelf: "flex-start", margin: 1, paddingHorizontal: 3, paddingVertical: 1, borderRadius: 5, ...centered },
  dayText: { color: TEXT, fontSize: 11, fontWeight: "500" },
  outsideMonthText: { color: FAINT },
  todayCell: { backgroundColor: SOFT }, // today: lighter orange
  selectedCell: { backgroundColor: STRONG }, // selected day: darker orange (replaces today's when selected)
  selectedText: { color: SEL_INK },
  weekdayLabel: { position: "absolute", top: 3, right: 4, color: TEXT, fontSize: 10, fontWeight: "700", letterSpacing: 0.3 },
  eventDots: { position: "absolute", bottom: 3, left: 4, flexDirection: "row", gap: 2 },
  starOn: { color: ORANGE },
  shapeRow: { flexDirection: "row", justifyContent: "space-between" },
  shapeChip: { ...chipBase, width: 40, height: 40, borderRadius: 10, ...centered },
  /* date header */
  dailyHeader: { flexDirection: "row", alignItems: "center", marginBottom: GAP },
  headerLeft: { flex: 1, flexDirection: "row", alignItems: "center", paddingRight: 2 },
  todayButton: { backgroundColor: PANEL_LIGHT, height: 24, paddingHorizontal: 10, borderRadius: 12, ...centered },
  todayButtonText: { color: TEXT, fontSize: 12, fontWeight: "700" },
  weekdayTitle: { flex: 1, textAlign: "right", marginLeft: 4 },
  headerRight: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 2 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 2 },
  monthLabel: { width: 78, alignItems: "center" },
  dailyTitle: { color: TEXT, fontSize: 14, lineHeight: 20, fontWeight: "700" },
  todayTitle: { color: ORANGE },
  arrowButton: { backgroundColor: PANEL_LIGHT, width: 32, height: 24, borderRadius: 12, ...centered },
  arrowText: { color: TEXT, fontSize: 20, lineHeight: 22 },
  /* timeline */
  timelineContainer: { flex: 1, backgroundColor: PANEL, marginHorizontal: -GAP, paddingHorizontal: GAP + 2, paddingTop: GAP, overflow: "hidden" },
  timelineColumns: { flexDirection: "row", gap: 9 },
  timeColumn: { flex: 1, minWidth: 0 },
  hourRow: { flexDirection: "row", alignItems: "flex-start", paddingTop: 5 },
  hourLabel: { color: TEXT, width: LABEL_WIDTH, fontSize: 10, fontWeight: "600" },
  hourLine: { flex: 1, height: 1, backgroundColor: LINE, marginTop: 6 },
  currentTimeLine: { position: "absolute", left: 0, right: 0, height: 2, flexDirection: "row", alignItems: "center", zIndex: 5 },
  currentTimeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: ORANGE, marginRight: -2 },
  currentTimeRule: { flex: 1, height: 2, backgroundColor: ORANGE },
  currentTimeLabel: { position: "absolute", left: 0, width: LABEL_WIDTH - 2, alignItems: "center", backgroundColor: TINT, borderRadius: 5, paddingVertical: 1 },
  hourOn: { width: LABEL_WIDTH - 2, backgroundColor: TINT, borderRadius: 5, paddingVertical: 1, marginTop: -1 },
  hourOnText: { color: ORANGE, fontSize: 10, fontWeight: "800", textAlign: "center" },
  currentTimeText: { color: ORANGE, fontSize: 10, fontWeight: "800" },
  /* events on the timeline */
  eventLayer: { position: "absolute", top: 0, bottom: 0, left: LABEL_WIDTH, right: 0 }, // starts right where the hour labels end
  eventBlock: { position: "absolute", flexDirection: "row", alignItems: "flex-start", borderRadius: 6, paddingHorizontal: 5, paddingVertical: 3, overflow: "hidden" },
  placeBar: { position: "absolute", top: 4, left: 10, right: 10, zIndex: 50, flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: PANEL_LIGHT, borderColor: ORANGE, borderWidth: 1.5, borderRadius: 12, paddingVertical: 6, paddingHorizontal: 12 },
  placeText: { color: TEXT, fontSize: 13, fontWeight: "700", flexShrink: 1 },
  placeCancel: { marginLeft: "auto", paddingVertical: 6, paddingLeft: 10 },
  eventDragging: { zIndex: 20, opacity: 0.92, shadowColor: "#000000", shadowOpacity: 0.5, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 8 },
  grip: { position: "absolute", left: 0, right: 0, bottom: 0, height: 12, ...centered },
  gripBar: { width: 22, height: 3, borderRadius: 2, opacity: 0.45 },
  eventBlockShort: { paddingVertical: 2, alignItems: "center" },
  eventGhost: { position: "absolute", borderRadius: 6, overflow: "hidden" },
  eventInner: { ...StyleSheet.absoluteFillObject, flexDirection: "row", alignItems: "flex-start", paddingHorizontal: 5, paddingVertical: 3 },
  eventInnerShort: { paddingVertical: 2, alignItems: "center" },
  eventText: { color: DARK, fontSize: 10, fontWeight: "700" },
  eventTime: { position: "absolute", left: 4, color: DARK, fontSize: 9, lineHeight: 11, fontWeight: "600", opacity: 0.75 },
  tightTimes: { marginRight: 5, justifyContent: "center" },
  tightText: { fontSize: 7, lineHeight: 8, fontWeight: "600", opacity: 0.8 },
  tightTitle: { fontSize: 9, lineHeight: 10 },
  miniInner: { ...StyleSheet.absoluteFillObject, paddingHorizontal: 5, alignItems: "flex-end", justifyContent: "center" },
  miniText: { fontSize: 8, lineHeight: 9, fontWeight: "700", textAlign: "right" },
  wrapInner: { ...StyleSheet.absoluteFillObject, padding: 2, alignItems: "center", justifyContent: "center" },
  upright: { position: "absolute", transform: [{ rotate: "-90deg" }], alignItems: "center", justifyContent: "center" },
  uprightText: { fontSize: 9, lineHeight: 10, textAlign: "center" },
  sliverGhost: { overflow: "visible", borderRadius: 0, alignItems: "flex-end", justifyContent: "center" },
  sliverTag: { height: TAG_H, maxWidth: "100%", borderRadius: TAG_H / 2, paddingHorizontal: 5, justifyContent: "center" },
  eventBody: { flex: 1, minWidth: 0, alignItems: "flex-end", justifyContent: "center" },
  eventTitle: { textAlign: "right" },
  eventDetail: { fontSize: 9, fontWeight: "600", opacity: 0.75, textAlign: "right", marginTop: 1 },
  /* editor sheet */
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: { backgroundColor: PANEL, borderTopLeftRadius: 17, borderTopRightRadius: 17, padding: 16, gap: 12, shadowColor: "#000", shadowOffset: { width: 0, height: -6 }, shadowOpacity: 0.7, shadowRadius: 18, elevation: 24, borderTopWidth: 1, borderColor: LINE },
  yearHeader: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 16, marginBottom: GAP },
  yearGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", paddingBottom: 16, rowGap: 14 },
  yearMonth: { width: "31.5%" },
  yearMonthTitle: { paddingVertical: 4 },
  yearMonthText: { color: TEXT, fontSize: 13, fontWeight: "700" },
  yearDays: { flexDirection: "row", flexWrap: "wrap" },
  yearCell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: "center", justifyContent: "center", borderRadius: 4 },
  yearDay: { color: TEXT, fontSize: 9, fontWeight: "600" },
  grabArea: { alignItems: "center", justifyContent: "center", height: 30, marginTop: -10, marginBottom: -10 },
  grabber: { width: 40, height: 5, borderRadius: 3, backgroundColor: MUTED, opacity: 0.55 },
  sheetTitle: { color: TEXT, fontSize: 17, fontWeight: "700" },
  input: { backgroundColor: PANEL_LIGHT, color: TEXT, fontSize: 16, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowLabel: { color: MUTED, fontSize: 15, fontWeight: "600" },
  endsText: { ...small, fontSize: 14, textAlign: "right" },
  tabs: { flexDirection: "row", gap: 8 },
  tab: { ...chipBase, flex: 1, minHeight: 48, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 10 },
  tabLabel: small,
  tabValue: { color: TEXT, fontSize: 14, fontWeight: "700", marginTop: 2 },
  wheelLabels: { flexDirection: "row", marginBottom: 2 },
  wheelLabel: { ...small, flex: 1, textAlign: "center" },
  wheelsRow: { flexDirection: "row", height: ITEM_H * VISIBLE },
  wheelBand: { position: "absolute", left: 0, right: 0, top: ITEM_H * 2, height: ITEM_H, backgroundColor: PANEL_LIGHT, borderRadius: 8 },
  wheel: { flex: 1 },
  wheelItem: { height: ITEM_H, ...centered },
  wheelText: { color: MUTED, fontSize: 18, fontWeight: "500" },
  wheelTextOn: { color: TEXT, fontWeight: "700" },
  chips: { flexDirection: "row", gap: 8 },
  chipsWrap: { flexWrap: "wrap" },
  everyChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  everyInput: { width: 48, minWidth: 0, backgroundColor: PANEL, color: TEXT, fontSize: 14, fontWeight: "700", textAlign: "center", borderRadius: 8, paddingHorizontal: 6, paddingVertical: 4 },
  everyInputOn: { color: ORANGE },
  chip: { ...chipBase, minHeight: 40, justifyContent: "center", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
  chipOn: { borderColor: ORANGE },
  chipText: { color: MUTED, fontSize: 14, fontWeight: "700" },
  chipTextOn: { color: ORANGE },
  dimmed: { opacity: 0.35 },
  dayChips: { flexDirection: "row", justifyContent: "space-between" },
  dayChip: { ...chipBase, width: 40, height: 40, borderRadius: 20, ...centered },
  dayChipOn: { borderColor: ORANGE, backgroundColor: TINT },
  dayChipText: { color: MUTED, fontSize: 14, fontWeight: "700" },
  moreBlock: { position: "absolute", ...chipBase, borderColor: LINE, borderWidth: 1, borderRadius: 6, alignItems: "center", justifyContent: "center", gap: 3, overflow: "hidden" },
  moreText: { color: TEXT, fontSize: 11, lineHeight: 13, fontWeight: "800" },
  moreDots: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 2, paddingHorizontal: 3 },
  moreDot: { width: 5, height: 5, borderRadius: 3 },
  moreRow: { ...chipBase, minHeight: 52, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  seqRow: { ...chipBase, minHeight: 48, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  seqRowText: { color: TEXT, fontSize: 14, fontWeight: "600" },
  seqRowValue: { color: MUTED, fontSize: 14, fontWeight: "600" },
  stepList: { maxHeight: 420 },
  sheetBody: { gap: 12 },
  stepBlock: { marginBottom: 6 },
  mediaRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingLeft: 28, marginBottom: 8 },
  mediaButtons: { flexDirection: "row", gap: 8, paddingLeft: 28, marginBottom: 8 },
  linkRow: { flexDirection: "row", gap: 8, paddingLeft: 28, alignItems: "center", marginBottom: 8 },
  thumb: { width: 64, height: 64, borderRadius: 8, overflow: "hidden", backgroundColor: PANEL_LIGHT },
  thumbFill: { ...StyleSheet.absoluteFillObject, ...centered },
  thumbPlay: { color: "#FFFFFF", fontSize: 18, textShadowColor: "#000000", textShadowRadius: 4 },
  thumbX: { position: "absolute", top: 2, right: 2, width: 24, height: 24, borderRadius: 12, backgroundColor: "rgba(0,0,0,0.65)", ...centered },
  thumbXText: { color: "#FFFFFF", fontSize: 10, fontWeight: "800" },
  viewer: { flex: 1, backgroundColor: "rgba(0,0,0,0.94)", justifyContent: "center" },
  viewerMedia: { width: "100%", height: "80%" },
  viewerClose: { position: "absolute", right: 16, width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.18)", ...centered },
  checkBlock: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: LINE },
  stepRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  stepNum: { color: MUTED, width: 22, fontSize: 14, fontWeight: "700", textAlign: "center" },
  stepInput: { flex: 1, minWidth: 0, width: 0, backgroundColor: PANEL_LIGHT, color: TEXT, fontSize: 15, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  stepRemove: { width: 40, height: 40, ...centered },
  stepRemoveText: { color: MUTED, fontSize: 16 },
  detailTitleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  detailDot: { width: 12, height: 12, borderRadius: 6 },
  detailMeta: { color: MUTED, fontSize: 14, fontWeight: "600" },
  checkRow: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  checkBox: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: MUTED, ...centered },
  checkBoxOn: { backgroundColor: ORANGE, borderColor: ORANGE },
  checkMark: { color: inkOn(ORANGE), fontSize: 13, fontWeight: "900" },
  checkText: { color: TEXT, fontSize: 16, flex: 1 },
  checkTextOn: { color: MUTED, textDecorationLine: "line-through" },
  colorFrame: { maxHeight: 98, flexGrow: 0, borderRadius: 12, backgroundColor: PANEL_LIGHT },
  colorRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, padding: 10 },
  durRow: { flexDirection: "row", gap: 8 },
  durCell: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: PANEL_LIGHT, borderRadius: 10, borderWidth: 1, borderColor: LINE, paddingHorizontal: 10 },
  durInput: { flex: 1, minWidth: 0, width: 0, color: TEXT, fontSize: 18, fontWeight: "700", paddingVertical: 10, textAlign: "center" },
  durUnit: { color: MUTED, fontSize: 13, fontWeight: "700" },
  settingBox: { backgroundColor: PANEL, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, gap: 8 },
  customChip: { borderStyle: "dashed", borderColor: MUTED, backgroundColor: PANEL_LIGHT, ...centered },
  customPlus: { color: MUTED, fontSize: 16, lineHeight: 18, fontWeight: "700" },
  pickerRow: { flexDirection: "row", gap: 10 },
  svSquare: { flex: 1, height: 200, borderRadius: 10, overflow: "hidden" },
  hueBar: { width: 28, height: 200, borderRadius: 14, overflow: "hidden" },
  svThumb: { position: "absolute", width: 22, height: 22, borderRadius: 11, borderWidth: 3, borderColor: "#FFFFFF", marginLeft: -11, marginTop: -11, shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
  hueThumb: { position: "absolute", left: 0, right: 0, height: 8, borderRadius: 4, borderWidth: 2, borderColor: "#FFFFFF", marginTop: -4 },
  colorPreviewRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  colorPreview: { width: 44, height: 44, borderRadius: 12, borderWidth: 1, borderColor: LINE },
  colorChip: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: "transparent", ...centered },
  colorCheck: { fontSize: 14, lineHeight: 16, fontWeight: "900" },
  fieldRow: { flexDirection: "row", gap: 8 },
  field: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: PANEL_LIGHT, borderRadius: 10, paddingHorizontal: 10 },
  fieldLabel: { ...small, width: 28 },
  fieldInput: { flex: 1, minWidth: 0, width: 0, color: TEXT, fontSize: 15, fontWeight: "600", paddingVertical: 11 },
  buttonRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  button: { flex: 1, minHeight: 48, justifyContent: "center", borderRadius: 10, borderWidth: 1.5, paddingVertical: 12, alignItems: "center" },
  buttonText: { fontSize: 15 },
  alertRoot: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  alertBox: { width: "100%", maxWidth: 320, backgroundColor: PANEL, borderRadius: 16, borderWidth: 1, borderColor: LINE, padding: 16, gap: 8 },
  alertTitle: { color: TEXT, fontSize: 17, fontWeight: "700", textAlign: "center" },
  alertMessage: { color: MUTED, fontSize: 14, textAlign: "center", marginBottom: 4 },
  alertButton: { minHeight: 46, borderRadius: 10, backgroundColor: PANEL_LIGHT, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  alertButtonText: { color: ORANGE, fontSize: 16, fontWeight: "700" },});}
let styles = buildStyles();