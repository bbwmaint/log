// Rotation Productivity Report PDF — team overview + one Pareto page per tech.
// Standalone builder (does not touch the shift-report pipeline). jsPDF under Node.
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { DEJAVU_REG, DEJAVU_BOLD } from './report-fonts.mjs';

const BBW_LOGO = 'data:image/png;base64,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';

// palette (RGB) — matches the app's light theme / indigo accent
const INK=[31,36,48], INK2=[66,71,79], MUTE=[154,160,170];
const IND=[79,70,229], IND_L=[99,102,241], IND_PALE=[199,201,240], AMBER=[245,158,11];
const GREEN=[22,163,74], RED=[220,38,38], CARD=[247,249,252], BORDER=[230,231,235], LINE=[215,217,222];

export function rotationFileName(R){ return `BBW_Rotation_Report_${R.from}_to_${R.to}.pdf`; }

export function buildRotationPDF(R){
  const doc=new jsPDF({unit:'pt',format:'letter'});
  let RF='helvetica';
  try{
    if(typeof DEJAVU_REG!=='undefined'){
      doc.addFileToVFS('DejaVu.ttf',DEJAVU_REG); doc.addFont('DejaVu.ttf','DejaVu','normal');
      doc.addFileToVFS('DejaVu-Bold.ttf',DEJAVU_BOLD); doc.addFont('DejaVu-Bold.ttf','DejaVu','bold');
      RF='DejaVu';
    }
  }catch(e){ RF='helvetica'; }
  const W=doc.internal.pageSize.getWidth(), H=doc.internal.pageSize.getHeight(), M=40;
  const F=(c)=>doc.setFillColor(c[0],c[1],c[2]);
  const D=(c)=>doc.setDrawColor(c[0],c[1],c[2]);
  const TC=(c)=>doc.setTextColor(c[0],c[1],c[2]);
  const safe=(s)=>String(s==null?'':s).replace(/\u2013/g,'-').replace(/\u2014/g,'-').replace(/[\u2018\u2019]/g,"'").replace(/[\u201C\u201D]/g,'"').replace(/\u2026/g,'...');
  const trunc=(s,n)=>{s=String(s||'');return s.length>n?s.slice(0,n-1)+'\u2026':s;};

  // Letterhead — matches the shift-report PDF: thin top rule, BBW logo,
  // subtitle, right-aligned title + date, then a bold divider.
  function header(rightTitle, rightSub, leftSub, titleSize){
    doc.setFillColor(17,17,17); doc.rect(0,0,W,6,'F');
    let y=44;
    let logoOK=false;
    if(BBW_LOGO){ try{ const _lh=24,_lw=_lh*(1996/881); doc.addImage(BBW_LOGO,'PNG',M,y-22,_lw,_lh); logoOK=true; }catch(e){} }
    if(!logoOK){ doc.setFont(RF,'bold'); doc.setFontSize(17); TC([17,17,17]); doc.text('BRUNSWICK BIERWORKS', M, y); }
    doc.setFont(RF,'normal'); doc.setFontSize(10.5); TC([120,120,120]);
    doc.text(safe(leftSub), M, y+15);
    doc.setFont(RF,'bold'); doc.setFontSize(titleSize||12); TC([17,17,17]);
    doc.text(safe(rightTitle), W-M, y, {align:'right'});
    doc.setFont(RF,'normal'); doc.setFontSize(10); TC([120,120,120]);
    doc.text(safe(rightSub), W-M, y+15, {align:'right'});
    y+=30;
    doc.setDrawColor(17,17,17); doc.setLineWidth(1.2); doc.line(M,y,W-M,y);
    return y+20;
  }

  function tiles(y, arr){
    const gap=10, tw=(W-2*M-gap*(arr.length-1))/arr.length, th=50;
    arr.forEach((t,i)=>{
      const x=M+i*(tw+gap);
      F(CARD); D(BORDER); doc.setLineWidth(0.8); doc.roundedRect(x,y,tw,th,6,6,'FD');
      TC(MUTE); doc.setFont(RF,'bold'); doc.setFontSize(7);
      doc.text(safe(t[0]).toUpperCase(), x+10, y+16);
      TC(t[2]||INK); doc.setFont(RF,'bold'); doc.setFontSize(15);
      doc.text(safe(t[1]), x+10, y+38);
    });
    return y+th+16;
  }

  function calloutBox(y, tint, edge, tcol, title, body){
    const bx=M, bw=W-2*M; doc.setFontSize(8.8); doc.setFont(RF,'normal');
    const wrapped=doc.splitTextToSize(safe(body), bw-24);
    const bh=20+wrapped.length*11+8;
    F(tint); D(edge); doc.setLineWidth(0.8); doc.roundedRect(bx,y,bw,bh,7,7,'FD');
    TC(tcol); doc.setFont(RF,'bold'); doc.setFontSize(9.2);
    doc.text('\u25B8  '+safe(title), bx+12, y+15);
    TC(INK2); doc.setFont(RF,'normal'); doc.setFontSize(8.8);
    doc.text(wrapped, bx+12, y+28);
    return y+bh+14;
  }

  // Horizontal leaderboard (name | bar | value)
  function hbars(x, y, w, rows, unit){
    const rh=17, labW=64, valW=34, barW=w-labW-valW;
    const max=Math.max(1,...rows.map(r=>r.value));
    rows.forEach((r,i)=>{
      const ry=y+i*rh;
      TC(INK2); doc.setFont(RF,'normal'); doc.setFontSize(9);
      doc.text(trunc(r.label,12), x+labW-6, ry+9, {align:'right'});
      F(CARD); doc.roundedRect(x+labW, ry+1, barW, 11, 2,2,'F');
      const bw=Math.max(2, barW*(r.value/max));
      F(IND_L); doc.roundedRect(x+labW, ry+1, bw, 11, 2,2,'F');
      TC(INK2); doc.setFont(RF,'bold'); doc.setFontSize(8.5);
      doc.text(r.value.toFixed(0)+unit, x+labW+barW+6, ry+9);
    });
    return y+rows.length*rh;
  }

  // Pareto: descending bars + cumulative % line + 80% marker.
  // `total` is the cumulative denominator (defaults to the sum of shown bars);
  // pass the tech's true total so a top-N view honestly ends below 100%.
  function pareto(x, y, w, h, items, title, rotate, total){
    const n=items.length; if(!n) return y+h;
    doc.setFont(RF,'bold'); doc.setFontSize(10.5); TC(INK);
    doc.text(safe(title), x, y);
    const px=x+30, py=y+14, pw=w-46, ph=h-14-(rotate?26:14);   // plot box (rotate => stagger 2 rows)
    const axisY=py+ph;
    const denom=total||items.reduce((a,it)=>a+it.hours,0)||1;
    const maxH=Math.max(...items.map(it=>it.hours))||1;
    const slot=pw/n, bw=Math.min(slot*0.6, 34);
    // axes
    D(LINE); doc.setLineWidth(0.8); doc.line(px,py,px,axisY); doc.line(px,axisY,px+pw,axisY);
    // left ticks (hours)
    TC(MUTE); doc.setFont(RF,'normal'); doc.setFontSize(7);
    for(let k=0;k<=2;k++){ const v=maxH*k/2, yy=axisY-(v/maxH)*ph;
      doc.text(v.toFixed(0), px-4, yy+2, {align:'right'}); }
    // 80% dashed line
    const y80=axisY-0.8*ph;
    D(MUTE); doc.setLineWidth(0.6); doc.setLineDashPattern([2,2],0); doc.line(px,y80,px+pw,y80);
    doc.setLineDashPattern([],0);
    TC(MUTE); doc.setFontSize(6.8); doc.text('80%', px+pw, y80-2, {align:'right'});
    // bars + cumulative
    let cum=0; const pts=[];
    items.forEach((it,i)=>{
      const cx=px+slot*i+slot/2;
      const bh=(it.hours/maxH)*ph, bx=cx-bw/2, by=axisY-bh;
      cum+=it.hours; const cp=cum/denom*100;
      const prev=items.slice(0,i).reduce((a,z)=>a+z.hours,0)/denom*100;
      const vital=(prev<80);
      F(vital?IND:IND_PALE); doc.roundedRect(bx,by,bw,bh,2,2,'F');
      TC(INK2); doc.setFont(RF,'bold'); doc.setFontSize(7);
      doc.text(it.hours.toFixed(1), cx, by-3, {align:'center'});
      // x label — horizontal; when many long names (rotate=true) stagger onto two
      // rows so adjacent labels sit on different lines and never collide.
      TC(INK2); doc.setFont(RF,'normal');
      if(rotate){
        const fs=6.6, row=i%2, ly=axisY+10+row*8.6;
        doc.setFontSize(fs);
        const maxC=Math.max(6, Math.floor((slot*1.8)/(fs*0.52)));
        doc.text(trunc(it.label,maxC), cx, ly, {align:'center'});
      } else {
        const fs=6.8; doc.setFontSize(fs);
        const maxC=Math.max(4, Math.floor((slot-2)/(fs*0.52)));
        doc.text(trunc(it.label,maxC), cx, axisY+10, {align:'center'});
      }
      pts.push([cx, axisY-(cp/100)*ph]);
    });
    // cumulative polyline + markers
    D(AMBER); doc.setLineWidth(1.4);
    for(let i=1;i<pts.length;i++) doc.line(pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1]);
    F(AMBER); pts.forEach(p=>doc.circle(p[0],p[1],2.2,'F'));
    // right axis label
    TC(AMBER); doc.setFont(RF,'normal'); doc.setFontSize(7);
    doc.text('100', px+pw+4, py+3); doc.text('0', px+pw+4, axisY+2);
    return y+h;
  }

  // ── PAGE 1 — overview ──────────────────────────────────────────────────────
  let y=header('Rotation Overview', `${R.fromLabel} – ${R.toLabel}`, 'Rotation Productivity Report'+(R.rotName?'  \u00b7  Shift '+R.rotName:''), 13);
  const T=R.team;
  y=tiles(y, [
    ['Techs on rota', String(T.techCount)],
    ['Total labour', T.totalLabour.toFixed(0)+' h'],
    ['PM vs reactive', `${T.pmPct}% / ${T.reactivePct}%`],
    ['Downtime handled', T.downtime.toFixed(1)+' h', RED],
  ]);
  y+=4;
  // leaderboard (left) + area pareto (right)
  doc.setFont(RF,'bold'); doc.setFontSize(11); TC(INK);
  doc.text('Hours by technician', M, y);
  doc.text('Team hours by area', M+ (W-2*M)/2 + 14, y);
  const secY=y+12;
  const lbRows=R.techs.slice(0,10).map(t=>({label:t.tech, value:t.hours}));
  hbars(M, secY, (W-2*M)/2 - 14, lbRows, 'h');
  pareto(M+(W-2*M)/2 + 14, secY-10, (W-2*M)/2 - 14, 150, R.team.byArea.slice(0,7), '', true);
  y=Math.max(secY+lbRows.length*17, secY+150) + 10;
  // insight (name real areas only; never label "Other" as an area)
  const realAreas=T.byArea.filter(a=>a.label!=='Other');
  const namedTop=realAreas.slice(0,2).map(a=>a.label).join(' + ')||'Maintenance';
  const top2h=realAreas.slice(0,2).reduce((a,x)=>a+x.hours,0);
  const pctTop=T.totalLabour>0?Math.round(top2h/T.totalLabour*100):0;
  const busiest=R.techs[0];
  y=calloutBox(y, [238,240,255], [199,201,242], IND, 'Where the rotation went',
    `${namedTop} absorbed ${pctTop}% of all labour.`+
    (busiest?` ${busiest.tech} logged the most hours (${busiest.hours.toFixed(1)}h).`:'')+
    ` ${T.reactivePct}% of team time was reactive.`);
  TC(MUTE); doc.setFont(RF,'normal'); doc.setFontSize(9);
  doc.text('Following pages: one Pareto page per technician.', M, y+4);

  // ── per-tech pages ─────────────────────────────────────────────────────────
  R.techs.forEach(t=>{
    doc.addPage();
    let y=header(t.tech, `${R.fromLabel} – ${R.toLabel}`, 'Rotation Productivity Report — by technician'+(R.rotName?'  \u00b7  Shift '+R.rotName:''), 14);
    y=tiles(y, [
      ['Total hours', t.hours.toFixed(1)+' h'],
      ['PMs done', String(t.pms), GREEN],
      ['Reactive jobs', String(t.reactive)],
      ['Downtime handled', t.downtime.toFixed(1)+' h', RED],
      ['Parts used', String(t.parts)],
    ]);
    y+=6;
    // main pareto (hours by machine) — cumulative measured vs the tech's true total
    y=pareto(M, y, W-2*M, 210, t.pareto, "Where "+t.tech+"'s hours went  (by machine)", true, t.hours);
    y+=8;
    // vital few callout (honest about spread-out techs)
    let cum=0, nFew=0, hit=false;
    for(const it of t.pareto){ cum+=it.hours; nFew++; if(cum/(t.hours||1)>=0.8){ hit=true; break; } }
    const fewNames=t.pareto.slice(0,nFew).map(x=>x.label).join(', ');
    const shownPct=Math.round(t.pareto.reduce((a,x)=>a+x.hours,0)/(t.hours||1)*100);
    const tailNote=t.tailCount>0?` (+${t.tailCount} more machine${t.tailCount===1?'':'s'}, ${t.tailHours.toFixed(1)}h)`:'';
    const vfBody=hit
      ? `80% of ${t.tech}'s time went to ${nFew} machine${nFew===1?'':'s'}: ${fewNames}.${tailNote}`
      : `${t.tech}'s time is spread out — the top ${t.pareto.length} machines cover ${shownPct}% of hours.${tailNote}`;
    y=calloutBox(y, [255,247,237], [253,215,170], [180,83,9], 'Vital few', vfBody);
    // work-type split (left) + top assets (right)
    doc.setFont(RF,'bold'); doc.setFontSize(10.5); TC(INK);
    doc.text('Hours by work type', M, y+4);
    const wt=[['PM',t.pmHours,GREEN],['Reactive',t.reactiveHours,RED],['Parts',t.partsHours,AMBER],['Changeover',t.coMins/60,IND_L]];
    const wtMax=Math.max(0.1,...wt.map(w=>w[1]));
    const wx=M, wy=y+14, ww=(W-2*M)/2-20, wh=90, bslot=ww/wt.length;
    D(LINE); doc.setLineWidth(0.8); doc.line(wx,wy+wh,wx+ww,wy+wh);
    wt.forEach((w,i)=>{
      const cx=wx+bslot*i+bslot/2, bh=(w[1]/wtMax)*(wh-14), bw=Math.min(bslot*0.55,26);
      F(w[2]); doc.roundedRect(cx-bw/2, wy+wh-bh, bw, bh, 2,2,'F');
      TC(INK2); doc.setFont(RF,'bold'); doc.setFontSize(7); doc.text(w[1].toFixed(1), cx, wy+wh-bh-3, {align:'center'});
      TC(INK2); doc.setFont(RF,'normal'); doc.setFontSize(7.5); doc.text(w[0], cx, wy+wh+10, {align:'center'});
    });
    // top assets handled (right side, simple list)
    const rx=M+(W-2*M)/2+6;
    doc.setFont(RF,'bold'); doc.setFontSize(10.5); TC(INK);
    doc.text('Top assets handled', rx, y+4);
    let ry=y+16;
    (t.topList||[]).forEach(a=>{
      F(CARD); doc.roundedRect(rx, ry, (W-M)-rx, 24, 3,3,'F');
      TC(INK); doc.setFont(RF,'bold'); doc.setFontSize(8.6); doc.text(trunc(a.asset,26), rx+8, ry+10);
      TC(MUTE); doc.setFont(RF,'normal'); doc.setFontSize(7.4); doc.text(trunc(safe(a.desc||''),34), rx+8, ry+20);
      TC(INK2); doc.setFont(RF,'bold'); doc.setFontSize(9); doc.text(a.hours.toFixed(1)+'h', (W-M)-8, ry+14, {align:'right'});
      ry+=28;
    });
  });

  // footer on every page
  const pages=doc.internal.getNumberOfPages();
  for(let p=1;p<=pages;p++){ doc.setPage(p);
    TC(MUTE); doc.setFont(RF,'normal'); doc.setFontSize(7.6);
    doc.text('Rotation Productivity Report  \u00b7  generated '+new Date().toLocaleString('en-CA'), M, H-18);
    doc.text('Page '+p+' of '+pages, W-M, H-18, {align:'right'});
  }
  return Buffer.from(doc.output('arraybuffer'));
}
