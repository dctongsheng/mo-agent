// Local UI state + server-backed sessions/profiles.
// Lives in React context so it's available everywhere without prop-drilling.

import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import type { DollForm } from "./components/Doll";
import { store } from "../store/store";
import * as gw from "../services/gateway-api";
import * as mo from "../services/mo-api";

export type Screen = "home" | "evolve" | "memory" | "dream" | "skills" | "settings";

export const EVOLVER_PROFILE_ID = "ye-mao-evolve";

export type Profile = {
  id: string; // server profile name
  name: string;
  glyph: string;
  form: DollForm;
  model: string;
  role: string;
  isHost: boolean;
  isEvolver: boolean; // permanent 夜貘（进化）— not deletable
};

export type Session = {
  id: string;
  title: string;
  time: string;
};

type AppState = {
  screen: Screen;
  manualNight: boolean;
  profiles: Profile[];
  currentProfileId: string;
  profileMenuOpen: boolean;
  sessions: Session[];
  sessionsLoaded: boolean;
  currentSessionId: string | null;
  /** The model currently serving chat — single source of truth for all screens. */
  currentModel: { model: string; provider: string } | null;
  setCurrentModel: (m: { model: string; provider: string }) => void;
  dollOn: boolean;
  dollForm: DollForm;
  dollStatus: string;
  connMode: "cloud" | "key" | "local";
  autostart: boolean;
  dollDefault: boolean;
  voiceOn: boolean;
  msgrs: Record<string, boolean>;
  mcpOn: Record<string, boolean>;
  dreamOn: boolean;
  dreamAnswer: "yes" | "no" | null;

  // actions
  go: (s: Screen) => void;
  toggleNight: () => void;
  selectProfile: (id: string) => void;
  toggleProfileMenu: () => void;
  createProfile: () => void;
  cloneProfile: () => void;
  deleteProfile: (id: string) => void;
  refreshSessions: () => Promise<void>;
  newSession: () => Promise<string | null>;
  selectSession: (id: string) => void;
  deleteSession: (id: string) => void;
  renameCurrentSession: (title: string) => void;
  cycleDoll: () => void;
  petDoll: () => void;
  hideDoll: () => void;
  showDoll: () => void;
  setConnMode: (m: "cloud" | "key" | "local") => void;
  toggleAutostart: () => void;
  toggleDollDefault: () => void;
  toggleVoice: () => void;
  toggleMsgr: (k: string) => void;
  toggleMcp: (k: string) => void;
  toggleDream: () => void;
  acceptDream: () => void;
  declineDream: () => void;
  noteUserMessage: (text: string) => void;
};

const GLYPHS = ["貘", "守", "晓", "影", "墨", "禾"];

function toUiProfile(p: mo.Profile, idx: number): Profile {
  const isEvolver = p.name === EVOLVER_PROFILE_ID;
  return {
    id: p.name,
    name: p.is_default ? `本体 · 小貘` : isEvolver ? `分身 · 夜貘（进化）` : `分身 · ${p.name}`,
    glyph: p.is_default ? "貘" : isEvolver ? "夜" : (p.name[0]?.toUpperCase() ?? GLYPHS[idx % GLYPHS.length]),
    form: (idx % 3) as DollForm,
    model: p.model ?? "未配置",
    role: p.is_default ? "什么都管的大管家" : isEvolver ? "夜里打磨技艺的那一只" : (p.provider ?? "等你吩咐"),
    isHost: p.is_default,
    isEvolver,
  };
}

