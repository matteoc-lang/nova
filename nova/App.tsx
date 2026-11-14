import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, Image, ImageBackground, Modal, Pressable,
  ScrollView, StatusBar, StyleSheet, Text, TextInput, View, useWindowDimensions
} from "react-native";
import { useEventListener } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { NavigationContainer, DefaultTheme } from "@react-navigation/native";
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
const AppCtx = createContext<any>(null);
const useApp = () => useContext(AppCtx);
const navTheme = { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: C.bg, card: C.bg, text: C.text, primary: C.red, border: C.line } };

const defaultSettings = {
  streamMode: "auto", quality: "auto", audioLang: "it", subLang: "it", autoSub: false,
  autoplay: true, loop: false, speed: 1, posterSize: 150, thumbWide: true,
  animations: true, progressBars: true, stats: false, saveData: false
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
  const base = 'MediaBrowser Client="NOVA", Device="Android", DeviceId="nova-android", Version="1.4.0"';
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

function setUrlParam(url: string, key: string, value: any) {
  const qIndex = url.indexOf("?");
  const base = qIndex >= 0 ? url.slice(0, qIndex) : url;
  const query = qIndex >= 0 ? url.slice(qIndex + 1) : "";
  const parts = query.split("&").filter(Boolean).filter(p => {
    const k = p.split("=")[0];
    try { return decodeURIComponent(k) !== key; } catch { return k !== key; }
  });
  parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
  return base + "?" + parts.join("&");
}

function removeUrlParam(url: string, key: string) {
  const qIndex = url.indexOf("?");
  if (qIndex < 0) return url;
  const base = url.slice(0, qIndex);
  const query = url.slice(qIndex + 1);
  const parts = query.split("&").filter(Boolean).filter(p => {
    const k = p.split("=")[0];
    try { return decodeURIComponent(k) !== key; } catch { return k !== key; }
  });
  return parts.length ? base + "?" + parts.join("&") : base;
}

function nativeProfile(force: boolean, bitrate: number, burnSubs: boolean) {
  return {
    MaxStreamingBitrate: bitrate,
    MaxStaticBitrate: 200000000,
    DirectPlayProfiles: force ? [] : [{ Container: "mp4,m4v,mov,mkv,webm", Type: "Video", VideoCodec: "h264,hevc,vp9,av1", AudioCodec: "aac,mp3,ac3,eac3,opus,flac,vorbis" }],
    TranscodingProfiles: [{ Container: "ts", Type: "Video", VideoCodec: "h264", AudioCodec: "aac,mp3", Context: "Streaming", Protocol: "hls", MaxAudioChannels: "2", MinSegments: "1", BreakOnNonKeyFrames: true }],
    SubtitleProfiles: burnSubs
      ? [{ Format: "srt", Method: "Encode" }, { Format: "ass", Method: "Encode" }, { Format: "ssa", Method: "Encode" }, { Format: "vtt", Method: "Encode" }, { Format: "pgs", Method: "Encode" }, { Format: "dvdsub", Method: "Encode" }]
      : [{ Format: "srt", Method: "External" }, { Format: "ass", Method: "External" }, { Format: "vtt", Method: "External" }, { Format: "srt", Method: "Encode" }, { Format: "ass", Method: "Encode" }, { Format: "pgs", Method: "Encode" }]
  };
}

async function getPlayback(session: any, itemId: string, settings: any, opts: any = {}) {
  if (session.mode === "demo") {
    return {
      id: itemId, url: opts.demoUrl, method: "DirectPlay", hls: false, quality: opts.quality || "auto",
      duration: opts.duration || 0, audio: [{ Index: 0, DisplayTitle: "Originale · AAC", Language: "eng" }],
      subs: [{ Index: 0, DisplayTitle: "Italiano demo", Language: "ita" }], audioIndex: 0, subtitleIndex: null,
      mediaSourceId: "demo", playSessionId: "demo", reason: "Demo MP4/H.264"
    };
  }

  const quality = opts.quality || settings.quality || "auto";
  const rates: any = { auto: 40000000, 2160: 40000000, 1080: 8000000, 720: 4000000, 480: 1500000, 360: 700000 };
  let bitrate = rates[quality] || 40000000;
  if (settings.saveData && quality === "auto") bitrate = 4000000;

  const explicitAudio = opts.audioIndex != null ? opts.audioIndex : null;
  const explicitSub = opts.subtitleIndex != null && opts.subtitleIndex >= 0 ? opts.subtitleIndex : null;
  const subOff = opts.subtitleIndex === -1;
  const wantTranscode = !!opts.force || settings.streamMode === "transcode" || quality !== "auto" || explicitAudio != null || explicitSub != null || subOff;

  const req = async (force: boolean, audioIndex: number | null, subtitleIndex: number | null, burnSubs: boolean) => {
    const body: any = {
      DeviceProfile: nativeProfile(force, bitrate, burnSubs),
      AutoOpenLiveStream: true,
      MaxStreamingBitrate: bitrate,
      EnableDirectPlay: !force,
      EnableDirectStream: !force,
      EnableTranscoding: true,
      AllowVideoStreamCopy: !force,
      AllowAudioStreamCopy: !force
    };
    if (audioIndex != null) body.AudioStreamIndex = audioIndex;
    if (subtitleIndex != null && subtitleIndex >= 0) body.SubtitleStreamIndex = subtitleIndex;
    const r = await fetch(session.server + "/Items/" + itemId + "/PlaybackInfo?userId=" + session.userId, {
      method: "POST", headers: authHeaders(session.token), body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error("PlaybackInfo HTTP " + r.status);
    return r.json();
  };

  let j = await req(wantTranscode, explicitAudio, explicitSub, explicitSub != null);
  let ms = j.MediaSources && j.MediaSources[0];
  if (!ms) throw new Error("Nessuna MediaSource disponibile.");

  const audio = (ms.MediaStreams || []).filter((s: any) => s.Type === "Audio");
  const subs = (ms.MediaStreams || []).filter((s: any) => s.Type === "Subtitle");

  let ai = explicitAudio;
  if (ai == null) {
    const pref = audio.find((a: any) => String(a.Language || "").toLowerCase().startsWith(settings.audioLang));
    ai = pref ? pref.Index : ms.DefaultAudioStreamIndex != null ? ms.DefaultAudioStreamIndex : audio[0]?.Index ?? null;
  }
  let si = explicitSub;
  if (si == null && !subOff && settings.autoSub) {
    const p = subs.find((s: any) => String(s.Language || "").toLowerCase().startsWith(settings.subLang));
    si = p ? p.Index : null;
  }

  const burnSubs = si != null;
  const mustForce = wantTranscode || burnSubs || (ai != null && ai !== ms.DefaultAudioStreamIndex);
  j = await req(mustForce, ai, si, burnSubs);
  ms = (j.MediaSources && j.MediaSources[0]) || ms;

  let url: string, method: string;
  if (!mustForce && ms.SupportsDirectPlay) {
    url = session.server + "/Videos/" + itemId + "/stream?static=true&mediaSourceId=" + ms.Id + "&api_key=" + session.token;
    method = "DirectPlay";
  } else if (ms.TranscodingUrl) {
    url = ms.TranscodingUrl.startsWith("http") ? ms.TranscodingUrl : session.server + ms.TranscodingUrl;
    url = removeUrlParam(url, "StartTimeTicks");
    if (ai != null) url = setUrlParam(url, "AudioStreamIndex", ai);
    if (si != null) {
      url = setUrlParam(url, "SubtitleStreamIndex", si);
      url = setUrlParam(url, "SubtitleMethod", "Encode");
    } else {
      url = removeUrlParam(url, "SubtitleStreamIndex");
      url = removeUrlParam(url, "SubtitleMethod");
    }
    if (!/[?&]api_key=/.test(url)) url = setUrlParam(url, "api_key", session.token);
    method = mustForce ? "Transcode" : "DirectStream";
  } else {
    url = session.server + "/Videos/" + itemId + "/stream?static=true&mediaSourceId=" + ms.Id + "&api_key=" + session.token;
    method = "DirectPlay";
  }

  return {
    id: itemId, url, method, hls: /\.m3u8/i.test(url), quality,
    duration: (ms.RunTimeTicks || 0) / 1e7,
    audio, subs, audioIndex: ai, subtitleIndex: si,
    mediaSourceId: ms.Id, playSessionId: j.PlaySessionId,
    reason: burnSubs ? "Transcoding con sottotitoli masterizzati" : mustForce ? "Transcoding richiesto o fallback" : "Direct Play nativo"
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
    series("cieli", "I Cieli di Ferro", 2024, ["Fantascienza", "Drammatico"], 205, 97, "Le città volano su piattaforme di ferro. Sotto le nuvole, qualcosa abita.", [
      { n: 1, name: "Stagione 1", episodes: eps("cieli", 1, ["Il decollo", "Sotto le nuvole", "Ferro e cielo", "La caduta", "Vecchie rotte", "Il segnale"], 205) },
      { n: 2, name: "Stagione 2", episodes: eps("cieli", 2, ["Ritorno a bordo", "La città fantasma", "Gravità zero", "Il patto", "Punto di fuga", "Cieli aperti"], 225) }
    ], 3),
    series("palude", "Palude", 2023, ["Thriller", "Giallo"], 150, 94, "Un paese di nebbia e canali, una serie di sparizioni che nessuno collega.", [
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

function IconButton({ name, onPress, size = 22, style }: any) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed, style]}>
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
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => { if (uri !== fallback) setUri(fallback); }} />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.posterFallback, { backgroundColor: "hsl(" + (item.hue || 210) + ",55%,22%)" }]}>
          <Text style={styles.posterFallbackTitle}>{item.title}</Text>
        </View>
      )}
      {!!ep && <View style={styles.epBadge}><Text style={styles.epBadgeText}>S{ep.season} · E{ep.episode}</Text></View>}
      {pct > 0 && <View style={styles.progressTrack}><View style={[styles.progressFill, { width: pct + "%" }]} /></View>}
      {wide && (
        <View style={styles.wideLabel}>
          <Text numberOfLines={1} style={styles.wideLabelTitle}>{ep ? ep.title : item.title}</Text>
          {!!ep && <Text numberOfLines={1} style={styles.wideLabelSub}>{item.title}</Text>}
        </View>
      )}
    </View>
  );
}

