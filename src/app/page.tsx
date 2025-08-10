// src/app/page.tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabaseClient"; // ✅ Supabase 클라이언트

// === TZ utils (UTC 저장 / KST 표시) ===
const KST_OFFSET_MIN = 9 * 60; // Asia/Seoul 고정, DST 없음

function kstToUtcISO(dateStr: string, timeStr: string) {
  // dateStr: 'YYYY-MM-DD', timeStr: 'HH:mm'
  const local = new Date(`${dateStr}T${timeStr}:00`);         // 브라우저 로컬 파싱
  const utcMs = local.getTime() - KST_OFFSET_MIN * 60 * 1000; // KST → UTC
  return new Date(utcMs).toISOString();                       // ex) '2025-08-10T03:24:00.000Z'
}

function utcISOToKst(iso: string) {
  const d = new Date(iso);
  const kstMs = d.getTime() + KST_OFFSET_MIN * 60 * 1000;
  const k = new Date(kstMs);
  const y = k.getFullYear();
  const m = String(k.getMonth()+1).padStart(2,'0');
  const dd = String(k.getDate()).padStart(2,'0');
  const hh = String(k.getHours()).padStart(2,'0');
  const mm = String(k.getMinutes()).padStart(2,'0');
  return { date: `${y}-${m}-${dd}`, time: `${hh}:${mm}` };
}

// 날짜만 다룰 때 +7일 (KST 안전: 정오 고정)
function add7KstSafe(dateStr: string) {
  const d = new Date(dateStr + 'T12:00:00'); // KST 하루 밀림 방지
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0,10);        // 'YYYY-MM-DD'
}

// 안정 비교용 직렬화
function j(v: unknown) {
  try { return JSON.stringify(v); } catch { return ""; }
}

// 고유 ID (동시 생성 충돌 방지)
function makeId(existing: {id:number}[]) {
  let id = Date.now();
  while (existing.some(x=>x.id===id)) id++;
  return id;
}

/** ========== LocalStorage helpers (로컬 전용 상태에 사용) ========== */
function useLocalStorage<T>(key: string, initialValue: T): [T, React.Dispatch<React.SetStateAction<T>>, boolean] {
  const [value, setValue] = React.useState(initialValue as T);
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    try {
      const saved = window.localStorage.getItem(key);
      if (saved) setValue(JSON.parse(saved));
    } catch {}
    setReady(true);
  }, [key]);
  React.useEffect(() => {
    if (!ready) return;
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }, [key, value, ready]);
  return [value, setValue, ready];
}

/** ========== Supabase KV helpers (공유 데이터: users / events) ========== */
// key 하나에 JSON 통째로 저장/불러오기
async function kvLoad<T>(key: string, fallback: T): Promise<T> {
  const { data, error } = await supabase
    .from("kv_store")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) {
    console.warn("kv load error", key, error);
    return fallback;
  }
  return (data?.value as T) ?? fallback;
}

async function kvSave<T>(key: string, value: T): Promise<void> {
  const { error } = await supabase
    .from("kv_store")
    .upsert({ key, value }, { onConflict: "key"/*, returning: "minimal"*/ });
  if (error) console.warn("kv save error", key, error);
}

