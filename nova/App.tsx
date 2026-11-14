import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  ImageBackground,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { NavigationContainer, DefaultTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { Audio, ResizeMode, Video } from "expo-av";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import Slider from "@react-native-community/slider";
import { LinearGradient } from "expo-linear-gradient";

const C = {
  bg: "#08080b",
  surface: "#15151c",
  surface2: "#1d1d26",
  surface3: "#282833",
  line: "#30303c",
  text: "#f6f5f2",
  muted: "#a6a6b2",
  faint: "#70707c",
  red: "#e50914",
  red2: "#ff2b37",
  green: "#2ee6a8",
  blue: "#3b82f6",
  amber: "#ffb224"
};

const Stack = createNativeStackNavigator();
const AppCtx = createContext<any>(null);
const useApp = () => useContext(AppCtx);

const navTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: C.bg,
    card: C.bg,
    text: C.text,
    primary: C.red,
    border: C.line
  }
};

const defaultSettings = {
  streamMode: "auto",
  quality: "auto",
  audioLang: "it",
  subLang: "it",
  autoSub: false,
  autoplay: true,
  loop: false,
  speed: 1,
  posterSize: 150,
  animations: true,
  progressBars: true,
  stats: false,
  saveData: false
};

function fmt(sec: number) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0");
}

function normalizeServer(value: string) {
  let s = String(value || "").trim().replace(/\/+$/, "");
  if (!s) throw new Error("Inserisci l'URL del server.");
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  try {
    new URL(s);
  } catch {
    throw new Error("URL non valido.");
  }
  return s;
}

function authHeaders(token?: string) {
  const base = 'MediaBrowser Client="NOVA", Device="Android", DeviceId="nova-android", Version="1.0.0"';
  return {
    "Content-Type": "application/json",
    Authorization: token ? base + ', Token="' + token + '"' : base
  };
}

async function fetchWithTimeout(url: string, options: any = {}, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function testServer(serverInput: string) {
  const server = normalizeServer(serverInput);
  try {
    const r = await fetchWithTimeout(server + "/System/Info/Public", {}, 7000);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    return { server, name: j.ServerName || "Jellyfin", version: j.Version || "" };
  } catch (e: any) {
    if (e.name === "AbortError") throw new Error("Timeout: server non raggiungibile.");
    throw new Error("Rete/CORS o URL sbagliato: " + (e.message || "connessione fallita"));
  }
}

async function authenticate(serverInput: string, username: string, password: string) {
  const server = normalizeServer(serverInput);
  let r: Response;
  try {
    r = await fetchWithTimeout(
      server + "/Users/AuthenticateByName",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ Username: username, Pw: password })
      },
      12000
    );
  } catch (e: any) {
    throw new Error(e.name === "AbortError" ? "Timeout: server non raggiungibile." : "Server non raggiungibile.");
  }
  if (!r.ok) throw new Error(r.status === 401 ? "Credenziali non valide." : "Il server ha risposto " + r.status + ".");
  const j = await r.json();
  return {
    mode: "jellyfin",
    server,
    token: j.AccessToken,
    userId: j.User.Id,
    user: j.User?.Name || username
  };
}

function imageUrl(session: any, id: string, type: string, width: number) {
  return session.server + "/Items/" + id + "/Images/" + type + "?maxWidth=" + width + "&quality=90&api_key=" + session.token;
}

function mapItem(session: any, x: any) {
  return {
    id: x.Id,
    type: x.Type === "Series" ? "series" : "movie",
    title: x.Name || "Senza titolo",
    year: x.ProductionYear || "",
    genres: x.Genres || [],
    overview: x.Overview || "",
    rating: x.OfficialRating || "T",
    match: Math.max(60, Math.min(99, Math.round((x.CommunityRating || 7) * 10 + 20))),
    duration: (x.RunTimeTicks || 0) / 1e7,
    cast: (x.People || []).slice(0, 5).map((p: any) => p.Name),
    added: Date.parse(x.DateCreated) || Date.now(),
    poster: imageUrl(session, x.Id, "Primary", 500),
    backdrop: imageUrl(session, x.Id, "Backdrop", 1280),
    hue: ((x.Name || "").length * 47) % 360
  };
}

function mapEpisode(session: any, x: any) {
  return {
    id: x.Id,
    seriesId: x.SeriesId,
    seriesName: x.SeriesName,
    season: x.ParentIndexNumber || 1,
    episode: x.IndexNumber || 1,
    title: x.Name || "Episodio",
    overview: x.Overview || "",
    duration: (x.RunTimeTicks || 0) / 1e7,
    thumb: imageUrl(session, x.Id, "Primary", 500),
    hue: 210
  };
}

async function loadLibrary(session: any) {
  const headers = authHeaders(session.token);
  const r = await fetch(
    session.server +
      "/Users/" +
      session.userId +
      "/Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=Overview,Genres,ProductionYear,CommunityRating,OfficialRating,DateCreated,People,RunTimeTicks,UserData",
    { headers }
  );
  if (!r.ok) throw new Error("Libreria HTTP " + r.status);
  const j = await r.json();
  const items = (j.Items || []).map((x: any) => mapItem(session, x));
  const map: any = {};
  items.forEach((it: any) => (map[it.id] = it));
  const progress: any = {};
  const epMap: any = {};

  for (const x of j.Items || []) {
    const ud = x.UserData;
    if (ud && ud.PlaybackPositionTicks > 0) {
      progress[x.Id] = {
        position: ud.PlaybackPositionTicks / 1e7,
        duration: (x.RunTimeTicks || 0) / 1e7,
        updated: Date.now()
      };
    }
  }

  try {
    const rr = await fetch(
      session.server +
        "/Users/" +
        session.userId +
        "/Items?Recursive=true&IncludeItemTypes=Episode,Movie&Filters=IsResumable&Fields=UserData,RunTimeTicks,SeriesName,SeriesId,ParentIndexNumber,IndexNumber",
      { headers }
    );
    const jj = await rr.json();
    for (const x of jj.Items || []) {
      if (x.Type === "Episode") {
        const ep = mapEpisode(session, x);
        epMap[ep.id] = ep;
        if (!map[ep.seriesId]) {
          map[ep.seriesId] = {
            id: ep.seriesId,
            type: "series",
            title: ep.seriesName || "Serie",
            year: "",
            genres: [],
            overview: "",
            rating: "T",
            match: 90,
            duration: 0,
            cast: [],
            added: Date.now(),
            poster: imageUrl(session, ep.seriesId, "Primary", 500),
            backdrop: imageUrl(session, ep.seriesId, "Backdrop", 1280),
            hue: 210
          };
          items.push(map[ep.seriesId]);
        }
      }
      if (x.UserData && x.UserData.PlaybackPositionTicks > 0) {
        progress[x.Id] = {
          position: x.UserData.PlaybackPositionTicks / 1e7,
          duration: (x.RunTimeTicks || 0) / 1e7,
          updated: Date.now()
        };
      }
    }
  } catch {}

  let nextUp: any[] = [];
  try {
    const nr = await fetch(
      session.server + "/Shows/NextUp?userId=" + session.userId + "&Fields=UserData,RunTimeTicks,SeriesId,SeriesName,ParentIndexNumber,IndexNumber",
      { headers }
    );
    const nj = await nr.json();
    nextUp = (nj.Items || []).map((x: any) => {
      const ep = mapEpisode(session, x);
      epMap[ep.id] = ep;
      return { item: map[ep.seriesId], ep };
    }).filter((x: any) => x.item);
  } catch {}

  return { items, map, epMap, progress, nextUp };
}

