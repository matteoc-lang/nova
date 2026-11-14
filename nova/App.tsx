import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, Animated, AppState, FlatList, Image, ImageBackground,
  Modal, PanResponder, Pressable, ScrollView, StatusBar, StyleSheet, Text,
  TextInput, View, useWindowDimensions
} from "react-native";
import { useEventListener } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import * as NavigationBar from "expo-navigation-bar";
import { NavigationContainer, DefaultTheme, createNavigationContainerRef } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import * as ScreenOrientation from "expo-screen-orientation";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import Slider from "@react-native-community/slider";
import { LinearGradient } from "expo-linear-gradient";

const C = {
  bg: "#08080b", surface: "#15151c", surface2: "#1d1d26", surface3: "#282833",
  line: "#30303c", text: "#f6f5f2", muted: "#a6a6b2", faint: "#70707c",
  red: "#e50914", green: "#2ee6a8", amber: "#ffb224"
};

const Stack = createNativeStackNavigator();
const navigationRef = createNavigationContainerRef<any>();
const AppCtx = createContext<any>(null);
const PlayerCtx = createContext<any>(null);
const useApp = () => useContext(AppCtx);
const usePlayer = () => useContext(PlayerCtx);
const navTheme = { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: C.bg, card: C.bg, text: C.text, primary: C.red, border: C.line } };

const defaultSettings = {
  streamMode: "auto", quality: "auto", audioLang: "it", subLang: "it", autoSub: true,
  autoplay: true, loop: false, speed: 1, posterSize: 150, thumbWide: true,
  animations: true, progressBars: true, stats: false, saveData: false,
  background: true, pip: true,
  subSize: 16, subBg: false, subColor: "#ffffff", subOutline: true, subBold: true,
  portraitZoom: 1.0, rotateBottom: true, fastStart: true
};

function fmt(sec: number) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0");
}

function normalizeServer(value: string) {
  let s = String(value || "").trim().replace(/\/+$/, "");
  if (!s) throw new Error("Inserisci l'URL del server.");
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  try { new URL(s); } catch { throw new Error("URL non valido."); }
  return s;
}

function authHeaders(token?: string) {
  const base = 'MediaBrowser Client="NOVA", Device="Android", DeviceId="nova-android", Version="3.2.0"';
  return { "Content-Type": "application/json", Authorization: token ? base + ', Token="' + token + '"' : base };
}

async function fetchWithTimeout(url: string, options: any = {}, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...options, signal: c.signal }); } finally { clearTimeout(t); }
}

async function testServer(input: string) {
  const server = normalizeServer(input);
  try {
    const r = await fetchWithTimeout(server + "/System/Info/Public", {}, 7000);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    return { server, name: j.ServerName || "Jellyfin", version: j.Version || "" };
  } catch (e: any) {
    if (e.name === "AbortError") throw new Error("Timeout: server non raggiungibile.");
    throw new Error("Rete o URL sbagliato: " + (e.message || "connessione fallita"));
  }
}

async function authenticate(input: string, username: string, password: string) {
  const server = normalizeServer(input);
  let r: Response;
  try {
    r = await fetchWithTimeout(server + "/Users/AuthenticateByName", {
      method: "POST", headers: authHeaders(), body: JSON.stringify({ Username: username, Pw: password })
    }, 12000);
  } catch (e: any) {
    throw new Error(e.name === "AbortError" ? "Timeout: server non raggiungibile." : "Server non raggiungibile.");
  }
  if (!r.ok) throw new Error(r.status === 401 ? "Credenziali non valide." : "Il server ha risposto " + r.status + ".");
  const j = await r.json();
  return { mode: "jellyfin", server, token: j.AccessToken, userId: j.User.Id, user: j.User?.Name || username };
}

const imageUrl = (s: any, id: string, type: string, w: number) =>
  s.server + "/Items/" + id + "/Images/" + type + "?maxWidth=" + w + "&quality=90&api_key=" + s.token;

function mapItem(s: any, x: any) {
  return {
    id: x.Id, type: x.Type === "Series" ? "series" : "movie", title: x.Name || "Senza titolo",
    year: x.ProductionYear || "", genres: x.Genres || [], overview: x.Overview || "",
    rating: x.OfficialRating || "T", match: Math.max(60, Math.min(99, Math.round((x.CommunityRating || 7) * 10 + 20))),
    duration: (x.RunTimeTicks || 0) / 1e7, cast: (x.People || []).slice(0, 5).map((p: any) => p.Name),
    added: Date.parse(x.DateCreated) || Date.now(),
    poster: imageUrl(s, x.Id, "Primary", 500), backdrop: imageUrl(s, x.Id, "Backdrop", 1280),
    hue: ((x.Name || "").length * 47) % 360
  };
}

function mapEpisode(s: any, x: any) {
  return {
    id: x.Id, seriesId: x.SeriesId, seriesName: x.SeriesName, season: x.ParentIndexNumber || 1,
    episode: x.IndexNumber || 1, title: x.Name || "Episodio", overview: x.Overview || "",
    duration: (x.RunTimeTicks || 0) / 1e7, thumb: imageUrl(s, x.Id, "Primary", 500), hue: 210
  };
}

async function loadLibrary(session: any) {
  const headers = authHeaders(session.token);
  const r = await fetch(session.server + "/Users/" + session.userId +
    "/Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=Overview,Genres,ProductionYear,CommunityRating,OfficialRating,DateCreated,People,RunTimeTicks,UserData", { headers });
  if (!r.ok) throw new Error("Libreria HTTP " + r.status);
  const j = await r.json();
  const items = (j.Items || []).map((x: any) => mapItem(session, x));
  const map: any = {}; items.forEach((i: any) => (map[i.id] = i));
  const progress: any = {}, epMap: any = {};
  for (const x of j.Items || []) {
    const ud = x.UserData;
    if (ud && ud.PlaybackPositionTicks > 0)
      progress[x.Id] = { position: ud.PlaybackPositionTicks / 1e7, duration: (x.RunTimeTicks || 0) / 1e7, updated: Date.now() };
  }
  try {
    const rr = await fetch(session.server + "/Users/" + session.userId +
      "/Items?Recursive=true&IncludeItemTypes=Episode,Movie&Filters=IsResumable&Fields=UserData,RunTimeTicks,SeriesName,SeriesId,ParentIndexNumber,IndexNumber", { headers });
    const jj = await rr.json();
    for (const x of jj.Items || []) {
      if (x.Type === "Episode") {
        const ep = mapEpisode(session, x); epMap[ep.id] = ep;
        if (!map[ep.seriesId]) {
          map[ep.seriesId] = { id: ep.seriesId, type: "series", title: ep.seriesName || "Serie", year: "", genres: [], overview: "", rating: "T", match: 90, duration: 0, cast: [], added: Date.now(), poster: imageUrl(session, ep.seriesId, "Primary", 500), backdrop: imageUrl(session, ep.seriesId, "Backdrop", 1280), hue: 210 };
          items.push(map[ep.seriesId]);
        }
      }
      if (x.UserData && x.UserData.PlaybackPositionTicks > 0)
        progress[x.Id] = { position: x.UserData.PlaybackPositionTicks / 1e7, duration: (x.RunTimeTicks || 0) / 1e7, updated: Date.now() };
    }
  } catch {}
  let nextUp: any[] = [];
  try {
    const nr = await fetch(session.server + "/Shows/NextUp?userId=" + session.userId +
      "&Fields=UserData,RunTimeTicks,SeriesId,SeriesName,ParentIndexNumber,IndexNumber", { headers });
    const nj = await nr.json();
    nextUp = (nj.Items || []).map((x: any) => {
      const ep = mapEpisode(session, x); epMap[ep.id] = ep;
      return { item: map[ep.seriesId], ep };
    }).filter((x: any) => x.item);
  } catch {}
  return { items, map, epMap, progress, nextUp };
}

async function loadSeasons(session: any, item: any) {
  if (session.mode === "demo") return item.seasons || [];
  const r = await fetch(session.server + "/Shows/" + item.id + "/Episodes?userId=" + session.userId +
    "&Fields=Overview,RunTimeTicks,UserData", { headers: authHeaders(session.token) });
  if (!r.ok) throw new Error("Episodi HTTP " + r.status);
  const j = await r.json();
  const by: any = {};
  for (const x of j.Items || []) {
    const ep = mapEpisode(session, x);
    if (!by[ep.season]) by[ep.season] = { n: ep.season, name: "Stagione " + ep.season, episodes: [] };
    by[ep.season].episodes.push(ep);
  }
  return Object.values(by).sort((a: any, b: any) => a.n - b.n)
    .map((s: any) => ({ ...s, episodes: s.episodes.sort((a: any, b: any) => a.episode - b.episode) }));
}

function isTextSub(s: any) {
  if (s?.IsTextSubtitleStream === true) return true;
  if (s?.IsTextSubtitleStream === false) return false;
  return /^(srt|subrip|ass|ssa|webvtt|vtt|mov_text|text)$/i.test(String(s?.Codec || ""));
}

async function fetchSubtitleText(session: any, itemId: string, mediaSourceId: string, index: number) {
  const base = session.server + "/Videos/" + itemId + "/" + mediaSourceId + "/Subtitles/" + index + "/Stream";
  let lastErr = "nessuna risposta";
  for (const ext of [".vtt", ".srt"]) {
    try {
      const r = await fetchWithTimeout(base + ext + "?api_key=" + session.token, {}, 25000);
      if (r.ok) {
        const t = await r.text();
        if (t && t.trim()) return t;
        lastErr = "file vuoto";
      } else lastErr = "HTTP " + r.status;
    } catch (e: any) {
      lastErr = e.name === "AbortError" ? "timeout (estrazione lato server)" : (e.message || "errore rete");
    }
  }
  throw new Error(lastErr);
}

function parseTimestamp(s: string) {
  const m = String(s).trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4].padEnd(3, "0"), 10) / 1000;
}

function cleanSubText(lines: string[]) {
  return lines.join("\n").replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "").replace(/\{[^}]*\}/g, "")
    .replace(/\\N/g, "\n").replace(/\\n/g, "\n").trim();
}