// ✅ Supabase 공유 상태 훅 (루프/레이스 방지 강화 + 실시간 반영 안정화)
function useShared<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>, boolean] {
  const [value, setValue] = React.useState<T>(initial);
  const [ready, setReady] = React.useState(false);
  const subInitRef = React.useRef(false);        // 구독 중복 방지
  const lastSavedStr = React.useRef<string>(""); // 마지막으로 저장한 스냅샷
  const saveTimer = React.useRef<number | null>(null);

  // 1) 최초 1회 로드
  React.useEffect(() => {
    let alive = true;
    (async () => {
      const loaded = await kvLoad<T>(key, initial);
      if (!alive) return;
      setValue(loaded);
      lastSavedStr.current = j(loaded);
      setReady(true);
    })();
    return () => { alive = false; };
  }, [key, initial]);

  // 2) 값 바뀌면 저장 — 디바운스 + 변경 감지
  const scheduleSave = React.useCallback((cur: T) => {
    const curStr = j(cur);
    if (curStr === lastSavedStr.current) return; // 변경 없음
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      await kvSave<T>(key, cur);
      lastSavedStr.current = j(cur);
    }, 250) as unknown as number;
  }, [key]);

  React.useEffect(() => {
    if (!ready) return;
    scheduleSave(value);
  }, [value, ready, scheduleSave]);

  // 3) 🔔 실시간 구독: kv_store의 해당 key가 바뀌면 re-load
  React.useEffect(() => {
    if (!ready) return;
    if (subInitRef.current) return;
    subInitRef.current = true;

    const channel = supabase
      .channel(`kv-${key}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'kv_store', filter: `key=eq.${key}` },
        async () => {
          const latest = await kvLoad<T>(key, initial);
          const latestStr = j(latest);
          if (latestStr !== lastSavedStr.current) {
            lastSavedStr.current = latestStr; // 🔒 저장 루프 방지
            setValue(latest);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      subInitRef.current = false;
    };
  }, [key, ready, initial]);

  return [value, setValue, ready];
}

/** ========== Types & Consts ========== */
type User = { id: number; name: string; password: string; isAdmin: boolean };
type Participant = { id: number; name: string; leader: boolean };
type CancelRequest = { userId: number; name: string; reason: string };

type EventItem = {
  id: number;
  title: string;
  date: string;   // YYYY-MM-DD
  time: string;   // HH:mm
  category: string; // 요일 전시대
  participants: Participant[];
  cancelRequests: CancelRequest[];
  openForApplications: boolean;
  notifiedToAll: boolean;
  repeatWeekly: boolean;
};

const CAPACITY = 4;
const CATEGORIES = [
  "월요일","화요일","수요일","목요일","금요일","토요일","일요일",
];

/** ========== Date utils (no libs) ========== */
function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(iso: string, n: number): string {
  const [y,m,d] = iso.split("-").map(Number);
  const nd = new Date(y, (m||1)-1, d||1);
  nd.setDate(nd.getDate() + n);
  const yy = nd.getFullYear();
  const mm = String(nd.getMonth()+1).padStart(2,"0");
  const dd = String(nd.getDate()).padStart(2,"0");
  return `${yy}-${mm}-${dd}`;
}
function cmpDate(a: string, b: string) { return a === b ? 0 : (a < b ? -1 : 1); }

// ✅ 여기 추가
function isPastEvent(ev: EventItem) {
  // 시간이 있으면 KST 기준 시작시각이 현재보다 이전인지 확인
  if (ev.time) {
    const startISO = kstToUtcISO(ev.date, ev.time);
    return new Date(startISO) < new Date();
  }
  // 시간이 없으면 날짜만 비교
  return cmpDate(ev.date, todayStr()) < 0;
}

/** ========== Responsive helper ========== */
function useIsMobile(bp = 640) {
  const [m, setM] = React.useState(false);
  React.useEffect(() => {
    const on = () => setM(window.innerWidth < bp);
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [bp]);
  return m;
}

/** ========== Seed data ========== */
function initialUsers(): User[] {
  return [
    { id: 1, name: "관리자", password: "admin", isAdmin: true },
    { id: 2, name: "지수", password: "1234", isAdmin: false },
    { id: 3, name: "민수", password: "1234", isAdmin: false },
    { id: 4, name: "서연", password: "1234", isAdmin: false },
  ];
}

/** ========== Mini UI (no Tailwind) ========== */
const S = {
  container: { maxWidth: 960, margin: "0 auto", padding: 16 } as React.CSSProperties,
  card: {
    border: "1px solid #e6e9ef",
    borderRadius: 12,
    padding: 16,
    background: "#fff",
    boxShadow: "0 1px 2px rgba(0,0,0,.06)",
    transition: "box-shadow .18s ease, transform .18s ease"
  } as React.CSSProperties,
  btn: {
    height: 44, padding: "0 16px",
    background: "#1a73e8", color: "#fff",
    borderRadius: 8, border: "1px solid #1a73e8",
    cursor: "pointer" as const,
    boxShadow: "0 1px 2px rgba(0,0,0,.10)",
    transition: "box-shadow .15s ease, transform .02s ease, background .15s ease",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    whiteSpace: "nowrap", wordBreak: "keep-all" as const, flexShrink: 0
  } as React.CSSProperties,
  btnGray: {
    height: 44, padding: "0 16px",
    background: "#f1f3f4", color: "#1f1f1f",
    borderRadius: 8, border: "1px solid #e6e9ef",
    cursor: "pointer" as const,
    transition: "box-shadow .15s ease, transform .02s ease, background .15s ease",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    whiteSpace: "nowrap" as const,
    wordBreak: "keep-all" as const,
    flexShrink: 0,
  } as React.CSSProperties,
  btnRed: {
    height: 44, padding: "0 16px",
    background: "#d93025", color: "#fff",
    borderRadius: 8, border: "1px solid #d93025",
    cursor: "pointer" as const,
    transition: "box-shadow .15s ease, transform .02s ease, background .15s ease",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    whiteSpace: "nowrap" as const,
    wordBreak: "keep-all" as const,
    flexShrink: 0,
  } as React.CSSProperties,
  input: {
    height: 40, padding: "0 12px",
    border: "1px solid #e6e9ef", borderRadius: 8, width: "100%",
    background: "#fff", outline: "none",
    transition: "border-color .15s ease, box-shadow .15s ease"
  } as React.CSSProperties,
  label: { fontSize: 12, color: "#5f6368", display: "block", marginBottom: 6 } as React.CSSProperties,
  small: { fontSize: 12, color: "#5f6368", wordBreak: "keep-all" as const } as React.CSSProperties,
};

function Card(props: React.HTMLAttributes<HTMLDivElement>) { return <div {...props} style={{...S.card, ...(props.style||{})}} />; }
function Button({ kind="default", style, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "default"|"gray"|"red" }) {
  const base = kind==="red" ? S.btnRed : kind==="gray" ? S.btnGray : S.btn;
  return <button {...rest} style={{...base, ...(style||{})}} />;
}
function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{...S.input, ...(props.style||{})}}
      onFocus={e=>{
        e.currentTarget.style.borderColor = "#1a73e8";
        e.currentTarget.style.boxShadow = "0 0 0 3px rgba(26,115,232,.15)";
      }}
      onBlur={e=>{
        e.currentTarget.style.borderColor = "#e6e9ef";
        e.currentTarget.style.boxShadow = "none";
      }}
    />
  );
}

/** Tiny UI Bits */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 12, background:"#f3f4f6", color:"#374151",
      padding:"4px 10px", borderRadius:999, border:"1px solid #e5e7eb"
    }}>
      {children}
    </span>
  );
}
function Badge({ tone="green", children }:{ tone?: "green"|"gray"|"red"; children: React.ReactNode }) {
  const map = {
    green: { bg:"#ecfdf5", bd:"#a7f3d0", fg:"#065f46" },
    gray:  { bg:"#f3f4f6", bd:"#e5e7eb", fg:"#374151" },
    red:   { bg:"#fef2f2", bd:"#fecaca", fg:"#7f1d1d" },
  }[tone];
  return (
    <span style={{
      fontSize: 11, fontWeight:600,
      background: map.bg, color: map.fg,
      padding:"3px 8px", borderRadius:999, border:`1px solid ${map.bd}`, letterSpacing:0.2
    }}>{children}</span>
  );
}

/** ========== Page (everything in one file) ========== */
export default function Home() {
  // 공유 데이터: users, events → Supabase 연동
  const [users, setUsers, usersReady] = useShared<User[]>("users", initialUsers());
  const [events, setEvents, eventsReady] = useShared<EventItem[]>("events", []);

  // 로컬 전용 상태
  const [currentUserId, setCurrentUserId] = useLocalStorage<number | null>("meet_current_v2", null);
  const [tab, setTab] = useLocalStorage<"feed"|"calendar"|"create"|"admin">("meet_tab_v2", "feed");
  const [openCat, setOpenCat] = useLocalStorage<string | null>("meet_feed_cat_open_v2", null);

  const isMobile = useIsMobile();

  const currentUser = users.find(u=>u.id===currentUserId) ?? null;
  const isAdmin = !!currentUser?.isAdmin;

  // 로그인/가입 상태
  const [loginName, setLoginName] = useState(""); const [loginPw, setLoginPw] = useState("");
  const [signupName, setSignupName] = useState(""); const [signupPw, setSignupPw] = useState("");

  // 생성/수정 폼
  const [editingId, setEditingId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [repeatWeekly, setRepeatWeekly] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);
  const [leaderId, setLeaderId] = useState<number | null>(null);

  // ⏱ 미래 시각이 지나면 자동으로 렌더 트리거 (15초 간격)
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  /** 지난 일정 자동 삭제 — 완료 후 3일 경과 시 제거 */
  useEffect(() => {
    if (!eventsReady) return;

    const now = new Date(); // UTC now
    const cutoffMs = 3 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(now.getTime() - cutoffMs); // 3일 전

    setEvents(prev => prev.filter(e => {
      if (e.time) {
        const startISO = kstToUtcISO(e.date, e.time);
        return new Date(startISO) >= cutoff;
      }
      const keepDate = addDays(todayStr(), -3); // 오늘-3일
      return cmpDate(e.date, keepDate) >= 0;
    }));
  }, [eventsReady, setEvents, nowTick]);

  /** 반복 일정 자동 생성(“방금 지난” 일정 기준으로 +7일 1개 생성) */
  useEffect(() => {
    if (!eventsReady) return;

    setEvents(prev => {
      const list = [...prev];
      let changed = false;

      // group by title|time|category
      const groups: Record<string, EventItem[]> = {};
      const keyOf = (e: EventItem) => `${e.title}|${e.time}|${e.category}`;
      for (const ev of list) (groups[keyOf(ev)] ||= []).push(ev);

      const now = new Date();

      Object.values(groups).forEach(g => {
        // 반복 옵션 있는 그룹만
        if (!g.some(x => x.repeatWeekly)) return;

        // 시간 오름차순
        g.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

        // ✅ “지금 기준으로 이미 시작된 것들” 중 가장 최근(= 방금 지난 카드)
        const recentlyPassed = [...g].reverse().find(item => {
          const startISO = kstToUtcISO(item.date, item.time);
          return new Date(startISO) <= now;
        });
        if (!recentlyPassed) return;

        // ✅ 그 카드 기준 +7일 생성 (이미 있으면 스킵)
        const nextDate = add7KstSafe(recentlyPassed.date);
        const exists = g.some(x => x.date === nextDate && x.time === recentlyPassed.time);
        if (exists) return;

        const newItem: EventItem = {
          ...recentlyPassed,
          id: makeId(list),
          date: nextDate,
          cancelRequests: [],
          notifiedToAll: false,
          openForApplications: recentlyPassed.participants.length < CAPACITY,
          repeatWeekly: true,
        };
        list.push(newItem);
        changed = true;
      });

      return changed ? list : prev;
    });
  }, [eventsReady, setEvents, nowTick]);

  /** 파생값 — 한국시간 도달 전 카드는 숨기고, 도달하면 자동 표시 */
/** 파생값 — 전시대일정: 과거/현재 + 각 그룹의 '최초 미래 1개'까지 표시 */
const feedByCategory = useMemo(() => {
  if (!eventsReady) return {} as Record<string, EventItem[]>;
  const map: Record<string, EventItem[]> = {};
  for (const c of CATEGORIES) map[c] = [];

  void nowTick; // 15초마다 재평가

  const now = new Date();

  // 1) 그룹핑: 동일한 title|time|category
  const keyOf = (e: EventItem) => `${e.title}|${e.time}|${e.category}`;
  const groups: Record<string, EventItem[]> = {};
  for (const e of events) (groups[keyOf(e)] ||= []).push(e);

  // 2) 각 그룹 처리
  Object.values(groups).forEach(g => {
    // 시간 오름차순 정렬
    g.sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));

    // (a) 과거/현재 도달한 카드 전부 포함
    const reached: EventItem[] = [];
    const future: EventItem[] = [];

    for (const e of g) {
      if (!e.time) { // 시간이 없는 카드는 항상 보이기
        reached.push(e);
        continue;
      }
      const startISO = kstToUtcISO(e.date, e.time);
      (new Date(startISO) <= now ? reached : future).push(e);
    }

    // (b) 미래 중 '가장 가까운 1개'만 예외적으로 포함
    const firstFuture = future[0] ?? null;

    // 카테고리로 분배
    for (const e of reached) (map[e.category] ||= []).push(e);
    if (firstFuture) (map[firstFuture.category] ||= []).push(firstFuture);
  });

  // 3) 각 카테고리 정렬
  for (const c of Object.keys(map)) {
    map[c].sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
  }

  return map;
}, [events, eventsReady, nowTick]);

  /** 인증 */
  function logIn() {
    const found = users.find(u=>u.name===loginName && u.password===loginPw);
    if (!found) { alert("이름 또는 비밀번호가 올바르지 않습니다."); return; }
    setCurrentUserId(found.id);
    setLoginName(""); setLoginPw("");
  }
  function signUp() {
    if (!signupName || !signupPw) return;
    if (users.some(u=>u.name===signupName)) { alert("이미 존재하는 이름입니다."); return; }
    const newUser: User = { id: Math.max(...users.map(u=>u.id), 0)+1, name: signupName, password: signupPw, isAdmin: false };
    setUsers([...users, newUser]); alert("가입 완료! 로그인해주세요.");
    setSignupName(""); setSignupPw("");
  }
  function logOut() { setCurrentUserId(null); }

  /** 유틸 */
  function isIn(ev: EventItem, uid: number) { return ev.participants.some(p=>p.id===uid); }
  function hasCapacity(ev: EventItem) { return ev.participants.length < CAPACITY; }

  /** 액션 */
  function joinEvent(evId: number) {
    if (!currentUser) return;
    setEvents(prev => prev.map(e=>{
      if (e.id!==evId) return e;
      if (isIn(e, currentUser.id) || !hasCapacity(e)) return e;
      const newList = [...e.participants, { id: currentUser.id, name: currentUser.name, leader: false }];
      return { ...e, participants: newList, openForApplications: newList.length < CAPACITY };
    }));
  }
  function requestCancel(evId: number, reason="개인 사정") {
    if (!currentUser) return;
    setEvents(prev => prev.map(e=>{
      if (e.id!==evId || !isIn(e, currentUser.id)) return e;
      if (e.cancelRequests.some(r=>r.userId===currentUser.id)) return e;
      return { ...e, cancelRequests: [...e.cancelRequests, { userId: currentUser.id, name: currentUser.name, reason }] };
    }));
  }
  /** 관리자가 취소요청 승인 */
  function adminApproveCancel(evId: number, userId: number) {
    if (!currentUser?.isAdmin) return;
    setEvents(prev => prev.map(e=>{
      if (e.id !== evId) return e;
      return {
        ...e,
        participants: e.participants.filter(p=>p.id!==userId),
        cancelRequests: e.cancelRequests.filter(r=>r.userId!==userId),
        openForApplications: true
      };
    }));
  }
  function adminRemoveParticipant(evId: number, userId: number) {
    if (!currentUser?.isAdmin) return;
    setEvents(prev => prev.map(e=>{
      if (e.id!==evId) return e;
      return {
        ...e,
        participants: e.participants.filter(p=>p.id!==userId),
        cancelRequests: e.cancelRequests.filter(r=>r.userId!==userId),
        openForApplications: true
      };
    }));
  }
  function notifyAllForOpenSlot(evId: number) {
    if (!currentUser?.isAdmin) return;
    setEvents(prev => prev.map(e=> e.id===evId ? { ...e, notifiedToAll: true, openForApplications: true } : e));
    alert("사이트 가입자에게 지원요청 알림이 발송되었다고 가정합니다(모의).");
  }
  function applyForSlot(evId: number) {
    if (!currentUser) return;
    setEvents(prev => prev.map(e=>{
      if (e.id!==evId || !e.openForApplications || !hasCapacity(e) || isIn(e, currentUser.id)) return e;
      const newList = [...e.participants, { id: currentUser.id, name: currentUser.name, leader: false }];
      return { ...e, participants: newList, openForApplications: newList.length < CAPACITY };
    }));
  }

  function resetForm() {
    setEditingId(null);
    setTitle(""); setDate(""); setTime(""); setCategory(CATEGORIES[0]); setRepeatWeekly(false);
    setSelectedUserIds([]); setLeaderId(null);
  }

  function startEdit(ev: EventItem) {
    setEditingId(ev.id);
    setTitle(ev.title); setDate(ev.date); setTime(ev.time); setCategory(ev.category);
    setRepeatWeekly(!!ev.repeatWeekly);
    setSelectedUserIds(ev.participants.map(p=>p.id));
    setLeaderId(ev.participants.find(p=>p.leader)?.id ?? null);
    setTab("create");
  }

  function deleteEvent(evId: number) {
    if (!isAdmin) return;
    if (!confirm("이 일정을 삭제할까요?")) return;

    // 로컬 즉시 반영 + 서버 즉시 저장(디바운스 대기 X)
    setEvents(prev => {
      const next = prev.filter(e=>e.id!==evId);
      // 🔥 즉시 플러시 (서버 반영 지연으로 복귀되는 현상 방지)
      kvSave("events", next).catch(err=>console.warn("immediate delete save error", err));
      return next;
    });

    if (editingId===evId) resetForm();
  }

  function upsertEvent() {
    if (!isAdmin) { alert("관리자만 일정 생성/수정 가능합니다."); return; }
    if (!title || !date || !time || !category) { alert("제목/날짜/시간/카테고리를 입력해주세요."); return; }
    if (selectedUserIds.length===0 || selectedUserIds.length>CAPACITY) { alert("참여자는 1~4명만 선택 가능합니다."); return; }
    if (!leaderId || !selectedUserIds.includes(leaderId)) { alert("인도자는 선택된 참여자 중 1명을 지정해야 합니다."); return; }

    const participants: Participant[] = selectedUserIds.map(uid=>{
      const u = users.find(x=>x.id===uid)!;
      return { id:u.id, name:u.name, leader: uid===leaderId };
    });

    if (editingId) {
      setEvents(prev => {
        const next = prev.map(e =>
          e.id===editingId
            ? { ...e, title, date, time, category, participants, repeatWeekly }
            : e
        );
        // 수정은 디바운스 저장으로 충분 (즉시 플러시는 생략 가능)
        return next;
      });
    } else {
      setEvents(prev => {
        const newEvent: EventItem = {
          id: makeId(prev),
          title, date, time, category,
          participants,
          cancelRequests: [],
          openForApplications: participants.length < CAPACITY,
          notifiedToAll: false,
          repeatWeekly
        };
        const next = [newEvent, ...prev];
        // 생성은 체감 위해 즉시 저장 플러시
        kvSave("events", next).catch(()=>{});
        return next;
      });
    }
    resetForm(); setTab("feed");
  }

  /** 관리자: 가입자 생성 */
  function adminCreateUser(name: string, pw: string, makeAdmin: boolean) {
    if (!isAdmin) return;
    if (!usersReady) { alert("데이터 동기화 중입니다. 1~2초 후 다시 시도해주세요."); return; }
    if (!name || !pw) { alert("이름/비밀번호를 입력해주세요."); return; }
    if (users.some(u => u.name === name)) { alert("이미 존재하는 이름입니다."); return; }

    const nu: User = {
      id: Math.max(...users.map(u => u.id), 0) + 1,
      name,
      password: pw,
      isAdmin: makeAdmin,
    };
    setUsers(prev => {
      const next = [...prev, nu];
      kvSave("users", next).catch(()=>{});
      return next;
    });
    alert("가입자를 추가했습니다.");
  }

  /** 로그인 게이트 */
  if (!currentUser) {
    return (
      <div style={{minHeight:"100dvh", background:"linear-gradient(#fff, #f8fafc)"}}>
        <div style={{...S.container, display:"grid", placeItems:"center", minHeight:"100dvh"}}>
          <Card style={{width:360}}>
            <div style={{textAlign:"center", fontWeight:700, fontSize:18, marginBottom:12}}>방학서부 전시대모임</div>
            <div style={{display:"grid", gap:8}}>
              <Input placeholder="이름" value={loginName} onChange={e=>setLoginName(e.target.value)} />
              <Input placeholder="비밀번호" type="password" value={loginPw} onChange={e=>setLoginPw(e.target.value)} />
              <Button onClick={logIn}>로그인</Button>
            </div>
            <div style={{marginTop:16, borderTop:"1px solid #e5e7eb", paddingTop:12}}>
              <div style={{...S.small, marginBottom:8}}>처음이신가요? 아래에서 회원가입</div>
              <div style={{display:"grid", gap:8}}>
                <Input placeholder="이름(회원가입)" value={signupName} onChange={e=>setSignupName(e.target.value)} />
                <Input placeholder="비밀번호(회원가입)" type="password" value={signupPw} onChange={e=>setSignupPw(e.target.value)} />
                <Button kind="gray" onClick={signUp}>가입하기</Button>
              </div>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  /** 로그인 상태 화면 */
  return (
    <div style={{minHeight:"100dvh", background:"linear-gradient(#fff, #f8fafc)"}}>
      <header style={{position:"sticky", top:0, zIndex:10, background:"#ffffffcc", backdropFilter:"blur(8px)", borderBottom:"1px solid #e5e7eb"}}>
        <div style={{
          ...S.container,
          display:"flex",
          justifyContent: isMobile ? "initial" : "space-between",
          alignItems: isMobile ? "stretch" : "center",
          flexDirection: isMobile ? "column" : "row",
          gap: isMobile ? 8 : 0,
          paddingTop:12, paddingBottom:12
        }}>
          <div style={{fontWeight:700}}>방학서부 전시대모임</div>
          <div style={{
            display:"flex",
            alignItems:"center",
            gap:12,
            color:"#4b5563",
            fontSize:14,
            flexWrap: isMobile ? "nowrap" : "wrap",
            overflowX: isMobile ? "auto" : "visible",
            whiteSpace: "nowrap",
            WebkitOverflowScrolling: "touch",
            paddingBottom: isMobile ? 4 : 0
          }}>
            <span style={{whiteSpace:"nowrap", wordBreak:"keep-all", flex:"0 0 auto"}}>
              현재 사용자: <b>{currentUser.name}</b>{isAdmin?" (관리자)":""}
            </span>
            <Button kind="gray" onClick={()=>setTab("feed")}>전시대일정</Button>
            <Button kind="gray" onClick={()=>setTab("calendar")}>캘린더</Button>
            {isAdmin && <Button kind="gray" onClick={()=>setTab("create")}>일정 만들기</Button>}
            <Button kind="gray" onClick={()=>setTab("admin")}>관리자</Button>
            <Button onClick={logOut} style={{background:"#374151"}}>로그아웃</Button>
          </div>
        </div>
      </header>

      <main style={S.container}>
        {/* 전시대일정 */}
        {tab==="feed" && (
          <div>
            {CATEGORIES.map(cat=>(
              <div key={cat} style={{marginBottom:16}}>
                <button
                  onClick={()=> setOpenCat(prev => prev===cat ? null : cat)}
                  style={{...S.card, width:"100%", textAlign:"left"}}
                >
                  <div style={{display:"flex", justifyContent:"space-between"}}>
                    <div>
                      <div style={{fontWeight:600, fontSize:14}}>{cat}</div>
                      <div style={S.small}>클릭하여 일정 보기</div>
                    </div>
                    <div style={S.small}>{openCat===cat ? "접기 ▲" : "펼치기 ▼"}</div>
                  </div>
                </button>

                {openCat===cat && (
                  <div style={{marginTop:8, display:"grid", gap:8}}>
                    {(feedByCategory[cat]||[]).length===0 && (
                      <div style={{...S.small, paddingLeft:8}}>이 카테고리에 일정이 없어요.</div>
                    )}
{(feedByCategory[cat]||[]).map(ev=>{
  const past = isPastEvent(ev); // ✅ 지난 카드 판단 (앞서 추가한 유틸 사용)
  const isFuture = ev.time ? new Date(kstToUtcISO(ev.date, ev.time)) > new Date() : false;

  return (
    <Card
      key={ev.id}
      style={past ? {
        // ✅ 지난 카드면 톤 다운
        background: "#f8fafc",
        border: "1px solid #d1d5db",
        opacity: 0.9,
        filter: "grayscale(0.1)"
      } : undefined}
    >
      <div style={{
        display:"flex",
        flexDirection: isMobile ? "column" : "row",
        justifyContent: isMobile ? "initial" : "space-between",
        gap:12
      }}>
        <div>
          <div style={{fontWeight:700, fontSize:16}}>{ev.title}</div>
          <div style={{fontSize:13, color: past ? "#4b5563" : "#6b7280", marginTop:2}}>
            {ev.date} • {ev.time}
          </div>

          {/* === Chip/Badge 상태줄 === */}
          <div style={{marginTop:8, display:"flex", gap:8, flexWrap:"wrap", alignItems:"center"}}>
            {ev.participants.map(p=>(
              <Chip key={p.id}>
                {p.name}{p.leader?" · 인도자":""}
              </Chip>
            ))}

            <Badge tone={ev.participants.length < CAPACITY ? "green" : "gray"}>
              정원 {ev.participants.length}/{CAPACITY}
            </Badge>

            {ev.openForApplications && <Badge tone="green">지원 열림</Badge>}
            {!ev.openForApplications && ev.participants.length>=CAPACITY && <Badge tone="gray">마감</Badge>}

            {/* (선택) 미래 일정 달 때 '예정' 뱃지 */}
            {isFuture && <Badge tone="gray">예정</Badge>}

            {/* (선택) 지난 일정 표시 */}
            {past && <Badge tone="red">지남</Badge>}
          </div>

          {/* 취소요청 영역 등 기존 내용은 그대로 유지 */}
          {ev.cancelRequests.length>0 && (
            <div style={{marginTop:12, background:"#f9fafb", border:"1px solid #e5e7eb", borderRadius:10, padding:12}}>
              <div style={{fontSize:12, fontWeight:600, marginBottom:6}}>취소요청 ({ev.cancelRequests.length})</div>
              <div style={{display:"grid", gap:6}}>
                {ev.cancelRequests.map(r=>(
                  <div key={r.userId} style={{display:"flex", justifyContent:"space-between", fontSize:14, alignItems:"center"}}>
                    <div><b>{r.name}</b> <span style={{color:"#6b7280"}}>{r.reason}</span></div>
                    {isAdmin && (
                      <div style={{display:"flex", gap:6}}>
                        <Button kind="gray" onClick={()=>adminApproveCancel(ev.id, r.userId)}>승인</Button>
                        <Button kind="red" onClick={()=>adminRemoveParticipant(ev.id, r.userId)}>삭제</Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {ev.notifiedToAll && <div style={{...S.small, color:"#059669", marginTop:6}}>지원요청 알림이 발송되었어요(모의)</div>}
        </div>

        <div style={{
          display:"flex",
          flexDirection: isMobile ? "row" : "column",
          gap:8,
          minWidth: isMobile ? 0 : 180,
          width: isMobile ? "100%" : undefined,
          marginTop: isMobile ? 8 : 0,
          flexWrap: isMobile ? "nowrap" : undefined,
          overflowX: isMobile ? "auto" : undefined,
          whiteSpace: isMobile ? "nowrap" : undefined,
          WebkitOverflowScrolling: isMobile ? "touch" : undefined
        }}>
          {!isIn(ev, currentUser.id) && hasCapacity(ev) && (
            <Button onClick={()=>joinEvent(ev.id)}>지원</Button>
          )}
          {isIn(ev, currentUser.id) && (
            <Button kind="gray" onClick={()=>requestCancel(ev.id)}>취소요청</Button>
          )}
          {!isIn(ev, currentUser.id) && !hasCapacity(ev) && ev.openForApplications && (
            <Button onClick={()=>applyForSlot(ev.id)}>빈자리 지원(선착순)</Button>
          )}
          {isAdmin && (
            <>
              <Button kind="gray" onClick={()=>notifyAllForOpenSlot(ev.id)}>지원요청 알림</Button>
              <Button kind="gray" onClick={()=>startEdit(ev)}>수정</Button>
              <Button kind="red" onClick={()=>deleteEvent(ev.id)}>삭제</Button>
            </>
          )}
        </div>
      </div>
    </Card>
  );
})}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 캘린더(리스트) */}
        {tab==="calendar" && (
          <div style={{marginTop:8, display:"grid", gap:12}}>
            {(() => {
              void nowTick; // 15초마다 재평가
              const visible = [...events]
                .sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
              return (
                <>
                  {visible.map(ev=>(
                    <Card key={ev.id}>
                      <div style={{
                        display:"flex",
                        flexDirection: isMobile ? "column" : "row",
                        justifyContent: isMobile ? "initial" : "space-between",
                        gap:12
                      }}>
                        <div>
                          <div style={{fontWeight:600}}>{ev.title}</div>
                          <div style={{fontSize:14, color:"#6b7280"}}>
                            {ev.category} • {ev.date} • {ev.time}
                          </div>
                        </div>
                        {isAdmin && (
                          <div style={{display:"flex", gap:8}}>
                            <Button kind="gray" onClick={()=>startEdit(ev)}>수정</Button>
                            <Button kind="red" onClick={()=>deleteEvent(ev.id)}>삭제</Button>
                          </div>
                        )}
                      </div>
                    </Card>
                  ))}
                  {visible.length===0 && (
                    <div style={{...S.small}}>등록된 일정이 없어요.</div>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* 일정 만들기/수정 (관리자만) */}
        {tab==="create" && isAdmin && (
          <div style={{marginTop:8}}>
            <Card>
              <div style={{display:"grid", gap:12}}>
                <div>
                  <label style={S.label}>일정 제목</label>
                  <Input placeholder="예: 토요 전시대 모임" value={title} onChange={e=>setTitle(e.target.value)} />
                </div>
                <div style={{display:"grid", gap:12, gridTemplateColumns:"1fr 1fr"}}>
                  <div>
                    <label style={S.label}>날짜</label>
                    <Input type="date" value={date} onChange={e=>setDate(e.target.value)} />
                  </div>
                  <div>
                    <label style={S.label}>시간</label>
                    <Input type="time" value={time} onChange={e=>setTime(e.target.value)} />
                  </div>
                </div>
                <div>
                  <label style={S.label}>카테고리(요일 전시대)</label>
                  <select value={category} onChange={e=>setCategory(e.target.value)} style={{...S.input, height:40}}>
                    {CATEGORIES.map(c=> <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>

                {/* 참여자 + 인도자 */}
                <div style={{border:"1px solid #e5e7eb", borderRadius:12, padding:12}}>
                  <div style={{fontSize:14, fontWeight:600, marginBottom:8}}>참여자 선택 (최대 4명) + 인도자 지정</div>
                  <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:8}}>
                    {users.map(u=>(
                      <label key={u.id} style={{display:"flex", alignItems:"center", gap:8, fontSize:14}}>
                        <input
                          type="checkbox"
                          checked={selectedUserIds.includes(u.id)}
                          onChange={(e)=>{
                            const checked = e.target.checked;
                            setSelectedUserIds(prev=>{
                              if (checked) { if (prev.length>=CAPACITY) return prev; return [...prev, u.id]; }
                              else { if (leaderId===u.id) setLeaderId(null); return prev.filter(id=>id!==u.id); }
                            });
                          }}
                        />
                        <span>{u.name}{u.isAdmin?" (관리자)":""}</span>
                        <span style={{marginLeft:"auto", display:"flex", alignItems:"center", gap:6}}>
                          <input
                            type="radio"
                            name="leader"
                            disabled={!selectedUserIds.includes(u.id)}
                            checked={leaderId===u.id}
                            onChange={()=>setLeaderId(u.id)}
                          />
                          <span style={{fontSize:12, color:"#6b7280"}}>인도자</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <div style={{...S.small, marginTop:6}}>정원: 4명(고정)</div>
                </div>

                <label style={{display:"flex", alignItems:"center", gap:8, fontSize:14}}>
                  <input type="checkbox" checked={repeatWeekly} onChange={e=>setRepeatWeekly(e.target.checked)} />
                  매주 같은 요일/시간으로 자동 생성 (다음 일정 7일 전에 자동 추가)
                </label>

                <div style={{display:"flex", gap:8, flexWrap: isMobile ? "wrap" : undefined}}>
                  <Button onClick={upsertEvent}>{editingId ? "일정 수정" : "일정 생성"}</Button>
                  {editingId && <Button kind="gray" onClick={resetForm}>취소</Button>}
                </div>
              </div>
            </Card>
            <div style={{...S.small, marginTop:8}}>※ 관리자만 생성/수정/삭제 가능</div>
          </div>
        )}

        {/* 관리자 */}
        {tab==="admin" && (
          <div style={{display:"grid", gap:16, marginTop:8}}>
            {/* 가입자 관리 */}
            <Card>
              <div style={{fontSize:14, fontWeight:600, marginBottom:8}}>가입자 관리</div>
              <AdminUserCreator onCreate={adminCreateUser} disabled={!usersReady} />
              <div style={{marginTop:12, display:"grid", gridTemplateColumns:"1fr 1fr", gap:8}}>
                {users.map(u=>(
                  <div key={u.id} style={{border:"1px solid #e5e7eb", borderRadius:10, padding:8, display:"flex", justifyContent:"space-between", fontSize:14}}>
                    <div>{u.name}{u.isAdmin?" (관리자)":""}</div>
                    <div style={S.small}>id: {u.id}</div>
                  </div>
                ))}
              </div>
            </Card>

            {/* 로컬 데이터 초기화 */}
            <Card>
              <div style={{fontSize:14, fontWeight:600, marginBottom:8}}>로컬 데이터 초기화</div>
              <Button kind="gray" onClick={()=>{
                localStorage.removeItem("meet_current_v2");
                localStorage.removeItem("meet_tab_v2");
                localStorage.removeItem("meet_feed_cat_open_v2");
                location.reload();
              }}>초기화 후 새로고침</Button>
              <div style={{...S.small, marginTop:8}}>
                ※ users / events는 Supabase의 kv_store에 저장됩니다. 이 버튼은 내 브라우저에만 영향.
              </div>
            </Card>
          </div>
        )}
      </main>

      <footer style={{padding:"32px 0", textAlign:"center", fontSize:12, color:"#6b7280"}}>
        Made with ❤ 방학서부 전시대모임 (Supabase 동기화 · 로컬저장 분리 · 관리자도구)
      </footer>
    </div>
  );
}

/** ========== 하위: 관리자 가입자 추가 ========== */
function AdminUserCreator({
  onCreate,
  disabled = false,
}: {
  onCreate: (name: string, pw: string, isAdmin: boolean) => void;
  disabled?: boolean;
}) {
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [admin, setAdmin] = useState(false);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1.5fr 1.5fr 1fr 1fr",
        gap: 8,
        alignItems: "end",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <div>
        <label style={S.label}>이름</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="예: 홍길동"
          disabled={disabled}
        />
      </div>
      <div>
        <label style={S.label}>비밀번호</label>
        <Input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="******"
          disabled={disabled}
        />
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={admin}
          onChange={(e) => setAdmin(e.target.checked)}
          disabled={disabled}
        />
        <span>관리자</span>
      </label>
      <Button
        onClick={() => {
          onCreate(name, pw, admin);
          setName("");
          setPw("");
          setAdmin(false);
        }}
        disabled={disabled}
      >
        가입자 추가
      </Button>

      {disabled && (
        <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "#6b7280" }}>
          🔄 Supabase와 동기화 중입니다. 잠시만 기다려 주세요…
        </div>
      )}
    </div>
  );
}