async function loadSeasons(session: any, item: any) {
  if (session.mode === "demo") return item.seasons || [];
  const r = await fetch(
    session.server + "/Shows/" + item.id + "/Episodes?userId=" + session.userId + "&Fields=Overview,RunTimeTicks,UserData",
    { headers: authHeaders(session.token) }
  );
  if (!r.ok) throw new Error("Episodi HTTP " + r.status);
  const j = await r.json();
  const bySeason: any = {};
  for (const x of j.Items || []) {
    const ep = mapEpisode(session, x);
    if (!bySeason[ep.season]) bySeason[ep.season] = { n: ep.season, name: "Stagione " + ep.season, episodes: [] };
    bySeason[ep.season].episodes.push(ep);
  }
  return Object.values(bySeason)
    .sort((a: any, b: any) => a.n - b.n)
    .map((s: any) => ({ ...s, episodes: s.episodes.sort((a: any, b: any) => a.episode - b.episode) }));
}

function nativeDeviceProfile(force: boolean, bitrate: number) {
  return {
    MaxStreamingBitrate: bitrate,
    MaxStaticBitrate: 200000000,
    MusicStreamingTranscodingBitrate: 192000,
    DirectPlayProfiles: force
      ? []
      : [
          {
            Container: "mp4,m4v,mov,mkv,webm",
            Type: "Video",
            VideoCodec: "h264,hevc,vp9,av1",
            AudioCodec: "aac,mp3,ac3,eac3,opus,flac,vorbis"
          }
        ],
    TranscodingProfiles: [
      {
        Container: "ts",
        Type: "Video",
        VideoCodec: "h264",
        AudioCodec: "aac,mp3",
        Context: "Streaming",
        Protocol: "hls",
        MaxAudioChannels: "2",
        MinSegments: "1",
        BreakOnNonKeyFrames: true
      }
    ],
    SubtitleProfiles: [
      { Format: "srt", Method: "External" },
      { Format: "ass", Method: "External" },
      { Format: "vtt", Method: "External" },
      { Format: "srt", Method: "Encode" },
      { Format: "ass", Method: "Encode" },
      { Format: "pgs", Method: "Encode" },
      { Format: "dvdsub", Method: "Encode" }
    ]
  };
}

async function getPlayback(session: any, itemId: string, settings: any, opts: any = {}) {
  if (session.mode === "demo") {
    return {
      id: itemId,
      url: opts.demoUrl,
      method: "DirectPlay",
      quality: opts.quality || "auto",
      duration: opts.duration || 0,
      audio: [{ Index: 0, DisplayTitle: "Originale Â· AAC", Language: "eng" }],
      subs: [{ Index: 0, DisplayTitle: "Italiano demo", Language: "ita", Codec: "srt" }],
      audioIndex: 0,
      subtitleIndex: null,
      mediaSourceId: "demo",
      playSessionId: "demo",
      reason: "Demo MP4/H.264"
    };
  }

  const quality = opts.quality || settings.quality || "auto";
  const bitrates: any = { auto: 40000000, 2160: 40000000, 1080: 8000000, 720: 4000000, 480: 1500000, 360: 700000 };
  let bitrate = bitrates[quality] || 40000000;
  if (settings.saveData && quality === "auto") bitrate = 4000000;

  let force =
    !!opts.force ||
    settings.streamMode === "transcode" ||
    quality !== "auto" ||
    opts.audioIndex != null ||
    (opts.subtitleIndex != null && opts.subtitleIndex >= 0);

  async function request(forceTranscode: boolean) {
    const r = await fetch(session.server + "/Items/" + itemId + "/PlaybackInfo?userId=" + session.userId, {
      method: "POST",
      headers: authHeaders(session.token),
      body: JSON.stringify({
        DeviceProfile: nativeDeviceProfile(forceTranscode, bitrate),
        AutoOpenLiveStream: true,
        MaxStreamingBitrate: bitrate
      })
    });
    if (!r.ok) throw new Error("PlaybackInfo HTTP " + r.status);
    return r.json();
  }

  let j = await request(force);
  let ms = j.MediaSources && j.MediaSources[0];
  if (!ms) throw new Error("Nessuna MediaSource disponibile.");

  const audio = (ms.MediaStreams || []).filter((s: any) => s.Type === "Audio");
  const subs = (ms.MediaStreams || []).filter((s: any) => s.Type === "Subtitle");

  let audioIndex = opts.audioIndex;
  if (audioIndex == null) {
    const pref = audio.find((a: any) => String(a.Language || "").toLowerCase().startsWith(settings.audioLang));
    audioIndex = pref ? pref.Index : ms.DefaultAudioStreamIndex != null ? ms.DefaultAudioStreamIndex : audio[0]?.Index;
  }

  let subtitleIndex = opts.subtitleIndex;
  if (subtitleIndex === -1) subtitleIndex = null;
  if (subtitleIndex == null && settings.autoSub && opts.subtitleIndex !== -1) {
    const pref = subs.find((s: any) => String(s.Language || "").toLowerCase().startsWith(settings.subLang));
    subtitleIndex = pref ? pref.Index : null;
  }

  if (!force && subtitleIndex != null) {
    force = true;
    j = await request(true);
    ms = j.MediaSources && j.MediaSources[0];
  }

  let url: string;
  let method: string;
  if (!force && ms.SupportsDirectPlay) {
    url = session.server + "/Videos/" + itemId + "/stream?static=true&mediaSourceId=" + ms.Id + "&api_key=" + session.token;
    method = "DirectPlay";
  } else if (ms.TranscodingUrl) {
    url = session.server + ms.TranscodingUrl + (ms.TranscodingUrl.includes("?") ? "&" : "?") + "api_key=" + session.token;
    if (audioIndex != null) url += "&AudioStreamIndex=" + audioIndex;
    if (subtitleIndex != null) url += "&SubtitleStreamIndex=" + subtitleIndex;
    method = ms.SupportsDirectStream ? "DirectStream" : "Transcode";
  } else {
    url = session.server + "/Videos/" + itemId + "/stream?static=true&mediaSourceId=" + ms.Id + "&api_key=" + session.token;
    method = "DirectPlay";
  }

  return {
    id: itemId,
    url,
    method,
    quality,
    duration: (ms.RunTimeTicks || 0) / 1e7,
    audio,
    subs,
    audioIndex,
    subtitleIndex,
    mediaSourceId: ms.Id,
    playSessionId: j.PlaySessionId,
    reason: force ? "Transcoding richiesto o fallback" : "Direct Play nativo"
  };
}

async function reportPlayback(session: any, kind: string, info: any, position: number, paused: boolean) {
  if (!session || session.mode !== "jellyfin" || !info) return;
  const path = kind === "start" ? "/Sessions/Playing" : kind === "stop" ? "/Sessions/Playing/Stopped" : "/Sessions/Playing/Progress";
  try {
    await fetch(session.server + path, {
      method: "POST",
      headers: authHeaders(session.token),
      body: JSON.stringify({
        ItemId: info.id,
        MediaSourceId: info.mediaSourceId,
        PlaySessionId: info.playSessionId,
        PositionTicks: Math.round((position || 0) * 1e7),
        PlayMethod: info.method,
        CanSeek: true,
        IsPaused: paused
      })
    });
  } catch {}
}

