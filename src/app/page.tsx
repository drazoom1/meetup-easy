// src/app/page.tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./../lib/supabaseClient";

/** ========== Types & Consts ========== */
type User = { id: number; name: string; password: string; isAdmin: boolean };
type Participant = { id: number; name: string; leader: boolean };
type CancelRequest = { userId: number; name: string; reason: string };

type EventItem = {
  id: number;
  title: string;
  date: string;        // YYYY-MM-DD
  time: string;        // HH:mm
  category: string;    // 요일 전시대
  participants: Participant[];
  cancelRequests: CancelRequest[];
  openForApplications: boolean;
  notifiedToAll: boolean;
  repeatWeekly: boolean;
};

const CAPACITY = 4;
const CATEGORIES = ["월요일","화요일","수요일","목요일","금요일","토요일","일요일"];

/** ========== Helpers ========== */
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
function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function cmpDate(a: string, b: string) { return a === b ? 0 : (a < b ? -1 : 1); }

/** ========== Mini UI (no Tailwind) ========== */
/* CSS 속성 타입 안전! */
const S = {
  container: { maxWidth: 960, margin: "0 auto", padding: 16 },
  card: {
    border: "1px solid #e6e9ef",
    borderRadius: 12,
    padding: 16,
    background: "#fff",
    boxShadow: "0 1px 2px rgba(0,0,0,.06)",
    transition: "box-shadow .18s ease, transform .18s ease"
  },
  btn: {
    height: 44, padding: "0 16px",
    background: "#1a73e8", color: "#fff",
    borderRadius: 8, border: "1px solid #1a73e8",
    cursor: "pointer" as const,
    boxShadow: "0 1px 2px rgba(0,0,0,.10)",
    transition: "box-shadow .15s ease, transform .02s ease, background .15s ease",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    whiteSpace: "nowrap", wordBreak: "keep-all", flexShrink: 0
  },
  btnGray: {
    height: 44, padding: "0 16px",
    background: "#f1f3f4", color: "#1f1f1f",
    borderRadius: 8, border: "1px solid #e6e9ef",
    cursor: "pointer" as const,
    transition: "box-shadow .15s ease, transform .02s ease, background .15s ease",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    whiteSpace: "nowrap", wordBreak: "keep-all", flexShrink: 0
  },
  btnRed: {
    height: 44, padding: "0 16px",
    background: "#d93025", color: "#fff",
    borderRadius: 8, border: "1px solid #d93025",
    cursor: "pointer" as const,
    transition: "box-shadow .15s ease, transform .02s ease, background .15s ease",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    whiteSpace: "nowrap", wordBreak: "keep-all", flexShrink: 0
  },
  input: {
    height: 40, padding: "0 12px",
    border: "1px solid #e6e9ef", borderRadius: 8, width: "100%",
    background: "#fff", outline: "none",
    transition: "border-color .15s ease, box-shadow .15s ease"
  },
  label: { fontSize: 12, color: "#5f6368", display: "block", marginBottom: 6 },
  small: { fontSize: 12, color: "#5f6368", wordBreak: "keep-all" },
} satisfies Record<string, React.CSSProperties>;

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
      onFocus={e=>{ e.currentTarget.style.borderColor = "#1a73e8"; e.currentTarget.style.boxShadow = "0 0 0 3px rgba(26,115,232,.15)"; }}
      onBlur={e=>{ e.currentTarget.style.borderColor = "#e6e9ef"; e.currentTarget.style.boxShadow = "none"; }}
    />
  );
}
function Chip({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 12, background:"#f3f4f6", color:"#374151", padding:"4px 10px", borderRadius:999, border:"1px solid #e5e7eb" }}>{children}</span>;
}
function Badge({ tone="green", children }:{ tone?: "green"|"gray"|"red"; children: React.ReactNode }) {
  const map = {
    green: { bg:"#ecfdf5", bd:"#a7f3d0", fg:"#065f46" },
    gray:  { bg:"#f3f4f6", bd:"#e5e7eb", fg:"#374151" },
    red:   { bg:"#fef2f2", bd:"#fecaca", fg:"#7f1d1d" },
  }[tone];
  return <span style={{ fontSize: 11, fontWeight:600, background: map.bg, color: map.fg, padding:"3px 8px", borderRadius:999, border:`1px solid ${map.bd}`, letterSpacing:0.2 }}>{children}</span>;
}