function ports() {
  const st = store.getState().gateway.state;
  return st.kind === "ready" ? { api: st.port, mo: st.moPort ?? 0 } : { api: 0, mo: 0 };
}

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [screen, setScreen] = useState<Screen>("home");
  const [manualNight, setManualNight] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [currentProfileId, setCurrentProfileId] = useState("default");
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState<{ model: string; provider: string } | null>(null);
  const [dollOn, setDollOn] = useState(true);
  const [dollForm, setDollForm] = useState<DollForm>(0);
  const [dollStatus, setDollStatus] = useState("正在听着……");
  const [connMode, setConnModeState] = useState<"cloud" | "key" | "local">("key");
  const [autostart, setAutostart] = useState(true);
  const [dollDefault, setDollDefault] = useState(true);
  const [voiceOn, setVoiceOn] = useState(true);
  const [msgrs, setMsgrs] = useState<Record<string, boolean>>({ tg: false, wa: false, dc: false, fs: false });
  const [mcpOn, setMcpOn] = useState<Record<string, boolean>>({ fs: true, browser: true, gh: false, cal: true });
  const [dreamOn, setDreamOn] = useState(true);
  const [dreamAnswer, setDreamAnswer] = useState<"yes" | "no" | null>(null);

  const refreshSessions = useCallback(async () => {
    const { api } = ports();
    if (!api) return;
    try {
      const list = await gw.listSessions(api);
      setSessions(list.map((s) => ({
        id: s.id,
        title: s.title?.trim() || "未命名的一页",
        time: gw.formatSessionTime(s.started_at),
      })));
      setSessionsLoaded(true);
    } catch { /* gateway still warming up */ }
  }, []);

  const refreshProfiles = useCallback(async () => {
    const { mo: moPort } = ports();
    if (!moPort) return;
    try {
      const res = await mo.listProfiles(moPort);
      const ui = res.profiles.map(toUiProfile);
      setProfiles(ui);
      const def = ui.find((p) => p.isHost) ?? ui[0];
      if (def) setCurrentProfileId((cur) => (ui.some((p) => p.id === cur) ? cur : def.id));
    } catch { /* dashboard not up yet */ }
  }, []);

  // Load server data once the gateway becomes ready (and again after restarts)
  useEffect(() => {
    let last: string = "";
    const sync = () => {
      const st = store.getState().gateway.state;
      const key = st.kind === "ready" ? `${st.port}:${st.moPort}` : st.kind;
      if (key === last) return;
      last = key;
      if (st.kind === "ready") {
        refreshSessions();
        refreshProfiles();
        if (st.moPort) {
          mo.getModelInfo(st.moPort)
            .then((mi) => setCurrentModel({ model: mi.model, provider: mi.provider }))
            .catch(() => {});
        }
      }
    };
    sync();
    const unsub = store.subscribe(sync);
    return unsub;
  }, [refreshSessions, refreshProfiles]);

  const go = useCallback((s: Screen) => {
    setScreen(s);
    document.body.classList.toggle("night", s === "dream" || manualNight);
  }, [manualNight]);

  const toggleNight = useCallback(() => {
    setManualNight((n) => {
      const next = !n;
      document.body.classList.toggle("night", screen === "dream" || next);
      return next;
    });
  }, [screen]);

  useEffect(() => {
    document.body.classList.toggle("night", screen === "dream" || manualNight);
  }, [screen, manualNight]);

  const selectProfile = useCallback((id: string) => {
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    setCurrentProfileId(id);
    setProfileMenuOpen(false);
    setDollForm(p.form);
    setDollStatus("换了一副身子");
    const { mo: moPort } = ports();
    if (moPort) mo.selectProfile(moPort, id).catch(() => {});
  }, [profiles]);

  const toggleProfileMenu = useCallback(() => setProfileMenuOpen((o) => !o), []);

  const createProfile = useCallback(() => {
    const { mo: moPort } = ports();
    if (!moPort) return;
    const name = `mo-${Date.now().toString(36).slice(-4)}`;
    mo.createProfile(moPort, name)
      .then(() => refreshProfiles())
      .then(() => { setProfileMenuOpen(false); setDollStatus("刚出生,有点怕生"); })
      .catch(() => setDollStatus("没造出来,再试一次?"));
  }, [refreshProfiles]);

  const cloneProfile = useCallback(() => {
    const { mo: moPort } = ports();
    if (!moPort) return;
    const name = `${currentProfileId}-ying`;
    mo.createProfile(moPort, name)
      .then(() => refreshProfiles())
      .then(() => { setProfileMenuOpen(false); setDollStatus("镜子里走出来一只"); })
      .catch(() => setDollStatus("影子没跟上来"));
  }, [currentProfileId, refreshProfiles]);

  const deleteProfile = useCallback((id: string) => {
    const { mo: moPort } = ports();
    if (!moPort) return;
    mo.deleteProfile(moPort, id)
      .then(() => refreshProfiles())
      .catch(() => {});
    if (currentProfileId === id) {
      setCurrentProfileId("default");
      setDollForm(0);
    }
  }, [currentProfileId, refreshProfiles]);

  // Commit the session we're leaving so OpenViking extracts memories from it.
  // api_server never fires on_session_end, so the desktop triggers it here.
  const commitPrev = useCallback((prev: string | null) => {
    const { mo: moPort } = ports();
    if (moPort && prev) mo.commitSession(moPort, prev).catch(() => {});
  }, []);

  const newSession = useCallback(async (): Promise<string | null> => {
    const { api } = ports();
    if (!api) return null;
    try {
      const s = await gw.createSession(api);
      setCurrentSessionId((prev) => { commitPrev(prev); return s.id; });
      setSessions((ss) => [{ id: s.id, title: "未命名的一页", time: "今天" }, ...ss]);
      setScreen("home");
      return s.id;
    } catch {
      return null;
    }
  }, [commitPrev]);

  const selectSession = useCallback((id: string) => {
    setCurrentSessionId((prev) => { if (prev !== id) commitPrev(prev); return id; });
    setScreen("home");
  }, [commitPrev]);

  const deleteSession = useCallback((id: string) => {
    const { api } = ports();
    setSessions((ss) => ss.filter((s) => s.id !== id));
    if (currentSessionId === id) setCurrentSessionId(null);
    if (api) gw.deleteSession(api, id).catch(() => {});
  }, [currentSessionId]);

  const renameCurrentSession = useCallback((title: string) => {
    const id = currentSessionId;
    if (!id) return;
    const short = title.slice(0, 16);
    setSessions((ss) => ss.map((s) => (s.id === id && s.title === "未命名的一页" ? { ...s, title: short } : s)));
    const { api } = ports();
    if (api) gw.renameSession(api, id, short).catch(() => {});
  }, [currentSessionId]);

  const cycleDoll = useCallback(() => {
    setDollForm((f) => ((f + 1) % 3) as DollForm);
    setDollStatus("换了个新样子");
  }, []);

  const petDoll = useCallback(() => setDollStatus("眯起眼,很受用"), []);
  const hideDoll = useCallback(() => setDollOn(false), []);
  const showDoll = useCallback(() => { setDollOn(true); setDollStatus("回来啦"); }, []);

  const noteUserMessage = useCallback((text: string) => {
    // doll transformation easter eggs
    if (/猫/.test(text)) { setDollForm(1); setDollStatus("竖起了耳朵"); }
    else if (/鸟/.test(text)) { setDollForm(2); setDollStatus("抖了抖羽毛"); }
    else if (/貘|变回/.test(text)) { setDollForm(0); setDollStatus("满足地晃了晃鼻子"); }
    else { setDollStatus("记在手记里了"); }
  }, []);

  const value: AppState = {
    screen, manualNight, profiles, currentProfileId, profileMenuOpen,
    sessions, sessionsLoaded, currentSessionId, currentModel, setCurrentModel,
    dollOn, dollForm, dollStatus,
    connMode, autostart, dollDefault, voiceOn,
    msgrs, mcpOn, dreamOn, dreamAnswer,
    go, toggleNight, selectProfile, toggleProfileMenu, createProfile,
    cloneProfile, deleteProfile, refreshSessions, newSession, selectSession, deleteSession,
    renameCurrentSession, cycleDoll, petDoll, hideDoll, showDoll,
    setConnMode: (m) => setConnModeState(m),
    toggleAutostart: () => setAutostart((a) => !a),
    toggleDollDefault: () => setDollDefault((d) => !d),
    toggleVoice: () => setVoiceOn((v) => !v),
    toggleMsgr: (k) => setMsgrs((m) => ({ ...m, [k]: !m[k] })),
    toggleMcp: (k) => setMcpOn((m) => ({ ...m, [k]: !m[k] })),
    toggleDream: () => setDreamOn((d) => !d),
    acceptDream: () => setDreamAnswer("yes"),
    declineDream: () => setDreamAnswer("no"),
    noteUserMessage,
  };

  return React.createElement(Ctx.Provider, { value }, children);
}

export function useAppState() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAppState outside provider");
  return ctx;
}