function MediaCard({ item, ep, wide, onPress, onLongPress, progress, width }: any) {
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={350}
      style={({ pressed }) => [styles.card, { width }, pressed && styles.cardPressed]}>
      <Poster item={item} ep={ep} wide={wide} progress={progress} />
    </Pressable>
  );
}

function Row({ title, data, renderItem, keyExtractor }: any) {
  if (!data || !data.length) return null;
  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>{title}</Text>
      <FlatList horizontal data={data} keyExtractor={keyExtractor} renderItem={renderItem}
        showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rowContent}
        ItemSeparatorComponent={() => <View style={{ width: 10 }} />} />
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
    try { const r = await testServer(server); setStatus("✓ " + r.name + " · v" + r.version); }
    catch (e: any) { setStatus(e.message); }
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
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.loginScroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.logo}>NOVA</Text>
        <Text style={styles.logoSub}>for Jellyfin</Text>
        <View style={styles.loginCard}>
          <Text style={styles.loginCardTitle}>Accedi</Text>
          <Text style={styles.loginCardSub}>Connettiti al tuo server Jellyfin.</Text>

          <Text style={styles.label}>Server</Text>
          <TextInput value={server} onChangeText={setServer} placeholder="http://192.168.1.10:8096"
            placeholderTextColor={C.faint} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input} />

          <Pressable onPress={doTest} style={styles.testButton}><Text style={styles.testButtonText}>Test connessione</Text></Pressable>
          {!!status && <Text style={[styles.status, status.startsWith("✓") ? styles.ok : styles.bad]}>{status}</Text>}

          <Text style={styles.label}>Utente</Text>
          <TextInput value={user} onChangeText={setUser} autoCapitalize="none" autoCorrect={false} style={styles.input} />

          <Text style={styles.label}>Password</Text>
          <View style={styles.passWrap}>
            <TextInput value={pass} onChangeText={setPass} secureTextEntry={!showPass}
              autoCapitalize="none" autoCorrect={false} autoComplete="off" importantForAutofill="no"
              style={[styles.input, { paddingRight: 50 }]} />
            <Pressable onPress={() => setShowPass(v => !v)} style={styles.eyeButton}>
              <Ionicons name={showPass ? "eye-off-outline" : "eye-outline"} size={22} color={C.muted} />
            </Pressable>
          </View>

          {!!err && <Text style={styles.bad}>{err}</Text>}

          <Pressable onPress={doLogin} disabled={busy} style={[styles.primaryButton, busy && { opacity: 0.6 }]}>
            <Text style={styles.primaryButtonText}>{busy ? "Accesso…" : "Accedi"}</Text>
          </Pressable>

          <View style={styles.divider}><View style={styles.dividerLine} /><Text style={styles.dividerText}>oppure</Text><View style={styles.dividerLine} /></View>

          <Pressable onPress={() => setSession({ mode: "demo", user: "Matteo" })} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Esplora la demo</Text>
          </Pressable>
          <Pressable onPress={resetLocal} style={styles.fixButton}><Text style={styles.fixButtonText}>Ripara dati locali</Text></Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function MenuItem({ label, value, selected, onPress }: any) {
  return (
    <Pressable onPress={onPress} style={styles.menuItem}>
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

function TopBar({ navigation }: any) {
  const { session, setSession, reloadLibrary, resetLocal } = useApp();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <>
      <View style={[styles.topBar, { paddingTop: insets.top, height: 62 + insets.top }]}>
        <Text style={styles.topLogo}>NOVA</Text>
        <View style={{ flex: 1 }} />
        <IconButton name="search" onPress={() => navigation.navigate("Search")} />
        <IconButton name="settings-outline" onPress={() => navigation.navigate("Settings")} />
        <Pressable onPress={() => setOpen(true)} style={({ pressed }) => pressed && { opacity: 0.75 }}>
          <Face size={34} />
        </Pressable>
      </View>

      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <Pressable style={styles.modalBackdrop} onPress={close}>
          <Pressable style={styles.profileMenu} onPress={() => {}}>
            <View style={styles.profileHead}>
              <Face size={54} />
              <View style={{ flex: 1 }}>
                <Text style={styles.profileName}>{session?.user || "Matteo"}</Text>
                <Text style={styles.muted} numberOfLines={1}>{session?.mode === "demo" ? "Modalità demo" : session?.server}</Text>
              </View>
            </View>
            <MenuItem label="Impostazioni" onPress={() => { close(); navigation.navigate("Settings"); }} />
            <MenuItem label="Ricarica libreria" onPress={() => { close(); reloadLibrary(); }} />
            <MenuItem label="Esci" onPress={() => { close(); setSession(null); }} />
            <MenuItem label="Ripara dati locali" onPress={() => { close(); resetLocal(); }} />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function HomeScreen({ navigation }: any) {
  const { items, epMap, progress, nextUp, list, libLoading, settings, featured, reshuffle } = useApp();
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

  if (libLoading) return <SafeAreaView style={styles.center}><ActivityIndicator color={C.red} size="large" /><Text style={styles.muted}>Carico la libreria…</Text></SafeAreaView>;
  if (!featured) return <SafeAreaView style={styles.center}><Text style={styles.emptyTitle}>Libreria vuota</Text></SafeAreaView>;

  const goDetail = (id: string) => navigation.navigate("Detail", { itemId: id });

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <TopBar navigation={navigation} />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          {featured.backdrop ? <ImageBackground source={{ uri: featured.backdrop }} style={StyleSheet.absoluteFill} resizeMode="cover" />
            : <View style={[StyleSheet.absoluteFill, { backgroundColor: "hsl(" + featured.hue + ",55%,22%)" }]} />}
          <LinearGradient colors={["rgba(8,8,11,0.15)", "rgba(8,8,11,0.75)", C.bg]} style={StyleSheet.absoluteFill} />
          <View style={styles.heroContent}>
            <View style={styles.heroKickerRow}>
              <Text style={styles.heroKicker}>CONSIGLIATO PER TE</Text>
              <Pressable onPress={reshuffle} style={styles.shuffleBtn}><Ionicons name="shuffle" size={16} color={C.muted} /></Pressable>
            </View>
            <Text style={styles.heroTitle}>{featured.title}</Text>
            <View style={styles.metaRow}>
              <Text style={styles.match}>{featured.match}% compatibile</Text>
              <Text style={styles.metaText}>{featured.year}</Text>
              <Text style={styles.badge}>HD</Text>
            </View>
            <Text numberOfLines={3} style={styles.heroDesc}>{featured.overview}</Text>
            <View style={styles.actions}>
              <Pressable onPress={() => navigation.navigate("Player", { itemId: featured.id })} style={styles.whiteButton}>
                <Ionicons name="play" size={22} color="#000" /><Text style={styles.whiteButtonText}>Play</Text>
              </Pressable>
              <Pressable onPress={() => goDetail(featured.id)} style={styles.ghostButton}>
                <Ionicons name="information-circle-outline" size={22} color="#fff" /><Text style={styles.ghostButtonText}>Info</Text>
              </Pressable>
            </View>
          </View>
        </View>

        <View style={styles.rows}>
          <Row title="Continua a guardare" data={continueData} keyExtractor={(x: any) => x.ep?.id || x.item.id}
            renderItem={({ item: x }: any) => (
              <MediaCard item={x.item} ep={x.ep} wide={wide} width={wide ? wideW : cardW}
                progress={progress[x.ep?.id || x.item.id]}
                onPress={() => navigation.navigate("Player", { itemId: x.item.id, episode: x.ep })}
                onLongPress={() => goDetail(x.item.id)} />
            )} />
          <Row title="Prossimi episodi" data={nextUp} keyExtractor={(x: any) => x.ep.id}
            renderItem={({ item: x }: any) => (
              <MediaCard item={x.item} ep={x.ep} wide={wide} width={wide ? wideW : cardW}
                progress={progress[x.ep.id]}
                onPress={() => navigation.navigate("Player", { itemId: x.item.id, episode: x.ep })}
                onLongPress={() => goDetail(x.item.id)} />
            )} />
          <Row title="La tua lista" data={myList} keyExtractor={(x: any) => x.id}
            renderItem={({ item }: any) => (
              <MediaCard item={item} width={cardW} onPress={() => goDetail(item.id)} onLongPress={() => goDetail(item.id)} />
            )} />
          <Row title="Aggiunti di recente" data={[...items].sort((a: any, b: any) => b.added - a.added)} keyExtractor={(x: any) => x.id}
            renderItem={({ item }: any) => <MediaCard item={item} width={cardW} onPress={() => goDetail(item.id)} onLongPress={() => goDetail(item.id)} />} />
          <Row title="Film" data={items.filter((i: any) => i.type === "movie")} keyExtractor={(x: any) => x.id}
            renderItem={({ item }: any) => <MediaCard item={item} width={cardW} onPress={() => goDetail(item.id)} onLongPress={() => goDetail(item.id)} />} />
          <Row title="Serie TV" data={items.filter((i: any) => i.type === "series")} keyExtractor={(x: any) => x.id}
            renderItem={({ item }: any) => <MediaCard item={item} width={cardW} onPress={() => goDetail(item.id)} onLongPress={() => goDetail(item.id)} />} />
        </View>
      </ScrollView>
    </View>
  );
}

function SearchScreen({ navigation }: any) {
  const { items } = useApp();
  const [q, setQ] = useState("");
  const res = q.trim() ? items.filter((i: any) => i.title.toLowerCase().includes(q.toLowerCase()) || i.genres.join(" ").toLowerCase().includes(q.toLowerCase())) : [];
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.searchHeader}>
        <IconButton name="arrow-back" onPress={() => navigation.goBack()} />
        <TextInput autoFocus value={q} onChangeText={setQ} placeholder="Cerca titoli, generi…" placeholderTextColor={C.faint}
          autoCapitalize="none" autoCorrect={false} style={styles.searchInput} />
      </View>
      <FlatList data={res} keyExtractor={(i: any) => i.id} numColumns={3} contentContainerStyle={styles.grid}
        renderItem={({ item }) => (
          <View style={styles.gridItem}>
            <MediaCard item={item} width="100%" onPress={() => navigation.navigate("Detail", { itemId: item.id })} />
            <Text numberOfLines={1} style={styles.gridTitle}>{item.title}</Text>
          </View>
        )}
        ListEmptyComponent={<View style={styles.center}><Ionicons name="search" size={48} color={C.faint} /><Text style={styles.emptyTitle}>Cerca nella libreria</Text></View>} />
    </SafeAreaView>
  );
}