function parseSubtitles(raw: string) {
  const text = String(raw || "").replace(/\r/g, "").replace(/^\uFEFF/, "");
  const cues: { start: number; end: number; text: string }[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n").filter(l => l.trim() !== "");
    if (!lines.length || /^(WEBVTT|NOTE|STYLE|REGION)/i.test(lines[0])) continue;
    let i = 0;
    if (!lines[i].includes("-->")) i = 1;
    if (i >= lines.length || !lines[i].includes("-->")) continue;
    const parts = lines[i].split("-->");
    const start = parseTimestamp(parts[0]);
    const end = parseTimestamp(parts[1]);
    if (start == null || end == null) continue;
    const body = cleanSubText(lines.slice(i + 1));
    if (body) cues.push({ start, end, text: body });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

function activeCueText(cues: any[], t: number) {
  if (!cues.length) return "";
  const out: string[] = [];
  for (const c of cues) {
    if (c.start > t + 0.05) break;
    if (t >= c.start && t <= c.end && !out.includes(c.text)) out.push(c.text);
  }
  return out.join("\n");
}

/* Profilo molto permissivo: ExoPlayer decodifica quasi tutto in locale.
   Se il device non ce la fa, scatta il fallback automatico al transcoding. */
function nativeProfile(force: boolean, bitrate: number) {
  return {
    MaxStreamingBitrate: bitrate,
    MaxStaticBitrate: 400000000,
    DirectPlayProfiles: force ? [] : [
      {
        Container: "mp4,m4v,mov,mkv,webm,avi,ts,m2ts,mts,flv,mpg,mpeg,wmv",
        Type: "Video",
        VideoCodec: "h264,hevc,h265,vp8,vp9,av1,mpeg4,mpeg2video",
        AudioCodec: "aac,mp3,mp2,ac3,eac3,dts,truehd,opus,flac,vorbis,alac,pcm_s16le,pcm_s24le"
      }
    ],
    TranscodingProfiles: [
      { Container: "ts", Type: "Video", VideoCodec: "h264", AudioCodec: "aac", Context: "Streaming", Protocol: "hls", MaxAudioChannels: "6", MinSegments: "1", BreakOnNonKeyFrames: true }
    ],
    SubtitleProfiles: [
      { Format: "srt", Method: "External" }, { Format: "vtt", Method: "External" },
      { Format: "ass", Method: "External" }, { Format: "ssa", Method: "External" }
    ]
  };
}

async function getPlayback(session: any, itemId: string, settings: any, opts: any = {}) {
  if (session.mode === "demo") {
    return {
      id: itemId, url: opts.demoUrl, method: "DirectPlay", hls: false, quality: opts.quality || "auto",
      duration: opts.duration || 0, audio: [{ Index: 0, DisplayTitle: "Originale · AAC", Language: "eng" }],
      subs: [], audioIndex: 0, mediaSourceId: "demo", playSessionId: "demo", reason: "Demo", startOffset: 0
    };
  }
  const quality = opts.quality || settings.quality || "auto";
  const rates: any = { auto: 120000000, 2160: 60000000, 1080: 12000000, 720: 5000000, 480: 2000000, 360: 900000 };
  let bitrate = rates[quality] || 120000000;
  if (settings.saveData && quality === "auto") bitrate = 4000000;
  const startSeconds = Math.max(0, opts.startSeconds || 0);
  const explicitAudio = opts.audioIndex != null ? opts.audioIndex : null;
  const force = !!opts.force || settings.streamMode === "transcode" || quality !== "auto" || explicitAudio != null;

  const body: any = {
    DeviceProfile: nativeProfile(force, bitrate), AutoOpenLiveStream: true, MaxStreamingBitrate: bitrate,
    EnableDirectPlay: !force, EnableDirectStream: true, EnableTranscoding: true,
    AllowVideoStreamCopy: true, AllowAudioStreamCopy: true
  };
  if (explicitAudio != null) body.AudioStreamIndex = explicitAudio;
  if (startSeconds > 0) body.StartTimeTicks = Math.round(startSeconds * 1e7);

  const r = await fetch(session.server + "/Items/" + itemId + "/PlaybackInfo?userId=" + session.userId, {
    method: "POST", headers: authHeaders(session.token), body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error("PlaybackInfo HTTP " + r.status);
  const j = await r.json();
  const ms = j.MediaSources && j.MediaSources[0];
  if (!ms) throw new Error("Nessuna MediaSource disponibile.");
  const audio = (ms.MediaStreams || []).filter((s: any) => s.Type === "Audio");
  const subs = (ms.MediaStreams || []).filter((s: any) => s.Type === "Subtitle");
  let ai = explicitAudio;
  if (ai == null) {
    const pref = audio.find((a: any) => String(a.Language || "").toLowerCase().startsWith(settings.audioLang));
    ai = pref ? pref.Index : ms.DefaultAudioStreamIndex != null ? ms.DefaultAudioStreamIndex : audio[0]?.Index ?? null;
  }
  let url: string, method: string;
  if (!force && ms.SupportsDirectPlay) {
    url = session.server + "/Videos/" + itemId + "/stream?static=true&mediaSourceId=" + ms.Id + "&api_key=" + session.token;
    method = "DirectPlay";
  } else if (ms.TranscodingUrl) {
    url = ms.TranscodingUrl.startsWith("http") ? ms.TranscodingUrl : session.server + ms.TranscodingUrl;
    if (!/[?&]api_key=/.test(url)) url += (url.includes("?") ? "&" : "?") + "api_key=" + session.token;
    method = force ? "Transcode" : "DirectStream";
  } else {
    url = session.server + "/Videos/" + itemId + "/stream?static=true&mediaSourceId=" + ms.Id + "&api_key=" + session.token;
    method = "DirectPlay";
  }
  const hls = /\.m3u8/i.test(url);
  return {
    id: itemId, url, method, hls, quality, duration: (ms.RunTimeTicks || 0) / 1e7,
    audio, subs, audioIndex: ai, mediaSourceId: ms.Id, playSessionId: j.PlaySessionId,
    reason: force ? "Transcoding" : (method === "DirectPlay" ? "Direct Play (nessuna conversione)" : "Direct Stream (remux)"),
    startOffset: hls && startSeconds > 0 ? startSeconds : 0
  };
}

async function reportPlayback(session: any, kind: string, info: any, position: number, paused: boolean) {
  if (!session || session.mode !== "jellyfin" || !info) return;
  const path = kind === "start" ? "/Sessions/Playing" : kind === "stop" ? "/Sessions/Playing/Stopped" : "/Sessions/Playing/Progress";
  try {
    await fetch(session.server + path, {
      method: "POST", headers: authHeaders(session.token),
      body: JSON.stringify({
        ItemId: info.id, MediaSourceId: info.mediaSourceId, PlaySessionId: info.playSessionId,
        PositionTicks: Math.round((position || 0) * 1e7), PlayMethod: info.method, CanSeek: true, IsPaused: paused
      })
    });
  } catch {}
}

function demoLibrary() {
  const V = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/";
  const vids: any = { a: V + "BigBuckBunny.mp4", b: V + "ElephantsDream.mp4", c: V + "Sintel.mp4", d: V + "TearsOfSteel.mp4" };
  const dur: any = { a: 596, b: 653, c: 888, d: 734 };
  const now = Date.now(), day = 86400000;
  const movie = (id: string, title: string, year: number, genres: string[], hue: number, v: string, match: number, overview: string, days: number) =>
    ({ id, type: "movie", title, year, genres, hue, video: vids[v], duration: dur[v], match, overview, cast: ["Cast demo"], rating: "T", added: now - days * day });
  const eps = (sid: string, sn: number, titles: string[], hue: number) => titles.map((title, i) => {
    const v = "abcd"[i % 4];
    return { id: sid + "-" + sn + "-" + (i + 1), seriesId: sid, season: sn, episode: i + 1, title, overview: "Un nuovo tassello si incastra nel mosaico.", duration: dur[v], video: vids[v], hue };
  });
  const series = (id: string, title: string, year: number, genres: string[], hue: number, match: number, overview: string, seasons: any[], days: number) =>
    ({ id, type: "series", title, year, genres, hue, match, overview, cast: ["Cast demo"], rating: "T", added: now - days * day, seasons });
  const items = [
    movie("orbita", "Orbita Nera", 2025, ["Fantascienza", "Thriller"], 210, "d", 98, "Una stazione orbitante smette di rispondere alla Terra.", 2),
    movie("neon", "Neon Requiem", 2024, ["Thriller", "Azione"], 350, "c", 96, "Un detective insegue un fantasma digitale tra i vicoli al neon.", 9),
    movie("codice", "Codice Rosso", 2025, ["Azione"], 18, "a", 88, "Un'ex agente deve fermare un attacco informatico globale.", 4),
    movie("mare", "Sotto la Pelle del Mare", 2024, ["Documentario"], 175, "c", 89, "Tre anni di riprese negli abissi del Mediterraneo.", 12),
    movie("vela", "Vela Solare", 2022, ["Animazione", "Avventura"], 55, "a", 87, "Una piccola sonda parte per un viaggio oltre il sistema solare.", 90),
    series("cieli", "I Cieli di Ferro", 2024, ["Fantascienza", "Drammatico"], 205, 97, "Le città volano su piattaforme di ferro.", [
      { n: 1, name: "Stagione 1", episodes: eps("cieli", 1, ["Il decollo", "Sotto le nuvole", "Ferro e cielo", "La caduta", "Vecchie rotte", "Il segnale"], 205) },
      { n: 2, name: "Stagione 2", episodes: eps("cieli", 2, ["Ritorno a bordo", "La città fantasma", "Gravità zero", "Il patto", "Punto di fuga", "Cieli aperti"], 225) }
    ], 3),
    series("palude", "Palude", 2023, ["Thriller", "Giallo"], 150, 94, "Un paese di nebbia e canali, una serie di sparizioni.", [
      { n: 1, name: "Stagione 1", episodes: eps("palude", 1, ["Acqua alta", "Il canale", "Nebbia", "Radici", "La chiusa", "Marea"], 150) }
    ], 20)
  ];
  const map: any = {}, epMap: any = {};
  items.forEach((it: any) => { map[it.id] = it; (it.seasons || []).forEach((s: any) => s.episodes.forEach((e: any) => (epMap[e.id] = e))); });
  return { items, map, epMap, progress: { neon: { position: 412, duration: 888, updated: now - 2 * day }, "cieli-1-3": { position: 300, duration: 888, updated: now - day } }, nextUp: [{ item: map.cieli, ep: epMap["cieli-1-4"] }] };
}

const isWatched = (p: any) => p && p.duration > 0 && p.position / p.duration >= 0.92;

function findNextEpisode(seasons: any[], ep: any) {
  if (!ep) return null;
  for (let i = 0; i < seasons.length; i++) {
    const idx = seasons[i].episodes.findIndex((e: any) => e.id === ep.id);
    if (idx >= 0) return seasons[i].episodes[idx + 1] || seasons[i + 1]?.episodes?.[0] || null;
  }
  return null;
}

function targetEpisode(seasons: any[], progress: any) {
  for (const s of seasons || []) for (const e of s.episodes || []) {
    const p = progress[e.id];
    if (p && p.position > 5 && !isWatched(p)) return e;
  }
  return seasons?.[0]?.episodes?.[0] || null;
}

function pickFeatured(items: any[], progress: any, epMap: any, list: string[]) {
  if (!items.length) return null;
  const w: any = {}; let history = 0;
  const bump = (it: any, amount: number) => { if (!it) return; history++; (it.genres || []).forEach((g: string) => (w[g] = (w[g] || 0) + amount)); };
  items.forEach((it: any) => {
    const p = progress[it.id];
    if (p && p.duration > 0 && p.position / p.duration > 0.08) bump(it, 2);
    if (list.includes(it.id)) bump(it, 1);
  });
  Object.keys(progress).forEach(id => { const ep = epMap[id]; if (ep) bump(items.find((i: any) => i.id === ep.seriesId), 2); });
  if (!history) return items[Math.floor(Math.random() * items.length)];
  const scored = items.map((it: any) => {
    let s = 0; (it.genres || []).forEach((g: string) => (s += w[g] || 0));
    s += (it.match || 80) / 25;
    if (isWatched(progress[it.id])) s -= 8;
    return { it, s };
  }).sort((a: any, b: any) => b.s - a.s);
  const pool = scored.slice(0, 8);
  return pool[Math.floor(Math.random() * pool.length)].it;
}

function IconButton({ name, onPress, size = 22, style, active }: any) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.iconButton, (pressed || active) && styles.pressed, style]}>
      <Ionicons name={name} size={size} color={C.text} />
    </Pressable>
  );
}

function Face({ size = 36 }: any) {
  return <View style={[styles.face, { width: size, height: size, borderRadius: size * 0.22 }]}><Ionicons name="happy" size={size * 0.72} color="#fff" /></View>;
}

function Poster({ item, wide, ep, progress }: any) {
  const primary = wide ? (ep?.thumb || item.backdrop || item.poster) : item.poster;
  const fallback = item.backdrop || item.poster;
  const [uri, setUri] = useState(primary);
  useEffect(() => { setUri(primary); }, [primary]);
  const p = progress;
  const pct = p && p.duration ? Math.max(0, Math.min(100, (p.position / p.duration) * 100)) : 0;
  return (
    <View style={[styles.poster, wide ? styles.posterWide : styles.posterTall]}>
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => { if (uri !== fallback) setUri(fallback); }} />
        : <View style={[StyleSheet.absoluteFill, styles.posterFallback, { backgroundColor: "hsl(" + (item.hue || 210) + ",55%,22%)" }]}><Text style={styles.posterFallbackTitle}>{item.title}</Text></View>}
      {!!ep && <View style={styles.epBadge}><Text style={styles.epBadgeText}>S{ep.season} · E{ep.episode}</Text></View>}
      {pct > 0 && <View style={styles.progressTrack}><View style={[styles.progressFill, { width: pct + "%" }]} /></View>}
      {wide && <View style={styles.wideLabel}><Text numberOfLines={1} style={styles.wideLabelTitle}>{ep ? ep.title : item.title}</Text>{!!ep && <Text numberOfLines={1} style={styles.wideLabelSub}>{item.title}</Text>}</View>}
    </View>
  );
}

function MediaCard({ item, ep, wide, onPress, onLongPress, progress, width }: any) {
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={350} style={({ pressed }) => [styles.card, { width }, pressed && styles.cardPressed]}>
      <Poster item={item} ep={ep} wide={wide} progress={progress} />
    </Pressable>
  );
}

function Row({ title, data, renderItem, keyExtractor }: any) {
  if (!data || !data.length) return null;
  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>{title}</Text>
      <FlatList horizontal data={data} keyExtractor={keyExtractor} renderItem={renderItem} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rowContent} ItemSeparatorComponent={() => <View style={{ width: 10 }} />} />
    </View>
  );
}

function MenuItem({ label, value, selected, disabled, onPress }: any) {
  return (
    <Pressable onPress={disabled ? undefined : onPress} style={[styles.menuItem, disabled && { opacity: 0.45 }]}>
      <Text style={styles.menuItemText}>{label}</Text>
      <Text style={styles.menuValue}>{selected ? "✓" : value || ""}</Text>
    </Pressable>
  );
}

function MenuToggle({ label, value, onToggle }: any) {
  return (
    <Pressable onPress={onToggle} style={styles.menuItem}>
      <Text style={styles.menuItemText}>{label}</Text>
      <View style={[styles.switch, value && styles.switchOn]}><View style={[styles.switchKnob, value && styles.switchKnobOn]} /></View>
    </Pressable>
  );
}