/** ========== Page ========== */
export default function Home() {
  const isMobile = useIsMobile();

  // 로그인/유저
  const [users, setUsers] = useState<User[]>([]);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const currentUser = users.find(u=>u.id===currentUserId) ?? null;
  const isAdmin = !!currentUser?.isAdmin;

  // 화면 상태
  const [tab, setTab] = useState<"feed"|"calendar"|"create"|"admin">("feed");
  const [openCat, setOpenCat] = useState<string | null>(null);

  // 폼 상태
  const [editingId, setEditingId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [repeatWeekly, setRepeatWeekly] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);
  const [leaderId, setLeaderId] = useState<number | null>(null);

  // 로그인/회원가입 입력
  const [loginName, setLoginName] = useState(""); const [loginPw, setLoginPw] = useState("");
  const [signupName, setSignupName] = useState(""); const [signupPw, setSignupPw] = useState("");

  // 이벤트 데이터
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);

  /** ========== 데이터 로드 ========== */
  async function loadAll() {
    setLoading(true);
    // 1) users
    const { data: udata, error: uerr } = await supabase.from("app_users").select("*").order("id", { ascending: true });
    if (!uerr && udata) {
      setUsers(udata.map(u=>({ id:u.id, name:u.name, password:u.password, isAdmin:u.is_admin })));
    }
    // 2) events
    const { data: edata } = await supabase.from("events").select("*").order("date", { ascending: true }).order("time", { ascending: true });

    // 3) participants
    const { data: pdata } = await supabase.from("participants").select("event_id,user_id,leader");

    // 4) cancel requests
    const { data: cdata } = await supabase.from("cancel_requests").select("event_id,user_id,reason");

    // 조합
    const usersMap = new Map(users.map(u=>[u.id, u.name]));
    // 최신 usersMap 보장을 위해 udata 기준 다시 만듦
    if (udata) {
      for (const u of udata) usersMap.set(u.id, u.name);
    }

    const evs: EventItem[] = (edata||[]).map(e=>{
      const parts = (pdata||[]).filter(p=>p.event_id===e.id).map(p=>({
        id: p.user_id,
        name: usersMap.get(p.user_id)||`#${p.user_id}`,
        leader: !!p.leader
      }));
      const cancels = (cdata||[]).filter(c=>c.event_id===e.id).map(c=>({
        userId: c.user_id,
        name: usersMap.get(c.user_id)||`#${c.user_id}`,
        reason: c.reason||""
      }));
      return {
        id: e.id,
        title: e.title,
        date: e.date,
        time: e.time,
        category: e.category,
        participants: parts,
        cancelRequests: cancels,
        openForApplications: !!e.open_for_applications,
        notifiedToAll: !!e.notified_to_all,
        repeatWeekly: !!e.repeat_weekly
      };
    });

    setEvents(evs);
    setLoading(false);
  }

  useEffect(()=>{
    // 로그인 유지(localStorage)
    try {
      const saved = window.localStorage.getItem("meet_current_user_id");
      if (saved) setCurrentUserId(Number(saved));
    } catch {}
    loadAll();
    // 실시간 반영
    const ch = supabase.channel("realtime-all")
      .on("postgres_changes", { event:"*", schema:"public", table:"events" }, loadAll)
      .on("postgres_changes", { event:"*", schema:"public", table:"participants" }, loadAll)
      .on("postgres_changes", { event:"*", schema:"public", table:"cancel_requests" }, loadAll)
      .on("postgres_changes", { event:"*", schema:"public", table:"app_users" }, loadAll)
      .subscribe();
    return ()=>{ supabase.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  /** 지난 일정 숨기기(삭제 아님) */
  const visibleEvents = useMemo(()=>{
    const t = todayStr();
    return events.filter(e => cmpDate(e.date, t) >= 0);
  },[events]);

  /** 카테고리별 묶기 */
  const feedByCategory = useMemo(()=>{
    const map: Record<string, EventItem[]> = {};
    for(const c of CATEGORIES) map[c] = [];
    for(const e of visibleEvents) (map[e.category] ||= []).push(e);
    for(const c of Object.keys(map)) map[c].sort((a,b)=> (a.date+a.time).localeCompare(b.date+b.time));
    return map;
  },[visibleEvents]);

  /** 인증 */
  async function logIn() {
    const { data } = await supabase.from("app_users").select("*").eq("name", loginName).eq("password", loginPw).maybeSingle();
    if (!data) { alert("이름 또는 비밀번호가 올바르지 않습니다."); return; }
    setCurrentUserId(data.id);
    try { window.localStorage.setItem("meet_current_user_id", String(data.id)); } catch {}
    setLoginName(""); setLoginPw("");
    loadAll();
  }
  async function signUp() {
    if (!signupName || !signupPw) return;
    // 중복 체크
    const { data: ex } = await supabase.from("app_users").select("id").eq("name", signupName).maybeSingle();
    if (ex) { alert("이미 존재하는 이름입니다."); return; }
    const { data, error } = await supabase.from("app_users").insert({ name: signupName, password: signupPw, is_admin: false }).select("*").single();
    if (error) { alert(error.message); return; }
    alert("가입 완료! 로그인해주세요.");
    setSignupName(""); setSignupPw("");
    loadAll();
  }
  function logOut() { setCurrentUserId(null); try { localStorage.removeItem("meet_current_user_id"); } catch {} }

  /** 유틸 */
  function isIn(ev: EventItem, uid: number) { return ev.participants.some(p=>p.id===uid); }
  function hasCapacity(ev: EventItem) { return ev.participants.length < CAPACITY; }

  /** 액션: 참가/취소요청/관리자처리 */
  async function joinEvent(evId: number) {
    if (!currentUser) return;
    const ev = events.find(e=>e.id===evId); if (!ev) return;
    if (isIn(ev, currentUser.id) || !hasCapacity(ev)) return;
    const { error } = await supabase.from("participants").insert({ event_id: evId, user_id: currentUser.id, leader: false });
    if (error) alert(error.message);
    // 꽉 찼다면 open_for_applications 갱신(선택)
    await supabase.from("events").update({ open_for_applications: ev.participants.length+1 < CAPACITY }).eq("id", evId);
  }
  async function requestCancel(evId: number, reason="개인 사정") {
    if (!currentUser) return;
    const { error } = await supabase.from("cancel_requests").insert({ event_id: evId, user_id: currentUser.id, reason });
    if (error) alert(error.message);
  }
  async function adminApproveCancel(evId: number, userId: number) {
    if (!isAdmin) return;
    await supabase.from("participants").delete().eq("event_id", evId).eq("user_id", userId);
    await supabase.from("cancel_requests").delete().eq("event_id", evId).eq("user_id", userId);
    await supabase.from("events").update({ open_for_applications: true }).eq("id", evId);
  }
  async function adminRemoveParticipant(evId: number, userId: number) {
    if (!isAdmin) return;
    await supabase.from("participants").delete().eq("event_id", evId).eq("user_id", userId);
    await supabase.from("cancel_requests").delete().eq("event_id", evId).eq("user_id", userId);
    await supabase.from("events").update({ open_for_applications: true }).eq("id", evId);
  }
  async function notifyAllForOpenSlot(evId: number) {
    if (!isAdmin) return;
    await supabase.from("events").update({ notified_to_all: true, open_for_applications: true }).eq("id", evId);
    alert("사이트 가입자에게 지원요청 알림이 발송되었다고 가정합니다(모의).");
  }
  async function applyForSlot(evId: number) {
    if (!currentUser) return;
    const ev = events.find(e=>e.id===evId); if (!ev) return;
    if (!ev.openForApplications || !hasCapacity(ev) || isIn(ev, currentUser.id)) return;
    await supabase.from("participants").insert({ event_id: evId, user_id: currentUser.id, leader: false });
    await supabase.from("events").update({ open_for_applications: ev.participants.length+1 < CAPACITY }).eq("id", evId);
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

  async function deleteEvent(evId: number) {
    if (!isAdmin) return;
    if (!confirm("이 일정을 삭제할까요?")) return;
    await supabase.from("events").delete().eq("id", evId);
    if (editingId===evId) resetForm();
  }

  async function upsertEvent() {
    if (!isAdmin) { alert("관리자만 일정 생성/수정 가능합니다."); return; }
    if (!title || !date || !time || !category) { alert("제목/날짜/시간/카테고리를 입력해주세요."); return; }
    if (selectedUserIds.length===0 || selectedUserIds.length>CAPACITY) { alert("참여자는 1~4명만 선택 가능합니다."); return; }
    if (!leaderId || !selectedUserIds.includes(leaderId)) { alert("인도자는 선택된 참여자 중 1명을 지정해야 합니다."); return; }

    if (editingId) {
      // 업데이트 + 참가자 전체 교체(간단)
      await supabase.from("events").update({
        title, date, time, category,
        repeat_weekly: repeatWeekly,
        // 정원 체크해서 열림/닫힘 표시
        open_for_applications: selectedUserIds.length < CAPACITY
      }).eq("id", editingId);
      await supabase.from("participants").delete().eq("event_id", editingId);
      const rows = selectedUserIds.map(uid=>({ event_id: editingId, user_id: uid, leader: uid===leaderId }));
      await supabase.from("participants").insert(rows);
    } else {
      // 새로 만들기
      const { data, error } = await supabase.from("events").insert({
        title, date, time, category,
        repeat_weekly: repeatWeekly,
        open_for_applications: selectedUserIds.length < CAPACITY,
        notified_to_all: false
      }).select("*").single();
      if (error || !data) { alert(error?.message || "생성 실패"); return; }
      const evId = data.id;
      const rows = selectedUserIds.map(uid=>({ event_id: evId, user_id: uid, leader: uid===leaderId }));
      await supabase.from("participants").insert(rows);
    }
    resetForm(); setTab("feed");
  }

  async function adminCreateUser(name: string, pw: string, makeAdmin: boolean) {
    if (!isAdmin) return;
    if (!name || !pw) { alert("이름/비밀번호를 입력해주세요."); return; }
    const exist = await supabase.from("app_users").select("id").eq("name", name).maybeSingle();
    if (exist.data) { alert("이미 존재하는 이름입니다."); return; }
    await supabase.from("app_users").insert({ name, password: pw, is_admin: makeAdmin });
    alert("가입자를 추가했습니다.");
  }

  /** 자동 반복 생성/지난 일정 삭제
   *  👉 다유저 환경에서는 서버(스케줄러)에서 처리해야 중복방지 가능
   *  👉 일단 주석 처리, 나중에 Vercel Cron으로 붙여드릴게요!
   */

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

  if (loading) {
    return <div style={{...S.container}}>불러오는 중...</div>;
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
                <button onClick={()=> setOpenCat(prev => prev===cat ? null : cat)} style={{...S.card, width:"100%", textAlign:"left"}}>
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
                    {(feedByCategory[cat]||[]).map(ev=>(
                      <Card key={ev.id}>
                        <div style={{
                          display:"flex",
                          flexDirection: isMobile ? "column" : "row",
                          justifyContent: isMobile ? "initial" : "space-between",
                          gap:12
                        }}>
                          <div>
                            <div style={{fontWeight:700, fontSize:16}}>{ev.title}</div>
                            <div style={{fontSize:13, color:"#6b7280", marginTop:2}}>
                              {ev.date} • {ev.time}
                            </div>
                            <div style={{marginTop:8, display:"flex", gap:8, flexWrap:"wrap", alignItems:"center"}}>
                              {ev.participants.map(p=>(
                                <Chip key={p.id}>{p.name}{p.leader?" · 인도자":""}</Chip>
                              ))}
                              <Badge tone={ev.participants.length < CAPACITY ? "green" : "gray"}>
                                정원 {ev.participants.length}/{CAPACITY}
                              </Badge>
                              {ev.openForApplications && <Badge tone="green">지원 열림</Badge>}
                              {!ev.openForApplications && ev.participants.length>=CAPACITY && <Badge tone="gray">마감</Badge>}
                            </div>

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
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 캘린더(리스트) */}
        {tab==="calendar" && (
          <div style={{marginTop:8, display:"grid", gap:12}}>
            {[...visibleEvents].sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)).map(ev=>(
              <Card key={ev.id}>
                <div style={{ display:"flex", flexDirection: isMobile ? "column" : "row", justifyContent: isMobile ? "initial" : "space-between", gap:12 }}>
                  <div>
                    <div style={{fontWeight:600}}>{ev.title}</div>
                    <div style={{fontSize:14, color:"#6b7280"}}>{ev.category} • {ev.date} • {ev.time}</div>
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
            {visibleEvents.length===0 && <div style={{...S.small}}>등록된 일정이 없어요.</div>}
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
                  매주 같은 요일/시간으로 자동 생성 (※ 다유저 환경에서는 서버 스케줄로 전환 예정)
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
              <AdminUserCreator onCreate={adminCreateUser} />
              <div style={{marginTop:12, display:"grid", gridTemplateColumns:"1fr 1fr", gap:8}}>
                {users.map(u=>(
                  <div key={u.id} style={{border:"1px solid #e5e7eb", borderRadius:10, padding:8, display:"flex", justifyContent:"space-between", fontSize:14}}>
                    <div>{u.name}{u.isAdmin?" (관리자)":""}</div>
                    <div style={S.small}>id: {u.id}</div>
                  </div>
                ))}
              </div>
            </Card>

            {/* 로컬 데이터 초기화(이제 거의 쓸 일 없음) */}
            <Card>
              <div style={{fontSize:14, fontWeight:600, marginBottom:8}}>로컬 로그인 정보 초기화</div>
              <Button kind="gray" onClick={()=>{
                try { localStorage.removeItem("meet_current_user_id"); } catch {}
                location.reload();
              }}>현재 기기 로그아웃</Button>
            </Card>
          </div>
        )}
      </main>

      <footer style={{padding:"32px 0", textAlign:"center", fontSize:12, color:"#6b7280"}}>
        Made with ❤ 방학서부 전시대모임 (Supabase 공유DB · 실시간 반영)
      </footer>
    </div>
  );
}

/** ========== 하위: 관리자 가입자 추가 ========== */
function AdminUserCreator({ onCreate }: { onCreate: (name:string, pw:string, isAdmin:boolean)=>void }) {
  const [name, setName] = useState(""); const [pw, setPw] = useState(""); const [admin, setAdmin] = useState(false);
  return (
    <div style={{display:"grid", gridTemplateColumns:"1.5fr 1.5fr 1fr 1fr", gap:8, alignItems:"end"}}>
      <div>
        <label style={S.label}>이름</label>
        <Input value={name} onChange={e=>setName(e.target.value)} placeholder="예: 홍길동" />
      </div>
      <div>
        <label style={S.label}>비밀번호</label>
        <Input type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="******" />
      </div>
      <label style={{display:"flex", alignItems:"center", gap:8}}>
        <input type="checkbox" checked={admin} onChange={e=>setAdmin(e.target.checked)} />
        <span>관리자</span>
      </label>
      <Button onClick={()=>{ onCreate(name, pw, admin); setName(""); setPw(""); setAdmin(false); }}>가입자 추가</Button>
    </div>
  );
}