function demoLibrary() {
  const V = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/";
  const vids: any = {
    a: V + "BigBuckBunny.mp4",
    b: V + "ElephantsDream.mp4",
    c: V + "Sintel.mp4",
    d: V + "TearsOfSteel.mp4"
  };
  const dur: any = { a: 596, b: 653, c: 888, d: 734 };
  const now = Date.now();
  const day = 86400000;
  const movie = (id: string, title: string, year: number, genres: string[], hue: number, v: string, match: number, overview: string, days: number) => ({
    id,
    type: "movie",
    title,
    year,
    genres,
    hue,
    video: vids[v],
    duration: dur[v],
    match,
    overview,
    cast: ["Cast demo"],
    rating: "T",
    added: now - days * day
  });
  const eps = (sid: string, season: number, titles: string[], hue: number) =>
    titles.map((title, i) => {
      const v = "abcd"[i % 4];
      return {
        id: sid + "-" + season + "-" + (i + 1),
        seriesId: sid,
        season,
        episode: i + 1,
        title,
        overview: "Un nuovo tassello si incastra nel mosaico.",
        duration: dur[v],
        video: vids[v],
        hue
      };
    });
  const series = (id: string, title: string, year: number, genres: string[], hue: number, match: number, overview: string, seasons: any[], days: number) => ({
    id,
    type: "series",
    title,
    year,
    genres,
    hue,
    match,
    overview,
    cast: ["Cast demo"],
    rating: "T",
    added: now - days * day,
    seasons
  });

  const items = [
    movie("orbita", "Orbita Nera", 2025, ["Fantascienza", "Thriller"], 210, "d", 98, "Una stazione orbitante smette di rispondere alla Terra.", 2),
    movie("neon", "Neon Requiem", 2024, ["Thriller", "Azione"], 350, "c", 96, "Un detective insegue un fantasma digitale tra i vicoli al neon.", 9),
    movie("codice", "Codice Rosso", 2025, ["Azione"], 18, "a", 88, "Un'ex agente deve fermare un attacco informatico globale.", 4),
    movie("mare", "Sotto la Pelle del Mare", 2024, ["Documentario"], 175, "c", 89, "Tre anni di riprese negli abissi del Mediterraneo.", 12),
    movie("vela", "Vela Solare", 2022, ["Animazione", "Avventura"], 55, "a", 87, "Una piccola sonda parte per un viaggio oltre il sistema solare.", 90),
    series("cieli", "I Cieli di Ferro", 2024, ["Fantascienza", "Drammatico"], 205, 97, "Le cittÃ  volano su piattaforme di ferro. Sotto le nuvole, qualcosa abita.", [
      { n: 1, name: "Stagione 1", episodes: eps("cieli", 1, ["Il decollo", "Sotto le nuvole", "Ferro e cielo", "La caduta", "Vecchie rotte", "Il segnale"], 205) },
      { n: 2, name: "Stagione 2", episodes: eps("cieli", 2, ["Ritorno a bordo", "La cittÃ  fantasma", "GravitÃ  zero", "Il patto", "Punto di fuga", "Cieli aperti"], 225) }
    ], 3),
    series("palude", "Palude", 2023, ["Thriller", "Giallo"], 150, 94, "Un paese di nebbia e canali, una serie di sparizioni che nessuno collega.", [
      { n: 1, name: "Stagione 1", episodes: eps("palude", 1, ["Acqua alta", "Il canale", "Nebbia", "Radici", "La chiusa", "Marea"], 150) }
    ], 20)
  ];

  const map: any = {};
  const epMap: any = {};
  items.forEach((it: any) => {
    map[it.id] = it;
    (it.seasons || []).forEach((s: any) => s.episodes.forEach((e: any) => (epMap[e.id] = e)));
  });

  const progress = {
    neon: { position: 412, duration: 888, updated: now - 2 * day },
    "cieli-1-3": { position: 300, duration: 888, updated: now - day }
  };

  return { items, map, epMap, progress, nextUp: [{ item: map.cieli, ep: epMap["cieli-1-4"] }] };
}

function isWatched(p: any) {
  return p && p.duration > 0 && p.position / p.duration >= 0.92;
}

function findNextEpisode(seasons: any[], ep: any) {
  if (!ep) return null;
  for (let i = 0; i < seasons.length; i++) {
    const idx = seasons[i].episodes.findIndex((e: any) => e.id === ep.id);
    if (idx >= 0) return seasons[i].episodes[idx + 1] || seasons[i + 1]?.episodes?.[0] || null;
  }
  return null;
}

function targetEpisode(seasons: any[], progress: any) {
  for (const s of seasons || []) {
    for (const e of s.episodes || []) {
      const p = progress[e.id];
      if (p && p.position > 5 && !isWatched(p)) return e;
    }
  }
  return seasons?.[0]?.episodes?.[0] || null;
}

function IconButton({ name, onPress, size = 22, style }: any) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed, style]}>
      <Ionicons name={name} size={size} color={C.text} />
    </Pressable>
  );
}

function Face({ size = 36 }: any) {
  return (
    <View style={[styles.face, { width: size, height: size, borderRadius: size * 0.22 }]}>
      <Ionicons name="happy" size={size * 0.72} color="#fff" />
    </View>
  );
}

function Poster({ item, wide, ep, progress }: any) {
  const uri = wide ? ep?.thumb || item.backdrop || item.poster : item.poster;
  const p = progress;
  const pct = p && p.duration ? Math.max(0, Math.min(100, (p.position / p.duration) * 100)) : 0;
  return (
    <View style={[styles.poster, wide && styles.posterWide]}>
      {uri ? (
        <Image source={{ uri }} style={styles.posterImage} resizeMode="cover" />
      ) : (
        <View style={[styles.posterFallback, { backgroundColor: "hsl(" + (item.hue || 210) + ",55%,22%)" }]}>
          <Text style={styles.posterFallbackTitle}>{item.title}</Text>
        </View>
      )}
      {pct > 0 && (
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: pct + "%" }]} />
        </View>
      )}
      {wide && (
        <View style={styles.wideLabel}>
          <Text numberOfLines={1} style={styles.wideLabelTitle}>
            {ep ? "S" + ep.season + ":E" + ep.episode + " Â· " + ep.title : item.title}
          </Text>
          {!!ep && <Text style={styles.wideLabelSub}>{item.title}</Text>}
        </View>
      )}
    </View>
  );
}

function MediaCard({ item, ep, wide, onPress, progress }: any) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.card, wide && styles.cardWide, pressed && styles.cardPressed]}>
      <Poster item={item} ep={ep} wide={wide} progress={progress} />
    </Pressable>
  );
}

function Row({ title, data, renderItem, keyExtractor }: any) {
  if (!data || !data.length) return null;
  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>{title}</Text>
      <FlatList
        horizontal
        data={data}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rowContent}
        ItemSeparatorComponent={() => <View style={{ width: 10 }} />}
      />
    </View>
  );
}