function MenuHeader({ title, onBack, onClose }: any) {
  return (
    <View style={styles.menuHeader}>
      <IconButton name="chevron-back" size={20} onPress={onBack} />
      <Text style={styles.menuHeaderText}>{title}</Text>
      <View style={{ flex: 1 }} />
      <IconButton name="close" size={20} onPress={onClose} />
    </View>
  );
}

function AppStatusBar() {
  const P = usePlayer();
  return <StatusBar hidden={P.mode === "full"} barStyle="light-content" backgroundColor="transparent" translucent />;
}

function PlayerProvider({ children }: any) {
  const { session, settings, saveProgress, progress } = useApp();
  const player = useVideoPlayer(null, p => { p.loop = false; });

  const [mode, setMode] = useState<"closed" | "full" | "mini">("closed");
  const [item, setItem] = useState<any>(null);
  const [episode, setEpisode] = useState<any>(null);
  const [info, setInfo] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrub, setScrub] = useState(0);
  const [cues, setCues] = useState<any[]>([]);
  const [subIndex, setSubIndex] = useState<number | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [ended, setEnded] = useState(false);
  const [nextEp, setNextEp] = useState<any>(null);
  const [videoSize, setVideoSize] = useState({ w: 16, h: 9 });
  const [landscape, setLandscape] = useState(false);
  const [controls, setControls] = useState(true);
  const [menu, setMenu] = useState<string | null>(null);
  const [fit, setFit] = useState<"contain" | "cover">("contain");

  const baseOffset = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const seekLock = useRef(0);
  const scrubbingRef = useRef(false);
  const finishedRef = useRef(false);
  const retried = useRef(false);
  const lastSave = useRef(0);
  const positionRef = useRef(0);
  const infoRef = useRef<any>(null);
  const optsRef = useRef<any>({});
  const itemRef = useRef<any>(null);
  const episodeRef = useRef<any>(null);
  const subIndexRef = useRef<number | null>(null);
  const subLangRef = useRef("");
  const noticeTimer = useRef<any>(null);
  const playingRef = useRef(false);
  const settingsRef = useRef(settings);

  useEffect(() => { infoRef.current = info; }, [info]);
  useEffect(() => { itemRef.current = item; }, [item]);
  useEffect(() => { episodeRef.current = episode; }, [episode]);
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => { subIndexRef.current = subIndex; }, [subIndex]);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  useEffect(() => {
    try { (player as any).timeUpdateEventInterval = 0.25; } catch {}
    try { player.staysActiveInBackground = true; } catch {}
    try { (player as any).showNowPlayingNotification = true; } catch {}
  }, [player]);

  /* Buffer aggressivo: parte quasi subito invece di attendere il riempimento */
  useEffect(() => {
    try {
      (player as any).bufferOptions = {
        preferredForwardBufferDuration: settings.fastStart ? 25 : 50,
        minBufferForPlayback: settings.fastStart ? 1 : 5,
        waitsForMinBufferDuration: !settings.fastStart,
        prioritizeTimeOverSizeThresholds: true
      };
    } catch {}
  }, [player, settings.fastStart]);

  useEffect(() => {
    try { player.playbackRate = settings.speed; } catch {}
    try { player.loop = settings.loop; } catch {}
    try { player.staysActiveInBackground = !!settings.background; } catch {}
  }, [settings.speed, settings.loop, settings.background, player]);

  useEffect(() => {
    if (mode === "full") {
      NavigationBar.setVisibilityAsync("hidden").catch(() => {});
      NavigationBar.setBehaviorAsync("overlay-swipe").catch(() => {});
    } else {
      NavigationBar.setVisibilityAsync("visible").catch(() => {});
    }
    return () => { NavigationBar.setVisibilityAsync("visible").catch(() => {}); };
  }, [mode]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", state => {
      if (state !== "active" && playingRef.current && settingsRef.current.pip) {
        const p = player as any;
        try { if (typeof p.enterPictureInPicture === "function") p.enterPictureInPicture(); else if (typeof p.startPictureInPicture === "function") p.startPictureInPicture(); } catch {}
      }
    });
    return () => sub.remove();
  }, [player]);

  useEffect(() => () => {
    ScreenOrientation.unlockAsync().catch(() => {});
    NavigationBar.setVisibilityAsync("visible").catch(() => {});
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  function flash(msg: string) {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 3000);
  }

  async function loadSubTrack(stream: any, silent = false) {
    const inf = infoRef.current;
    if (!inf || !stream) return;
    if (session.mode === "demo") { if (!silent) flash("Nessun sottotitolo nella demo."); return; }
    if (!isTextSub(stream)) { if (!silent) flash("Sottotitoli grafici (PGS): non supportati senza transcoding."); return; }
    setSubLoading(true);
    if (!silent) flash("Carico i sottotitoli… il video continua.");
    try {
      const raw = await fetchSubtitleText(session, inf.id, inf.mediaSourceId, stream.Index);
      const parsed = parseSubtitles(raw);
      if (!parsed.length) throw new Error("nessuna battuta leggibile");
      setCues(parsed); setSubIndex(stream.Index);
      subIndexRef.current = stream.Index; subLangRef.current = String(stream.Language || "");
      if (!silent) flash("Sottotitoli: " + (stream.DisplayTitle || stream.Language || "attivi"));
    } catch (e: any) {
      setCues([]); setSubIndex(null); subIndexRef.current = null;
      if (!silent) flash("Sottotitoli: " + (e.message || "errore"));
    } finally { setSubLoading(false); }
  }

  async function load(opts: any = {}, itArg = itemRef.current, epArg = episodeRef.current, startAt = 0) {
    if (!itArg || !session) return;
    setLoading(true); setError(""); setEnded(false);
    optsRef.current = { ...optsRef.current, ...opts };
    seekLock.current = Date.now() + 1000;
    try {
      const inf = await getPlayback(session, epArg ? epArg.id : itArg.id, settingsRef.current, {
        ...optsRef.current, startSeconds: startAt, demoUrl: epArg?.video || itArg.video, duration: epArg?.duration || itArg.duration
      });
      infoRef.current = inf; setInfo(inf);
      setDuration(inf.duration || epArg?.duration || itArg.duration || 0);
      baseOffset.current = inf.startOffset || 0;
      pendingSeek.current = inf.hls ? null : startAt;
      setPosition(startAt); positionRef.current = startAt;

      const metaTitle = epArg ? `${epArg.title}` : itArg.title;
      const metaArtist = epArg ? `${itArg.title} · S${epArg.season}:E${epArg.episode}` : (itArg.year ? String(itArg.year) : "NOVA");
      player.replace({ uri: inf.url, metadata: { title: metaTitle, artist: metaArtist, artwork: itArg.poster || itArg.backdrop } });

      const s = settingsRef.current;
      if (subIndexRef.current != null) {
        const match = (inf.subs || []).find((x: any) => x.Index === subIndexRef.current) || (inf.subs || []).find((x: any) => String(x.Language || "") === subLangRef.current && isTextSub(x));
        if (match) loadSubTrack(match, true); else { setCues([]); setSubIndex(null); subIndexRef.current = null; }
      } else if (s.autoSub) {
        const pref = (inf.subs || []).find((x: any) => String(x.Language || "").toLowerCase().startsWith(s.subLang) && isTextSub(x));
        if (pref) loadSubTrack(pref, true);
      }
    } catch (e: any) { setError(e.message || "Errore di riproduzione."); setLoading(false); }
  }

  async function open(it: any, ep: any = null, startAt?: number) {
    if (!it) return;
    let e = ep;
    if (it.type === "series" && !e) { try { const ss = await loadSeasons(session, it); e = targetEpisode(ss, progress); } catch {} }
    setItem(it); itemRef.current = it; setEpisode(e); episodeRef.current = e;
    setMode("full"); setStarted(false); setControls(true); setCues([]); setSubIndex(null);
    subIndexRef.current = null; subLangRef.current = ""; finishedRef.current = false; retried.current = false; optsRef.current = {};
    const id = e ? e.id : it.id;
    const start = startAt != null ? startAt : (isWatched(progress[id]) ? 0 : (progress[id]?.position || 0));
    await load({}, it, e, start);
  }

  function minimize() { setMode("mini"); setMenu(null); setLandscape(false); ScreenOrientation.unlockAsync().catch(() => {}); }
  function expand() { setMode("full"); setControls(true); }
  function close() {
    try { player.pause(); } catch {}
    if (infoRef.current) reportPlayback(session, "stop", infoRef.current, positionRef.current, true);
    setMode("closed"); setMenu(null); setEnded(false); setCues([]); setSubIndex(null); subIndexRef.current = null;
    ScreenOrientation.unlockAsync().catch(() => {}); setLandscape(false);
  }

  useEventListener(player, "statusChange", ({ status, error: err }: any) => {
    if (status === "readyToPlay") {
      setBuffering(false); setLoading(false); setStarted(true);
      try { const vt = player.videoTrack; if (vt?.width && vt?.height) setVideoSize({ w: vt.width, h: vt.height }); } catch {}
      if (pendingSeek.current != null) { const t = pendingSeek.current; pendingSeek.current = null; try { player.currentTime = t; } catch {} }
      try { player.play(); } catch {}
    } else if (status === "loading") setBuffering(true);
    else if (status === "error") {
      setBuffering(false);
      if (!retried.current && infoRef.current?.method !== "Transcode") {
        retried.current = true; flash("Formato non supportato: transcoding…");
        load({ force: true }, itemRef.current, episodeRef.current, positionRef.current);
      } else { setError(err?.message || "Stream non decodificabile."); setLoading(false); }
    }
  });

  useEventListener(player, "videoTrackChange", ({ videoTrack }: any) => { if (videoTrack?.width && videoTrack?.height) setVideoSize({ w: videoTrack.width, h: videoTrack.height }); });

  useEventListener(player, "timeUpdate", ({ currentTime }: any) => {
    if (scrubbingRef.current || Date.now() < seekLock.current) return;
    const pos = baseOffset.current + (currentTime || 0);
    positionRef.current = pos; setPosition(pos);
    const dur = infoRef.current?.duration || player.duration || 0;
    if (dur > 0) setDuration(dur);
    const it = itemRef.current; if (!it) return;
    const id = episodeRef.current ? episodeRef.current.id : it.id;
    if (Date.now() - lastSave.current > 5000 && dur > 0) { lastSave.current = Date.now(); saveProgress(id, pos, dur); }
    if (dur > 0 && pos >= dur - 1 && !finishedRef.current) { finishedRef.current = true; handleEnd(); }
  });

  useEventListener(player, "playingChange", ({ isPlaying }: any) => setPlaying(!!isPlaying));

  useEffect(() => {
    if (!info) return;
    reportPlayback(session, "start", info, positionRef.current, false);
    const t = setInterval(() => reportPlayback(session, "progress", info, positionRef.current, !playingRef.current), 10000);
    return () => clearInterval(t);
  }, [info?.url]);

  useEffect(() => {
    if (mode !== "full" || !landscape || !controls || !playing || menu || loading) return;
    const t = setTimeout(() => setControls(false), 4000);
    return () => clearTimeout(t);
  }, [mode, landscape, controls, playing, menu, loading]);

  useEffect(() => {
    if (!ended || !nextEp || !settings.autoplay) return;
    const t = setTimeout(() => playEpisode(nextEp), 8000);
    return () => clearTimeout(t);
  }, [ended, nextEp, settings.autoplay]);

  async function handleEnd() {
    const it = itemRef.current; if (!it) return;
    const id = episodeRef.current ? episodeRef.current.id : it.id;
    const dur = infoRef.current?.duration || duration;
    saveProgress(id, dur, dur);
    let nx = null;
    if (it.type === "series" && episodeRef.current) { try { const ss = await loadSeasons(session, it); nx = findNextEpisode(ss, episodeRef.current); } catch {} }
    setNextEp(nx); setEnded(true);
  }

  function beginScrub() { scrubbingRef.current = true; setScrubbing(true); setScrub(positionRef.current); }
  function endScrub(target: number) {
    const dur = infoRef.current?.duration || duration || 0;
    const T = Math.max(0, Math.min(target, dur > 0 ? dur - 0.25 : target));
    scrubbingRef.current = false; setScrubbing(false);
    seekLock.current = Date.now() + 1000;
    setPosition(T); positionRef.current = T; finishedRef.current = false; setEnded(false);
    if (infoRef.current?.hls) load(optsRef.current, itemRef.current, episodeRef.current, T);
    else { try { player.currentTime = T; } catch {} }
  }

  function togglePlay() { try { if (playing) player.pause(); else player.play(); } catch {} setControls(true); }

  async function rotate() {
    try {
      if (landscape) { await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP); setLandscape(false); }
      else { await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE_RIGHT); setLandscape(true); }
    } catch {}
    setControls(true);
  }

  async function switchAudio(index: number) { setMenu(null); flash("Cambio audio…"); await load({ audioIndex: index, force: true }, itemRef.current, episodeRef.current, positionRef.current); }
  function selectSub(stream: any | null) {
    setMenu(null);
    if (!stream) { setCues([]); setSubIndex(null); subIndexRef.current = null; subLangRef.current = ""; flash("Sottotitoli disattivati"); return; }
    loadSubTrack(stream);
  }
  function setQuality(q: string) { setMenu(null); flash("Qualità: " + (q === "auto" ? "auto" : q + "p")); load({ quality: q, force: q !== "auto" }, itemRef.current, episodeRef.current, positionRef.current); }
  function playEpisode(ep: any) {
    setEnded(false); setNextEp(null); setEpisode(ep); episodeRef.current = ep;
    finishedRef.current = false; retried.current = false; optsRef.current = {}; setCues([]);
    load({}, itemRef.current, ep, 0);
  }

  const value = {
    player, mode, item, episode, info, loading, buffering, started, error, playing,
    position, duration, scrubbing, scrub, cues, subIndex, subLoading, notice, ended,
    nextEp, videoSize, landscape, controls, menu, fit,
    setControls, setMenu, setScrub, setFit,
    open, close, minimize, expand, togglePlay, beginScrub, endScrub, rotate,
    switchAudio, selectSub, setQuality, playEpisode, flash
  };
  return <PlayerCtx.Provider value={value}>{children}</PlayerCtx.Provider>;
}