function DetailScreen({ route, navigation }: any) {
  const { session, items, progress, list, toggleList } = useApp();
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
        {item.backdrop ? <ImageBackground source={{ uri: item.backdrop }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          : <View style={[StyleSheet.absoluteFill, { backgroundColor: "hsl(" + item.hue + ",55%,22%)" }]} />}
        <LinearGradient colors={["rgba(8,8,11,0.2)", "rgba(8,8,11,0.75)", C.bg]} style={StyleSheet.absoluteFill} />
        <SafeAreaView style={styles.detailHeroContent}>
          <IconButton name="arrow-back" onPress={() => navigation.goBack()} />
          <Text style={styles.detailTitle}>{item.title}</Text>
          <View style={styles.metaRow}>
            <Text style={styles.match}>{item.match}% compatibile</Text>
            <Text style={styles.metaText}>{item.year}</Text>
            <Text style={styles.badge}>{item.rating}</Text>
          </View>
          <Text numberOfLines={4} style={styles.heroDesc}>{item.overview}</Text>
          <View style={styles.actions}>
            <Pressable onPress={() => navigation.navigate("Player", { itemId: item.id, episode: ep })} style={styles.whiteButton}>
              <Ionicons name="play" size={22} color="#000" /><Text style={styles.whiteButtonText}>{resume > 0 ? "Riprendi" : "Play"}</Text>
            </Pressable>
            <Pressable onPress={() => toggleList(item.id)} style={[styles.roundButton, inList && styles.roundOn]}>
              <Ionicons name={inList ? "checkmark" : "add"} size={26} color={inList ? C.green : "#fff"} />
            </Pressable>
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
              {seasons.map((s: any) => (
                <Pressable key={s.n} onPress={() => setSeason(s.n)} style={[styles.seasonChip, cur?.n === s.n && styles.seasonChipOn]}>
                  <Text style={[styles.seasonText, cur?.n === s.n && styles.seasonTextOn]}>{s.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
            {(cur?.episodes || []).map((e: any) => {
              const p = progress[e.id];
              const pct = p && p.duration ? Math.min(100, (p.position / p.duration) * 100) : 0;
              return (
                <Pressable key={e.id} onPress={() => navigation.navigate("Player", { itemId: item.id, episode: e })} style={styles.episode}>
                  <Text style={styles.episodeNum}>{e.episode}</Text>
                  <View style={styles.episodeThumb}>
                    <Image source={{ uri: e.thumb }} style={StyleSheet.absoluteFill} onError={() => {}} />
                    {pct > 0 && <View style={styles.progressTrack}><View style={[styles.progressFill, { width: pct + "%" }]} /></View>}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.episodeTitle}>{e.title}</Text>
                    <Text numberOfLines={2} style={styles.episodeDesc}>{e.overview}</Text>
                  </View>
                  <Text style={styles.faint}>{fmt(e.duration)}</Text>
                </Pressable>
              );
            })}
          </>
        )}

        {!!similar.length && (
          <>
            <Text style={styles.sectionTitle}>Altri titoli simili</Text>
            <View style={styles.similarGrid}>
              {similar.map((x: any) => (
                <View key={x.id} style={styles.similarItem}>
                  <MediaCard item={x} width="100%" onPress={() => navigation.navigate("Detail", { itemId: x.id })} />
                </View>
              ))}
            </View>
          </>
        )}
      </View>
    </ScrollView>
  );
}

function PlayerScreen({ route, navigation }: any) {
  const { session, items, epMap, progress, settings, setSettings, saveProgress } = useApp();
  const dim = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const item = items.find((x: any) => x.id === route.params.itemId);

  const [episode, setEpisode] = useState<any>(route.params.episode || epMap[route.params.episodeId] || null);
  const [info, setInfo] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrub, setScrub] = useState(0);
  const [controls, setControls] = useState(true);
  const [menu, setMenu] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [nextEp, setNextEp] = useState<any>(null);
  const [countdown, setCountdown] = useState(8);
  const [landscape, setLandscape] = useState(false);
  const [notice, setNotice] = useState("");

  const player = useVideoPlayer(null, p => { p.loop = false; });
  const pendingSeek = useRef<number | null>(null);
  const seekLock = useRef(0);
  const scrubbingRef = useRef(false);
  const finishedRef = useRef(false);
  const retried = useRef(false);
  const lastSave = useRef(0);
  const positionRef = useRef(0);
  const infoRef = useRef<any>(null);
  const optsRef = useRef<any>({});
  const episodeRef = useRef<any>(null);
  const noticeTimer = useRef<any>(null);

  useEffect(() => { infoRef.current = info; }, [info]);
  useEffect(() => { episodeRef.current = episode; }, [episode]);
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => () => {
    ScreenOrientation.unlockAsync().catch(() => {});
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  function flashNotice(msg: string) {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 2600);
  }

  async function load(opts: any = {}, epArg = episodeRef.current, startAt = 0) {
    if (!item) return;
    setLoading(true); setError(""); setEnded(false);
    optsRef.current = { ...optsRef.current, ...opts };
    try {
      const inf = await getPlayback(session, epArg ? epArg.id : item.id, settings, {
        ...optsRef.current,
        demoUrl: epArg?.video || item.video,
        duration: epArg?.duration || item.duration
      });
      infoRef.current = inf;
      setInfo(inf);
      const fullDuration = inf.duration || epArg?.duration || item.duration || 0;
      setDuration(fullDuration);
      pendingSeek.current = startAt;
      setPosition(startAt);
      positionRef.current = startAt;
      player.replace({ uri: inf.url });
    } catch (e: any) {
      setError(e.message || "Errore di riproduzione.");
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!item) return;
    let alive = true;
    (async () => {
      let ep = route.params.episode || epMap[route.params.episodeId] || null;
      if (item.type === "series" && !ep) {
        const ss = await loadSeasons(session, item);
        ep = targetEpisode(ss, progress);
      }
      if (!alive) return;
      setEpisode(ep);
      episodeRef.current = ep;
      const id = ep ? ep.id : item.id;
      const start = isWatched(progress[id]) ? 0 : (route.params.resume ?? (progress[id]?.position || 0));
      await load({}, ep, start);
    })();
    return () => {
      alive = false;
      if (infoRef.current) reportPlayback(session, "stop", infoRef.current, positionRef.current, true);
    };
  }, [item?.id]);

  useEventListener(player, "statusChange", ({ status, error }: any) => {
    if (status === "readyToPlay") {
      if (pendingSeek.current != null) {
        const t = pendingSeek.current;
        pendingSeek.current = null;
        try { player.currentTime = t; } catch {}
      }
      try { player.play(); } catch {}
      setLoading(false);
    } else if (status === "loading") {
      setLoading(true);
    } else if (status === "error") {
      if (!retried.current && infoRef.current?.method === "DirectPlay") {
        retried.current = true;
        flashNotice("Formato non supportato: passo al transcoding…");
        load({ force: true }, episodeRef.current, positionRef.current);
      } else {
        setError(error?.message || "Il dispositivo non riesce a decodificare questo stream.");
        setLoading(false);
      }
    }
  });

  useEventListener(player, "timeUpdate", ({ currentTime }: any) => {
    if (scrubbingRef.current || Date.now() < seekLock.current) return;
    const pos = currentTime || 0;
    positionRef.current = pos;
    setPosition(pos);
    const dur = infoRef.current?.duration || player.duration || 0;
    if (dur > 0) setDuration(dur);
    const id = episodeRef.current ? episodeRef.current.id : item.id;
    if (Date.now() - lastSave.current > 5000 && dur > 0) {
      lastSave.current = Date.now();
      saveProgress(id, pos, dur);
    }
    if (dur > 0 && pos >= dur - 1 && !finishedRef.current) {
      finishedRef.current = true;
      handleEnd();
    }
  });

  useEventListener(player, "playingChange", ({ isPlaying }: any) => setPlaying(!!isPlaying));

  useEffect(() => {
    try { player.playbackRate = settings.speed; } catch {}
    try { player.loop = settings.loop; } catch {}
  }, [settings.speed, settings.loop]);

  useEffect(() => {
    if (!info) return;
    reportPlayback(session, "start", info, positionRef.current, false);
    const t = setInterval(() => reportPlayback(session, "progress", info, positionRef.current, !playing), 10000);
    return () => clearInterval(t);
  }, [info?.url]);

  useEffect(() => {
    if (!controls || !playing || menu || loading) return;
    const t = setTimeout(() => setControls(false), 4000);
    return () => clearTimeout(t);
  }, [controls, playing, menu, loading]);

  useEffect(() => {
    if (!ended || !nextEp || !settings.autoplay) return;
    setCountdown(8);
    const t = setInterval(() => setCountdown(c => { if (c <= 1) { clearInterval(t); playEpisode(nextEp); return 0; } return c - 1; }), 1000);
    return () => clearInterval(t);
  }, [ended, nextEp]);

  async function handleEnd() {
    const id = episodeRef.current ? episodeRef.current.id : item.id;
    const dur = infoRef.current?.duration || duration;
    saveProgress(id, dur, dur);
    let nx = null;
    if (item.type === "series" && episodeRef.current) {
      const ss = await loadSeasons(session, item);
      nx = findNextEpisode(ss, episodeRef.current);
    }
    setNextEp(nx);
    setEnded(true);
  }

  function seekTo(target: number) {
    const dur = infoRef.current?.duration || duration || 0;
    const T = Math.max(0, Math.min(target, dur > 0 ? dur - 0.25 : target));
    seekLock.current = Date.now() + 900;
    setPosition(T);
    positionRef.current = T;
    finishedRef.current = false;
    try { player.currentTime = T; } catch {}
  }

  function togglePlay() {
    if (loading) return;
    if (playing) player.pause(); else player.play();
    setControls(true);
  }

  async function rotate() {
    try {
      if (landscape) { await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP); setLandscape(false); }
      else { await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE_RIGHT); setLandscape(true); }
    } catch {}
    setControls(true);
  }

  async function switchAudio(index: number) {
    setMenu(null);
    flashNotice("Cambio traccia audio…");
    await load({ audioIndex: index, force: true }, episodeRef.current, positionRef.current);
    flashNotice("Traccia audio: " + (infoRef.current?.audio?.find((a: any) => a.Index === index)?.DisplayTitle || index));
  }

  async function switchSubs(index: number | null) {
    setMenu(null);
    flashNotice(index == null ? "Disattivo i sottotitoli…" : "Attivo i sottotitoli…");
    await load({ subtitleIndex: index == null ? -1 : index, force: true }, episodeRef.current, positionRef.current);
    const label = index == null ? "Disattivati" : (infoRef.current?.subs?.find((s: any) => s.Index === index)?.DisplayTitle || "Attivi");
    flashNotice("Sottotitoli: " + label);
  }

  function playEpisode(ep: any) {
    setEnded(false); setNextEp(null); setEpisode(ep); episodeRef.current = ep;
    finishedRef.current = false; retried.current = false; optsRef.current = {};
    load({}, ep, 0);
  }

  if (!item) return <SafeAreaView style={styles.center}><Text style={styles.emptyTitle}>Titolo non trovato</Text></SafeAreaView>;

  const title = episode ? episode.title : item.title;
  const subtitle = episode ? item.title + " · S" + episode.season + ":E" + episode.episode : item.year + " · " + item.genres.join(", ");
  const menuW = Math.min(400, dim.width - 32);
  const menuH = Math.min(dim.height * 0.82, 560);
  const activeAudio = info?.audio?.find((a: any) => a.Index === info.audioIndex);
  const activeSub = info?.subs?.find((s: any) => s.Index === info.subtitleIndex);

  return (
    <View style={styles.playerRoot}>
      <StatusBar hidden />
      <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />

      <Pressable style={StyleSheet.absoluteFill} onPress={() => setControls(v => !v)} />

      {loading && (
        <View style={styles.centerSpin} pointerEvents="none">
          <ActivityIndicator color={C.red} size="large" />
        </View>
      )}

      {!!notice && <View style={[styles.notice, { top: insets.top + 8 }]} pointerEvents="none"><Text style={styles.noticeText}>{notice}</Text></View>}

      {!!error && (
        <View style={[styles.playerError, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
          <Ionicons name="warning-outline" size={48} color={C.amber} />
          <Text style={styles.emptyTitle}>Video non caricabile</Text>
          <Text style={styles.muted}>{error}</Text>
          <Pressable onPress={() => load({ force: true }, episodeRef.current, positionRef.current)} style={styles.primaryButton}><Text style={styles.primaryButtonText}>Riprova in transcoding</Text></Pressable>
          <Pressable onPress={() => navigation.goBack()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Chiudi</Text></Pressable>
        </View>
      )}

      {settings.stats && info && !error && (
        <View style={[styles.statsPanel, { top: controls ? insets.top + 64 : insets.top + 8 }]} pointerEvents="none">
          <Text style={styles.statsTitle}>STATISTICHE</Text>
          <Text style={styles.statsLine}>Metodo: {info.method}</Text>
          <Text style={styles.statsLine}>Qualità: {info.quality}</Text>
          <Text style={styles.statsLine}>Posizione: {fmt(position)} / {fmt(duration)}</Text>
          <Text style={styles.statsLine}>Audio: {activeAudio?.DisplayTitle || activeAudio?.Language || "default"}</Text>
          <Text style={styles.statsLine}>Sub: {activeSub?.DisplayTitle || "off"}</Text>
          <Text style={styles.statsLine}>{info.reason}</Text>
        </View>
      )}

      {controls && !ended && !error && (
        <>
          <LinearGradient colors={["rgba(0,0,0,0.75)", "transparent"]} style={styles.playerTopScrim} pointerEvents="none" />
          <View style={[styles.playerTop, { top: insets.top + 8 }]}>
            <IconButton name="arrow-back" size={26} onPress={() => navigation.goBack()} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={styles.playerTitle}>{title}</Text>
              <Text numberOfLines={1} style={styles.playerSub}>{subtitle}</Text>
            </View>
            <IconButton name="sync-outline" size={24} onPress={rotate} />
          </View>

          {!loading && (
            <Pressable onPress={togglePlay} style={styles.centerPlay} hitSlop={30}>
              <Ionicons name={playing ? "pause" : "play"} size={62} color="#fff" style={styles.centerIcon} />
            </Pressable>
          )}

          <LinearGradient colors={["transparent", "rgba(0,0,0,0.85)"]} style={styles.playerBottomScrim} pointerEvents="none" />
          <View style={[styles.playerBottom, { bottom: insets.bottom + 8 }]}>
            <Slider style={{ width: "100%", height: 34 }} minimumValue={0} maximumValue={Math.max(1, duration)}
              value={scrubbing ? scrub : position} minimumTrackTintColor={C.red}
              maximumTrackTintColor="rgba(255,255,255,0.35)" thumbTintColor={C.red}
              onSlidingStart={() => { scrubbingRef.current = true; setScrubbing(true); setScrub(positionRef.current); }}
              onValueChange={setScrub}
              onSlidingComplete={seekTo} />
            <View style={styles.playerControls}>
              <Text style={styles.playerTime}>{fmt(scrubbing ? scrub : position)} <Text style={styles.faint}>/ {fmt(duration)}</Text></Text>
              <View style={{ flex: 1 }} />
              <IconButton name="musical-notes-outline" onPress={() => setMenu("audio")} />
              <IconButton name="chatbox-ellipses-outline" onPress={() => setMenu("subs")} />
              <Pressable onPress={() => setMenu("quality")} style={styles.hdButton}>
                <View style={styles.hdBox}>
                  <Text style={styles.hdText}>{info?.quality && info.quality !== "auto" ? info.quality + "p" : "HD"}</Text>
                </View>
              </Pressable>
              <IconButton name="settings-outline" onPress={() => setMenu("root")} />
            </View>
          </View>
        </>
      )}

      {ended && (
        <View style={[styles.endOverlay, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
          {nextEp ? (
            <>
              <Text style={styles.endLabel}>Prossimo episodio</Text>
              <Pressable onPress={() => playEpisode(nextEp)} style={styles.nextCard}>
                <View style={styles.nextThumb} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.episodeTitle}>S{nextEp.season}:E{nextEp.episode} · {nextEp.title}</Text>
                  <Text style={styles.muted}>{item.title}</Text>
                </View>
                {settings.autoplay && <Text style={styles.countdown}>{countdown}</Text>}
              </Pressable>
              <View style={styles.actions}>
                <Pressable onPress={() => playEpisode(nextEp)} style={styles.whiteButton}><Ionicons name="play" size={20} color="#000" /><Text style={styles.whiteButtonText}>Guarda subito</Text></Pressable>
                <Pressable onPress={() => navigation.goBack()} style={styles.ghostButton}><Text style={styles.ghostButtonText}>Chiudi</Text></Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.endLabel}>Fine</Text>
              <View style={styles.actions}>
                <Pressable onPress={() => { setEnded(false); finishedRef.current = false; seekTo(0); }} style={styles.whiteButton}>
                  <Ionicons name="refresh" size={20} color="#000" /><Text style={styles.whiteButtonText}>Riguarda</Text>
                </Pressable>
                <Pressable onPress={() => navigation.goBack()} style={styles.ghostButton}><Text style={styles.ghostButtonText}>Chiudi</Text></Pressable>
              </View>
            </>
          )}
        </View>
      )}

      <Modal visible={!!menu} transparent animationType="fade" onRequestClose={() => setMenu(null)}>
        <Pressable style={[styles.modalBackdrop, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
          <Pressable style={[styles.menu, { width: menuW, maxHeight: menuH }]} onPress={() => {}}>
            <ScrollView showsVerticalScrollIndicator keyboardShouldPersistTaps="handled" bounces={false}>
              {menu === "root" && (
                <>
                  <MenuHeader title="Impostazioni player" onBack={() => setMenu(null)} onClose={() => setMenu(null)} />
                  <MenuItem label="Velocità" value={settings.speed === 1 ? "Normale" : settings.speed + "×"} onPress={() => setMenu("speed")} />
                  <MenuToggle label="Prossimo episodio" value={settings.autoplay} onToggle={() => setSettings({ ...settings, autoplay: !settings.autoplay })} />
                  <MenuToggle label="Ripeti video" value={settings.loop} onToggle={() => setSettings({ ...settings, loop: !settings.loop })} />
                  <MenuToggle label="Statistiche" value={settings.stats} onToggle={() => setSettings({ ...settings, stats: !settings.stats })} />
                  <MenuItem label="Ruota schermo" value={landscape ? "Orizzontale" : "Verticale"} onPress={rotate} />
                  <MenuItem label="Impostazioni complete" onPress={() => navigation.replace("Settings")} />
                </>
              )}
              {menu === "speed" && (
                <>
                  <MenuHeader title="Velocità" onBack={() => setMenu("root")} onClose={() => setMenu(null)} />
                  {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(s => (
                    <MenuItem key={s} label={s === 1 ? "Normale" : s + "×"} selected={settings.speed === s} onPress={() => setSettings({ ...settings, speed: s })} />
                  ))}
                </>
              )}
              {menu === "quality" && (
                <>
                  <MenuHeader title="Qualità" onBack={() => setMenu("root")} onClose={() => setMenu(null)} />
                  {["auto", "2160", "1080", "720", "480", "360"].map(q => (
                    <MenuItem key={q} label={q === "auto" ? "Automatica" : q + "p"} selected={String(info?.quality) === q}
                      onPress={() => { setMenu(null); flashNotice("Qualità: " + (q === "auto" ? "auto" : q + "p")); load({ quality: q, force: q !== "auto" }, episodeRef.current, positionRef.current); }} />
                  ))}
                </>
              )}
              {menu === "audio" && (
                <>
                  <MenuHeader title="Audio" onBack={() => setMenu("root")} onClose={() => setMenu(null)} />
                  {(info?.audio || []).length === 0 && <Text style={styles.menuNote}>Questo file non espone tracce audio selezionabili.</Text>}
                  {(info?.audio || []).map((a: any) => (
                    <MenuItem key={a.Index} label={a.DisplayTitle || a.Language || "Audio " + a.Index} selected={info?.audioIndex === a.Index} onPress={() => switchAudio(a.Index)} />
                  ))}
                  <Text style={styles.menuNote}>Cambiando audio il server ricrea lo stream dalla posizione attuale.</Text>
                </>
              )}
              {menu === "subs" && (
                <>
                  <MenuHeader title="Sottotitoli" onBack={() => setMenu("root")} onClose={() => setMenu(null)} />
                  <MenuItem label="Disattivati" selected={info?.subtitleIndex == null} onPress={() => switchSubs(null)} />
                  {(info?.subs || []).map((s: any) => (
                    <MenuItem key={s.Index} label={s.DisplayTitle || s.Language || "Sottotitoli " + s.Index} selected={info?.subtitleIndex === s.Index} onPress={() => switchSubs(s.Index)} />
                  ))}
                  <Text style={styles.menuNote}>I sottotitoli vengono masterizzati dal server: la selezione ricarica lo stream mantenendo la posizione.</Text>
                </>
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function Choice({ label, value, options, onChange }: any) {
  return (
    <View style={styles.settingBlock}>
      <Text style={styles.settingLabel}>{label}</Text>
      <View style={styles.choiceWrap}>
        {options.map((o: any) => (
          <Pressable key={o[0]} onPress={() => onChange(o[0])} style={[styles.choice, String(value) === String(o[0]) && styles.choiceOn]}>
            <Text style={[styles.choiceText, String(value) === String(o[0]) && styles.choiceTextOn]}>{o[1]}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Toggle({ label, value, onToggle }: any) {
  return (
    <Pressable onPress={onToggle} style={styles.settingRow}>
      <Text style={styles.settingLabel}>{label}</Text>
      <View style={[styles.switch, value && styles.switchOn]}><View style={[styles.switchKnob, value && styles.switchKnobOn]} /></View>
    </Pressable>
  );
}

function SettingsScreen({ navigation }: any) {
  const { session, settings, setSettings, reloadLibrary, resetLocal, setSession } = useApp();
  const dim = useWindowDimensions();
  const twoCol = dim.width > 700;

  async function doTest() {
    if (session.mode === "demo") return Alert.alert("Demo", "Sei in modalità demo.");
    try { const r = await testServer(session.server); Alert.alert("Server OK", r.name + " · v" + r.version); }
    catch (e: any) { Alert.alert("Test fallito", e.message); }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.searchHeader}>
        <IconButton name="arrow-back" onPress={() => navigation.goBack()} />
        <Text style={styles.pageTitle}>Impostazioni</Text>
      </View>
      <ScrollView contentContainerStyle={[styles.settingsScroll, twoCol && styles.settingsScrollWide]} keyboardShouldPersistTaps="handled">
        <View style={[styles.settingsCard, twoCol && styles.halfCard]}>
          <Text style={styles.sectionTitle}>Riproduzione</Text>
          <Choice label="Modalità streaming" value={settings.streamMode} options={[["auto", "Auto"], ["direct", "Direct Play"], ["transcode", "Transcoding"]]} onChange={(v: string) => setSettings({ ...settings, streamMode: v })} />
          <Choice label="Qualità massima" value={settings.quality} options={[["auto", "Auto"], ["2160", "4K"], ["1080", "1080p"], ["720", "720p"], ["480", "480p"]]} onChange={(v: string) => setSettings({ ...settings, quality: v })} />
          <Toggle label="Risparmio dati" value={settings.saveData} onToggle={() => setSettings({ ...settings, saveData: !settings.saveData })} />
          <Toggle label="Prossimo episodio automatico" value={settings.autoplay} onToggle={() => setSettings({ ...settings, autoplay: !settings.autoplay })} />
          <Toggle label="Ripeti video" value={settings.loop} onToggle={() => setSettings({ ...settings, loop: !settings.loop })} />
          <Choice label="Velocità" value={settings.speed} options={[[0.5, "0.5×"], [0.75, "0.75×"], [1, "1×"], [1.25, "1.25×"], [1.5, "1.5×"], [2, "2×"]]} onChange={(v: number) => setSettings({ ...settings, speed: v })} />
        </View>

        <View style={[styles.settingsCard, twoCol && styles.halfCard]}>
          <Text style={styles.sectionTitle}>Audio e sottotitoli</Text>
          <Choice label="Lingua audio" value={settings.audioLang} options={[["it", "IT"], ["en", "EN"], ["ja", "JA"], ["fr", "FR"], ["de", "DE"]]} onChange={(v: string) => setSettings({ ...settings, audioLang: v })} />
          <Choice label="Lingua sottotitoli" value={settings.subLang} options={[["it", "IT"], ["en", "EN"], ["ja", "JA"], ["fr", "FR"], ["de", "DE"]]} onChange={(v: string) => setSettings({ ...settings, subLang: v })} />
          <Toggle label="Sottotitoli automatici" value={settings.autoSub} onToggle={() => setSettings({ ...settings, autoSub: !settings.autoSub })} />
          <Toggle label="Statistiche riproduzione" value={settings.stats} onToggle={() => setSettings({ ...settings, stats: !settings.stats })} />
        </View>

        <View style={[styles.settingsCard, twoCol && styles.halfCard]}>
          <Text style={styles.sectionTitle}>Interfaccia</Text>
          <Text style={styles.settingLabel}>Dimensione locandine: {settings.posterSize}px</Text>
          <Slider minimumValue={120} maximumValue={220} step={5} value={settings.posterSize}
            minimumTrackTintColor={C.red} maximumTrackTintColor={C.surface3} thumbTintColor={C.red}
            onValueChange={v => setSettings({ ...settings, posterSize: v })} />
          <Toggle label="Locandine orizzontali (Continua / Prossimi)" value={settings.thumbWide} onToggle={() => setSettings({ ...settings, thumbWide: !settings.thumbWide })} />
          <Toggle label="Animazioni" value={settings.animations} onToggle={() => setSettings({ ...settings, animations: !settings.animations })} />
          <Toggle label="Barre di progresso" value={settings.progressBars} onToggle={() => setSettings({ ...settings, progressBars: !settings.progressBars })} />
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
  const saveProgress = (id: string, position: number, duration: number) =>
    setProgress((p: any) => ({ ...p, [id]: { position, duration, updated: Date.now() } }));
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
        {!session ? <LoginScreen /> : (
          <NavigationContainer theme={navTheme}>
            <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg } }}>
              <Stack.Screen name="Home" component={HomeScreen} />
              <Stack.Screen name="Search" component={SearchScreen} />
              <Stack.Screen name="Detail" component={DetailScreen} />
              <Stack.Screen name="Player" component={PlayerScreen} />
              <Stack.Screen name="Settings" component={SettingsScreen} />
            </Stack.Navigator>
          </NavigationContainer>
        )}
      </AppCtx.Provider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  muted: { color: C.muted, fontSize: 13 },
  faint: { color: C.faint, fontSize: 12 },
  emptyTitle: { color: C.text, fontSize: 20, fontWeight: "800" },
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
  primaryButtonText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  secondaryButton: { backgroundColor: C.surface2, borderColor: C.line, borderWidth: 1, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 18, alignItems: "center", justifyContent: "center" },
  secondaryButtonText: { color: C.text, fontWeight: "800" },
  fixButton: { backgroundColor: "#ffb22412", borderColor: "#ffb22455", borderWidth: 1, borderRadius: 10, paddingVertical: 11, alignItems: "center", justifyContent: "center", marginTop: 10 },
  fixButtonText: { color: "#ffd58a", fontWeight: "800", fontSize: 13 },
  divider: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 16 },
  dividerLine: { flex: 1, height: 1, backgroundColor: C.line },
  dividerText: { color: C.faint, fontSize: 12 },
  topBar: { paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: C.bg },
  topLogo: { color: C.red, fontSize: 26, fontWeight: "900", letterSpacing: 1 },
  iconButton: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  pressed: { backgroundColor: "#ffffff1c" },
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
  metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 12 },
  match: { color: C.green, fontWeight: "800" },
  metaText: { color: C.text, fontWeight: "600" },
  badge: { color: C.muted, borderColor: C.faint, borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1, fontSize: 11, fontWeight: "700" },
  heroDesc: { color: "#dadade", fontSize: 15, lineHeight: 22, marginBottom: 18 },
  actions: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
  whiteButton: { backgroundColor: "#fff", borderRadius: 8, paddingHorizontal: 18, paddingVertical: 11, flexDirection: "row", alignItems: "center", gap: 8 },
  whiteButtonText: { color: "#000", fontWeight: "800", fontSize: 15 },
  ghostButton: { backgroundColor: "rgba(110,110,122,0.45)", borderRadius: 8, paddingHorizontal: 18, paddingVertical: 11, flexDirection: "row", alignItems: "center", gap: 8 },
  ghostButtonText: { color: "#fff", fontWeight: "800", fontSize: 15 },
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
  detailBody: { padding: 20, paddingBottom: 60 },
  inListNote: { color: C.green, fontSize: 12, fontWeight: "700", marginTop: 10 },
  facts: { color: C.muted, fontSize: 13, marginBottom: 8 },
  sectionTitle: { color: C.text, fontSize: 21, fontWeight: "800", marginTop: 8, marginBottom: 12 },
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
  playerRoot: { flex: 1, backgroundColor: "#000" },
  centerSpin: { position: "absolute", left: "50%", top: "50%", marginLeft: -40, marginTop: -40, width: 80, height: 80, alignItems: "center", justifyContent: "center" },
  playerError: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(6,6,9,0.95)", alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  notice: { position: "absolute", top: 70, alignSelf: "center", backgroundColor: "rgba(8,8,11,0.9)", borderColor: C.line, borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9, maxWidth: "86%" },
  noticeText: { color: C.text, fontSize: 13, fontWeight: "700", textAlign: "center" },
  playerTopScrim: { position: "absolute", top: 0, left: 0, right: 0, height: 120 },
  playerBottomScrim: { position: "absolute", bottom: 0, left: 0, right: 0, height: 160 },
  playerTop: { position: "absolute", top: 12, left: 12, right: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  playerTitle: { color: "#fff", fontWeight: "800", fontSize: 16 },
  playerSub: { color: "#d2d2d8", fontSize: 12 },
  centerPlay: { position: "absolute", left: "50%", top: "50%", marginLeft: -40, marginTop: -40, width: 80, height: 80, alignItems: "center", justifyContent: "center" },
  centerIcon: { textShadowColor: "rgba(0,0,0,0.85)", textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 10 },
  playerBottom: { position: "absolute", left: 12, right: 12, bottom: 8 },
  playerControls: { flexDirection: "row", alignItems: "center", gap: 2 },
  playerTime: { color: "#fff", fontWeight: "700", fontSize: 13 },
  hdButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center" },
  hdBox: { borderWidth: 1.5, borderColor: "#fff", borderRadius: 4, paddingHorizontal: 4, height: 19, alignItems: "center", justifyContent: "center" },
  hdText: { color: "#fff", fontWeight: "900", fontSize: 10, lineHeight: 12, textAlign: "center", includeFontPadding: false },
  statsPanel: { position: "absolute", left: 12, backgroundColor: "rgba(8,8,11,0.82)", borderColor: C.line, borderWidth: 1, borderRadius: 10, padding: 10, maxWidth: "72%" },
  statsTitle: { color: C.green, fontWeight: "900", fontSize: 10, letterSpacing: 1.4, marginBottom: 5 },
  statsLine: { color: "#d6d6de", fontSize: 11, lineHeight: 16 },
  endOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(6,6,9,0.93)", alignItems: "center", justifyContent: "center", padding: 24, gap: 18 },
  endLabel: { color: C.muted, textTransform: "uppercase", letterSpacing: 2, fontWeight: "800", fontSize: 12 },
  nextCard: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: C.surface2, borderColor: C.line, borderWidth: 1, borderRadius: 14, padding: 14, width: "100%" },
  nextThumb: { width: 120, aspectRatio: 16 / 9, borderRadius: 8, backgroundColor: C.surface3 },
  countdown: { color: C.red, fontWeight: "900", fontSize: 22 },
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
  settingsScroll: { padding: 16, paddingBottom: 60, gap: 16 },
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