function LoginScreen() {
  const { setSession, resetLocal } = useApp();
  const [server, setServer] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem("nova.lastServer").then(v => v && setServer(v));
    AsyncStorage.getItem("nova.lastUser").then(v => v && setUser(v));
  }, []);

  async function doTest() {
    setStatus("Verificoâ€¦");
    setErr("");
    try {
      const r = await testServer(server);
      setStatus("âœ“ " + r.name + " Â· v" + r.version);
    } catch (e: any) {
      setStatus(e.message);
    }
  }

  async function doLogin() {
    setBusy(true);
    setErr("");
    try {
      const s = await authenticate(server, user, pass);
      await AsyncStorage.setItem("nova.lastServer", s.server);
      await AsyncStorage.setItem("nova.lastUser", user);
      await setSession(s);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function demo() {
    await setSession({ mode: "demo", user: "Matteo" });
  }

  return (
    <SafeAreaView style={styles.loginRoot}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.loginScroll}>
        <Text style={styles.logo}>NOVA</Text>
        <Text style={styles.logoSub}>for Jellyfin</Text>
        <Text style={styles.loginTitle}>Il tuo cinema personale.</Text>

        <View style={styles.loginCard}>
          <Text style={styles.loginCardTitle}>Accedi</Text>
          <Text style={styles.loginCardSub}>Connettiti al tuo server Jellyfin.</Text>

          <Text style={styles.label}>Server</Text>
          <TextInput
            value={server}
            onChangeText={setServer}
            placeholder="http://192.168.1.10:8096"
            placeholderTextColor={C.faint}
            autoCapitalize="none"
            keyboardType="url"
            style={styles.input}
          />

          <Pressable onPress={doTest} style={styles.testButton}>
            <Text style={styles.testButtonText}>Test connessione</Text>
          </Pressable>
          {!!status && <Text style={[styles.status, status.startsWith("âœ“") ? styles.ok : styles.bad]}>{status}</Text>}

          <Text style={styles.label}>Utente</Text>
          <TextInput value={user} onChangeText={setUser} autoCapitalize="none" style={styles.input} />

          <Text style={styles.label}>Password</Text>
          <TextInput value={pass} onChangeText={setPass} secureTextEntry style={styles.input} />

          {!!err && <Text style={styles.bad}>{err}</Text>}

          <Pressable onPress={doLogin} disabled={busy} style={[styles.primaryButton, busy && { opacity: 0.6 }]}>
            <Text style={styles.primaryButtonText}>{busy ? "Accessoâ€¦" : "Accedi"}</Text>
          </Pressable>

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>oppure</Text>
            <View style={styles.dividerLine} />
          </View>

          <Pressable onPress={demo} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Esplora la demo</Text>
          </Pressable>

          <Pressable onPress={resetLocal} style={styles.fixButton}>
            <Text style={styles.fixButtonText}>Ripara dati locali</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function TopBar({ navigation, title }: any) {
  return (
    <View style={styles.topBar}>
      <Text style={styles.topLogo}>NOVA</Text>
      <View style={{ flex: 1 }} />
      <IconButton name="search" onPress={() => navigation.navigate("Search")} />
      <IconButton name="settings-outline" onPress={() => navigation.navigate("Settings")} />
      <Face size={34} />
    </View>
  );
}

function HomeScreen({ navigation }: any) {
  const { items, epMap, progress, nextUp, libLoading, settings } = useApp();
  const featured = items[0];

  const continueData = useMemo(() => {
    return Object.keys(progress)
      .filter(id => progress[id].position > 5 && !isWatched(progress[id]))
      .sort((a, b) => progress[b].updated - progress[a].updated)
      .map(id => {
        const ep = epMap[id];
        if (ep) {
          const item = items.find((x: any) => x.id === ep.seriesId);
          return item ? { item, ep } : null;
        }
        const item = items.find((x: any) => x.id === id);
        return item ? { item, ep: null } : null;
      })
      .filter(Boolean);
  }, [items, epMap, progress]);

  if (libLoading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator color={C.red} size="large" />
        <Text style={styles.muted}>Carico la libreriaâ€¦</Text>
      </SafeAreaView>
    );
  }

  if (!featured) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.emptyTitle}>Libreria vuota</Text>
        <Text style={styles.muted}>Il server non ha restituito film o serie.</Text>
      </SafeAreaView>
    );
  }

  const movies = items.filter((i: any) => i.type === "movie");
  const series = items.filter((i: any) => i.type === "series");
  const recent = [...items].sort((a: any, b: any) => b.added - a.added);

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <TopBar navigation={navigation} />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          {featured.backdrop ? (
            <ImageBackground source={{ uri: featured.backdrop }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: "hsl(" + featured.hue + ",55%,22%)" }]} />
          )}
          <LinearGradient colors={["rgba(8,8,11,0.15)", "rgba(8,8,11,0.75)", C.bg]} style={StyleSheet.absoluteFill} />
          <View style={styles.heroContent}>
            <Text style={styles.heroKicker}>IN EVIDENZA</Text>
            <Text style={styles.heroTitle}>{featured.title}</Text>
            <View style={styles.metaRow}>
              <Text style={styles.match}>{featured.match}% compatibile</Text>
              <Text style={styles.metaText}>{featured.year}</Text>
              <Text style={styles.badge}>HD</Text>
            </View>
            <Text numberOfLines={3} style={styles.heroDesc}>
              {featured.overview}
            </Text>
            <View style={styles.actions}>
              <Pressable
                onPress={() => navigation.navigate("Player", { itemId: featured.id })}
                style={styles.whiteButton}
              >
                <Ionicons name="play" size={22} color="#000" />
                <Text style={styles.whiteButtonText}>Play</Text>
              </Pressable>
              <Pressable onPress={() => navigation.navigate("Detail", { itemId: featured.id })} style={styles.ghostButton}>
                <Ionicons name="information-circle-outline" size={22} color="#fff" />
                <Text style={styles.ghostButtonText}>Info</Text>
              </Pressable>
            </View>
          </View>
        </View>

        <View style={styles.rows}>
          <Row
            title="Continua a guardare"
            data={continueData}
            keyExtractor={(x: any) => x.ep?.id || x.item.id}
            renderItem={({ item: x }: any) => (
              <MediaCard
                item={x.item}
                ep={x.ep}
                wide
                progress={progress[x.ep?.id || x.item.id]}
                onPress={() => navigation.navigate("Player", { itemId: x.item.id, episode: x.ep })}
              />
            )}
          />
          <Row
            title="Prossimi episodi"
            data={nextUp}
            keyExtractor={(x: any) => x.ep.id}
            renderItem={({ item: x }: any) => (
              <MediaCard
                item={x.item}
                ep={x.ep}
                wide
                onPress={() => navigation.navigate("Player", { itemId: x.item.id, episode: x.ep })}
              />
            )}
          />
          <Row
            title="Aggiunti di recente"
            data={recent}
            keyExtractor={(x: any) => x.id}
            renderItem={({ item }: any) => (
              <MediaCard item={item} onPress={() => navigation.navigate("Detail", { itemId: item.id })} />
            )}
          />
          <Row
            title="Film"
            data={movies}
            keyExtractor={(x: any) => x.id}
            renderItem={({ item }: any) => (
              <MediaCard item={item} onPress={() => navigation.navigate("Detail", { itemId: item.id })} />
            )}
          />
          <Row
            title="Serie TV"
            data={series}
            keyExtractor={(x: any) => x.id}
            renderItem={({ item }: any) => (
              <MediaCard item={item} onPress={() => navigation.navigate("Detail", { itemId: item.id })} />
            )}
          />
        </View>
      </ScrollView>
    </View>
  );
}