function PlayerOverlay() {
  const P = usePlayer();
  const { settings, setSettings, items, list, toggleList } = useApp();
  const dim = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isLandscape = P.landscape || dim.width > dim.height;
  const drag = useRef(new Animated.Value(0)).current;

  useEffect(() => { if (P.mode === "full") drag.setValue(0); }, [P.mode]);

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, g) => !isLandscape && g.dy > 12 && Math.abs(g.dy) > Math.abs(g.dx) * 1.3,
    onPanResponderMove: (_, g) => drag.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_, g) => {
      if (g.dy > 100 || g.vy > 0.8) {
        Animated.timing(drag, { toValue: dim.height, duration: 190, useNativeDriver: true }).start(() => { drag.setValue(0); P.minimize(); });
      } else Animated.spring(drag, { toValue: 0, useNativeDriver: true, friction: 7, tension: 60 }).start();
    },
    onPanResponderTerminate: () => Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start()
  })).current;

  const itemId = P.item?.id;
  const epId = P.episode?.id;
  const infoUrl = P.info?.url;
  const inList = itemId ? list.includes(itemId) : false;

  /* Pannello informativo memoizzato: non si ri-renderizza a ogni tick di posizione */
  const infoPanel = useMemo(() => {
    if (!P.item) return null;
    const similar = items.filter((x: any) => x.id !== P.item.id && x.genres.some((g: string) => P.item.genres.includes(g))).slice(0, 6);
    const activeAudio = P.info?.audio?.find((a: any) => a.Index === P.info.audioIndex);
    const activeSub = (P.info?.subs || []).find((s: any) => s.Index === P.subIndex);
    return (
      <ScrollView style={styles.infoPanel} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }}>
        <Text style={styles.infoTitle}>{P.episode ? P.episode.title : P.item.title}</Text>
        <Text style={styles.infoSub}>{P.episode ? `${P.item.title} · S${P.episode.season}:E${P.episode.episode}` : `${P.item.year} · ${P.item.genres.join(", ")}`}</Text>
        <View style={styles.metaRow}>
          <Text style={styles.match}>{P.item.match}% compatibile</Text>
          <Text style={styles.badge}>{P.item.rating}</Text>
          <Text style={styles.badge}>{P.info?.method || "—"}</Text>
        </View>
        <View style={[styles.actions, { marginVertical: 14 }]}>
          <Pressable onPress={() => toggleList(P.item.id)} style={[styles.roundButton, inList && styles.roundOn]}><Ionicons name={inList ? "checkmark" : "add"} size={24} color={inList ? C.green : "#fff"} /></Pressable>
          <Pressable onPress={() => { P.minimize(); if (navigationRef.isReady()) navigationRef.navigate("Detail", { itemId: P.item.id }); }} style={styles.ghostButton}><Ionicons name="information-circle-outline" size={20} color="#fff" /><Text style={styles.ghostButtonText}>Dettagli</Text></Pressable>
        </View>
        {!!P.episode?.overview && <Text style={styles.infoDesc}>{P.episode.overview}</Text>}
        {!!P.item.overview && <Text style={styles.infoDesc}>{P.item.overview}</Text>}
        <Text style={styles.facts}><Text style={styles.faint}>Generi: </Text>{P.item.genres.join(", ") || "–"}</Text>
        <Text style={styles.facts}><Text style={styles.faint}>Cast: </Text>{(P.item.cast || []).join(", ") || "–"}</Text>
        {settings.stats && P.info && (
          <View style={styles.statsInline}>
            <Text style={styles.statsTitle}>STATISTICHE</Text>
            <Text style={styles.statsLine}>Metodo {P.info.method} · Qualità {P.info.quality}</Text>
            <Text style={styles.statsLine}>Audio {activeAudio?.DisplayTitle || "default"}</Text>
            <Text style={styles.statsLine}>Sub {activeSub?.DisplayTitle || "off"} · {P.cues.length} battute</Text>
            <Text style={styles.statsLine}>{P.info.reason}</Text>
          </View>
        )}
        {!!similar.length && (
          <>
            <Text style={styles.sectionTitle}>Altri titoli simili</Text>
            <View style={styles.similarGrid}>
              {similar.map((x: any) => <View key={x.id} style={styles.similarItem}><MediaCard item={x} width="100%" onPress={() => { P.minimize(); if (navigationRef.isReady()) navigationRef.navigate("Detail", { itemId: x.id }); }} /></View>)}
            </View>
          </>
        )}
      </ScrollView>
    );
  }, [itemId, epId, infoUrl, inList, settings.stats, P.subIndex, P.cues.length, insets.bottom]);

  if (P.mode !== "full" || !P.item) return null;

  const aspect = P.videoSize.w && P.videoSize.h ? P.videoSize.w / P.videoSize.h : 16 / 9;
  const vw = dim.width;
  const vh = isLandscape ? dim.height : Math.min(dim.width / aspect, dim.height * 0.45);
  const subText = activeCueText(P.cues, P.position);
  const showControls = isLandscape ? P.controls : true;
  const bigSpinner = (P.loading || P.buffering) && !P.started;
  const menuW = Math.min(400, dim.width - 32);
  const menuH = Math.min(dim.height * 0.8, 560);
  const dragScale = drag.interpolate({ inputRange: [0, 320], outputRange: [1, 0.82], extrapolate: "clamp" });
  const dragRadius = drag.interpolate({ inputRange: [0, 120], outputRange: [0, 14], extrapolate: "clamp" });
  const zoom = isLandscape ? 1 : (settings.portraitZoom || 1);

  const subStyle = {
    color: settings.subColor || "#fff",
    fontSize: settings.subSize,
    lineHeight: settings.subSize * 1.32,
    fontWeight: (settings.subBold ? "700" : "500") as any,
    backgroundColor: settings.subBg ? "rgba(0,0,0,0.55)" : "transparent",
    paddingHorizontal: settings.subBg ? 9 : 0,
    paddingVertical: settings.subBg ? 4 : 0,
    textShadowColor: settings.subOutline ? "#000" : "transparent",
    textShadowRadius: settings.subOutline ? 5 : 0,
    textShadowOffset: { width: 0, height: 1 }
  };

  const rotateBtn = <IconButton name="sync-outline" size={20} onPress={P.rotate} />;

  const videoBlock = (
    <Animated.View
      style={[styles.videoBox, { width: vw, height: vh, borderRadius: isLandscape ? 0 : dragRadius, transform: isLandscape ? [] : [{ translateY: drag }, { scale: dragScale }] }]}
      {...(!isLandscape ? pan.panHandlers : {})}
    >
      <VideoView player={P.player} style={[StyleSheet.absoluteFill, zoom !== 1 ? { transform: [{ scale: zoom }] } : null]} contentFit={isLandscape ? P.fit : "contain"} nativeControls={false} allowsPictureInPicture />
      <Pressable style={StyleSheet.absoluteFill} onPress={() => P.setControls(!P.controls)} />

      {!!subText && <View style={[styles.subBox, { bottom: showControls && isLandscape ? 82 : 14 }]} pointerEvents="none"><Text style={[styles.subText, subStyle]}>{subText}</Text></View>}

      {bigSpinner && <View style={styles.centerSpin} pointerEvents="none"><ActivityIndicator color={C.red} size="large" /></View>}
      {showControls && !bigSpinner && !P.ended && !P.error && (
        <Pressable onPress={P.togglePlay} style={styles.centerPlay} hitSlop={26}>
          <Ionicons name={P.playing ? "pause" : "play"} size={isLandscape ? 60 : 46} color="#fff" style={styles.centerIcon} />
        </Pressable>
      )}

      {showControls && !P.error && (
        <>
          <LinearGradient colors={["rgba(0,0,0,0.7)", "transparent"]} style={styles.vTopScrim} pointerEvents="none" />
          <View style={[styles.vTop, { top: isLandscape ? Math.max(insets.top, 4) : 4 }]}>
            <IconButton name="chevron-down" size={26} onPress={P.minimize} />
            <View style={{ flex: 1 }}>{isLandscape && <Text numberOfLines={1} style={styles.playerTitle}>{P.episode ? P.episode.title : P.item.title}</Text>}</View>
            {P.buffering && P.started && <ActivityIndicator color={C.red} size="small" style={{ marginRight: 6 }} />}
            {isLandscape && <IconButton name={P.fit === "contain" ? "scan-outline" : "contract-outline"} size={22} onPress={() => P.setFit(P.fit === "contain" ? "cover" : "contain")} />}
            {!settings.rotateBottom && rotateBtn}
          </View>

          <LinearGradient colors={["transparent", "rgba(0,0,0,0.8)"]} style={styles.vBottomScrim} pointerEvents="none" />
          <View style={[styles.vBottom, { bottom: isLandscape ? Math.max(insets.bottom, 2) : 2 }]}>
            <Slider style={{ width: "100%", height: 28 }} minimumValue={0} maximumValue={Math.max(1, P.duration)}
              value={P.scrubbing ? P.scrub : P.position} minimumTrackTintColor={C.red} maximumTrackTintColor="rgba(255,255,255,0.35)" thumbTintColor={C.red}
              onSlidingStart={P.beginScrub} onValueChange={P.setScrub} onSlidingComplete={P.endScrub} />
            <View style={styles.vControls}>
              <Text style={styles.playerTime}>{fmt(P.scrubbing ? P.scrub : P.position)} <Text style={styles.faint}>/ {fmt(P.duration)}</Text></Text>
              <View style={{ flex: 1 }} />
              <IconButton name="musical-notes-outline" size={20} onPress={() => P.setMenu("audio")} />
              <IconButton name="chatbox-ellipses-outline" size={20} active={P.subIndex != null} onPress={() => P.setMenu("subs")} />
              <Pressable onPress={() => P.setMenu("quality")} style={styles.hdButton}><View style={styles.hdBox}><Text style={styles.hdText}>{P.info?.quality && P.info.quality !== "auto" ? P.info.quality + "p" : "HD"}</Text></View></Pressable>
              <IconButton name="settings-outline" size={20} onPress={() => P.setMenu("root")} />
              {!!settings.rotateBottom && rotateBtn}
            </View>
          </View>
        </>
      )}

      {!!P.error && (
        <View style={styles.vError}>
          <Ionicons name="warning-outline" size={36} color={C.amber} />
          <Text style={styles.emptyTitleSm}>Video non caricabile</Text>
          <Text style={styles.mutedSm}>{P.error}</Text>
          <View style={styles.actions}>
            <Pressable onPress={() => P.setQuality("auto")} style={styles.primaryButtonSm}><Text style={styles.primaryButtonText}>Riprova</Text></Pressable>
            <Pressable onPress={P.close} style={styles.secondaryButtonSm}><Text style={styles.secondaryButtonText}>Chiudi</Text></Pressable>
          </View>
        </View>
      )}

      {P.ended && (
        <View style={styles.vError}>
          <Text style={styles.endLabel}>{P.nextEp ? "Prossimo episodio" : "Fine"}</Text>
          {P.nextEp && (
            <Pressable onPress={() => P.playEpisode(P.nextEp)} style={styles.nextCard}>
              <View style={styles.nextThumb} />
              <View style={{ flex: 1 }}><Text style={styles.episodeTitle}>S{P.nextEp.season}:E{P.nextEp.episode} · {P.nextEp.title}</Text><Text style={styles.mutedSm}>{P.item.title}</Text></View>
            </Pressable>
          )}
          <View style={styles.actions}>
            {P.nextEp && <Pressable onPress={() => P.playEpisode(P.nextEp)} style={styles.whiteButton}><Ionicons name="play" size={18} color="#000" /><Text style={styles.whiteButtonText}>Guarda</Text></Pressable>}
            <Pressable onPress={() => P.endScrub(0)} style={styles.ghostButton}><Ionicons name="refresh" size={18} color="#fff" /><Text style={styles.ghostButtonText}>Riguarda</Text></Pressable>
            <Pressable onPress={P.close} style={styles.ghostButton}><Text style={styles.ghostButtonText}>Chiudi</Text></Pressable>
          </View>
        </View>
      )}
    </Animated.View>
  );

  return (
    <View style={[styles.overlayRoot, isLandscape ? styles.overlayLand : { paddingTop: insets.top }]}>
      {isLandscape ? <View style={styles.landWrap}>{videoBlock}</View> : (<>{videoBlock}{infoPanel}</>)}

      {!!P.notice && <View style={[styles.notice, { top: isLandscape ? Math.max(insets.top, 12) : insets.top + vh + 8 }]} pointerEvents="none"><Text style={styles.noticeText}>{P.notice}</Text></View>}

      {!!P.menu && (
        <Modal visible transparent animationType="fade" onRequestClose={() => P.setMenu(null)}>
          <Pressable style={[styles.modalBackdrop, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]} onPress={() => P.setMenu(null)}>
            <Pressable style={[styles.menu, { width: menuW, maxHeight: menuH }]} onPress={() => {}}>
              <ScrollView showsVerticalScrollIndicator keyboardShouldPersistTaps="handled" bounces={false}>
                {P.menu === "root" && (
                  <>
                    <MenuHeader title="Impostazioni player" onBack={() => P.setMenu(null)} onClose={() => P.setMenu(null)} />
                    <MenuItem label="Velocità" value={settings.speed === 1 ? "Normale" : settings.speed + "×"} onPress={() => P.setMenu("speed")} />
                    <MenuItem label="Stile sottotitoli" onPress={() => P.setMenu("substyle")} />
                    <MenuItem label="Zoom verticale" value={Math.round((settings.portraitZoom || 1) * 100) + "%"} onPress={() => P.setMenu("zoom")} />
                    <MenuItem label="Riempimento schermo" value={P.fit === "contain" ? "Adatta" : "Riempi"} onPress={() => P.setFit(P.fit === "contain" ? "cover" : "contain")} />
                    <MenuToggle label="Tasto rotazione in basso" value={settings.rotateBottom} onToggle={() => setSettings({ ...settings, rotateBottom: !settings.rotateBottom })} />
                    <MenuToggle label="Avvio rapido" value={settings.fastStart} onToggle={() => setSettings({ ...settings, fastStart: !settings.fastStart })} />
                    <MenuToggle label="Prossimo episodio" value={settings.autoplay} onToggle={() => setSettings({ ...settings, autoplay: !settings.autoplay })} />
                    <MenuToggle label="Ripeti video" value={settings.loop} onToggle={() => setSettings({ ...settings, loop: !settings.loop })} />
                    <MenuToggle label="Background" value={settings.background} onToggle={() => setSettings({ ...settings, background: !settings.background })} />
                    <MenuToggle label="Picture-in-Picture" value={settings.pip} onToggle={() => setSettings({ ...settings, pip: !settings.pip })} />
                    <MenuToggle label="Statistiche" value={settings.stats} onToggle={() => setSettings({ ...settings, stats: !settings.stats })} />
                    <MenuItem label="Miniplayer" onPress={() => { P.setMenu(null); P.minimize(); }} />
                    <MenuItem label="Chiudi video" onPress={() => { P.setMenu(null); P.close(); }} />
                  </>
                )}
                {P.menu === "substyle" && (
                  <>
                    <MenuHeader title="Stile sottotitoli" onBack={() => P.setMenu("root")} onClose={() => P.setMenu(null)} />
                    <MenuToggle label="Sfondo" value={settings.subBg} onToggle={() => setSettings({ ...settings, subBg: !settings.subBg })} />
                    <MenuToggle label="Bordo / ombra" value={settings.subOutline} onToggle={() => setSettings({ ...settings, subOutline: !settings.subOutline })} />
                    <MenuToggle label="Grassetto" value={settings.subBold} onToggle={() => setSettings({ ...settings, subBold: !settings.subBold })} />
                    {[14, 16, 18, 20, 24, 28, 32].map(s => <MenuItem key={s} label={"Dimensione " + s + "px"} selected={settings.subSize === s} onPress={() => setSettings({ ...settings, subSize: s })} />)}
                    {[["#ffffff", "Bianco"], ["#ffe600", "Giallo"], ["#7CFC00", "Verde"], ["#00e5ff", "Ciano"]].map(c => <MenuItem key={c[0]} label={"Colore " + c[1]} selected={settings.subColor === c[0]} onPress={() => setSettings({ ...settings, subColor: c[0] })} />)}
                  </>
                )}
                {P.menu === "zoom" && (
                  <>
                    <MenuHeader title="Zoom verticale" onBack={() => P.setMenu("root")} onClose={() => P.setMenu(null)} />
                    {[1, 1.05, 1.1, 1.15, 1.2, 1.3].map(z => <MenuItem key={z} label={Math.round(z * 100) + "%"} selected={Math.abs((settings.portraitZoom || 1) - z) < 0.001} onPress={() => setSettings({ ...settings, portraitZoom: z })} />)}
                    <Text style={styles.menuNote}>Oltre il 100% il video riempie il riquadro eliminando le righe nere, con un leggero crop ai bordi.</Text>
                  </>
                )}
                {P.menu === "speed" && (<><MenuHeader title="Velocità" onBack={() => P.setMenu("root")} onClose={() => P.setMenu(null)} />{[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(s => <MenuItem key={s} label={s === 1 ? "Normale" : s + "×"} selected={settings.speed === s} onPress={() => setSettings({ ...settings, speed: s })} />)}</>)}
                {P.menu === "quality" && (<><MenuHeader title="Qualità" onBack={() => P.setMenu("root")} onClose={() => P.setMenu(null)} />{["auto", "2160", "1080", "720", "480", "360"].map(q => <MenuItem key={q} label={q === "auto" ? "Automatica (Direct Play)" : q + "p"} selected={String(P.info?.quality) === q} onPress={() => P.setQuality(q)} />)}<Text style={styles.menuNote}>Solo "Automatica" evita la conversione sul server: le altre attivano il transcoding e sono più lente ad avviarsi.</Text></>)}
                {P.menu === "audio" && (<><MenuHeader title="Audio" onBack={() => P.setMenu("root")} onClose={() => P.setMenu(null)} />{(P.info?.audio || []).length === 0 && <Text style={styles.menuNote}>Nessuna traccia selezionabile.</Text>}{(P.info?.audio || []).map((a: any) => <MenuItem key={a.Index} label={a.DisplayTitle || a.Language || "Audio " + a.Index} selected={P.info?.audioIndex === a.Index} onPress={() => P.switchAudio(a.Index)} />)}</>)}
                {P.menu === "subs" && (
                  <>
                    <MenuHeader title="Sottotitoli" onBack={() => P.setMenu("root")} onClose={() => P.setMenu(null)} />
                    {P.subLoading && <Text style={styles.menuNote}>Caricamento… il video continua.</Text>}
                    <MenuItem label="Disattivati" selected={P.subIndex == null} onPress={() => P.selectSub(null)} />
                    {(P.info?.subs || []).map((s: any) => <MenuItem key={s.Index} label={(s.DisplayTitle || s.Language || "Sub " + s.Index) + (isTextSub(s) ? "" : "  · grafico")} selected={P.subIndex === s.Index} disabled={!isTextSub(s)} onPress={() => P.selectSub(s)} />)}
                    {(P.info?.subs || []).length === 0 && <Text style={styles.menuNote}>Questo file non contiene sottotitoli.</Text>}
                    <MenuItem label="Stile sottotitoli" onPress={() => P.setMenu("substyle")} />
                  </>
                )}
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

function MiniPlayer() {
  const P = usePlayer();
  const insets = useSafeAreaInsets();
  if (P.mode !== "mini" || !P.item) return null;
  const title = P.episode ? P.episode.title : P.item.title;
  const sub = P.episode ? `${P.item.title} · S${P.episode.season}:E${P.episode.episode}` : P.item.title;
  const pct = P.duration > 0 ? Math.min(100, (P.position / P.duration) * 100) : 0;
  return (
    <View style={[styles.mini, { bottom: insets.bottom + 8 }]}>
      <Pressable style={styles.miniRow} onPress={P.expand}>
        <View style={styles.miniVideo}><VideoView player={P.player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} allowsPictureInPicture /></View>
        <View style={{ flex: 1, paddingRight: 6 }}><Text numberOfLines={1} style={styles.miniTitle}>{title}</Text><Text numberOfLines={1} style={styles.miniSub}>{sub}</Text></View>
        <IconButton name={P.playing ? "pause" : "play"} size={24} onPress={P.togglePlay} />
        <IconButton name="close" size={22} onPress={P.close} />
      </Pressable>
      <View style={styles.miniProgress}><View style={[styles.progressFill, { width: pct + "%" }]} /></View>
    </View>
  );
}

function LoginScreen() {
  const { setSession, resetLocal } = useApp();
  const [server, setServer] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem("nova.lastServer").then(v => v && setServer(v));
    AsyncStorage.getItem("nova.lastUser").then(v => v && setUser(v));
  }, []);

  async function doTest() {
    setStatus("Verifico…"); setErr("");
    try { const r = await testServer(server); setStatus("✓ " + r.name + " · v" + r.version); } catch (e: any) { setStatus(e.message); }
  }
  async function doLogin() {
    setBusy(true); setErr("");
    try {
      const s = await authenticate(server, user, pass);
      await AsyncStorage.setItem("nova.lastServer", s.server);
      await AsyncStorage.setItem("nova.lastUser", user);
      await setSession(s);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.loginScroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.logo}>NOVA</Text>
        <Text style={styles.logoSub}>for Jellyfin</Text>
        <View style={styles.loginCard}>
          <Text style={styles.loginCardTitle}>Accedi</Text>
          <Text style={styles.loginCardSub}>Connettiti al tuo server Jellyfin.</Text>
          <Text style={styles.label}>Server</Text>
          <TextInput value={server} onChangeText={setServer} placeholder="http://192.168.1.10:8096" placeholderTextColor={C.faint} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input} />
          <Pressable onPress={doTest} style={styles.testButton}><Text style={styles.testButtonText}>Test connessione</Text></Pressable>
          {!!status && <Text style={[styles.status, status.startsWith("✓") ? styles.ok : styles.bad]}>{status}</Text>}
          <Text style={styles.label}>Utente</Text>
          <TextInput value={user} onChangeText={setUser} autoCapitalize="none" autoCorrect={false} style={styles.input} />
          <Text style={styles.label}>Password</Text>
          <View style={styles.passWrap}>
            <TextInput value={pass} onChangeText={setPass} secureTextEntry={!showPass} autoCapitalize="none" autoCorrect={false} autoComplete="off" importantForAutofill="no" style={[styles.input, { paddingRight: 50 }]} />
            <Pressable onPress={() => setShowPass(v => !v)} style={styles.eyeButton}><Ionicons name={showPass ? "eye-off-outline" : "eye-outline"} size={22} color={C.muted} /></Pressable>
          </View>
          {!!err && <Text style={styles.bad}>{err}</Text>}
          <Pressable onPress={doLogin} disabled={busy} style={[styles.primaryButton, busy && { opacity: 0.6 }]}><Text style={styles.primaryButtonText}>{busy ? "Accesso…" : "Accedi"}</Text></Pressable>
          <View style={styles.divider}><View style={styles.dividerLine} /><Text style={styles.dividerText}>oppure</Text><View style={styles.dividerLine} /></View>
          <Pressable onPress={() => setSession({ mode: "demo", user: "Matteo" })} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Esplora la demo</Text></Pressable>
          <Pressable onPress={resetLocal} style={styles.fixButton}><Text style={styles.fixButtonText}>Ripara dati locali</Text></Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function TopBar() {
  const { session, setSession, reloadLibrary, resetLocal } = useApp();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <View style={[styles.topBar, { paddingTop: insets.top, height: 62 + insets.top }]}>
        <Text style={styles.topLogo}>NOVA</Text>
        <View style={{ flex: 1 }} />
        <IconButton name="search" onPress={() => navigationRef.navigate("Search")} />
        <IconButton name="settings-outline" onPress={() => navigationRef.navigate("Settings")} />
        <Pressable onPress={() => setOpen(true)} style={({ pressed }) => pressed && { opacity: 0.75 }}><Face size={34} /></Pressable>
      </View>
      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <Pressable style={styles.modalBackdrop} onPress={close}>
          <Pressable style={styles.profileMenu} onPress={() => {}}>
            <View style={styles.profileHead}>
              <Face size={54} />
              <View style={{ flex: 1 }}><Text style={styles.profileName}>{session?.user || "Matteo"}</Text><Text style={styles.muted} numberOfLines={1}>{session?.mode === "demo" ? "Modalità demo" : session?.server}</Text></View>
            </View>
            <MenuItem label="Impostazioni" onPress={() => { close(); navigationRef.navigate("Settings"); }} />
            <MenuItem label="Ricarica libreria" onPress={() => { close(); reloadLibrary(); }} />
            <MenuItem label="Esci" onPress={() => { close(); setSession(null); }} />
            <MenuItem label="Ripara dati locali" onPress={() => { close(); resetLocal(); }} />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function HomeScreen() {
  const { items, epMap, progress, nextUp, list, libLoading, settings, featured, reshuffle } = useApp();
  const P = usePlayer();
  const wide = settings.thumbWide;
  const cardW = settings.posterSize;
  const wideW = Math.round(cardW * 1.75);

  const continueData = useMemo(() => Object.keys(progress)
    .filter(id => progress[id].position > 5 && !isWatched(progress[id]))
    .sort((a, b) => progress[b].updated - progress[a].updated)
    .map(id => {
      const ep = epMap[id];
      if (ep) { const it = items.find((x: any) => x.id === ep.seriesId); return it ? { item: it, ep } : null; }
      const it = items.find((x: any) => x.id === id); return it ? { item: it, ep: null } : null;
    }).filter(Boolean), [items, epMap, progress]);

  const myList = useMemo(() => items.filter((i: any) => list.includes(i.id)), [items, list]);
  const goDetail = (id: string) => navigationRef.navigate("Detail", { itemId: id });

  if (libLoading) return <SafeAreaView style={styles.center}><ActivityIndicator color={C.red} size="large" /><Text style={styles.muted}>Carico la libreria…</Text></SafeAreaView>;
  if (!featured) return <SafeAreaView style={styles.center}><Text style={styles.emptyTitle}>Libreria vuota</Text></SafeAreaView>;

  return (
    <View style={styles.screen}>
      <TopBar />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          {featured.backdrop ? <ImageBackground source={{ uri: featured.backdrop }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <View style={[StyleSheet.absoluteFill, { backgroundColor: "hsl(" + featured.hue + ",55%,22%)" }]} />}
          <LinearGradient colors={["rgba(8,8,11,0.15)", "rgba(8,8,11,0.75)", C.bg]} style={StyleSheet.absoluteFill} />
          <View style={styles.heroContent}>
            <View style={styles.heroKickerRow}><Text style={styles.heroKicker}>CONSIGLIATO PER TE</Text><Pressable onPress={reshuffle} style={styles.shuffleBtn}><Ionicons name="shuffle" size={16} color={C.muted} /></Pressable></View>
            <Text style={styles.heroTitle}>{featured.title}</Text>
            <View style={styles.metaRow}><Text style={styles.match}>{featured.match}% compatibile</Text><Text style={styles.metaText}>{featured.year}</Text><Text style={styles.badge}>HD</Text></View>
            <Text numberOfLines={3} style={styles.heroDesc}>{featured.overview}</Text>
            <View style={styles.actions}>
              <Pressable onPress={() => P.open(featured)} style={styles.whiteButton}><Ionicons name="play" size={22} color="#000" /><Text style={styles.whiteButtonText}>Play</Text></Pressable>
              <Pressable onPress={() => goDetail(featured.id)} style={styles.ghostButton}><Ionicons name="information-circle-outline" size={22} color="#fff" /><Text style={styles.ghostButtonText}>Info</Text></Pressable>
            </View>
          </View>
        </View>
        <View style={styles.rows}>
          <Row title="Continua a guardare" data={continueData} keyExtractor={(x: any) => x.ep?.id || x.item.id} renderItem={({ item: x }: any) => <MediaCard item={x.item} ep={x.ep} wide={wide} width={wide ? wideW : cardW} progress={progress[x.ep?.id || x.item.id]} onPress={() => P.open(x.item, x.ep)} onLongPress={() => goDetail(x.item.id)} />} />
          <Row title="Prossimi episodi" data={nextUp} keyExtractor={(x: any) => x.ep.id} renderItem={({ item: x }: any) => <MediaCard item={x.item} ep={x.ep} wide={wide} width={wide ? wideW : cardW} progress={progress[x.ep.id]} onPress={() => P.open(x.item, x.ep)} onLongPress={() => goDetail(x.item.id)} />} />
          <Row title="La tua lista" data={myList} keyExtractor={(x: any) => x.id} renderItem={({ item }: any) => <MediaCard item={item} width={cardW} onPress={() => goDetail(item.id)} onLongPress={() => goDetail(item.id)} />} />
          <Row title="Aggiunti di recente" data={[...items].sort((a: any, b: any) => b.added - a.added)} keyExtractor={(x: any) => x.id} renderItem={({ item }: any) => <MediaCard item={item} width={cardW} onPress={() => goDetail(item.id)} onLongPress={() => goDetail(item.id)} />} />
          <Row title="Film" data={items.filter((i: any) => i.type === "movie")} keyExtractor={(x: any) => x.id} renderItem={({ item }: any) => <MediaCard item={item} width={cardW} onPress={() => goDetail(item.id)} onLongPress={() => goDetail(item.id)} />} />
          <Row title="Serie TV" data={items.filter((i: any) => i.type === "series")} keyExtractor={(x: any) => x.id} renderItem={({ item }: any) => <MediaCard item={item} width={cardW} onPress={() => goDetail(item.id)} onLongPress={() => goDetail(item.id)} />} />
        </View>
      </ScrollView>
    </View>
  );
}

function SearchScreen() {
  const { items } = useApp();
  const [q, setQ] = useState("");
  const res = q.trim() ? items.filter((i: any) => i.title.toLowerCase().includes(q.toLowerCase()) || i.genres.join(" ").toLowerCase().includes(q.toLowerCase())) : [];
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.searchHeader}><IconButton name="arrow-back" onPress={() => navigationRef.goBack()} /><TextInput autoFocus value={q} onChangeText={setQ} placeholder="Cerca titoli, generi…" placeholderTextColor={C.faint} autoCapitalize="none" autoCorrect={false} style={styles.searchInput} /></View>
      <FlatList data={res} keyExtractor={(i: any) => i.id} numColumns={3} contentContainerStyle={styles.grid}
        renderItem={({ item }) => <View style={styles.gridItem}><MediaCard item={item} width="100%" onPress={() => navigationRef.navigate("Detail", { itemId: item.id })} /><Text numberOfLines={1} style={styles.gridTitle}>{item.title}</Text></View>}
        ListEmptyComponent={<View style={styles.center}><Ionicons name="search" size={48} color={C.faint} /><Text style={styles.emptyTitle}>Cerca nella libreria</Text></View>} />
    </SafeAreaView>
  );
}

function DetailScreen({ route }: any) {
  const { session, items, progress, list, toggleList } = useApp();
  const P = usePlayer();
  const item = items.find((x: any) => x.id === route.params.itemId);
  const [seasons, setSeasons] = useState<any[]>(item?.seasons || []);
  const [season, setSeason] = useState(1);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!item || item.type !== "series" || seasons.length) return;
    setLoading(true);
    loadSeasons(session, item).then(setSeasons).catch(e => Alert.alert("Errore episodi", e.message)).finally(() => setLoading(false));
  }, [item?.id]);

  if (!item) return <SafeAreaView style={styles.center}><Text style={styles.emptyTitle}>Titolo non trovato</Text></SafeAreaView>;
  const cur = seasons.find((s: any) => s.n === season) || seasons[0];
  const ep = item.type === "series" ? targetEpisode(seasons, progress) : null;
  const resume = ep ? progress[ep.id]?.position || 0 : progress[item.id]?.position || 0;
  const similar = items.filter((x: any) => x.id !== item.id && x.genres.some((g: string) => item.genres.includes(g))).slice(0, 8);
  const inList = list.includes(item.id);

  return (
    <ScrollView style={styles.screen} showsVerticalScrollIndicator={false}>
      <View style={styles.detailHero}>
        {item.backdrop ? <ImageBackground source={{ uri: item.backdrop }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <View style={[StyleSheet.absoluteFill, { backgroundColor: "hsl(" + item.hue + ",55%,22%)" }]} />}
        <LinearGradient colors={["rgba(8,8,11,0.2)", "rgba(8,8,11,0.75)", C.bg]} style={StyleSheet.absoluteFill} />
        <SafeAreaView style={styles.detailHeroContent}>
          <IconButton name="arrow-back" onPress={() => navigationRef.goBack()} />
          <Text style={styles.detailTitle}>{item.title}</Text>
          <View style={styles.metaRow}><Text style={styles.match}>{item.match}% compatibile</Text><Text style={styles.metaText}>{item.year}</Text><Text style={styles.badge}>{item.rating}</Text></View>
          <Text numberOfLines={4} style={styles.heroDesc}>{item.overview}</Text>
          <View style={styles.actions}>
            <Pressable onPress={() => P.open(item, ep)} style={styles.whiteButton}><Ionicons name="play" size={22} color="#000" /><Text style={styles.whiteButtonText}>{resume > 0 ? "Riprendi" : "Play"}</Text></Pressable>
            <Pressable onPress={() => toggleList(item.id)} style={[styles.roundButton, inList && styles.roundOn]}><Ionicons name={inList ? "checkmark" : "add"} size={26} color={inList ? C.green : "#fff"} /></Pressable>
          </View>
          {inList && <Text style={styles.inListNote}>Nella tua lista</Text>}
        </SafeAreaView>
      </View>
      <View style={styles.detailBody}>
        <Text style={styles.facts}><Text style={styles.faint}>Cast: </Text>{item.cast.join(", ") || "–"}</Text>
        <Text style={styles.facts}><Text style={styles.faint}>Generi: </Text>{item.genres.join(", ") || "–"}</Text>
        {item.type === "series" && (
          <>
            <View style={styles.seasonHeader}><Text style={styles.sectionTitle}>Episodi</Text>{loading && <ActivityIndicator color={C.red} />}</View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              {seasons.map((s: any) => <Pressable key={s.n} onPress={() => setSeason(s.n)} style={[styles.seasonChip, cur?.n === s.n && styles.seasonChipOn]}><Text style={[styles.seasonText, cur?.n === s.n && styles.seasonTextOn]}>{s.name}</Text></Pressable>)}
            </ScrollView>
            {(cur?.episodes || []).map((e: any) => {
              const p = progress[e.id];
              const pct = p && p.duration ? Math.min(100, (p.position / p.duration) * 100) : 0;
              return (
                <Pressable key={e.id} onPress={() => P.open(item, e)} style={styles.episode}>
                  <Text style={styles.episodeNum}>{e.episode}</Text>
                  <View style={styles.episodeThumb}><Image source={{ uri: e.thumb }} style={StyleSheet.absoluteFill} />{pct > 0 && <View style={styles.progressTrack}><View style={[styles.progressFill, { width: pct + "%" }]} /></View>}</View>
                  <View style={{ flex: 1 }}><Text style={styles.episodeTitle}>{e.title}</Text><Text numberOfLines={2} style={styles.episodeDesc}>{e.overview}</Text></View>
                  <Text style={styles.faint}>{fmt(e.duration)}</Text>
                </Pressable>
              );
            })}
          </>
        )}
        {!!similar.length && (<><Text style={styles.sectionTitle}>Altri titoli simili</Text><View style={styles.similarGrid}>{similar.map((x: any) => <View key={x.id} style={styles.similarItem}><MediaCard item={x} width="100%" onPress={() => navigationRef.navigate("Detail", { itemId: x.id })} /></View>)}</View></>)}
      </View>
    </ScrollView>
  );
}

function Choice({ label, value, options, onChange }: any) {
  return (
    <View style={styles.settingBlock}>
      <Text style={styles.settingLabel}>{label}</Text>
      <View style={styles.choiceWrap}>{options.map((o: any) => <Pressable key={o[0]} onPress={() => onChange(o[0])} style={[styles.choice, String(value) === String(o[0]) && styles.choiceOn]}><Text style={[styles.choiceText, String(value) === String(o[0]) && styles.choiceTextOn]}>{o[1]}</Text></Pressable>)}</View>
    </View>
  );
}

function Toggle({ label, value, onToggle }: any) {
  return <Pressable onPress={onToggle} style={styles.settingRow}><Text style={styles.settingLabel}>{label}</Text><View style={[styles.switch, value && styles.switchOn]}><View style={[styles.switchKnob, value && styles.switchKnobOn]} /></View></Pressable>;
}

function SettingsScreen() {
  const { session, settings, setSettings, reloadLibrary, resetLocal, setSession } = useApp();
  const dim = useWindowDimensions();
  const twoCol = dim.width > 700;
  async function doTest() {
    if (session.mode === "demo") return Alert.alert("Demo", "Sei in modalità demo.");
    try { const r = await testServer(session.server); Alert.alert("Server OK", r.name + " · v" + r.version); } catch (e: any) { Alert.alert("Test fallito", e.message); }
  }
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.searchHeader}><IconButton name="arrow-back" onPress={() => navigationRef.goBack()} /><Text style={styles.pageTitle}>Impostazioni</Text></View>
      <ScrollView contentContainerStyle={[styles.settingsScroll, twoCol && styles.settingsScrollWide]} keyboardShouldPersistTaps="handled">
        <View style={[styles.settingsCard, twoCol && styles.halfCard]}>
          <Text style={styles.sectionTitle}>Riproduzione</Text>
          <Choice label="Modalità streaming" value={settings.streamMode} options={[["auto", "Auto"], ["direct", "Direct Play"], ["transcode", "Transcoding"]]} onChange={(v: string) => setSettings({ ...settings, streamMode: v })} />
          <Choice label="Qualità massima" value={settings.quality} options={[["auto", "Auto"], ["2160", "4K"], ["1080", "1080p"], ["720", "720p"], ["480", "480p"]]} onChange={(v: string) => setSettings({ ...settings, quality: v })} />
          <Toggle label="Avvio rapido (buffer minimo)" value={settings.fastStart} onToggle={() => setSettings({ ...settings, fastStart: !settings.fastStart })} />
          <Toggle label="Risparmio dati" value={settings.saveData} onToggle={() => setSettings({ ...settings, saveData: !settings.saveData })} />
          <Toggle label="Prossimo episodio automatico" value={settings.autoplay} onToggle={() => setSettings({ ...settings, autoplay: !settings.autoplay })} />
          <Toggle label="Ripeti video" value={settings.loop} onToggle={() => setSettings({ ...settings, loop: !settings.loop })} />
          <Toggle label="Continua in background" value={settings.background} onToggle={() => setSettings({ ...settings, background: !settings.background })} />
          <Toggle label="Picture-in-Picture all'uscita" value={settings.pip} onToggle={() => setSettings({ ...settings, pip: !settings.pip })} />
          <Choice label="Velocità" value={settings.speed} options={[[0.5, "0.5×"], [0.75, "0.75×"], [1, "1×"], [1.25, "1.25×"], [1.5, "1.5×"], [2, "2×"]]} onChange={(v: number) => setSettings({ ...settings, speed: v })} />
        </View>
        <View style={[styles.settingsCard, twoCol && styles.halfCard]}>
          <Text style={styles.sectionTitle}>Sottotitoli</Text>
          <Choice label="Lingua" value={settings.subLang} options={[["it", "IT"], ["en", "EN"], ["ja", "JA"], ["fr", "FR"], ["de", "DE"]]} onChange={(v: string) => setSettings({ ...settings, subLang: v })} />
          <Toggle label="Automatici" value={settings.autoSub} onToggle={() => setSettings({ ...settings, autoSub: !settings.autoSub })} />
          <Toggle label="Sfondo" value={settings.subBg} onToggle={() => setSettings({ ...settings, subBg: !settings.subBg })} />
          <Toggle label="Bordo / ombra" value={settings.subOutline} onToggle={() => setSettings({ ...settings, subOutline: !settings.subOutline })} />
          <Toggle label="Grassetto" value={settings.subBold} onToggle={() => setSettings({ ...settings, subBold: !settings.subBold })} />
          <Choice label="Dimensione" value={settings.subSize} options={[[14, "14"], [16, "16"], [18, "18"], [20, "20"], [24, "24"], [28, "28"], [32, "32"]]} onChange={(v: number) => setSettings({ ...settings, subSize: v })} />
          <Choice label="Colore" value={settings.subColor} options={[["#ffffff", "Bianco"], ["#ffe600", "Giallo"], ["#7CFC00", "Verde"], ["#00e5ff", "Ciano"]]} onChange={(v: string) => setSettings({ ...settings, subColor: v })} />
          <Choice label="Lingua audio" value={settings.audioLang} options={[["it", "IT"], ["en", "EN"], ["ja", "JA"], ["fr", "FR"], ["de", "DE"]]} onChange={(v: string) => setSettings({ ...settings, audioLang: v })} />
        </View>
        <View style={[styles.settingsCard, twoCol && styles.halfCard]}>
          <Text style={styles.sectionTitle}>Interfaccia</Text>
          <Text style={styles.settingLabel}>Dimensione locandine: {settings.posterSize}px</Text>
          <Slider minimumValue={120} maximumValue={220} step={5} value={settings.posterSize} minimumTrackTintColor={C.red} maximumTrackTintColor={C.surface3} thumbTintColor={C.red} onValueChange={v => setSettings({ ...settings, posterSize: v })} />
          <Choice label="Zoom video in verticale" value={settings.portraitZoom} options={[[1, "100%"], [1.05, "105%"], [1.1, "110%"], [1.15, "115%"], [1.2, "120%"], [1.3, "130%"]]} onChange={(v: number) => setSettings({ ...settings, portraitZoom: v })} />
          <Toggle label="Tasto rotazione in basso" value={settings.rotateBottom} onToggle={() => setSettings({ ...settings, rotateBottom: !settings.rotateBottom })} />
          <Toggle label="Locandine orizzontali (Continua / Prossimi)" value={settings.thumbWide} onToggle={() => setSettings({ ...settings, thumbWide: !settings.thumbWide })} />
          <Toggle label="Animazioni" value={settings.animations} onToggle={() => setSettings({ ...settings, animations: !settings.animations })} />
          <Toggle label="Barre di progresso" value={settings.progressBars} onToggle={() => setSettings({ ...settings, progressBars: !settings.progressBars })} />
          <Toggle label="Statistiche riproduzione" value={settings.stats} onToggle={() => setSettings({ ...settings, stats: !settings.stats })} />
        </View>
        <View style={[styles.settingsCard, twoCol && styles.halfCard]}>
          <Text style={styles.sectionTitle}>Server</Text>
          <Text style={styles.muted}>{session.mode === "demo" ? "Modalità demo" : session.server}</Text>
          <View style={styles.settingsActions}>
            <Pressable onPress={reloadLibrary} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Ricarica libreria</Text></Pressable>
            <Pressable onPress={doTest} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Test server</Text></Pressable>
            <Pressable onPress={() => setSession(null)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Esci</Text></Pressable>
            <Pressable onPress={resetLocal} style={styles.fixButton}><Text style={styles.fixButtonText}>Ripara dati locali</Text></Pressable>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function App() {
  const [session, setSessionState] = useState<any>(null);
  const [booting, setBooting] = useState(true);
  const [libLoading, setLibLoading] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const [epMap, setEpMap] = useState<any>({});
  const [nextUp, setNextUp] = useState<any[]>([]);
  const [progress, setProgress] = useState<any>({});
  const [list, setList] = useState<string[]>([]);
  const [settings, setSettings] = useState<any>(defaultSettings);
  const [featured, setFeatured] = useState<any>(null);

  useEffect(() => {
    (async () => {
      try {
        const s = await SecureStore.getItemAsync("nova.session");
        const st = await AsyncStorage.getItem("nova.settings");
        const pr = await AsyncStorage.getItem("nova.progress");
        const li = await AsyncStorage.getItem("nova.list");
        if (s) setSessionState(JSON.parse(s));
        if (st) setSettings({ ...defaultSettings, ...JSON.parse(st) });
        if (pr) setProgress(JSON.parse(pr));
        if (li) setList(JSON.parse(li));
      } catch {}
      setBooting(false);
    })();
  }, []);

  useEffect(() => { AsyncStorage.setItem("nova.settings", JSON.stringify(settings)); }, [settings]);
  useEffect(() => { AsyncStorage.setItem("nova.progress", JSON.stringify(progress)); }, [progress]);
  useEffect(() => { AsyncStorage.setItem("nova.list", JSON.stringify(list)); }, [list]);

  async function setSession(s: any) {
    if (s) await SecureStore.setItemAsync("nova.session", JSON.stringify(s));
    else await SecureStore.deleteItemAsync("nova.session");
    setSessionState(s);
    if (!s) { setItems([]); setEpMap({}); setNextUp([]); setFeatured(null); }
  }

  async function reloadLibrary() {
    if (!session) return;
    setLibLoading(true);
    try {
      const data = session.mode === "demo" ? demoLibrary() : await loadLibrary(session);
      setItems(data.items); setEpMap(data.epMap || {}); setNextUp(data.nextUp || []);
      setProgress((p: any) => ({ ...data.progress, ...p }));
      setFeatured(pickFeatured(data.items, { ...data.progress, ...progress }, data.epMap || {}, list));
    } catch (e: any) { Alert.alert("Errore libreria", e.message); await setSession(null); }
    finally { setLibLoading(false); }
  }

  useEffect(() => { if (session) reloadLibrary(); }, [session?.token, session?.mode]);

  const reshuffle = () => setFeatured(pickFeatured(items, progress, epMap, list));
  const saveProgress = (id: string, pos: number, dur: number) => setProgress((p: any) => ({ ...p, [id]: { position: pos, duration: dur, updated: Date.now() } }));
  const toggleList = (id: string) => setList(l => (l.includes(id) ? l.filter(x => x !== id) : [...l, id]));

  async function resetLocal() {
    await SecureStore.deleteItemAsync("nova.session");
    const keys = await AsyncStorage.getAllKeys();
    await AsyncStorage.multiRemove(keys.filter(k => k.startsWith("nova.")));
    setSessionState(null); setItems([]); setEpMap({}); setNextUp([]); setProgress({}); setList([]); setSettings(defaultSettings); setFeatured(null);
  }

  const value = { session, setSession, items, epMap, nextUp, progress, saveProgress, list, toggleList, settings, setSettings, libLoading, reloadLibrary, resetLocal, featured, reshuffle };

  if (booting) return <SafeAreaProvider><SafeAreaView style={styles.center}><Text style={styles.logo}>NOVA</Text><ActivityIndicator color={C.red} /></SafeAreaView></SafeAreaProvider>;

  return (
    <SafeAreaProvider>
      <AppCtx.Provider value={value}>
        <PlayerProvider>
          <View style={{ flex: 1, backgroundColor: C.bg }}>
            <AppStatusBar />
            {!session ? <LoginScreen /> : (
              <NavigationContainer ref={navigationRef} theme={navTheme}>
                <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg } }}>
                  <Stack.Screen name="Home" component={HomeScreen} />
                  <Stack.Screen name="Search" component={SearchScreen} />
                  <Stack.Screen name="Detail" component={DetailScreen} />
                  <Stack.Screen name="Settings" component={SettingsScreen} />
                </Stack.Navigator>
              </NavigationContainer>
            )}
            <MiniPlayer />
            <PlayerOverlay />
          </View>
        </PlayerProvider>
      </AppCtx.Provider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  muted: { color: C.muted, fontSize: 13 },
  mutedSm: { color: C.muted, fontSize: 12, textAlign: "center" },
  faint: { color: C.faint, fontSize: 12 },
  emptyTitle: { color: C.text, fontSize: 20, fontWeight: "800" },
  emptyTitleSm: { color: C.text, fontSize: 16, fontWeight: "800" },
  logo: { fontSize: 56, fontWeight: "900", color: C.red, letterSpacing: 2 },
  logoSub: { color: C.muted, letterSpacing: 4, textTransform: "uppercase", fontSize: 12, marginTop: -8, marginBottom: 16 },
  loginScroll: { padding: 24, gap: 6 },
  loginCard: { backgroundColor: C.surface, borderColor: C.line, borderWidth: 1, borderRadius: 18, padding: 22 },
  loginCardTitle: { color: C.text, fontSize: 24, fontWeight: "800" },
  loginCardSub: { color: C.muted, fontSize: 13, marginBottom: 8 },
  label: { color: C.muted, fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: "#0d0d12", borderColor: C.line, borderWidth: 1, borderRadius: 10, color: C.text, paddingHorizontal: 14, paddingVertical: 12 },
  passWrap: { position: "relative", justifyContent: "center" },
  eyeButton: { position: "absolute", right: 6, top: 0, bottom: 0, width: 42, alignItems: "center", justifyContent: "center" },
  testButton: { alignSelf: "flex-start", backgroundColor: C.surface2, borderColor: C.line, borderWidth: 1, borderRadius: 30, paddingHorizontal: 14, paddingVertical: 8, marginTop: 10 },
  testButtonText: { color: C.muted, fontWeight: "700", fontSize: 12 },
  status: { fontSize: 12, marginTop: 8 },
  ok: { color: C.green },
  bad: { color: "#ff6b72", marginTop: 8 },
  primaryButton: { backgroundColor: C.red, borderRadius: 10, paddingVertical: 13, paddingHorizontal: 20, alignItems: "center", justifyContent: "center", marginTop: 16 },
  primaryButtonSm: { backgroundColor: C.red, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 16, alignItems: "center" },
  primaryButtonText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  secondaryButton: { backgroundColor: C.surface2, borderColor: C.line, borderWidth: 1, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 18, alignItems: "center", justifyContent: "center" },
  secondaryButtonSm: { backgroundColor: C.surface2, borderColor: C.line, borderWidth: 1, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 16, alignItems: "center" },
  secondaryButtonText: { color: C.text, fontWeight: "800" },
  fixButton: { backgroundColor: "#ffb22412", borderColor: "#ffb22455", borderWidth: 1, borderRadius: 10, paddingVertical: 11, alignItems: "center", justifyContent: "center", marginTop: 10 },
  fixButtonText: { color: "#ffd58a", fontWeight: "800", fontSize: 13 },
  divider: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 16 },
  dividerLine: { flex: 1, height: 1, backgroundColor: C.line },
  dividerText: { color: C.faint, fontSize: 12 },
  topBar: { paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: C.bg },
  topLogo: { color: C.red, fontSize: 26, fontWeight: "900", letterSpacing: 1 },
  iconButton: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  pressed: { backgroundColor: "#ffffff22" },
  face: { backgroundColor: C.red, alignItems: "center", justifyContent: "center" },
  profileMenu: { width: "88%", maxWidth: 400, backgroundColor: C.surface, borderColor: C.line, borderWidth: 1, borderRadius: 16, overflow: "hidden" },
  profileHead: { flexDirection: "row", alignItems: "center", gap: 14, padding: 18, borderBottomWidth: 1, borderBottomColor: C.line },
  profileName: { color: C.text, fontSize: 18, fontWeight: "800", marginBottom: 3 },
  hero: { height: 560, justifyContent: "flex-end" },
  heroContent: { padding: 20, paddingBottom: 34 },
  heroKickerRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 },
  heroKicker: { color: C.muted, fontWeight: "800", letterSpacing: 2, fontSize: 12 },
  shuffleBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: "#ffffff1a", alignItems: "center", justifyContent: "center" },
  heroTitle: { color: C.text, fontSize: 42, fontWeight: "900", textTransform: "uppercase", marginBottom: 10 },
  metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 4 },
  match: { color: C.green, fontWeight: "800" },
  metaText: { color: C.text, fontWeight: "600" },
  badge: { color: C.muted, borderColor: C.faint, borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1, fontSize: 11, fontWeight: "700" },
  heroDesc: { color: "#dadade", fontSize: 15, lineHeight: 22, marginBottom: 18 },
  actions: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  whiteButton: { backgroundColor: "#fff", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 8 },
  whiteButtonText: { color: "#000", fontWeight: "800", fontSize: 14 },
  ghostButton: { backgroundColor: "rgba(110,110,122,0.45)", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 8 },
  ghostButtonText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  rows: { marginTop: -20, paddingBottom: 40 },
  row: { marginTop: 22 },
  rowTitle: { color: C.text, fontSize: 18, fontWeight: "800", paddingHorizontal: 16, marginBottom: 10 },
  rowContent: { paddingHorizontal: 16 },
  card: {},
  cardPressed: { transform: [{ scale: 1.05 }], opacity: 0.9 },
  poster: { borderRadius: 10, overflow: "hidden", backgroundColor: C.surface2, width: "100%" },
  posterTall: { aspectRatio: 2 / 3 },
  posterWide: { aspectRatio: 16 / 9 },
  posterFallback: { padding: 12, justifyContent: "flex-end" },
  posterFallbackTitle: { color: C.text, fontWeight: "900", fontSize: 16 },
  epBadge: { position: "absolute", top: 8, left: 8, backgroundColor: "rgba(8,8,11,0.82)", borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 },
  epBadgeText: { color: "#fff", fontWeight: "800", fontSize: 11 },
  progressTrack: { position: "absolute", left: 0, right: 0, bottom: 0, height: 4, backgroundColor: "rgba(255,255,255,0.25)" },
  progressFill: { height: "100%", backgroundColor: C.red },
  wideLabel: { position: "absolute", left: 10, right: 10, bottom: 10 },
  wideLabelTitle: { color: "#fff", fontWeight: "800", fontSize: 13 },
  wideLabelSub: { color: "#d2d2d8", fontSize: 12 },
  searchHeader: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 10, gap: 8 },
  searchInput: { flex: 1, backgroundColor: C.surface2, borderColor: C.line, borderWidth: 1, borderRadius: 30, color: C.text, paddingHorizontal: 16, paddingVertical: 10 },
  grid: { padding: 16 },
  gridItem: { flex: 1 / 3, maxWidth: "33.333%", paddingHorizontal: 5, marginBottom: 18 },
  gridTitle: { color: C.muted, fontSize: 12, marginTop: 6 },
  detailHero: { minHeight: 560, justifyContent: "flex-end" },
  detailHeroContent: { padding: 20, paddingBottom: 34 },
  detailTitle: { color: C.text, fontSize: 40, fontWeight: "900", textTransform: "uppercase", marginTop: 16, marginBottom: 10 },
  detailBody: { padding: 20, paddingBottom: 90 },
  inListNote: { color: C.green, fontSize: 12, fontWeight: "700", marginTop: 10 },
  facts: { color: C.muted, fontSize: 13, marginBottom: 8 },
  sectionTitle: { color: C.text, fontSize: 20, fontWeight: "800", marginTop: 18, marginBottom: 12 },
  seasonHeader: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 20 },
  seasonChip: { backgroundColor: C.surface2, borderColor: C.line, borderWidth: 1, borderRadius: 30, paddingHorizontal: 16, paddingVertical: 8, marginRight: 8 },
  seasonChipOn: { backgroundColor: "#fff", borderColor: "#fff" },
  seasonText: { color: C.muted, fontWeight: "800" },
  seasonTextOn: { color: "#000" },
  episode: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.08)" },
  episodeNum: { color: C.faint, fontSize: 20, fontWeight: "800", width: 28, textAlign: "center" },
  episodeThumb: { width: 130, aspectRatio: 16 / 9, borderRadius: 8, overflow: "hidden", backgroundColor: C.surface3 },
  episodeTitle: { color: C.text, fontWeight: "800", fontSize: 15 },
  episodeDesc: { color: C.muted, fontSize: 12, marginTop: 3 },
  similarGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  similarItem: { width: "31%" },
  roundButton: { width: 46, height: 46, borderRadius: 23, borderWidth: 2, borderColor: "rgba(255,255,255,0.6)", alignItems: "center", justifyContent: "center" },
  roundOn: { borderColor: C.green },
  overlayRoot: { ...StyleSheet.absoluteFillObject, backgroundColor: C.bg, zIndex: 100 },
  overlayLand: { justifyContent: "center", alignItems: "center", backgroundColor: "#000" },
  landWrap: { flex: 1, width: "100%", alignItems: "center", justifyContent: "center", backgroundColor: "#000" },
  videoBox: { backgroundColor: "#000", overflow: "hidden", position: "relative" },
  infoPanel: { flex: 1, backgroundColor: C.bg },
  infoTitle: { color: C.text, fontSize: 21, fontWeight: "800", marginBottom: 4 },
  infoSub: { color: C.muted, fontSize: 13, marginBottom: 10 },
  infoDesc: { color: "#d6d6de", fontSize: 14, lineHeight: 21, marginBottom: 12 },
  statsInline: { backgroundColor: C.surface, borderColor: C.line, borderWidth: 1, borderRadius: 10, padding: 12, marginTop: 14 },
  vTopScrim: { position: "absolute", top: 0, left: 0, right: 0, height: 70 },
  vBottomScrim: { position: "absolute", bottom: 0, left: 0, right: 0, height: 110 },
  vTop: { position: "absolute", top: 4, left: 4, right: 4, flexDirection: "row", alignItems: "center", zIndex: 20 },
  vBottom: { position: "absolute", left: 8, right: 8, bottom: 2, zIndex: 20 },
  vControls: { flexDirection: "row", alignItems: "center", gap: 0 },
  vError: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(6,6,9,0.94)", alignItems: "center", justifyContent: "center", padding: 16, gap: 10, zIndex: 40 },
  subBox: { position: "absolute", left: 12, right: 12, alignItems: "center", zIndex: 15 },
  subText: { textAlign: "center", borderRadius: 5, overflow: "hidden" },
  centerSpin: { position: "absolute", left: "50%", top: "50%", marginLeft: -30, marginTop: -30, width: 60, height: 60, alignItems: "center", justifyContent: "center", zIndex: 30 },
  centerPlay: { position: "absolute", left: "50%", top: "50%", marginLeft: -36, marginTop: -36, width: 72, height: 72, alignItems: "center", justifyContent: "center", zIndex: 25 },
  centerIcon: { textShadowColor: "rgba(0,0,0,0.85)", textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 10 },
  playerTitle: { color: "#fff", fontWeight: "800", fontSize: 15 },
  playerTime: { color: "#fff", fontWeight: "700", fontSize: 12 },
  hdButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  hdBox: { borderWidth: 1.5, borderColor: "#fff", borderRadius: 4, paddingHorizontal: 4, height: 18, alignItems: "center", justifyContent: "center" },
  hdText: { color: "#fff", fontWeight: "900", fontSize: 10, lineHeight: 12, textAlign: "center", includeFontPadding: false },
  statsTitle: { color: C.green, fontWeight: "900", fontSize: 10, letterSpacing: 1.4, marginBottom: 5 },
  statsLine: { color: "#d6d6de", fontSize: 11, lineHeight: 16 },
  endLabel: { color: C.muted, textTransform: "uppercase", letterSpacing: 2, fontWeight: "800", fontSize: 11 },
  nextCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: C.surface2, borderColor: C.line, borderWidth: 1, borderRadius: 12, padding: 10, width: "100%" },
  nextThumb: { width: 90, aspectRatio: 16 / 9, borderRadius: 6, backgroundColor: C.surface3 },
  notice: { position: "absolute", alignSelf: "center", backgroundColor: "rgba(8,8,11,0.92)", borderColor: C.line, borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8, maxWidth: "88%", zIndex: 120 },
  noticeText: { color: C.text, fontSize: 12.5, fontWeight: "700", textAlign: "center" },
  mini: { position: "absolute", left: 8, right: 8, backgroundColor: C.surface2, borderColor: C.line, borderWidth: 1, borderRadius: 12, overflow: "hidden", zIndex: 90 },
  miniRow: { flexDirection: "row", alignItems: "center", gap: 8, padding: 6 },
  miniVideo: { width: 96, aspectRatio: 16 / 9, borderRadius: 7, overflow: "hidden", backgroundColor: "#000" },
  miniTitle: { color: C.text, fontWeight: "800", fontSize: 13 },
  miniSub: { color: C.muted, fontSize: 11 },
  miniProgress: { height: 3, backgroundColor: "rgba(255,255,255,0.18)" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 16 },
  menu: { backgroundColor: "rgba(16,16,22,0.99)", borderColor: C.line, borderWidth: 1, borderRadius: 16, overflow: "hidden" },
  menuItem: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" },
  menuItemText: { color: C.text, fontSize: 14, fontWeight: "600", flex: 1, paddingRight: 10 },
  menuValue: { color: C.green, fontWeight: "800" },
  menuHeader: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line },
  menuHeaderText: { color: C.text, fontWeight: "800", fontSize: 15 },
  menuNote: { color: C.faint, fontSize: 12, padding: 14, lineHeight: 17 },
  switch: { width: 40, height: 22, borderRadius: 11, backgroundColor: "#3a3a46", padding: 2 },
  switchOn: { backgroundColor: C.red },
  switchKnob: { width: 18, height: 18, borderRadius: 9, backgroundColor: "#fff" },
  switchKnobOn: { transform: [{ translateX: 18 }] },
  pageTitle: { color: C.text, fontSize: 24, fontWeight: "800" },
  settingsScroll: { padding: 16, paddingBottom: 90, gap: 16 },
  settingsScrollWide: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start" },
  settingsCard: { backgroundColor: C.surface, borderColor: C.line, borderWidth: 1, borderRadius: 16, padding: 18 },
  halfCard: { width: "48%", flexGrow: 1 },
  settingBlock: { marginVertical: 10 },
  settingLabel: { color: C.text, fontWeight: "700", marginBottom: 8, flex: 1, paddingRight: 12 },
  settingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12 },
  choiceWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: { backgroundColor: C.surface2, borderColor: C.line, borderWidth: 1, borderRadius: 30, paddingHorizontal: 14, paddingVertical: 8 },
  choiceOn: { backgroundColor: "#fff", borderColor: "#fff" },
  choiceText: { color: C.muted, fontWeight: "800", fontSize: 12 },
  choiceTextOn: { color: "#000" },
  settingsActions: { gap: 10, marginTop: 14 }
});
