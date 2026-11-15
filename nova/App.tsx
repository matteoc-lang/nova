import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, Animated, AppState, FlatList, Image, ImageBackground,
  Modal, PanResponder, Pressable, ScrollView, StatusBar, StyleSheet, Text,
  TextInput, View, useWindowDimensions
} from "react-native";
import { useEventListener } from "expo";
import { requireNativeModule } from "expo-modules-core";
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

let NovaPip: any = null;
try { NovaPip = requireNativeModule("NovaPip"); } catch {}

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
  const base = 'MediaBrowser Client="NOVA", Device="Android", DeviceId="nova-android", Version="6.1.0"';
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
  return lines.join("\n").replace(/<[^>]+>/g, "").replace(/\{[^}]*\}/g, "").replace(/\\N/g, "\n").replace(/\\n/g, "\n").trim();
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
    const idx = seasons[i].episodes.findIndex((e: any) 