function SearchScreen({ navigation }: any) {
  const { items } = useApp();
  const [q, setQ] = useState("");
  const res = q.trim()
    ? items.filter((i: any) => i.title.toLowerCase().includes(q.toLowerCase()) || i.genres.join(" ").toLowerCase().includes(q.toLowerCase()))
    : [];

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.searchHeader}>
        <IconButton name="arrow-back" onPress={() => navigation.goBack()} />
        <TextInput
          autoFocus
          value={q}
          onChangeText={setQ}
          placeholder="Cerca titoli, generiâ€¦"
          placeholderTextColor={C.faint}
          style={styles.searchInput}
        />
      </View>
      <FlatList
        data={res}
        keyExtractor={(i: any) => i.id}
        numColumns={3}
        contentContainerStyle={styles.grid}
        renderItem={({ item }) => (
          <View style={styles.gridItem}>
            <MediaCard item={item} onPress={() => navigation.navigate("Detail", { itemId: item.id })} />
            <Text numberOfLines={1} style={styles.gridTitle}>
              {item.title}
            </Text>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.center}>
            <Ionicons name="search" size={48} color={C.faint} />
            <Text style={styles.emptyTitle}>Cerca nella libreria</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

function DetailScreen({ route, navigation }: any) {
  const { session, items, progress, list, toggleList, settings } = useApp();
  const item = items.find((x: any) => x.id === route.params.itemId);
  const [seasons, setSeasons] = useState<any[]>(item?.seasons || []);
  const [season, setSeason] = useState(1);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!item || item.type !== "series" || seasons.length) return;
    setLoading(true);
    loadSeasons(session, item)
      .then(setSeasons)
      .catch((e) => Alert.alert("Errore episodi", e.message))
      .finally(() => setLoading(false));
  }, [item?.id]);

  if (!item) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.emptyTitle}>Titolo non trovato</Text>
      </SafeAreaView>
    );
  }

  const currentSeason = seasons.find((s: any) => s.n === season) || seasons[0];
  const ep = item.type === "series" ? targetEpisode(seasons, progress) : null;
  const resume = ep ? progress[ep.id]?.position || 0 : progress[item.id]?.position || 0;
  const similar = items.filter((x: any) => x.id !== item.id && x.genres.some((g: string) => item.genres.includes(g))).slice(0, 8);

  function play() {
    navigation.navigate("Player", { itemId: item.id, episode: ep });
  }

  return (
    <ScrollView style={styles.screen} showsVerticalScrollIndicator={false}>
      <View style={styles.detailHero}>
        {item.backdrop ? (
          <ImageBackground source={{ uri: item.backdrop }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: "hsl(" + item.hue + ",55%,22%)" }]} />
        )}
        <LinearGradient colors={["rgba(8,8,11,0.2)", "rgba(8,8,11,0.75)", C.bg]} style={StyleSheet.absoluteFill} />
        <SafeAreaView style={styles.detailHeroContent}>
          <IconButton name="arrow-back" onPress={() => navigation.goBack()} />
          <Text style={styles.detailTitle}>{item.title}</Text>
          <View style={styles.metaRow}>
            <Text style={styles.match}>{item.match}% compatibile</Text>
            <Text style={styles.metaText}>{item.year}</Text>
            <Text style={styles.badge}>HD</Text>
            <Text style={styles.badge}>{item.rating}</Text>
          </View>
          <Text numberOfLines={4} style={styles.heroDesc}>
            {item.overview}
          </Text>
          <View style={styles.actions}>
            <Pressable onPress={play} style={styles.whiteButton}>
              <Ionicons name="play" size={22} color="#000" />
              <Text style={styles.whiteButtonText}>{resume > 0 ? "Riprendi" : "Play"}</Text>
            </Pressable>
            <Pressable onPress={() => toggleList(item.id)} style={[styles.roundButton, list.includes(item.id) && styles.roundOn]}>
              <Ionicons name={list.includes(item.id) ? "checkmark" : "add"} size={24} color={list.includes(item.id) ? C.green : "#fff"} />
            </Pressable>
          </View>
        </SafeAreaView>
      </View>

      <View style={styles.detailBody}>
        <Text style={styles.facts}>
          <Text style={styles.faint}>Cast: </Text>
          {item.cast.join(", ") || "â€“"}
        </Text>
        <Text style={styles.facts}>
          <Text style={styles.faint}>Generi: </Text>
          {item.genres.join(", ") || "â€“"}
        </Text>

        {item.type === "series" && (
          <>
            <View style={styles.seasonHeader}>
              <Text style={styles.sectionTitle}>Episodi</Text>
              {loading && <ActivityIndicator color={C.red} />}
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              {seasons.map((s: any) => (
                <Pressable key={s.n} onPress={() => setSeason(s.n)} style={[styles.seasonChip, currentSeason?.n === s.n && styles.seasonChipOn]}>
                  <Text style={[styles.seasonText, currentSeason?.n === s.n && styles.seasonTextOn]}>{s.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
            {(currentSeason?.episodes || []).map((e: any) => {
              const p = progress[e.id];
              const pct = p && p.duration ? Math.min(100, (p.position / p.duration) * 100) : 0;
              return (
                <Pressable key={e.id} onPress={() => navigation.navigate("Player", { itemId: item.id, episode: e })} style={styles.episode}>
                  <Text style={styles.episodeNum}>{e.episode}</Text>
                  <View style={styles.episodeThumb}>
                    {e.thumb ? <Image source={{ uri: e.thumb }} style={StyleSheet.absoluteFill} /> : <View style={[StyleSheet.absoluteFill, { backgroundColor: C.surface3 }]} />}
                    {pct > 0 && (
                      <View style={styles.progressTrack}>
                        <View style={[styles.progressFill, { width: pct + "%" }]} />
                      </View>
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.episodeTitle}>{e.title}</Text>
                    <Text numberOfLines={2} style={styles.episodeDesc}>
                      {e.overview}
                    </Text>
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
                  <MediaCard item={x} onPress={() => navigation.navigate("Detail", { itemId: x.id })} />
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
  const { session, items, epMap, settings, setSettings, saveProgress } = useApp();
  const item = items.find((x: any) => x.id === route.params.itemId);
  const [episode, setEpisode] = useState<any>(route.params.episode || null);
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
  const videoRef = useRef<any>(null);
  const pendingSeek = useRef<number | null>(null);
  const retried = useRef(false);
  const lastSave = useRef(0);
  const positionRef = useRef(0);
  const infoRef = useRef<any>(null);

  useEffect(() => {
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true, staysActiveInBackground: false });
  }, []);

  useEffect(() => {
    infoRef.current = info;
  }, [info]);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  async function load(opts: any = {}, epArg = episode) {
    if (!item) return;
    setLoading(true);
    setError("");
    try {
      const mediaId = epArg ? epArg.id : item.id;
      const inf = await getPlayback(session, mediaId, settings, {
        ...opts,
        demoUrl: epArg?.video || item.video,
        duration: epArg?.duration || item.duration
      });
      setInfo(inf);
      setDuration(inf.duration || epArg?.duration || item.duration || 0);
    } catch (e: any) {
      setError(e.message || "Errore di riproduzione.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!item) return;
    (async () => {
      let ep = episode;
      if (item.type === "series" && !ep) {
        const seasons = await loadSeasons(session, item);
        ep = targetEpisode(seasons, {});
        setEpisode(ep);
      }
      await load({}, ep);
    })();
    return () => {
      if (infoRef.current) reportPlayback(session, "stop", infoRef.current, positionRef.current, true);
    };
  }, [item?.id]);

  useEffect(() => {
    if (!info) return;
    reportPlayback(session, "start", info, positionRef.current, false);
    const t = setInterval(() => {
      reportPlayback(session, "progress", info, positionRef.current, !playing);
    }, 10000);
    return () => clearInterval(t);
  }, [info?.url]);

  useEffect(() => {
    if (!controls || !playing) return;
    const t = setTimeout(() => setControls(false), 3500);
    return () => clearTimeout(t);
  }, [controls, playing]);

  useEffect(() => {
    if (!ended || !nextEp || !settings.autoplay) return;
    setCountdown(8);
    const t = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) {
          clearInterval(t);
          playEpisode(nextEp);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [ended, nextEp]);

  async function reload(opts: any) {
    pendingSeek.current = position;
    await load(opts, episode);
  }

  async function togglePlay() {
    if (!videoRef.current) return;
    if (playing) await videoRef.current.pauseAsync();
    else await videoRef.current.playAsync();
    setControls(true);
  }

  async function onStatus(status: any) {
    if (!status) return;
    if (status.isLoaded) {
      const pos = (status.positionMillis || 0) / 1000;
      const dur = (status.durationMillis || 0) / 1000 || duration;
      setPosition(pos);
      setDuration(dur);
      setPlaying(!!status.isPlaying);
      if (pendingSeek.current != null) {
        const t = pendingSeek.current;
        pendingSeek.current = null;
        videoRef.current?.setPositionAsync(t);
      }
      const id = episode ? episode.id : item.id;
      if (Date.now() - lastSave.current > 5000 && dur > 0) {
        lastSave.current = Date.now();
        saveProgress(id, pos, dur);
      }
      if (status.didJustFinish) {
        saveProgress(id, dur, dur);
        if (settings.loop) {
          videoRef.current?.setPositionAsync(0);
          videoRef.current?.playAsync();
        } else {
          let next = null;
          if (item.type === "series" && episode) {
            const seasons = await loadSeasons(session, item);
            next = findNextEpisode(seasons, episode);
          }
          setNextEp(next);
          setEnded(true);
        }
      }
    }
    if (status.error) {
      if (!retried.current && info?.method === "DirectPlay") {
        retried.current = true;
        reload({ force: true });
      } else {
        setError(String(status.error));
      }
    }
  }

  function playEpisode(ep: any) {
    setEnded(false);
    setNextEp(null);
    setEpisode(ep);
    setInfo(null);
    setPosition(0);
    load({}, ep);
  }

  if (!item) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.emptyTitle}>Titolo non trovato</Text>
      </SafeAreaView>
    );
  }

  const title = episode ? episode.title : item.title;
  const subtitle = episode ? item.title + " Â· S" + episode.season + ":E" + episode.episode : item.year + " Â· " + item.genres.join(", ");

  return (
    <View style={styles.playerRoot}>
      <StatusBar hidden />
      {info?.url ? (
        <Video
          ref={videoRef}
          source={{ uri: info.url }}
          style={StyleSheet.absoluteFill}
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay
          rate={settings.speed}
          useNativeControls={false}
          onPlaybackStatusUpdate={onStatus}
        />
      ) : null}

      <Pressable style={StyleSheet.absoluteFill} onPress={() => setControls(v => !v)} />

      {loading && (
        <View style={styles.playerLoading}>
          <ActivityIndicator color={C.red} size="large" />
        </View>
      )}

      {!!error && (
        <View style={styles.playerError}>
          <Ionicons name="warning-outline" size={48} color={C.amber} />
          <Text style={styles.emptyTitle}>Video non caricabile</Text>
          <Text style={styles.muted}>{error}</Text>
          <Pressable onPress={() => reload({ force: true })} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Riprova in transcoding</Text>
          </Pressable>
          <Pressable onPress={() => navigation.goBack()} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Chiudi</Text>
          </Pressable>
        </View>
      )}

      {controls && !ended && !error && (
        <>
          <LinearGradient colors={["rgba(0,0,0,0.75)", "transparent"]} style={styles.playerTopScrim} />
          <View style={styles.playerTop}>
            <IconButton name="arrow-back" size={26} onPress={() => navigation.goBack()} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={styles.playerTitle}>{title}</Text>
              <Text numberOfLines={1} style={styles.playerSub}>{subtitle}</Text>
            </View>
          </View>

          <Pressable onPress={togglePlay} style={styles.centerPlay}>
            <Ionicons name={playing ? "pause" : "play"} size={44} color="#fff" />
          </Pressable>

          <LinearGradient colors={["transparent", "rgba(0,0,0,0.85)"]} style={styles.playerBottomScrim} />
          <View style={styles.playerBottom}>
            <Slider
              style={{ width: "100%", height: 34 }}
              minimumValue={0}
              maximumValue={Math.max(1, duration)}
              value={scrubbing ? scrub : position}
              minimumTrackTintColor={C.red}
              maximumTrackTintColor="rgba(255,255,255,0.35)"
              thumbTintColor={C.red}
              onSlidingStart={() => setScrubbing(true)}
              onValueChange={setScrub}
              onSlidingComplete={async v => {
                setScrubbing(false);
                setPosition(v);
                await videoRef.current?.setPositionAsync(v);
              }}
            />
            <View style={styles.playerControls}>
              <Text style={styles.playerTime}>
                {fmt(scrubbing ? scrub : position)} <Text style={styles.faint}>/ {fmt(duration)}</Text>
              </Text>
              <View style={{ flex: 1 }} />
              <IconButton name="musical-notes-outline" onPress={() => setMenu("audio")} />
              <IconButton name="chatbox-ellipses-outline" onPress={() => setMenu("subs")} />
              <Pressable onPress={() => setMenu("quality")} style={styles.hdButton}>
                <Text style={styles.hdText}>{info?.quality && info.quality !== "auto" ? info.quality + "p" : "HD"}</Text>
              </Pressable>
              <IconButton name="settings-outline" onPress={() => setMenu("root")} />
            </View>
            {settings.stats && info && (
              <Text style={styles.statsText}>
                {info.method} Â· {info.quality} Â· {info.reason}
              </Text>
            )}
          </View>
        </>
      )}

      {ended && (
        <View style={styles.endOverlay}>
          {nextEp ? (
            <>
              <Text style={styles.endLabel}>Prossimo episodio</Text>
              <Pressable onPress={() => playEpisode(nextEp)} style={styles.nextCard}>
                <View style={styles.nextThumb} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.episodeTitle}>
                    S{nextEp.season}:E{nextEp.episode} Â· {nextEp.title}
                  </Text>
                  <Text style={styles.muted}>{item.title}</Text>
                </View>
                {settings.autoplay && <Text style={styles.countdown}>{countdown}</Text>}
              </Pressable>
              <View style={styles.actions}>
                <Pressable onPress={() => playEpisode(nextEp)} style={styles.whiteButton}>
                  <Ionicons name="play" size={20} color="#000" />
                  <Text style={styles.whiteButtonText}>Guarda subito</Text>
                </Pressable>
                <Pressable onPress={() => navigation.goBack()} style={styles.ghostButton}>
                  <Text style={styles.ghostButtonText}>Chiudi</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.endLabel}>Fine</Text>
              <View style={styles.actions}>
                <Pressable
                  onPress={() => {
                    setEnded(false);
                    videoRef.current?.setPositionAsync(0);
                    videoRef.current?.playAsync();
                  }}
                  style={styles.whiteButton}
                >
                  <Ionicons name="refresh" size={20} color="#000" />
                  <Text style={styles.whiteButtonText}>Riguarda</Text>
                </Pressable>
                <Pressable onPress={() => navigation.goBack()} style={styles.ghostButton}>
                  <Text style={styles.ghostButtonText}>Chiudi</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      )}

      <Modal visible={!!menu} transparent animationType="fade" onRequestClose={() => setMenu(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setMenu(null)}>
          <Pressable style={styles.menu}>
            {menu === "root" && (
              <>
                <MenuItem label="VelocitÃ " value={settings.speed === 1 ? "Normale" : settings.speed + "Ã—"} onPress={() => setMenu("speed")} />
                <MenuToggle label="Prossimo episodio" value={settings.autoplay} onToggle={() => setSettings({ ...settings, autoplay: !settings.autoplay })} />
                <MenuToggle label="Ripeti video" value={settings.loop} onToggle={() => setSettings({ ...settings, loop: !settings.loop })} />
                <MenuToggle label="Statistiche" value={settings.stats} onToggle={() => setSettings({ ...settings, stats: !settings.stats })} />
                <MenuItem label="Impostazioni complete" onPress={() => navigation.replace("Settings")} />
              </>
            )}
            {menu === "speed" && (
              <>
                <MenuHeader title="VelocitÃ " onBack={() => setMenu("root")} />
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map(s => (
                  <MenuItem key={s} label={s === 1 ? "Normale" : s + "Ã—"} selected={settings.speed === s} onPress={() => setSettings({ ...settings, speed: s })} />
                ))}
              </>
            )}
            {menu === "quality" && (
              <>
                <MenuHeader title="QualitÃ " onBack={() => setMenu("root")} />
                {["auto", "2160", "1080", "720", "480", "360"].map(q => (
                  <MenuItem
                    key={q}
                    label={q === "auto" ? "Automatica" : q + "p"}
                    selected={String(info?.quality) === q}
                    onPress={() => {
                      setMenu(null);
                      reload({ quality: q, force: q !== "auto" });
                    }}
                  />
                ))}
              </>
            )}
            {menu === "audio" && (
              <>
                <MenuHeader title="Audio" onBack={() => setMenu("root")} />
                {(info?.audio || []).map((a: any) => (
                  <MenuItem
                    key={a.Index}
                    label={a.DisplayTitle || a.Language || "Audio"}
                    selected={info?.audioIndex === a.Index}
                    onPress={() => {
                      setMenu(null);
                      reload({ audioIndex: a.Index, force: true });
                    }}
                  />
                ))}
              </>
            )}
            {menu === "subs" && (
              <>
                <MenuHeader title="Sottotitoli" onBack={() => setMenu("root")} />
                <MenuItem
                  label="Disattivati"
                  selected={!info?.subtitleIndex}
                  onPress={() => {
                    setMenu(null);
                    reload({ subtitleIndex: -1, force: true });
                  }}
                />
                {(info?.subs || []).map((s: any) => (
                  <MenuItem
                    key={s.Index}
                    label={s.DisplayTitle || s.Language || "Sottotitoli"}
                    selected={info?.subtitleIndex === s.Index}
                    onPress={() => {
                      setMenu(null);
                      reload({ subtitleIndex: s.Index, force: true });
                    }}
                  />
                ))}
                <Text style={styles.menuNote}>I sottotitoli vengono masterizzati dal server quando necessario.</Text>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function MenuItem({ label, value, selected, onPress }: any) {
  return (
    <Pressable onPress={onPress} style={styles.menuItem}>
      <Text style={styles.menuItemText}>{label}</Text>
      <Text style={styles.menuValue}>{selected ? "âœ“" : value || ""}</Text>
    </Pressable>
  );
}

function MenuToggle({ label, value, onToggle }: any) {
  return (
    <Pressable onPress={onToggle} style={styles.menuItem}>
      <Text style={styles.menuItemText}>{label}</Text>
      <View style={[styles.switch, value && styles.switchOn]}>
        <View style={[styles.switchKnob, value && styles.switchKnobOn]} />
      </View>
    </Pressable>
  );
}

function MenuHeader({ title, onBack }: any) {
  return (
    <View style={styles.menuHeader}>
      <IconButton name="chevron-back" size={20} onPress={onBack} />
      <Text style={styles.menuHeaderText}>{title}</Text>
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
      <View style={[styles.switch, value && styles.switchOn]}>
        <View style={[styles.switchKnob, value && styles.switchKnobOn]} />
      </View>
    </Pressable>
  );
}

function SettingsScreen({ navigation }: any) {
  const { session, settings, setSettings, reloadLibrary, resetLocal, setSession, lastPlayback } = useApp();

  async function doTest() {
    if (session.mode === "demo") {
      Alert.alert("Demo", "Sei in modalitÃ  demo.");
      return;
    }
    try {
      const r = await testServer(session.server);
      Alert.alert("Server OK", r.name + " Â· v" + r.version);
    } catch (e: any) {
      Alert.alert("Test fallito", e.message);
    }
  }

  async function logout() {
    await setSession(null);
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.searchHeader}>
        <IconButton name="arrow-back" onPress={() => navigation.goBack()} />
        <Text style={styles.pageTitle}>Impostazioni</Text>
      </View>
      <ScrollView contentContainerStyle={styles.settingsScroll}>
        <View style={styles.settingsCard}>
          <Text style={styles.sectionTitle}>Riproduzione</Text>
          <Choice
            label="ModalitÃ  streaming"
            value={settings.streamMode}
            options={[["auto", "Auto"], ["direct", "Direct Play"], ["transcode", "Transcoding"]]}
            onChange={(v: string) => setSettings({ ...settings, streamMode: v })}
          />
          <Choice
            label="QualitÃ  massima"
            value={settings.quality}
            options={[["auto", "Auto"], ["2160", "4K"], ["1080", "1080p"], ["720", "720p"], ["480", "480p"]]}
            onChange={(v: string) => setSettings({ ...settings, quality: v })}
          />
          <Toggle label="Risparmio dati" value={settings.saveData} onToggle={() => setSettings({ ...settings, saveData: !settings.saveData })} />
          <Toggle label="Prossimo episodio automatico" value={settings.autoplay} onToggle={() => setSettings({ ...settings, autoplay: !settings.autoplay })} />
          <Toggle label="Ripeti video" value={settings.loop} onToggle={() => setSettings({ ...settings, loop: !settings.loop })} />
          <Choice
            label="VelocitÃ "
            value={settings.speed}
            options={[[0.5, "0.5Ã—"], [0.75, "0.75Ã—"], [1, "1Ã—"], [1.25, "1.25Ã—"], [1.5, "1.5Ã—"], [2, "2Ã—"]]}
            onChange={(v: number) => setSettings({ ...settings, speed: v })}
          />
        </View>

        <View style={styles.settingsCard}>
          <Text style={styles.sectionTitle}>Audio e sottotitoli</Text>
          <Choice
            label="Lingua audio"
            value={settings.audioLang}
            options={[["it", "IT"], ["en", "EN"], ["ja", "JA"], ["fr", "FR"], ["de", "DE"]]}
            onChange={(v: string) => setSettings({ ...settings, audioLang: v })}
          />
          <Choice
            label="Lingua sottotitoli"
            value={settings.subLang}
            options={[["it", "IT"], ["en", "EN"], ["ja", "JA"], ["fr", "FR"], ["de", "DE"]]}
            onChange={(v: string) => setSettings({ ...settings, subLang: v })}
          />
          <Toggle label="Sottotitoli automatici" value={settings.autoSub} onToggle={() => setSettings({ ...settings, autoSub: !settings.autoSub })} />
          <Toggle label="Statistiche riproduzione" value={settings.stats} onToggle={() => setSettings({ ...settings, stats: !settings.stats })} />
        </View>

        <View style={styles.settingsCard}>
          <Text style={styles.sectionTitle}>Interfaccia</Text>
          <Text style={styles.settingLabel}>Dimensione locandine: {settings.posterSize}px</Text>
          <Slider
            minimumValue={120}
            maximumValue={220}
            step={5}
            value={settings.posterSize}
            minimumTrackTintColor={C.red}
            maximumTrackTintColor={C.surface3}
            thumbTintColor={C.red}
            onValueChange={(v) => setSettings({ ...settings, posterSize: v })}
          />
          <Toggle label="Animazioni" value={settings.animations} onToggle={() => setSettings({ ...settings, animations: !settings.animations })} />
          <Toggle label="Barre di progresso" value={settings.progressBars} onToggle={() => setSettings({ ...settings, progressBars: !settings.progressBars })} />
        </View>

        <View style={styles.settingsCard}>
          <Text style={styles.sectionTitle}>Server</Text>
          <Text style={styles.muted}>{session.mode === "demo" ? "ModalitÃ  demo" : session.server}</Text>
          <View style={styles.settingsActions}>
            <Pressable onPress={reloadLibrary} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Ricarica libreria</Text>
            </Pressable>
            <Pressable onPress={doTest} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Test server</Text>
            </Pressable>
            <Pressable onPress={logout} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Esci</Text>
            </Pressable>
            <Pressable onPress={resetLocal} style={styles.fixButton}>
              <Text style={styles.fixButtonText}>Ripara dati locali</Text>
            </Pressable>
          </View>
          {lastPlayback && (
            <Text style={styles.menuNote}>
              Ultima riproduzione: {lastPlayback.method} Â· {lastPlayback.quality} Â· {lastPlayback.reason}
            </Text>
          )}
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
  const [lastPlayback, setLastPlayback] = useState<any>(null);

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

  useEffect(() => {
    AsyncStorage.setItem("nova.settings", JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    AsyncStorage.setItem("nova.progress", JSON.stringify(progress));
  }, [progress]);

  useEffect(() => {
    AsyncStorage.setItem("nova.list", JSON.stringify(list));
  }, [list]);

  async function setSession(s: any) {
    if (s) await SecureStore.setItemAsync("nova.session", JSON.stringify(s));
    else await SecureStore.deleteItemAsync("nova.session");
    setSessionState(s);
    if (!s) {
      setItems([]);
      setEpMap({});
      setNextUp([]);
    }
  }

  async function reloadLibrary() {
    if (!session) return;
    setLibLoading(true);
    try {
      const data = session.mode === "demo" ? demoLibrary() : await loadLibrary(session);
      setItems(data.items);
      setEpMap(data.epMap || {});
      setNextUp(data.nextUp || []);
      setProgress((p: any) => ({ ...data.progress, ...p }));
    } catch (e: any) {
      Alert.alert("Errore libreria", e.message);
      await setSession(null);
    } finally {
      setLibLoading(false);
    }
  }

  useEffect(() => {
    if (session) reloadLibrary();
  }, [session?.token, session?.mode]);

  function saveProgress(id: string, position: number, duration: number) {
    setProgress((p: any) => ({
      ...p,
      [id]: { position, duration, updated: Date.now() }
    }));
  }

  function toggleList(id: string) {
    setList((l) => (l.includes(id) ? l.filter(x => x !== id) : [...l, id]));
  }

  async function resetLocal() {
    await SecureStore.deleteItemAsync("nova.session");
    const keys = await AsyncStorage.getAllKeys();
    await AsyncStorage.multiRemove(keys.filter(k => k.startsWith("nova.")));
    setSessionState(null);
    setItems([]);
    setEpMap({});
    setNextUp([]);
    setProgress({});
    setList([]);
    setSettings(defaultSettings);
  }

  const value = {
    session,
    setSession,
    items,
    epMap,
    nextUp,
    progress,
    saveProgress,
    list,
    toggleList,
    settings,
    setSettings,
    libLoading,
    reloadLibrary,
    resetLocal,
    lastPlayback,
    setLastPlayback
  };

  if (booting) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.center}>
          <Text style={styles.logo}>NOVA</Text>
          <ActivityIndicator color={C.red} />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <AppCtx.Provider value={value}>
        {!session ? (
          <LoginScreen />
        ) : (
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
  logo: { fontFamily: "System", fontSize: 56, fontWeight: "900", color: C.red, letterSpacing: 2 },
  logoSub: { color: C.muted, letterSpacing: 4, textTransform: "uppercase", fontSize: 12, marginTop: -8 },
  loginRoot: { flex: 1, backgroundColor: C.bg },
  loginScroll: { padding: 24, gap: 14 },
  loginTitle: { color: C.text, fontSize: 24, fontWeight: "800", marginBottom: 12 },
  loginCard: { backgroundColor: C.surface, borderColor: C.line, borderWidth: 1, borderRadius: 18, padding: 22 },
  loginCardTitle: { color: C.text, fontSize: 24, fontWeight: "800" },
  loginCardSub: { color: C.muted, fontSize: 13, marginBottom: 18 },
  label: { color: C.muted, fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, marginTop: 10 },
  input: { backgroundColor: "#0d0d12", borderColor: C.line, borderWidth: 1, borderRadius: 10, color: C.text, paddingHorizontal: 14, paddingVertical: 12 },
  testButton: { alignSelf: "flex-start", backgroundColor: C.surface2, borderColor: C.line, borderWidth: 1, borderRadius: 30, paddingHorizontal: 14, paddingVertical: 8, marginTop: 10 },
  testButtonText: { color: C.muted, fontWeight: "700", fontSize: 12 },
  status: { fontSize: 12, marginTop: 8 },
  ok: { color: C.green },
  bad: { color: "#ff6b72", marginTop: 8 },
  primaryButton: { backgroundColor: C.red, borderRadius: 10, paddingVertical: 13, alignItems: "center", justifyContent: "center", marginTop: 14 },
  primaryButtonText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  secondaryButton: { backgroundColor: C.surface2, borderColor: C.line, borderWidth: 1, borderRadius: 10, paddingVertical: 12, alignItems: "center", justifyContent: "center" },
  secondaryButtonText: { color: C.text, fontWeight: "800" },
  fixButton: { backgroundColor: "#ffb22412", borderColor: "#ffb22455", borderWidth: 1, borderRadius: 10, paddingVertical: 11, alignItems: "center", justifyContent: "center", marginTop: 10 },
  fixButtonText: { color: "#ffd58a", fontWeight: "800", fontSize: 13 },
  divider: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 16 },
  dividerLine: { flex: 1, height: 1, backgroundColor: C.line },
  dividerText: { color: C.faint, fontSize: 12 },
  topBar: { height: 62, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: C.bg },
  topLogo: { color: C.red, fontSize: 26, fontWeight: "900", letterSpacing: 1 },
  iconButton: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  pressed: { backgroundColor: "#ffffff1c", transform: [{ scale: 1.06 }] },
  face: { backgroundColor: C.red, alignItems: "center", justifyContent: "center" },
  hero: { height: 560, justifyContent: "flex-end" },
  heroContent: { padding: 20, paddingBottom: 34 },
  heroKicker: { color: C.muted, fontWeight: "800", letterSpacing: 2, fontSize: 12, marginBottom: 8 },
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
  card: { width: 150 },
  cardWide: { width: 260 },
  cardPressed: { transform: [{ scale: 1.06 }] },
  poster: { borderRadius: 10, overflow: "hidden", backgroundColor: C.surface2 },
  posterWide: {},
  posterImage: { width: "100%", aspectRatio: 2 / 3 },
  posterFallback: { width: "100%", aspectRatio: 2 / 3, padding: 12, justifyContent: "flex-end" },
  posterFallbackTitle: { color: C.text, fontWeight: "900", fontSize: 18 },
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
  facts: { color: C.muted, fontSize: 13, marginBottom: 8 },
  sectionTitle: { color: C.text, fontSize: 21, fontWeight: "800", marginTop: 24, marginBottom: 12 },
  seasonHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
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
  roundButton: { width: 44, height: 44, borderRadius: 22, borderWidth: 2, borderColor: "rgba(255,255,255,0.6)", alignItems: "center", justifyContent: "center" },
  roundOn: { borderColor: C.green },
  playerRoot: { flex: 1, backgroundColor: "#000" },
  playerLoading: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  playerError: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(6,6,9,0.95)", alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  playerTopScrim: { position: "absolute", top: 0, left: 0, right: 0, height: 120 },
  playerBottomScrim: { position: "absolute", bottom: 0, left: 0, right: 0, height: 160 },
  playerTop: { position: "absolute", top: 12, left: 12, right: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  playerTitle: { color: "#fff", fontWeight: "800", fontSize: 16 },
  playerSub: { color: "#d2d2d8", fontSize: 12 },
  centerPlay: { position: "absolute", left: "50%", top: "50%", marginLeft: -43, marginTop: -43, width: 86, height: 86, borderRadius: 43, backgroundColor: "rgba(8,8,11,0.62)", borderWidth: 1, borderColor: "rgba(255,255,255,0.25)", alignItems: "center", justifyContent: "center" },
  playerBottom: { position: "absolute", left: 12, right: 12, bottom: 8 },
  playerControls: { flexDirection: "row", alignItems: "center", gap: 4 },
  playerTime: { color: "#fff", fontWeight: "700", fontSize: 13 },
  hdButton: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  hdText: { color: "#fff", fontWeight: "900", fontSize: 11, borderWidth: 1.5, borderColor: "#fff", borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  statsText: { color: "#d6d6de", fontSize: 11, marginTop: 4 },
  endOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(6,6,9,0.93)", alignItems: "center", justifyContent: "center", padding: 24, gap: 18 },
  endLabel: { color: C.muted, textTransform: "uppercase", letterSpacing: 2, fontWeight: "800", fontSize: 12 },
  nextCard: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: C.surface2, borderColor: C.line, borderWidth: 1, borderRadius: 14, padding: 14, width: "100%" },
  nextThumb: { width: 120, aspectRatio: 16 / 9, borderRadius: 8, backgroundColor: C.surface3 },
  countdown: { color: C.red, fontWeight: "900", fontSize: 22 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end", padding: 16 },
  menu: { backgroundColor: "rgba(16,16,22,0.98)", borderColor: C.line, borderWidth: 1, borderRadius: 16, overflow: "hidden", maxHeight: "75%" },
  menuItem: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" },
  menuItemText: { color: C.text, fontSize: 14, fontWeight: "600" },
  menuValue: { color: C.green, fontWeight: "800" },
  menuHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line },
  menuHeaderText: { color: C.text, fontWeight: "800", fontSize: 15 },
  menuNote: { color: C.faint, fontSize: 12, padding: 14 },
  switch: { width: 40, height: 22, borderRadius: 11, backgroundColor: "#3a3a46", padding: 2 },
  switchOn: { backgroundColor: C.red },
  switchKnob: { width: 18, height: 18, borderRadius: 9, backgroundColor: "#fff" },
  switchKnobOn: { transform: [{ translateX: 18 }] },
  pageTitle: { color: C.text, fontSize: 24, fontWeight: "800" },
  settingsScroll: { padding: 16, paddingBottom: 60, gap: 16 },
  settingsCard: { backgroundColor: C.surface, borderColor: C.line, borderWidth: 1, borderRadius: 16, padding: 18 },
  settingBlock: { marginVertical: 10 },
  settingLabel: { color: C.text, fontWeight: "700", marginBottom: 8 },
  settingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12 },
  choiceWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: { backgroundColor: C.surface2, borderColor: C.line, borderWidth: 1, borderRadius: 30, paddingHorizontal: 14, paddingVertical: 8 },
  choiceOn: { backgroundColor: "#fff", borderColor: "#fff" },
  choiceText: { color: C.muted, fontWeight: "800", fontSize: 12 },
  choiceTextOn: { color: "#000" },
  settingsActions: { gap: 10, marginTop: 14 }
});
